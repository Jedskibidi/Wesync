const socket = io();
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
let lastRoom = null; // { code, nickname } of the room we are in
let rejoining = false; // true while we wait for the server to take us back
let pendingAction = null; // "create" or "join" while we wait for the server

let messageTimer = null;

// The song library from GET /songs: [{ file, title }, ...], newest first
let library = [];
// Song lengths in seconds, by file name (null while we are still loading it)
const durations = new Map();

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

function showOverlay() {
  $("joinOverlay").hidden = false;
}

function hideOverlay() {
  $("joinOverlay").hidden = true;
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
}

// An error from the server while we are on the first screen:
// put it under the field it is about.
function showLandingError(text) {
  if (/nickname/i.test(text)) {
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
  $("roomSection").hidden = false;
  $("roomInfo").hidden = true;
  $("memberPanel").hidden = true;
}

// In a room: show the room card (member count, copy link, leave)
function showRoomView() {
  $("roomSection").hidden = true;
  $("inviteHint").hidden = true;
  $("roomInfo").hidden = false;
  $("memberPanel").hidden = false;
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
  setFill($("volume"), Number($("volume").value) * 100);
}

// The current time under the seek bar and on the LCD, and the seek thumb
function updateTimeDisplay() {
  const seekBar = $("seek");
  if (!isSeeking) seekBar.value = audio.currentTime;
  const shown = isSeeking ? Number(seekBar.value) : audio.currentTime;
  $("currentTime").textContent = formatTime(shown);
  $("lcdTime").textContent = lcdFormat(shown);
  updateSeekFill();
}

// "01 Song title" (the number is the song's place in the playlist)
function updateLcdTitle() {
  if (!currentSong) {
    $("lcdTrack").textContent = "INSERT DISC";
  } else {
    const index = library.findIndex((song) => song.file === currentSong);
    const number = index >= 0 ? String(index + 1).padStart(2, "0") + " " : "";
    $("lcdTrack").textContent = number + titleFromFile(currentSong);
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

// Draw the queue list. "queue" looks like [{ id, file, title }, ...].
// We use textContent (not innerHTML) so a song title can never inject HTML.
//
// The last queue we were given is kept, so the list can be redrawn when the
// playing song changes (loadSong / clearSong call renderQueue() with no
// argument). The song that is playing now is drawn as the first row.
let lastQueue = [];

function renderQueue(queue = lastQueue) {
  lastQueue = Array.isArray(queue) ? queue : [];
  const items = inRoom ? lastQueue : []; // no room, no queue

  const list = $("queueList");
  list.innerHTML = "";

  // The song that is playing now: highlighted, not draggable, no Remove
  if (inRoom && currentSong) {
    const nowRow = document.createElement("li");
    nowRow.className = "track is-active";
    nowRow.setAttribute("aria-current", "true");

    const nowTitle = document.createElement("span");
    nowTitle.className = "track-title";
    nowTitle.textContent = titleFromFile(currentSong);

    nowRow.append(nowTitle, makeTag("Now playing", "tag-host"));
    list.appendChild(nowRow);
  }

  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Queue is empty";
    list.appendChild(empty);
    return;
  }

  items.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "track";
    makeQueueRowDraggable(li, item, index, items);

    const title = document.createElement("span");
    title.className = "track-title";
    title.textContent = item.title;

    const removeButton = document.createElement("button");
    removeButton.className = "btn btn-secondary btn-sm";
    removeButton.textContent = "Remove";
    removeButton.onclick = () => {
      socket.emit("removeFromQueue", { id: item.id });
    };

    li.appendChild(title);
    li.appendChild(removeButton);
    list.appendChild(li);
  });
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

// "by" is the nickname of whoever picked the song (null when playing alone
// or when we do not know).
function loadSong(file, by = null) {
  currentSong = file;
  pickedBy = by;
  audio.src = "/music/" + encodeURIComponent(file);
  audio.load();
  audio.pause();
  $("seek").value = 0;
  $("currentTime").textContent = "0:00";
  $("duration").textContent = "0:00";
  $("lcdTime").textContent = "00:00";
  updateSeekFill();
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
  $("seek").value = 0;
  $("currentTime").textContent = "0:00";
  $("duration").textContent = "0:00";
  $("lcdTime").textContent = "00:00";
  updateSeekFill();
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
    } else if (err.name === "NotSupportedError") {
      showError("This song can't be played in your browser.");
    }
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
    showMessage("Reconnecting to your room...");
    socket.emit("joinRoom", lastRoom);
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
  if (lastRoom) {
    // We will try to rejoin automatically when the connection returns
    showMessage("Connection lost. Reconnecting...");
  } else {
    showLanding();
    showMessage("Disconnected. Create or join a room again.");
  }
});

// The server could not be reached at all
socket.on("connect_error", () => {
  // Never connected: nothing to reconnect to yet. Connected before: retrying.
  setConnection(everConnected ? "reconnecting" : "offline");
});

