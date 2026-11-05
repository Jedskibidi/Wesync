const API_URL = window.WESYNC_API_URL || "";
const socket = io(API_URL || undefined);
const $ = (id) => document.getElementById(id);
const audio = $("audio");

// If our audio is more than this many seconds off the room, we jump (B13/F13)
const DRIFT_LIMIT_SECONDS = 0.3;

// How long an error message stays on screen, in milliseconds
const ERROR_VISIBLE_MS = 6000;

const ROOM_CODE_PATTERN = /^[A-Z0-9]{4}$/;

let inRoom = false;
let currentSong = null; // file name of the song loaded in the <audio>
let pickedBy = null; // nickname of whoever picked the current song (rooms only)
let isSeeking = false; // true while the user drags the seek bar

// What the room is doing, as last told by the server (or by our own buttons).
let playback = { position: 0, isPlaying: false, receivedAt: performance.now() };
let needsSync = false; // true while we wait for the audio file to load
// true while the "tap to join the listening" overlay is up: a late joiner
// must click once before any sound starts (browsers block autoplay)
let waitingForClick = false;

// Rejoin after a lost connection (B16)
let submittedNickname = ""; // the nickname we last used to create/join
let submittedPassword = ""; // the room password we last used (kept to rejoin)
let lastRoom = null; // { code, nickname } of the room we are in
let rejoining = false; // true while we wait for the server to take us back
let pendingAction = null; // "create" or "join" while we wait for the server

let messageTimer = null;

// The song library from GET /songs: [{ file, title }, ...], newest first
let library = [];
let songsLoading = true; // true until the first /songs answer (spinner)
let songsFailed = false; // true if /songs could not be loaded
// Song lengths in seconds, by file name (null while we are still loading it)
const durations = new Map();
let filterText = ""; // what is typed in the song search box
let songsRoomCode = null; // the room the current song list belongs to

// ---------- Songs live in the room ----------
// Every room has its own songs (the server keeps them in music/<ROOM>/ and
// deletes them when the room closes), so song addresses and the song list
// always need the room code.

function roomCodeNow() {
  return lastRoom ? lastRoom.code : null;
}

// "/music/AB12/<file>": where the audio of a song is
function songUrl(file) {
  return API_URL + "/music/" + roomCodeNow() + "/" + encodeURIComponent(file);
}

// "?room=AB12&sid=<our socket id>": the server uses it to check that we are
// really in that room. Empty when we are not in a room.
function roomQuery() {
  const code = roomCodeNow();
  if (!code || !socket.id) return "";
  return `?room=${encodeURIComponent(code)}&sid=${encodeURIComponent(socket.id)}`;
}

// ---------- Small helpers ----------