socket.on("roomState", (state) => {
  const justJoined = pendingAction === "join"; // the user pressed Join Room
  showMessage("");
  clearFieldErrors();
  rejoining = false;
  pendingAction = null;
  lastRoom = { code: state.code, nickname: submittedNickname };
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

socket.on("roomError", (err) => {
  if (rejoining) {
    // The server did not take us back (for example the room is gone)
    rejoining = false;
    lastRoom = null;
    clearUrl();
    showLanding();
    showError(`Could not rejoin your room. ${err.message}`);
    return;
  }

  // On the first screen, show the error under the field it is about
  if (!inRoom && pendingAction) {
    showLandingError(err.message);
    pendingAction = null;
    return;
  }

  showError(err.message);
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

socket.on("seek", ({ position }) => {
  applyRemote(() => {
    remember(position, playback.isPlaying);
    syncAudioToRoom();
  });
});

// "by" is the nickname of the person who picked the song (if the server sends it)
socket.on("changeSong", ({ song, by }) => {
  applyRemote(() => {
    loadSong(song, by || null);
    remember(0, false);
    syncAudioToRoom(); // the file is still loading, so this waits for metadata
  });
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
  socket.emit("createRoom", { nickname });
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
  socket.emit("joinRoom", { code, nickname });
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

// Typing in a field removes its error
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

$("seek").addEventListener("change", () => {
  isSeeking = false;
  if (!currentSong) return;
  const position = Number($("seek").value);
  remember(position, playback.isPlaying);
  seekTo(position);
  sendToRoom("seek", { position });
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

// The file could not be loaded or decoded (B16): missing, deleted, broken
audio.addEventListener("error", () => {
  if (!currentSong) return;
  showError("This song could not be loaded. Try another one.");
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
  probe.src = "/music/" + encodeURIComponent(file);
}

// Draw the playlist. The song that is loaded gets the honey row with the bee.
// We use textContent (not innerHTML) for the titles.
function renderPlaylist() {
  const list = $("playlist");
  list.innerHTML = "";

  if (library.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No songs yet. Add your mp3 files.";
    list.appendChild(empty);
    return;
  }

  library.forEach((song) => {
    const li = document.createElement("li");
    li.className = "track" + (song.file === currentSong ? " is-active" : "");
    li.dataset.file = song.file;
    li.tabIndex = 0;

    const info = document.createElement("div");
    info.className = "info";
    const title = document.createElement("div");
    title.className = "track-title";
    title.textContent = song.title;
    const artist = document.createElement("div");
    artist.className = "track-artist";
    artist.textContent = "Your music";
    info.append(title, artist);

    const time = document.createElement("span");
    time.className = "track-time";
    time.textContent = rowTime(song.file);

    const queueButton = document.createElement("button");
    queueButton.className = "btn btn-secondary btn-sm";
    queueButton.textContent = "+ Queue";
    queueButton.setAttribute("aria-label", "Add to queue");
    queueButton.onclick = (e) => {
      e.stopPropagation();
      queueSong(song.file);
    };

    li.append(info, time, queueButton);
    li.onclick = () => chooseSong(song.file);
    li.onkeydown = (e) => {
      if (e.target === li && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        chooseSong(song.file);
      }
    };
    list.appendChild(li);
  });
}

// Fetch /songs and draw the playlist. We call this on page load and again
// after every successful upload. Returns true if the list was loaded.
async function loadSongs() {
  try {
    const res = await fetch("/songs");
    if (!res.ok) throw new Error("Bad response from /songs");
    const songs = await res.json();

    library = Array.isArray(songs) ? songs : [];
    renderPlaylist();
    library.forEach((song) => fetchDuration(song.file));
    updateLcdTitle(); // the LCD can now show the song number
    return true;
  } catch {
    showError("Could not load the song list. Try refreshing the page.");
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

function setUploadStatus(text, kind) {
  uploadStatus.textContent = text;
  uploadStatus.className = "upload-status" + (kind ? " " + kind : "");
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

async function uploadFiles(fileList) {
  if (uploading) return;

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
      const res = await fetch("/upload", { method: "POST", body: formData });
      if (!res.ok) {
        // Show the server's own reason if it sent one (short text or {error|message})
        let reason = "";
        try {
          const text = (await res.text()).trim();
          try {
            const data = JSON.parse(text);
            reason = data.error || data.message || "";
          } catch {
            reason = text;
          }
        } catch {}
        throw new Error(
          `server said ${res.status}${reason ? ": " + reason.slice(0, 120) : ""}`,
        );
      }
      uploaded++;
    } catch (err) {
      problems.push(`${file.name}: ${err.message}`);
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
["library.js", "roominfo.js"].forEach((file) => {
  const script = document.createElement("script");
  script.src = file;
  document.body.appendChild(script);
});