// 3:05 (used under the seek bar and in the playlist)
function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// 03:05 (used on the LCD screen)
function lcdFormat(seconds) {
  if (!Number.isFinite(seconds)) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// "1700000000000-Magnolia-Remix.mp3" -> "Magnolia Remix" (same as the server)
function titleFromFile(file) {
  return file
    .replace(/\.[^.]+$/, "")
    .replace(/^\d{10,}-/, "")
    .replace(/-/g, " ");
}

// A message that stays until something replaces it
function showMessage(text) {
  clearTimeout(messageTimer);
  $("message").textContent = text;
}

// An error message that disappears by itself after a few seconds
function showError(text) {
  showMessage(text);
  messageTimer = setTimeout(() => {
    if ($("message").textContent === text) showMessage("");
  }, ERROR_VISIBLE_MS);
}

// A small spinning ring (the CSS draws and turns it)
function makeSpinner() {
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");
  return spinner;
}

// A message with a spinner in front, for things that are still loading.
// It stays until something replaces it (showMessage / showError).
function showLoading(text) {
  clearTimeout(messageTimer);
  const box = $("message");
  box.textContent = "";
  box.append(makeSpinner(), text);
}

// Turn whatever the server said into a friendly sentence. Anything we do not
// recognise becomes a generic message, so raw error text is never shown.
const GENERIC_ERROR = "Something went wrong. Please try again.";

function friendlyError(raw) {
  const text = String(raw || "").trim();
  const rules = [
    [/^Room (\w+) not found/i, (m) => `We couldn't find room ${m[1].toUpperCase()}. Check the code and try again.`],
    [/nickname.*already taken/i, () => "Someone in this room already uses that nickname. Please pick another one."],
    [/^Please enter a nickname/i, () => "Please enter a nickname."],
    [/needs a password/i, () => "This room is protected. Please enter its password."],
    [/too many wrong passwords/i, () => "Too many wrong passwords. Please wait a minute and try again."],
    [/wrong password/i, () => "That password isn't right. Please try again."],
    [/room code has 4/i, () => "A room code has 4 letters or numbers."],
    [/not in a room/i, () => "You're not in a room right now. Create or join one first."],
    [/^Pick a song first/i, () => "Pick a song first."],
    [/^Song not found/i, () => "We couldn't find that song. It may have been deleted."],
    [/queue is full/i, () => "The queue is full. Remove a song to make room."],
    [/not in the queue/i, () => "That song was already removed from the queue."],
    [/queue is empty/i, () => "The queue is empty. Add a song first."],
    [/no previous song/i, () => "There's no previous song to go back to."],
    [/went wrong on the server/i, () => "The server had a problem. Please try again."],
  ];
  for (const [pattern, make] of rules) {
    const match = text.match(pattern);
    if (match) return make(match);
  }
  return GENERIC_ERROR;
}

// Creating or joining a room: spinner, buttons off, and a friendly message
// if the server never answers.
const ROOM_LOADING_TIMEOUT_MS = 10000;
let roomLoadingTimer = null;

function startRoomLoading(text) {
  $("create").disabled = true;
  $("join").disabled = true;
  showLoading(text);
  clearTimeout(roomLoadingTimer);
  roomLoadingTimer = setTimeout(() => {
    stopRoomLoading();
    pendingAction = null;
    showError("The server is taking too long to answer. Please try again in a moment.");
  }, ROOM_LOADING_TIMEOUT_MS);
}

function stopRoomLoading() {
  clearTimeout(roomLoadingTimer);
  $("create").disabled = false;
  $("join").disabled = false;
  if ($("message").querySelector(".spinner")) showMessage("");
}

const AVATAR_COLORS = ["#f7b731", "#f29a8e", "#ffd966", "#dda66a"];

function avatarColor(name) {
  let sum = 0;
  for (const ch of name) sum += ch.codePointAt(0);
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

function showMembers(members, host) {
  const list = $("memberList");
  list.innerHTML = "";
  $("memberCount").textContent = members.length;

  // Host first, everybody else in the order the server sent them
  const ordered = [...members].sort(
    (a, b) => Number(b === host) - Number(a === host),
  );

  ordered.forEach((name) => {
    const isYou = name === submittedNickname;
    const isHost = name === host;

    const row = document.createElement("li");
    row.className = "member" + (isYou ? " is-you" : "");

    const avatar = document.createElement("span");
    avatar.className = "member-avatar";
    avatar.style.background = avatarColor(name);
    avatar.textContent = Array.from(name)[0]?.toUpperCase() || "?";
    avatar.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "member-name";
    label.textContent = name;

    row.append(avatar, label);

    if (isYou) row.appendChild(makeTag("You", "tag-you"));
    if (isHost) row.appendChild(makeTag("Host", "tag-host"));

    list.appendChild(row);
  });
}

function makeTag(text, className) {
  const tag = document.createElement("span");
  tag.className = "member-tag " + className;
  tag.textContent = text;
  return tag;
}

let focusBeforeOverlay = null; // where the keyboard focus was, to go back to

function showOverlay() {
  if (!$("joinOverlay").hidden) return; // already up
  focusBeforeOverlay = document.activeElement;
  $("joinOverlay").hidden = false;
  // While the popup is open the rest of the page cannot be reached (Tab,
  // clicks, screen reader), so the keyboard focus cannot wander behind it.
  document.querySelector("main").inert = true;
  $("joinListening").focus();
}

function hideOverlay() {
  if ($("joinOverlay").hidden) return; // nothing to close
  $("joinOverlay").hidden = true;
  document.querySelector("main").inert = false;

  // Give the focus back to where it was (or to the play button if that
  // place is gone, for example the first screen that just closed)
  const back = focusBeforeOverlay;
  focusBeforeOverlay = null;
  if (back && back !== document.body) back.focus();
  if (!document.activeElement || document.activeElement === document.body) {
    if (!$("playPause").disabled) $("playPause").focus();
  }
}

// ---------- First screen: inline errors ----------

// Show an error right under a field. field is "nickname" or "code".
function showFieldError(field, text) {
  const error = $(field + "Error");
  error.textContent = text;
  error.hidden = false;
  $(field).setAttribute("aria-invalid", "true");
}

function clearFieldError(field) {
  const error = $(field + "Error");
  error.textContent = "";
  error.hidden = true;
  $(field).removeAttribute("aria-invalid");
}

function clearFieldErrors() {
  clearFieldError("nickname");
  clearFieldError("code");
  clearFieldError("roomPassword");
}

// An error from the server while we are on the first screen:
// put it under the field it is about.
function showLandingError(text) {
  if (/password/i.test(text)) {
    // The room is protected: show the password box under the room code
    $("passwordRow").hidden = false;
    showFieldError("roomPassword", text);
    $("roomPassword").focus();
  } else if (/nickname/i.test(text)) {
    showFieldError("nickname", text);
  } else if (pendingAction === "join") {
    showFieldError("code", text);
  } else {
    showError(text);
  }
}

// ---------- First screen: which card is visible ----------
// The player stays visible in both cases (it also works alone).

// Not in a room: show the create/join card
function showLanding() {
  // If the keyboard focus is on a button that is about to disappear
  // ("Leave room"), move it to the first field so it is not lost
  const hadFocus = $("roomInfo").contains(document.activeElement);
  $("roomSection").hidden = false;
  $("roomInfo").hidden = true;
  $("memberPanel").hidden = true;
  if (hadFocus) $("nickname").focus();
}

// In a room: show the room card (member count, copy link, leave)
function showRoomView() {
  // Same idea: the "Create Room" / "Join Room" button is about to disappear
  const hadFocus = $("roomSection").contains(document.activeElement);
  $("roomSection").hidden = true;
  $("passwordRow").hidden = true;
  $("roomPassword").value = "";
  $("inviteHint").hidden = true;
  $("roomInfo").hidden = false;
  $("memberPanel").hidden = false;
  if (hadFocus) {
    const first = $("roomInfo").querySelector("button"); // "Copy invite link"
    if (first) first.focus();
  }
}

// Keep the address bar as an invite link: ?room=AB12
function updateUrl(code) {
  const wanted = "?room=" + code;
  if (location.search !== wanted) history.replaceState(null, "", wanted);
}

function clearUrl() {
  history.replaceState(null, "", location.pathname);
}

// ---------- Player display (time, sliders, LCD, buttons) ----------

// The honey bar behind a slider's thumb (the CSS reads --fill)
function setFill(slider, percent) {
  slider.style.setProperty("--fill", percent + "%");
}

function updateSeekFill() {
  const seekBar = $("seek");
  const max = Number(seekBar.max) || 0;
  setFill(seekBar, max > 0 ? (Number(seekBar.value) / max) * 100 : 0);
}

function updateVolumeFill() {
  const volume = Number($("volume").value);
  setFill($("volume"), volume * 100);
  // A screen reader says "50%" instead of "0.5"
  $("volume").setAttribute("aria-valuetext", `${Math.round(volume * 100)}%`);
}

// The current time under the seek bar and on the LCD, and the seek thumb
function updateTimeDisplay() {
  const seekBar = $("seek");
  if (!isSeeking) seekBar.value = audio.currentTime;
  const shown = isSeeking ? Number(seekBar.value) : audio.currentTime;
  $("currentTime").textContent = formatTime(shown);
  $("lcdTime").textContent = lcdFormat(shown);
  // A screen reader says "1:05 of 3:20" instead of a number of seconds
  seekBar.setAttribute(
    "aria-valuetext",
    `${formatTime(shown)} of ${formatTime(audio.duration)}`,
  );
  updateSeekFill();
}

// "01 Song title" (the number is the song's place in the playlist)
function updateLcdTitle() {
  if (!currentSong) {
    $("lcdTrack").textContent = "INSERT DISC";
  } else {
    // Only the track number: the title is already shown big, right below
    const index = library.findIndex((song) => song.file === currentSong);
    const number = index >= 0 ? String(index + 1).padStart(2, "0") : "";
    $("lcdTrack").textContent = number ? `TRACK ${number}` : "PLAYING";
  }
  updateNowPlaying();
}

// The big title, the cover placeholder and the "Picked by" line.
// textContent (not innerHTML) so a nickname or title can never inject HTML.
function updateNowPlaying() {
  $("npTitle").textContent = currentSong
    ? titleFromFile(currentSong)
    : "Nothing playing";

  // "Picked by" only makes sense in a room, and only if we know who
  const picker = $("npPicker");
  if (inRoom && currentSong && pickedBy) {
    picker.textContent = `Picked by ${pickedBy}`;
    picker.hidden = false;
  } else {
    picker.textContent = "";
    picker.hidden = true;
  }
}

// Turn the controls on or off and keep the play/pause label correct.
// Without a song, play/pause, seek, next and previous are disabled.
function updateControls() {
  const hasSong = !!currentSong;
  $("playPause").disabled = !hasSong;
  $("seek").disabled = !hasSong;
  // In a room, "next" can start the queue even when no song is loaded
  $("next").disabled = !hasSong && !inRoom;
  $("previous").disabled = !hasSong && !inRoom;
  const playing = hasSong && !audio.paused;
  $("playPause").textContent = playing ? "II" : "▶";
  $("playPause").setAttribute("aria-label", playing ? "Pause" : "Play");
}

// ---------- Queue (F14) ----------

// id of the queue item being dragged right now (null when nothing is)
let draggedQueueId = null;

function clearDropMarks() {
  $("queueList")
    .querySelectorAll(".drop-before, .drop-after, .is-dragging")
    .forEach((row) => row.classList.remove("drop-before", "drop-after", "is-dragging"));
}

// Make a queue row draggable. Dropping it sends reorderQueue; the server
// answers with queueUpdate, so every tab redraws in the same new order.
function makeQueueRowDraggable(li, item, index, queue) {
  li.draggable = true;

  li.addEventListener("dragstart", (e) => {
    draggedQueueId = item.id;
    li.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(item.id)); // Firefox needs data
  });

  li.addEventListener("dragend", () => {
    draggedQueueId = null;
    clearDropMarks();
  });

  li.addEventListener("dragover", (e) => {
    if (draggedQueueId === null) return; // not one of our rows (e.g. a file)
    e.preventDefault();
    const box = li.getBoundingClientRect();
    const after = e.clientY > box.top + box.height / 2;
    li.classList.toggle("drop-after", after);
    li.classList.toggle("drop-before", !after);
  });

  li.addEventListener("dragleave", () => {
    li.classList.remove("drop-before", "drop-after");
  });

  li.addEventListener("drop", (e) => {
    if (draggedQueueId === null) return;
    e.preventDefault();

    const after = li.classList.contains("drop-after");
    const from = queue.findIndex((q) => q.id === draggedQueueId);
    let to = index + (after ? 1 : 0);
    if (from !== -1 && from < to) to--; // the dragged row leaves its old place

    if (from !== -1 && from !== to) {
      socket.emit("reorderQueue", { id: draggedQueueId, toIndex: to });
    }
    draggedQueueId = null;
    clearDropMarks();
  });
}

// Small up / down buttons. They are the way to reorder with the keyboard or
// a touch screen, where drag and drop does not work. They send the same
// reorderQueue as a drag. "action" ("up" / "down") lets renderQueue put the
// keyboard focus back on the same button after the list is redrawn.
function makeMoveButton(symbol, label, disabled, toIndex, id, action) {
  const button = document.createElement("button");
  button.className = "btn btn-secondary btn-sm";
  button.type = "button";
  button.textContent = symbol;
  button.setAttribute("aria-label", label);
  button.dataset.action = action;
  button.disabled = disabled;
  button.onclick = () => socket.emit("reorderQueue", { id, toIndex });
  return button;
}

// Draw the queue list. "queue" looks like [{ id, file, title }, ...].
// We use textContent (not innerHTML) so a song title can never inject HTML.
//
// The last queue we were given is kept, so the list can be redrawn when the
// playing song changes (loadSong / clearSong call renderQueue() with no
// argument). The song that is playing now is drawn as the first row.
let lastQueue = [];

// The queue is redrawn from scratch after every change, which would drop the
// keyboard focus on the page. These two remember which button had the focus
// and put it back (or on the nearest sensible button).
function queueFocusInfo(list) {
  const active = document.activeElement;
  if (!active || !list.contains(active)) return null;
  const row = active.closest("li[data-queue-id]");
  if (!row) return null;
  const rows = Array.from(list.querySelectorAll("li[data-queue-id]"));
  return {
    id: row.dataset.queueId,
    action: active.dataset.action || "remove",
    index: rows.indexOf(row),
  };
}

function restoreQueueFocus(list, info) {
  if (!info) return;
  const rows = Array.from(list.querySelectorAll("li[data-queue-id]"));
  let target = null;

  const sameRow = rows.find((row) => row.dataset.queueId === info.id);
  if (sameRow) {
    // The same button if it still works (the first row's "up" is off now),
    // otherwise any other button of that row
    target =
      sameRow.querySelector(`button[data-action="${info.action}"]:not(:disabled)`) ||
      sameRow.querySelector("button:not(:disabled)");
  } else if (rows.length > 0) {
    // The row was removed: the "Remove" button of the row that took its place
    const next = rows[Math.min(info.index, rows.length - 1)];
    target = next.querySelector('button[data-action="remove"]');
  }
  if (!target && !$("playPause").disabled) target = $("playPause");
  if (target) target.focus();
}

function renderQueue(queue = lastQueue) {
  lastQueue = Array.isArray(queue) ? queue : [];
  const items = inRoom ? lastQueue : []; // no room, no queue

  const list = $("queueList");
  const focused = queueFocusInfo(list);
  list.innerHTML = "";

  // (The song that is playing now is not repeated here: it already shows in
  // "Now playing" and highlighted in the Playlist. This list is only what
  // comes next.)
  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Queue is empty";
    list.appendChild(empty);
    restoreQueueFocus(list, focused);
    return;
  }

  items.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "track";
    li.dataset.queueId = item.id;
    makeQueueRowDraggable(li, item, index, items);

    const title = document.createElement("span");
    title.className = "track-title";
    title.textContent = item.title;

    const removeButton = document.createElement("button");
    removeButton.className = "btn btn-secondary btn-sm";
    removeButton.textContent = "Remove";
    removeButton.dataset.action = "remove";
    removeButton.setAttribute("aria-label", `Remove ${item.title} from queue`);
    removeButton.onclick = () => {
      socket.emit("removeFromQueue", { id: item.id });
    };

    const move = document.createElement("span");
    move.className = "queue-move";
    move.append(
      makeMoveButton("\u25B2", `Move ${item.title} up`, index === 0, index - 1, item.id, "up"),
      makeMoveButton("\u25BC", `Move ${item.title} down`, index === items.length - 1, index + 1, item.id, "down"),
    );

    li.appendChild(title);
    li.appendChild(move);
    li.appendChild(removeButton);
    list.appendChild(li);
  });

  restoreQueueFocus(list, focused);
}

// ---------- Room playback memory ----------

function remember(position, isPlaying) {
  playback = { position, isPlaying, receivedAt: performance.now() };
}

// While the room is playing, time keeps moving since we last heard about it.
function expectedPosition() {
  if (!playback.isPlaying) return playback.position;
  return playback.position + (performance.now() - playback.receivedAt) / 1000;
}

// ---------- Audio actions (these never send anything to the server) ----------

// Back to the start: seek bar empty (and its length forgotten until the new
// song says how long it is), times at 0:00. Used when a song is loaded or
// cleared, so the old song's numbers never stay on screen.
function resetPlayerDisplay() {
  isSeeking = false; // a drag that was going on is over
  const seekBar = $("seek");
  seekBar.max = 0;
  seekBar.value = 0;
  seekBar.setAttribute("aria-valuetext", "0:00 of 0:00");
  $("currentTime").textContent = "0:00";
  $("duration").textContent = "0:00";
  $("lcdTime").textContent = "00:00";
  updateSeekFill();
}

// "by" is the nickname of whoever picked the song (null when playing alone
// or when we do not know).
function loadSong(file, by = null) {
  currentSong = file;
  pickedBy = by;
  audio.src = songUrl(file);
  audio.load();
  audio.pause();
  resetPlayerDisplay();
  updateControls();
  updateLcdTitle();
  renderPlaylist();
  renderQueue(); // the playing song is the first row of the queue
}

function clearSong() {
  currentSong = null;
  pickedBy = null;
  needsSync = false;
  waitingForClick = false;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  resetPlayerDisplay();
  updateControls();
  updateLcdTitle();
  renderPlaylist();
  renderQueue(); // the playing song is the first row of the queue
}

function seekTo(seconds) {
  const max = Number.isFinite(audio.duration) ? audio.duration : seconds;
  audio.currentTime = Math.min(Math.max(0, seconds), max);
}

function playAudio() {
  // A late joiner has not clicked yet: keep the overlay up, stay silent
  if (waitingForClick) {
    showOverlay();
    return;
  }
  audio.play().catch((err) => {
    if (err.name === "NotAllowedError") {
      // Browsers block sound until the user has clicked on the page.
      showOverlay();
    }
    // NotSupportedError (a missing or broken file) is explained by the audio
    // "error" handler further down, so no second message is shown here.
    // AbortError just means a new song was loaded in the meantime. Harmless.
  });
}

// Put our audio where the room is right now. If the file has not loaded
// yet, wait: the "loadedmetadata" event below finishes the job.
function syncAudioToRoom() {
  if (!currentSong) return;
  if (audio.readyState < 1) {
    needsSync = true;
    return;
  }
  needsSync = false;
  seekTo(expectedPosition());
  if (playback.isPlaying) {
    playAudio();
  } else {
    audio.pause();
    waitingForClick = false;
    hideOverlay();
  }
}

// ---------- Apply the full room state (join, create, getState, next...) ----------

function applyState(state, justJoined = false) {
  // Joining a room where music is already playing: ask for one click first.
  // A paused room (or one with no song) needs no overlay.
  if (justJoined && state.isPlaying && state.currentSong) {
    waitingForClick = true;
    showOverlay();
  }

  inRoom = true;
  showRoomView();
  updateUrl(state.code);
  $("room").textContent = state.code;
  showMembers(state.members, state.host);
  renderQueue(state.queue);

  remember(state.position, state.isPlaying);

  if (!state.currentSong) {
    clearSong();
    hideOverlay();
    return;
  }

  if (state.currentSong !== currentSong) {
    loadSong(state.currentSong, state.pickedBy || null);
  } else {
    // Same song, but the picker (or the fact that we are in a room) may differ
    pickedBy = state.pickedBy || null;
    updateNowPlaying();
  }
  syncAudioToRoom();
}

// ---------- Remote updates, toasts and connection state ----------

// true while we are applying something that came FROM the server. Anything
// that would send to the server goes through sendToRoom(), which refuses to
// send while this is true, so a remote update can never be echoed back.
let isRemoteUpdate = false;

function applyRemote(fn) {
  const before = isRemoteUpdate;
  isRemoteUpdate = true;
  try {
    fn();
  } finally {
    isRemoteUpdate = before;
  }
}

// The only way the player sends play, pause, seek or changeSong.
// Real user actions only: not while applying a remote update, not outside a room.
function sendToRoom(event, data) {
  if (isRemoteUpdate || !inRoom) return;
  socket.emit(event, data);
}

// A small message in the corner that goes away by itself
const TOAST_VISIBLE_MS = 3000;
const MAX_TOASTS = 4;

function showToast(text) {
  let box = $("toasts");
  if (!box) {
    box = document.createElement("div");
    box.id = "toasts";
    box.className = "toasts";
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
    document.body.appendChild(box);
  }
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = text; // textContent: a nickname can never inject HTML
  box.appendChild(toast);
  while (box.children.length > MAX_TOASTS) box.firstChild.remove();
  setTimeout(() => toast.remove(), TOAST_VISIBLE_MS);
}

// Who was in the room the last time we looked, to toast joins and leaves
let knownMembers = [];

function announceMembers(members) {
  members
    .filter((name) => !knownMembers.includes(name) && name !== submittedNickname)
    .forEach((name) => showToast(`${name} joined`));
  knownMembers
    .filter((name) => !members.includes(name) && name !== submittedNickname)
    .forEach((name) => showToast(`${name} left`));
  knownMembers = [...members];
}

// ---------- Messages for what other people do ----------

// Long titles are cut so a toast stays small
function shortTitle(title) {
  const text = String(title || "");
  return text.length > 30 ? text.slice(0, 29) + "…" : text;
}

// Skipping, queue changes: the server sends { type, by, title }
socket.on("activity", ({ type, by, title }) => {
  if (!by) return;
  const song = shortTitle(title);
  const messages = {
    next: `${by} skipped to "${song}"`,
    previous: `${by} went back to "${song}"`,
    queueAdd: `${by} added "${song}" to the queue`,
    queueRemove: `${by} removed "${song}" from the queue`,
    queueMove: `${by} moved "${song}" in the queue`,
  };
  if (messages[type]) showToast(messages[type]);
});

// Jumping around in a song can fire many times in a row (for example when
// someone holds an arrow key), so we wait a moment and show only the last one
let seekToastTimer = null;
let seekFrom = 0; // where the song was when the jump started

// "before" is where the room was just before the jump, so we can tell if
// the song was moved forward or backward
function toastSeek(by, position, before) {
  if (!by) return;
  if (seekToastTimer === null) seekFrom = before; // first jump of a series
  clearTimeout(seekToastTimer);
  seekToastTimer = setTimeout(() => {
    seekToastTimer = null;
    const time = formatTime(position);
    if (position > seekFrom + 0.5) showToast(`${by} forwarded the song to ${time}`);
    else if (position < seekFrom - 0.5) showToast(`${by} rewound the song to ${time}`);
    else showToast(`${by} jumped to ${time}`);
  }, 600);
}

// The connection indicator: "connected", "reconnecting" or "offline"
let everConnected = false;

function setConnection(state) {
  const label = $("status");
  label.textContent = state;
  label.dataset.state = state; // the CSS colors the dot from this
}

// ---------- Messages from the server ----------

socket.on("connect", () => {
  everConnected = true;
  setConnection("connected");

  // Connection came back after a drop: the server forgot us, so rejoin.
  if (lastRoom) {
    rejoining = true;
    showLoading("Reconnecting to your room...");
    socket.emit("joinRoom", lastRoom);
  } else {
    showMessage(""); // clears "can't reach the server" and similar
  }
});

socket.on("disconnect", (reason) => {
  // These two reasons mean the browser will NOT try again by itself
  const final = reason === "io client disconnect" || reason === "io server disconnect";
  setConnection(final ? "offline" : "reconnecting");
  inRoom = false;
  waitingForClick = false;
  hideOverlay();
  audio.pause();
  updateControls();
  updateNowPlaying(); // hides "Picked by" while we are out of the room
  stopRoomLoading();
  if (lastRoom) {
    // We will try to rejoin automatically when the connection returns
    showLoading("Lost connection to the server. Trying to reconnect...");
  } else {
    showLanding();
    showMessage("You're disconnected from the server. Wait for it to reconnect, then create or join a room.");
  }
});

// The server could not be reached at all
socket.on("connect_error", () => {
  // Never connected: nothing to reconnect to yet. Connected before: retrying.
  setConnection(everConnected ? "reconnecting" : "offline");
  if (!everConnected) {
    showMessage("We can't reach the server right now. Check your connection. We'll keep trying.");
  }
});

socket.on("roomState", (state) => {
  const justJoined = pendingAction === "join"; // the user pressed Join Room
  stopRoomLoading();
  showMessage("");
  clearFieldErrors();
  clearNoRoomUploadMessage();
  rejoining = false;
  pendingAction = null;
  lastRoom = {
    code: state.code,
    nickname: submittedNickname,
    password: submittedPassword,
  };
  // A new room has its own songs (also retry if the last load failed)
  if (state.code !== songsRoomCode || songsFailed) loadSongs();
  knownMembers = [...state.members]; // our own join is not toasted
  applyRemote(() => applyState(state, justJoined));
});

socket.on("membersUpdate", (data) => {
  announceMembers(data.members);
  showMembers(data.members, data.host);
});

socket.on("queueUpdate", ({ queue }) => {
  renderQueue(queue);
});

// Somebody in the room uploaded a song: refresh the playlist and library card
socket.on("songsUpdate", (info) => {
  loadSongs();
  document.dispatchEvent(new Event("songsChanged"));
  // Tell us about songs other people added (we already see our own upload)
  if (info && info.by && info.by !== submittedNickname) {
    showToast(`${info.by} added "${shortTitle(info.title)}" to the playlist`);
  }
});

// We left the room: its songs are gone for us too
document.addEventListener("roomLeft", () => loadSongs());

socket.on("roomError", (err) => {
  stopRoomLoading();
  const text = friendlyError(err && err.message);

  if (rejoining) {
    // The server did not take us back (for example the room is gone)
    rejoining = false;
    lastRoom = null;
    loadSongs(); // the room's songs went with it
    clearUrl();
    showLanding();
    showError("We couldn't take you back to your room. It may have closed, so please create or join a room again.");
    return;
  }

  // On the first screen, show the error under the field it is about
  if (!inRoom && pendingAction) {
    showLandingError(text);
    pendingAction = null;
    return;
  }

  showError(text);
});

// Someone else pressed a button. We only change our own audio here.
// We do NOT send anything back, so no echo loops are possible.
socket.on("play", ({ position, by }) => {
  applyRemote(() => {
    remember(position, true);
    syncAudioToRoom();
  });
  if (by) showToast(`${by} played`);
});

socket.on("pause", ({ position, by }) => {
  applyRemote(() => {
    remember(position, false);
    syncAudioToRoom();
  });
  if (by) showToast(`${by} paused`);
});

socket.on("seek", ({ position, by }) => {
  const before = expectedPosition(); // where the room was before this jump
  applyRemote(() => {
    remember(position, playback.isPlaying);
    syncAudioToRoom();
  });
  toastSeek(by, position, before);
});

// "by" is the nickname of the person who picked the song (if the server sends it)
socket.on("changeSong", ({ song, by }) => {
  applyRemote(() => {
    loadSong(song, by || null);
    remember(0, false);
    syncAudioToRoom(); // the file is still loading, so this waits for metadata
  });
  if (by) showToast(`${by} picked "${shortTitle(titleFromFile(song))}"`);
});

// Drift correction (F13): the server tells us every few seconds where the
// song should be. If we are off by more than 0.3 s, jump to the right spot.
function handleSyncTick({ position, isPlaying }) {
  if (!inRoom || !currentSong) return;

  remember(position, isPlaying);

  // Do not interfere while loading, dragging the seek bar, or after the end
  if (audio.readyState < 1 || isSeeking || audio.seeking || audio.ended) return;

  if (!isPlaying) {
    if (!audio.paused) audio.pause();
  } else if (audio.paused) {
    playAudio(); // the room is playing but we are not (may show the overlay)
  }

  const drift = audio.currentTime - position;
  if (Math.abs(drift) > DRIFT_LIMIT_SECONDS) {
    seekTo(position);
  }
}

socket.on("syncTick", (tick) => applyRemote(() => handleSyncTick(tick)));

socket.io.on("reconnect_attempt", () => setConnection("reconnecting"));
socket.io.on("reconnect_failed", () => setConnection("offline"));

// The browser knows when the network itself goes away
window.addEventListener("offline", () => setConnection("offline"));
window.addEventListener("online", () => {
  if (!socket.connected) setConnection("reconnecting");
});

// ---------- Our own buttons: change our audio AND tell the server ----------
// Everything in the player works alone. In a room, the buttons also send
// their action to the server so everybody else follows.

// Returns the trimmed nickname, or "" (after showing an error) if it is empty.
function readNickname() {
  const nickname = $("nickname").value.trim();
  if (!nickname) {
    showFieldError("nickname", "Please enter a nickname");
    return "";
  }
  return nickname;
}

// Returns the cleaned room code, or "" (after showing an error) if invalid.
function readCode() {
  const code = $("code").value.trim().toUpperCase();
  $("code").value = code;
  if (!code) {
    showFieldError("code", "Please enter the room code");
    return "";
  }
  if (!ROOM_CODE_PATTERN.test(code)) {
    showFieldError("code", "A room code has 4 letters or numbers");
    return "";
  }
  return code;
}

function startCreate() {
  clearFieldErrors();
  showMessage("");

  const nickname = readNickname();
  if (!nickname) return $("nickname").focus();

  lastRoom = null;
  rejoining = false;
  pendingAction = "create";
  submittedNickname = nickname;
  submittedPassword = "";
  socket.emit("createRoom", { nickname });
  startRoomLoading("Creating your room...");
}

function startJoin() {
  clearFieldErrors();
  showMessage("");

  // Check both fields first, so both errors can show at once
  const nickname = readNickname();
  const code = readCode();
  if (!nickname) return $("nickname").focus();
  if (!code) return $("code").focus();

  lastRoom = null;
  rejoining = false;
  pendingAction = "join";
  submittedNickname = nickname;
  submittedPassword = $("roomPassword").value;
  socket.emit("joinRoom", { code, nickname, password: submittedPassword });
  startRoomLoading(`Joining room ${code}...`);
}

$("create").onclick = startCreate;
$("join").onclick = startJoin;

// Enter in the nickname box: join if a code is filled in, otherwise create.
$("nickname").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if ($("code").value.trim()) startJoin();
  else startCreate();
});

// Enter in the code box: join
$("code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") startJoin();
});

// Enter in the password box: join
$("roomPassword").addEventListener("keydown", (e) => {
  if (e.key === "Enter") startJoin();
});

// Typing in a field removes its error
$("roomPassword").addEventListener("input", () => clearFieldError("roomPassword"));
$("nickname").addEventListener("input", () => clearFieldError("nickname"));
$("code").addEventListener("input", () => {
  $("code").value = $("code").value.toUpperCase();
  clearFieldError("code");
});

// Invite link: /?room=AB12 fills in the code and waits for a nickname
function readInviteFromUrl() {
  const raw = new URLSearchParams(location.search).get("room");
  if (raw === null) return;

  const code = raw.trim().toUpperCase();
  if (!ROOM_CODE_PATTERN.test(code)) {
    showFieldError("code", "That invite link has an invalid room code");
    return;
  }

  $("code").value = code;
  $("inviteHint").textContent =
    `You've been invited to room ${code}. Enter a nickname and press Join Room.`;
  $("inviteHint").hidden = false;
  $("nickname").focus();
}

// Clicking a song in the playlist: load it and start playing.
// In a room, we are the one who picked it.
function chooseSong(file) {
  loadSong(file, inRoom ? submittedNickname : null);
  remember(0, true);
  playAudio();
  sendToRoom("changeSong", { song: file });
  sendToRoom("play", { position: 0 });
}

// The server answers with queueUpdate, which redraws the list for everyone
function queueSong(file) {
  if (!inRoom) return showError("Join a room to use the queue");
  socket.emit("addToQueue", { song: file });
}

// One button for play and pause. The label is kept correct by updateControls().
$("playPause").onclick = () => {
  if (!currentSong) return showError("Pick a song first");
  if (audio.paused) {
    if (audio.ended) seekTo(0); // song finished: play from the start
    remember(audio.currentTime, true);
    playAudio();
    sendToRoom("play", { position: audio.currentTime });
  } else {
    audio.pause();
    remember(audio.currentTime, false);
    sendToRoom("pause", { position: audio.currentTime });
  }
};

// Next and previous (B15). In a room the server decides, then sends roomState
// to everyone (including us), and applyState() loads and plays the new song.
// Alone, they walk through the playlist. "Previous" restarts the song first
// if we are more than 3 seconds into it.
function stepSolo(direction) {
  if (direction < 0 && currentSong && audio.currentTime > 3) {
    seekTo(0);
    return;
  }

  const files = library.map((song) => song.file);
  if (files.length === 0) return;

  const index = files.indexOf(currentSong);
  let target;
  if (index === -1) {
    target = direction > 0 ? 0 : files.length - 1;
  } else {
    target = (index + direction + files.length) % files.length;
  }

  loadSong(files[target]);
  remember(0, true);
  playAudio();
}

$("next").onclick = () => {
  if (inRoom) socket.emit("next");
  else stepSolo(1);
};

$("previous").onclick = () => {
  if (inRoom) socket.emit("previous");
  else stepSolo(-1);
};

// Seek bar: "input" fires while dragging, "change" fires when released.
$("seek").addEventListener("input", () => {
  isSeeking = true;
  updateTimeDisplay();
});

function commitSeek() {
  isSeeking = false;
  if (!currentSong) return;
  const position = Number($("seek").value);
  remember(position, playback.isPlaying);
  seekTo(position);
  sendToRoom("seek", { position });
}

$("seek").addEventListener("change", commitSeek);

// Keyboard: the arrow keys jump 5 seconds. (The slider's own step is 0.1 s,
// which would take forever to cross a song.) Home, End, Page Up and Page
// Down still work the normal way.
const SEEK_KEY_SECONDS = 5;
const SEEK_KEYS = {
  ArrowLeft: -SEEK_KEY_SECONDS,
  ArrowDown: -SEEK_KEY_SECONDS,
  ArrowRight: SEEK_KEY_SECONDS,
  ArrowUp: SEEK_KEY_SECONDS,
};

$("seek").addEventListener("keydown", (e) => {
  const change = SEEK_KEYS[e.key];
  if (change === undefined || !currentSong) return;
  e.preventDefault();
  const seekBar = $("seek");
  const next = Number(seekBar.value) + change;
  seekBar.value = Math.min(Math.max(0, next), Number(seekBar.max));
  commitSeek();
  updateTimeDisplay();
});

// Volume is local on purpose: everyone controls their own
$("volume").addEventListener("input", () => {
  audio.volume = Number($("volume").value);
  if (audio.volume > 0) audio.muted = false; // moving the slider unmutes
});

// Mute button. If the slider is at 0, unmuting also raises it a little.
$("mute").onclick = () => {
  if (audio.muted || audio.volume === 0) {
    audio.muted = false;
    if (audio.volume === 0) {
      audio.volume = 0.5;
      $("volume").value = 0.5;
    }
  } else {
    audio.muted = true;
  }
};

audio.addEventListener("volumechange", () => {
  $("mute").textContent = audio.muted || audio.volume === 0 ? "Unmute" : "Mute";
  updateVolumeFill();
});

// "Tap to join the listening": the tap allows sound, then we jump to
// where the room is right now (not where it was when the overlay opened).
$("joinListening").onclick = () => {
  // This click is the user gesture the browser wants. Jump to where the room
  // is right now (expectedPosition) and start the sound.
  waitingForClick = false;
  hideOverlay();
  syncAudioToRoom();
};

// ---------- Audio element events ----------

audio.addEventListener("loadedmetadata", () => {
  $("seek").max = audio.duration;
  $("duration").textContent = formatTime(audio.duration);
  updateTimeDisplay();
  if (needsSync) syncAudioToRoom();
});

audio.addEventListener("timeupdate", updateTimeDisplay);

// If sound is really playing, the overlay is not needed anymore.
audio.addEventListener("playing", hideOverlay);

// Keep the play/pause label and the disabled state in step with the audio.
// (When a song ends, the browser fires "pause" first, so the label resets.)
["play", "pause", "emptied"].forEach((name) => {
  audio.addEventListener(name, updateControls);
});

// The song reached its end (B15). Every tab reports it, and the server only
// acts on the first report, so the queue never skips extra songs.
audio.addEventListener("ended", () => {
  if (inRoom && currentSong) {
    socket.emit("songEnded", { song: currentSong });
  }
});

// The file could not be loaded or decoded (B16): missing, deleted, broken.
// The browser reports a missing file and a damaged one the same way, so we
// ask the server (a HEAD request, nothing is downloaded) which one it is.
audio.addEventListener("error", async () => {
  if (!currentSong) return;
  const file = currentSong;
  const title = titleFromFile(file);
  const code = audio.error ? audio.error.code : 0;
  const networkProblem = !!audio.error && code === audio.error.MEDIA_ERR_NETWORK;

  let missing = false;
  try {
    const res = await fetch(songUrl(file), { method: "HEAD" });
    missing = res.status === 404;
  } catch {
    // We could not even reach the server, so the file is not "missing"
  }

  // The user may have picked another song while we were checking
  if (currentSong !== file) return;

  // Back to "nothing loaded", instead of a player stuck on a song that
  // cannot play (play button, seek bar and title all go back to idle)
  clearSong();

  if (missing) {
    showError(`"${title}" is missing from the server. It may have been deleted, so the song list was refreshed.`);
    loadSongs(); // the playlist...
    document.dispatchEvent(new Event("songsChanged")); // ...and the library card
  } else if (networkProblem) {
    showError(`The connection dropped while loading "${title}". Check your connection and try again.`);
  } else {
    showError(`We couldn't play "${title}". The file may be damaged, so try another one.`);
  }
});

// ---------- Playlist (the "library") ----------

function rowTime(file) {
  const seconds = durations.get(file);
  return Number.isFinite(seconds) ? formatTime(seconds) : "";
}

// Show a song's length in its playlist row (without redrawing the list)
function showRowDuration(file) {
  Array.from($("playlist").children).forEach((row) => {
    if (row.dataset.file !== file) return;
    const time = row.querySelector(".track-time");
    if (time) time.textContent = rowTime(file);
  });
}

// Ask the browser for the length of a song, once
function fetchDuration(file) {
  if (durations.has(file)) return;
  durations.set(file, null);
  const probe = new Audio();
  probe.preload = "metadata";
  probe.onloadedmetadata = () => {
    durations.set(file, probe.duration);
    showRowDuration(file);
  };
  probe.src = songUrl(file);
}

// Draw the playlist. The song that is loaded gets the honey row with the bee.
// We use textContent (not innerHTML) for the titles.
function renderPlaylist() {
  const list = $("playlist");

  // Choosing a song redraws the list. Remember where the keyboard focus was
  // (the "Play" or "+ Queue" button of a row) so it is not lost.
  const active = document.activeElement;
  const focusedRow = active && list.contains(active) ? active.closest(".track") : null;
  const focusedFile = focusedRow ? focusedRow.dataset.file : null;
  const focusedAction = focusedRow ? active.dataset.action || "" : "";

  list.innerHTML = "";

  if (library.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    if (songsLoading) {
      empty.append(makeSpinner(), "Loading songs...");
    } else if (songsFailed) {
      empty.textContent = "We couldn't load your songs. Check your connection and refresh the page.";
    } else if (!roomCodeNow()) {
      empty.textContent = "No songs yet.";
    } else {
      empty.textContent = "No songs yet. Add your mp3 files.";
    }
    list.appendChild(empty);
    return;
  }

  // The search box filters the list (by title, ignoring upper/lower case)
  const query = filterText.trim().toLowerCase();
  const shown = library.filter((song) => song.title.toLowerCase().includes(query));
  if (shown.length === 0) {
    const none = document.createElement("li");
    none.className = "empty";
    none.textContent = `No songs match "${filterText.trim()}"`;
    list.appendChild(none);
    return;
  }

  shown.forEach((song) => {
    const li = document.createElement("li");
    li.className = "track" + (song.file === currentSong ? " is-active" : "");
    li.dataset.file = song.file;

    const info = document.createElement("div");
    info.className = "info";
    const title = document.createElement("div");
    title.className = "track-title";
    title.textContent = song.title;
    info.append(title);

    const time = document.createElement("span");
    time.className = "track-time";
    time.textContent = rowTime(song.file);

    // Real buttons, so the keyboard and screen readers can reach them.
    // (Clicking anywhere else on the row with the mouse still plays it.)
    const playButton = document.createElement("button");
    playButton.className = "btn btn-sm";
    playButton.type = "button";
    playButton.textContent = "Play";
    playButton.dataset.action = "play";
    playButton.setAttribute("aria-label", `Play ${song.title}`);
    playButton.onclick = (e) => {
      e.stopPropagation();
      chooseSong(song.file);
    };

    const queueButton = document.createElement("button");
    queueButton.className = "btn btn-secondary btn-sm";
    queueButton.type = "button";
    queueButton.textContent = "+ Queue";
    queueButton.dataset.action = "queue";
    queueButton.setAttribute("aria-label", `Add to queue: ${song.title}`);
    queueButton.onclick = (e) => {
      e.stopPropagation();
      queueSong(song.file);
    };

    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(playButton, queueButton);

    li.append(info, time, actions);
    li.onclick = () => chooseSong(song.file);
    list.appendChild(li);
  });

  if (focusedFile) {
    const row = Array.from(list.children).find((r) => r.dataset.file === focusedFile);
    const target =
      row &&
      (row.querySelector(`button[data-action="${focusedAction}"]`) ||
        row.querySelector("button"));
    if (target) target.focus();
  }
}

// The search box above the list
$("songSearch").addEventListener("input", () => {
  filterText = $("songSearch").value;
  renderPlaylist();
});

// Fetch /songs and draw the playlist. We call this when we enter a room, and
// again after every upload. Outside a room there are no songs. Returns true
// if the list was loaded.
async function loadSongs() {
  const code = roomCodeNow();
  songsRoomCode = code;

  if (!code) {
    library = [];
    songsLoading = false;
    songsFailed = false;
    renderPlaylist();
    updateLcdTitle();
    return true;
  }

  songsLoading = true;
  renderPlaylist();
  try {
    const res = await fetch(API_URL + "/songs" + roomQuery());
    if (!res.ok) throw new Error("Bad response from /songs");
    const songs = await res.json();

    // We may have left or changed room while the answer was on its way
    if (code !== roomCodeNow()) return false;

    library = Array.isArray(songs) ? songs : [];
    songsLoading = false;
    songsFailed = false;
    renderPlaylist();
    library.forEach((song) => fetchDuration(song.file));
    updateLcdTitle(); // the LCD can now show the song number
    return true;
  } catch {
    songsLoading = false;
    songsFailed = true;
    renderPlaylist();
    showError("We couldn't load the song list. Check your connection and refresh the page.");
    return false;
  }
}

// ---------- Upload (.mp3 only) ----------

// The server accepts any field name, but "song" is what it was written for.
const UPLOAD_FIELD = "song";
const MAX_UPLOAD_MB = 20; // same limit as the server
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const dropZone = $("dropZone");
const songFile = $("songFile");
const uploadStatus = $("uploadStatus");
let uploading = false;

// On a touch screen there is nothing to drag files from: say "tap" instead
if (window.matchMedia("(pointer: coarse)").matches) {
  dropZone.textContent = "Tap to choose .mp3 files";
}

function setUploadStatus(text, kind) {
  uploadStatus.textContent = text;
  uploadStatus.className = "upload-status" + (kind ? " " + kind : "");
}

// Shown when someone tries to upload without being in a room
const NO_ROOM_UPLOAD_MESSAGE = "Create or join a room first. Songs belong to the room.";

// Once you are in a room that message is out of date, so remove it
function clearNoRoomUploadMessage() {
  if (uploadStatus.textContent === NO_ROOM_UPLOAD_MESSAGE) setUploadStatus("");
}

// Returns an error message, or "" if the file is fine.
// This only checks on the client; the server must check again.
function checkFile(file) {
  const isMp3Name = file.name.toLowerCase().endsWith(".mp3");
  const typeOk = file.type === "" || file.type === "audio/mpeg";
  if (!isMp3Name || !typeOk) return `${file.name}: only .mp3 files are allowed`;
  if (file.size === 0) return `${file.name}: the file is empty`;
  if (file.size > MAX_UPLOAD_BYTES) {
    return `${file.name}: too big (max ${MAX_UPLOAD_MB} MB)`;
  }
  return "";
}

// A short, friendly reason for a failed upload. The server's own text is
// never shown, only what we recognise in it.
async function uploadFailureReason(res) {
  let reason = "";
  try {
    const data = await res.json();
    reason = String(data.error || data.message || "");
  } catch {}
  if (res.status === 413 || /too large/i.test(reason)) {
    return `it's too big (max ${MAX_UPLOAD_MB} MB)`;
  }
  if (/only mp3/i.test(reason)) return "it isn't an MP3 file";
  if (res.status === 403) return "you're not in this room anymore, please rejoin and try again";
  if (res.status === 409 || /song limit/i.test(reason)) return "this room has reached its song limit";
  if (res.status === 429 || /too many uploads/i.test(reason)) return "too many uploads, wait a minute and try again";
  if (res.status === 507 || /storage is full/i.test(reason)) return "the server is out of space right now";
  if (res.status === 410 || /room has closed/i.test(reason)) return "the room has closed";
  if (res.status >= 500) return "the server had a problem, please try again";
  return "the upload didn't work, please try again";
}

async function uploadFiles(fileList) {
  if (uploading) return;

  if (!inRoom || !roomCodeNow()) {
    setUploadStatus(NO_ROOM_UPLOAD_MESSAGE, "error");
    return;
  }

  const good = [];
  const problems = [];
  Array.from(fileList).forEach((file) => {
    const error = checkFile(file);
    if (error) problems.push(error);
    else good.push(file);
  });

  if (good.length === 0) {
    setUploadStatus(problems[0] || "No file chosen", "error");
    return;
  }

  uploading = true;
  dropZone.classList.add("is-busy");
  let uploaded = 0;

  for (const file of good) {
    setUploadStatus(
      `Uploading... ${file.name} (${uploaded + 1}/${good.length})`,
    );
    try {
      const formData = new FormData();
      formData.append(UPLOAD_FIELD, file, file.name);
      const res = await fetch(API_URL + "/upload" + roomQuery(), { method: "POST", body: formData });
      if (res.ok) {
        uploaded++;
      } else {
        problems.push(`${file.name}: ${await uploadFailureReason(res)}`);
      }
    } catch {
      // fetch itself failed: no network, or the server is down
      problems.push(`${file.name}: couldn't reach the server, check your connection`);
    }
  }

  // Refresh the library so the new songs show up in the playlist
  if (uploaded > 0) {
    await loadSongs();
    // Tell the song library (library.js) to reload its list too
    document.dispatchEvent(new Event("songsChanged"));
  }
  uploading = false;
  dropZone.classList.remove("is-busy");

  if (problems.length > 0) {
    const done = uploaded > 0 ? `Uploaded ${uploaded}. ` : "";
    setUploadStatus(`${done}Failed: ${problems.join("; ")}`, "error");
  } else {
    setUploadStatus(
      `Uploaded ${uploaded} song${uploaded > 1 ? "s" : ""}!`,
      "ok",
    );
  }
}

// The "Add songs" button and the drop zone (click or keyboard) open the picker
$("addBtn").onclick = () => songFile.click();
dropZone.addEventListener("click", () => songFile.click());
dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    songFile.click();
  }
});

songFile.addEventListener("change", () => {
  const files = Array.from(songFile.files);
  songFile.value = ""; // so choosing the same file again still fires "change"
  uploadFiles(files);
});

// Drag and drop
["dragenter", "dragover"].forEach((name) => {
  dropZone.addEventListener(name, (e) => {
    e.preventDefault();
    dropZone.classList.add("is-drag");
  });
});
["dragleave", "drop"].forEach((name) => {
  dropZone.addEventListener(name, (e) => {
    e.preventDefault();
    dropZone.classList.remove("is-drag");
  });
});
dropZone.addEventListener("drop", (e) => uploadFiles(e.dataTransfer.files));

// A file dropped outside the zone should not make the browser open it
["dragover", "drop"].forEach((name) => {
  window.addEventListener(name, (e) => e.preventDefault());
});

// ---------- Only show the player while you are in a room ----------
// The player, playlist and queue are hidden on the first screen (Create Room /
// Join Room). They appear as soon as the room card appears, and go away again
// when you leave. We watch the room card's "hidden" attribute, so this works
// no matter which file shows or hides it.
const roomLayout = document.querySelector(".layout");

function syncLayoutWithRoom() {
  const inARoom = !$("roomInfo").hidden;
  roomLayout.style.display = inARoom ? "" : "none";
  if (!inARoom) audio.pause(); // no hidden music playing after leaving
}

new MutationObserver(syncLayoutWithRoom).observe($("roomInfo"), {
  attributes: true,
  attributeFilter: ["hidden"],
});
syncLayoutWithRoom();

// ---------- Start ----------

updateControls(); // everything starts disabled until a song is loaded
updateNowPlaying(); // shows "Nothing playing" until a song is loaded
updateSeekFill();
updateVolumeFill();
loadSongs();

// If the address has ?room=AB12, fill in the code and wait for a nickname
readInviteFromUrl();

// ---------- Extra features, each in its own file ----------
// Each file loads on its own, so they cannot conflict with other work.
// (library.js is no longer loaded: its list, search and buttons now live in
// the Playlist card, so there is only one song list.)
["roominfo.js", "visualizer.js"].forEach((file) => {
  const script = document.createElement("script");
  script.src = file;
  document.body.appendChild(script);
});