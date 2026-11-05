/**
 * @file app.js
 * @description Frontend logic for Wesync, a shared music-listening app. Handles
 * the landing page (create/join a room, nickname, password, invite links), the
 * Socket.IO connection, the audio player and its controls (play, pause, seek,
 * volume, next/previous), playback sync with everyone in the room, the song
 * queue with drag-and-drop reordering, the playlist and search, MP3 uploads,
 * toast notifications, and the connection status.
 * @location client\app.js
 */

const API_URL = window.WESYNC_API_URL || "";
const socket = io(API_URL || undefined);
const $ = (id) => document.getElementById(id);
const audio = $("audio");

const DRIFT_LIMIT_SECONDS = 0.3;

const ERROR_VISIBLE_MS = 6000;

const ROOM_CODE_PATTERN = /^[A-Z0-9]{4}$/;

let inRoom = false;
let currentSong = null;
let pickedBy = null;
let isSeeking = false;

let playback = { position: 0, isPlaying: false, receivedAt: performance.now() };
let needsSync = false;
let waitingForClick = false;

let submittedNickname = "";
let submittedPassword = "";
let lastRoom = null;
let rejoining = false;
let pendingAction = null;

let messageTimer = null;

let library = [];
let songsLoading = true;
let songsFailed = false;
const durations = new Map();
let filterText = "";
let songsRoomCode = null;

function roomCodeNow() {
  return lastRoom ? lastRoom.code : null;
}

function songUrl(file) {
  return API_URL + "/music/" + roomCodeNow() + "/" + encodeURIComponent(file);
}

function roomQuery() {
  const code = roomCodeNow();
  if (!code || !socket.id) return "";
  return `?room=${encodeURIComponent(code)}&sid=${encodeURIComponent(socket.id)}`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function lcdFormat(seconds) {
  if (!Number.isFinite(seconds)) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function titleFromFile(file) {
  return file
    .replace(/\.[^.]+$/, "")
    .replace(/^\d{10,}-/, "")
    .replace(/-/g, " ");
}

function showMessage(text) {
  clearTimeout(messageTimer);
  $("message").textContent = text;
}

function showError(text) {
  showMessage(text);
  messageTimer = setTimeout(() => {
    if ($("message").textContent === text) showMessage("");
  }, ERROR_VISIBLE_MS);
}

function makeSpinner() {
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");
  return spinner;
}

function showLoading(text) {
  clearTimeout(messageTimer);
  const box = $("message");
  box.textContent = "";
  box.append(makeSpinner(), text);
}

const GENERIC_ERROR = "Something went wrong. Please try again.";

function friendlyError(raw) {
  const text = String(raw || "").trim();
  const rules = [
    [
      /^Room (\w+) not found/i,
      (m) =>
        `We couldn't find room ${m[1].toUpperCase()}. Check the code and try again.`,
    ],
    [
      /nickname.*already taken/i,
      () =>
        "Someone in this room already uses that nickname. Please pick another one.",
    ],
    [/^Please enter a nickname/i, () => "Please enter a nickname."],
    [
      /needs a password/i,
      () => "This room is protected. Please enter its password.",
    ],
    [
      /too many wrong passwords/i,
      () => "Too many wrong passwords. Please wait a minute and try again.",
    ],
    [/wrong password/i, () => "That password isn't right. Please try again."],
    [/room code has 4/i, () => "A room code has 4 letters or numbers."],
    [
      /not in a room/i,
      () => "You're not in a room right now. Create or join one first.",
    ],
    [/^Pick a song first/i, () => "Pick a song first."],
    [
      /^Song not found/i,
      () => "We couldn't find that song. It may have been deleted.",
    ],
    [/queue is full/i, () => "The queue is full. Remove a song to make room."],
    [
      /not in the queue/i,
      () => "That song was already removed from the queue.",
    ],
    [/queue is empty/i, () => "The queue is empty. Add a song first."],
    [/no previous song/i, () => "There's no previous song to go back to."],
    [
      /went wrong on the server/i,
      () => "The server had a problem. Please try again.",
    ],
  ];
  for (const [pattern, make] of rules) {
    const match = text.match(pattern);
    if (match) return make(match);
  }
  return GENERIC_ERROR;
}

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
    showError(
      "The server is taking too long to answer. Please try again in a moment.",
    );
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

let focusBeforeOverlay = null;

function showOverlay() {
  if (!$("joinOverlay").hidden) return;
  focusBeforeOverlay = document.activeElement;
  $("joinOverlay").hidden = false;
  document.querySelector("main").inert = true;
  $("joinListening").focus();
}

function hideOverlay() {
  if ($("joinOverlay").hidden) return;
  $("joinOverlay").hidden = true;
  document.querySelector("main").inert = false;

  const back = focusBeforeOverlay;
  focusBeforeOverlay = null;
  if (back && back !== document.body) back.focus();
  if (!document.activeElement || document.activeElement === document.body) {
    if (!$("playPause").disabled) $("playPause").focus();
  }
}

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

function showLandingError(text) {
  if (/password/i.test(text)) {
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

function showLanding() {
  const hadFocus = $("roomInfo").contains(document.activeElement);
  $("roomSection").hidden = false;
  $("roomInfo").hidden = true;
  $("memberPanel").hidden = true;
  if (hadFocus) $("nickname").focus();
}

function showRoomView() {
  const hadFocus = $("roomSection").contains(document.activeElement);
  $("roomSection").hidden = true;
  $("passwordRow").hidden = true;
  $("roomPassword").value = "";
  $("inviteHint").hidden = true;
  $("roomInfo").hidden = false;
  $("memberPanel").hidden = false;
  if (hadFocus) {
    const first = $("roomInfo").querySelector("button");
    if (first) first.focus();
  }
}

function updateUrl(code) {
  const wanted = "?room=" + code;
  if (location.search !== wanted) history.replaceState(null, "", wanted);
}

function clearUrl() {
  history.replaceState(null, "", location.pathname);
}

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
  $("volume").setAttribute("aria-valuetext", `${Math.round(volume * 100)}%`);
}

function updateTimeDisplay() {
  const seekBar = $("seek");
  if (!isSeeking) seekBar.value = audio.currentTime;
  const shown = isSeeking ? Number(seekBar.value) : audio.currentTime;
  $("currentTime").textContent = formatTime(shown);
  $("lcdTime").textContent = lcdFormat(shown);
  seekBar.setAttribute(
    "aria-valuetext",
    `${formatTime(shown)} of ${formatTime(audio.duration)}`,
  );
  updateSeekFill();
}

function updateLcdTitle() {
  if (!currentSong) {
    $("lcdTrack").textContent = "INSERT DISC";
  } else {
    const index = library.findIndex((song) => song.file === currentSong);
    const number = index >= 0 ? String(index + 1).padStart(2, "0") : "";
    $("lcdTrack").textContent = number ? `TRACK ${number}` : "PLAYING";
  }
  updateNowPlaying();
}

function updateNowPlaying() {
  $("npTitle").textContent = currentSong
    ? titleFromFile(currentSong)
    : "Nothing playing";

  const picker = $("npPicker");
  if (inRoom && currentSong && pickedBy) {
    picker.textContent = `Picked by ${pickedBy}`;
    picker.hidden = false;
  } else {
    picker.textContent = "";
    picker.hidden = true;
  }
}

function updateControls() {
  const hasSong = !!currentSong;
  $("playPause").disabled = !hasSong;
  $("seek").disabled = !hasSong;
  $("next").disabled = !hasSong && !inRoom;
  $("previous").disabled = !hasSong && !inRoom;
  const playing = hasSong && !audio.paused;
  $("playPause").textContent = playing ? "II" : "▶";
  $("playPause").setAttribute("aria-label", playing ? "Pause" : "Play");
}

let draggedQueueId = null;

function clearDropMarks() {
  $("queueList")
    .querySelectorAll(".drop-before, .drop-after, .is-dragging")
    .forEach((row) =>
      row.classList.remove("drop-before", "drop-after", "is-dragging"),
    );
}

function makeQueueRowDraggable(li, item, index, queue) {
  li.draggable = true;

  li.addEventListener("dragstart", (e) => {
    draggedQueueId = item.id;
    li.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(item.id));
  });

  li.addEventListener("dragend", () => {
    draggedQueueId = null;
    clearDropMarks();
  });

  li.addEventListener("dragover", (e) => {
    if (draggedQueueId === null) return;
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
    if (from !== -1 && from < to) to--;

    if (from !== -1 && from !== to) {
      socket.emit("reorderQueue", { id: draggedQueueId, toIndex: to });
    }
    draggedQueueId = null;
    clearDropMarks();
  });
}

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

let lastQueue = [];

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
    target =
      sameRow.querySelector(
        `button[data-action="${info.action}"]:not(:disabled)`,
      ) || sameRow.querySelector("button:not(:disabled)");
  } else if (rows.length > 0) {
    const next = rows[Math.min(info.index, rows.length - 1)];
    target = next.querySelector('button[data-action="remove"]');
  }
  if (!target && !$("playPause").disabled) target = $("playPause");
  if (target) target.focus();
}

function renderQueue(queue = lastQueue) {
  lastQueue = Array.isArray(queue) ? queue : [];
  const items = inRoom ? lastQueue : [];

  const list = $("queueList");
  const focused = queueFocusInfo(list);
  list.innerHTML = "";

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
      makeMoveButton(
        "\u25B2",
        `Move ${item.title} up`,
        index === 0,
        index - 1,
        item.id,
        "up",
      ),
      makeMoveButton(
        "\u25BC",
        `Move ${item.title} down`,
        index === items.length - 1,
        index + 1,
        item.id,
        "down",
      ),
    );

    li.appendChild(title);
    li.appendChild(move);
    li.appendChild(removeButton);
    list.appendChild(li);
  });

  restoreQueueFocus(list, focused);
}

function remember(position, isPlaying) {
  playback = { position, isPlaying, receivedAt: performance.now() };
}

function expectedPosition() {
  if (!playback.isPlaying) return playback.position;
  return playback.position + (performance.now() - playback.receivedAt) / 1000;
}

function resetPlayerDisplay() {
  isSeeking = false;
  const seekBar = $("seek");
  seekBar.max = 0;
  seekBar.value = 0;
  seekBar.setAttribute("aria-valuetext", "0:00 of 0:00");
  $("currentTime").textContent = "0:00";
  $("duration").textContent = "0:00";
  $("lcdTime").textContent = "00:00";
  updateSeekFill();
}

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
  renderQueue();
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
  renderQueue();
}

function seekTo(seconds) {
  const max = Number.isFinite(audio.duration) ? audio.duration : seconds;
  audio.currentTime = Math.min(Math.max(0, seconds), max);
}

function playAudio() {
  if (waitingForClick) {
    showOverlay();
    return;
  }
  audio.play().catch((err) => {
    if (err.name === "NotAllowedError") {
      showOverlay();
    }
  });
}

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

function applyState(state, justJoined = false) {
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
    pickedBy = state.pickedBy || null;
    updateNowPlaying();
  }
  syncAudioToRoom();
}

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

function sendToRoom(event, data) {
  if (isRemoteUpdate || !inRoom) return;
  socket.emit(event, data);
}

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
  toast.textContent = text;
  box.appendChild(toast);
  while (box.children.length > MAX_TOASTS) box.firstChild.remove();
  setTimeout(() => toast.remove(), TOAST_VISIBLE_MS);
}

let knownMembers = [];

function announceMembers(members) {
  members
    .filter(
      (name) => !knownMembers.includes(name) && name !== submittedNickname,
    )
    .forEach((name) => showToast(`${name} joined`));
  knownMembers
    .filter((name) => !members.includes(name) && name !== submittedNickname)
    .forEach((name) => showToast(`${name} left`));
  knownMembers = [...members];
}

function shortTitle(title) {
  const text = String(title || "");
  return text.length > 30 ? text.slice(0, 29) + "…" : text;
}

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

let seekToastTimer = null;
let seekFrom = 0;

function toastSeek(by, position, before) {
  if (!by) return;
  if (seekToastTimer === null) seekFrom = before;
  clearTimeout(seekToastTimer);
  seekToastTimer = setTimeout(() => {
    seekToastTimer = null;
    const time = formatTime(position);
    if (position > seekFrom + 0.5)
      showToast(`${by} forwarded the song to ${time}`);
    else if (position < seekFrom - 0.5)
      showToast(`${by} rewound the song to ${time}`);
    else showToast(`${by} jumped to ${time}`);
  }, 600);
}

let everConnected = false;

function setConnection(state) {
  const label = $("status");
  label.textContent = state;
  label.dataset.state = state;
}

socket.on("connect", () => {
  everConnected = true;
  setConnection("connected");

  if (lastRoom) {
    rejoining = true;
    showLoading("Reconnecting to your room...");
    socket.emit("joinRoom", lastRoom);
  } else {
    showMessage("");
  }
});

socket.on("disconnect", (reason) => {
  const final =
    reason === "io client disconnect" || reason === "io server disconnect";
  setConnection(final ? "offline" : "reconnecting");
  inRoom = false;
  waitingForClick = false;
  hideOverlay();
  audio.pause();
  updateControls();
  updateNowPlaying();
  stopRoomLoading();
  if (lastRoom) {
    showLoading("Lost connection to the server. Trying to reconnect...");
  } else {
    showLanding();
    showMessage(
      "You're disconnected from the server. Wait for it to reconnect, then create or join a room.",
    );
  }
});

socket.on("connect_error", () => {
  setConnection(everConnected ? "reconnecting" : "offline");
  if (!everConnected) {
    showMessage(
      "We can't reach the server right now. Check your connection. We'll keep trying.",
    );
  }
});

socket.on("roomState", (state) => {
  const justJoined = pendingAction === "join";
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
  if (state.code !== songsRoomCode || songsFailed) loadSongs();
  knownMembers = [...state.members];
  applyRemote(() => applyState(state, justJoined));
});

socket.on("membersUpdate", (data) => {
  announceMembers(data.members);
  showMembers(data.members, data.host);
});

socket.on("queueUpdate", ({ queue }) => {
  renderQueue(queue);
});

socket.on("songsUpdate", (info) => {
  loadSongs();
  document.dispatchEvent(new Event("songsChanged"));
  if (info && info.by && info.by !== submittedNickname) {
    showToast(`${info.by} added "${shortTitle(info.title)}" to the playlist`);
  }
});

document.addEventListener("roomLeft", () => loadSongs());

socket.on("roomError", (err) => {
  stopRoomLoading();
  const text = friendlyError(err && err.message);

  if (rejoining) {
    rejoining = false;
    lastRoom = null;
    loadSongs();
    clearUrl();
    showLanding();
    showError(
      "We couldn't take you back to your room. It may have closed, so please create or join a room again.",
    );
    return;
  }

  if (!inRoom && pendingAction) {
    showLandingError(text);
    pendingAction = null;
    return;
  }

  showError(text);
});

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
  const before = expectedPosition();
  applyRemote(() => {
    remember(position, playback.isPlaying);
    syncAudioToRoom();
  });
  toastSeek(by, position, before);
});

socket.on("changeSong", ({ song, by }) => {
  applyRemote(() => {
    loadSong(song, by || null);
    remember(0, false);
    syncAudioToRoom();
  });
  if (by) showToast(`${by} picked "${shortTitle(titleFromFile(song))}"`);
});

function handleSyncTick({ position, isPlaying }) {
  if (!inRoom || !currentSong) return;

  remember(position, isPlaying);

  if (audio.readyState < 1 || isSeeking || audio.seeking || audio.ended) return;

  if (!isPlaying) {
    if (!audio.paused) audio.pause();
  } else if (audio.paused) {
    playAudio();
  }

  const drift = audio.currentTime - position;
  if (Math.abs(drift) > DRIFT_LIMIT_SECONDS) {
    seekTo(position);
  }
}

socket.on("syncTick", (tick) => applyRemote(() => handleSyncTick(tick)));

socket.io.on("reconnect_attempt", () => setConnection("reconnecting"));
socket.io.on("reconnect_failed", () => setConnection("offline"));

window.addEventListener("offline", () => setConnection("offline"));
window.addEventListener("online", () => {
  if (!socket.connected) setConnection("reconnecting");
});

function readNickname() {
  const nickname = $("nickname").value.trim();
  if (!nickname) {
    showFieldError("nickname", "Please enter a nickname");
    return "";
  }
  return nickname;
}

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

$("nickname").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if ($("code").value.trim()) startJoin();
  else startCreate();
});

$("code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") startJoin();
});

$("roomPassword").addEventListener("keydown", (e) => {
  if (e.key === "Enter") startJoin();
});

$("roomPassword").addEventListener("input", () =>
  clearFieldError("roomPassword"),
);
$("nickname").addEventListener("input", () => clearFieldError("nickname"));
$("code").addEventListener("input", () => {
  $("code").value = $("code").value.toUpperCase();
  clearFieldError("code");
});

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

function chooseSong(file) {
  loadSong(file, inRoom ? submittedNickname : null);
  remember(0, true);
  playAudio();
  sendToRoom("changeSong", { song: file });
  sendToRoom("play", { position: 0 });
}

function queueSong(file) {
  if (!inRoom) return showError("Join a room to use the queue");
  socket.emit("addToQueue", { song: file });
}

$("playPause").onclick = () => {
  if (!currentSong) return showError("Pick a song first");
  if (audio.paused) {
    if (audio.ended) seekTo(0);
    remember(audio.currentTime, true);
    playAudio();
    sendToRoom("play", { position: audio.currentTime });
  } else {
    audio.pause();
    remember(audio.currentTime, false);
    sendToRoom("pause", { position: audio.currentTime });
  }
};

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

$("volume").addEventListener("input", () => {
  audio.volume = Number($("volume").value);
  if (audio.volume > 0) audio.muted = false;
});

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

$("joinListening").onclick = () => {
  waitingForClick = false;
  hideOverlay();
  syncAudioToRoom();
};

audio.addEventListener("loadedmetadata", () => {
  $("seek").max = audio.duration;
  $("duration").textContent = formatTime(audio.duration);
  updateTimeDisplay();
  if (needsSync) syncAudioToRoom();
});

audio.addEventListener("timeupdate", updateTimeDisplay);

audio.addEventListener("playing", hideOverlay);

["play", "pause", "emptied"].forEach((name) => {
  audio.addEventListener(name, updateControls);
});

audio.addEventListener("ended", () => {
  if (inRoom && currentSong) {
    socket.emit("songEnded", { song: currentSong });
  }
});

audio.addEventListener("error", async () => {
  if (!currentSong) return;
  const file = currentSong;
  const title = titleFromFile(file);
  const code = audio.error ? audio.error.code : 0;
  const networkProblem =
    !!audio.error && code === audio.error.MEDIA_ERR_NETWORK;

  let missing = false;
  try {
    const res = await fetch(songUrl(file), { method: "HEAD" });
    missing = res.status === 404;
  } catch {}

  if (currentSong !== file) return;

  clearSong();

  if (missing) {
    showError(
      `"${title}" is missing from the server. It may have been deleted, so the song list was refreshed.`,
    );
    loadSongs();
    document.dispatchEvent(new Event("songsChanged"));
  } else if (networkProblem) {
    showError(
      `The connection dropped while loading "${title}". Check your connection and try again.`,
    );
  } else {
    showError(
      `We couldn't play "${title}". The file may be damaged, so try another one.`,
    );
  }
});

function rowTime(file) {
  const seconds = durations.get(file);
  return Number.isFinite(seconds) ? formatTime(seconds) : "";
}

function showRowDuration(file) {
  Array.from($("playlist").children).forEach((row) => {
    if (row.dataset.file !== file) return;
    const time = row.querySelector(".track-time");
    if (time) time.textContent = rowTime(file);
  });
}

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

function renderPlaylist() {
  const list = $("playlist");

  const active = document.activeElement;
  const focusedRow =
    active && list.contains(active) ? active.closest(".track") : null;
  const focusedFile = focusedRow ? focusedRow.dataset.file : null;
  const focusedAction = focusedRow ? active.dataset.action || "" : "";

  list.innerHTML = "";

  if (library.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    if (songsLoading) {
      empty.append(makeSpinner(), "Loading songs...");
    } else if (songsFailed) {
      empty.textContent =
        "We couldn't load your songs. Check your connection and refresh the page.";
    } else if (!roomCodeNow()) {
      empty.textContent = "No songs yet.";
    } else {
      empty.textContent = "No songs yet. Add your mp3 files.";
    }
    list.appendChild(empty);
    return;
  }

  const query = filterText.trim().toLowerCase();
  const shown = library.filter((song) =>
    song.title.toLowerCase().includes(query),
  );
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
    const row = Array.from(list.children).find(
      (r) => r.dataset.file === focusedFile,
    );
    const target =
      row &&
      (row.querySelector(`button[data-action="${focusedAction}"]`) ||
        row.querySelector("button"));
    if (target) target.focus();
  }
}

$("songSearch").addEventListener("input", () => {
  filterText = $("songSearch").value;
  renderPlaylist();
});

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

    if (code !== roomCodeNow()) return false;

    library = Array.isArray(songs) ? songs : [];
    songsLoading = false;
    songsFailed = false;
    renderPlaylist();
    library.forEach((song) => fetchDuration(song.file));
    updateLcdTitle();
    return true;
  } catch {
    songsLoading = false;
    songsFailed = true;
    renderPlaylist();
    showError(
      "We couldn't load the song list. Check your connection and refresh the page.",
    );
    return false;
  }
}

const UPLOAD_FIELD = "song";
const MAX_UPLOAD_MB = 20;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const dropZone = $("dropZone");
const songFile = $("songFile");
const uploadStatus = $("uploadStatus");
let uploading = false;

if (window.matchMedia("(pointer: coarse)").matches) {
  dropZone.textContent = "Tap to choose .mp3 files";
}

function setUploadStatus(text, kind) {
  uploadStatus.textContent = text;
  uploadStatus.className = "upload-status" + (kind ? " " + kind : "");
}

const NO_ROOM_UPLOAD_MESSAGE =
  "Create or join a room first. Songs belong to the room.";

function clearNoRoomUploadMessage() {
  if (uploadStatus.textContent === NO_ROOM_UPLOAD_MESSAGE) setUploadStatus("");
}

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
  if (res.status === 403)
    return "you're not in this room anymore, please rejoin and try again";
  if (res.status === 409 || /song limit/i.test(reason))
    return "this room has reached its song limit";
  if (res.status === 429 || /too many uploads/i.test(reason))
    return "too many uploads, wait a minute and try again";
  if (res.status === 507 || /storage is full/i.test(reason))
    return "the server is out of space right now";
  if (res.status === 410 || /room has closed/i.test(reason))
    return "the room has closed";
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
      const res = await fetch(API_URL + "/upload" + roomQuery(), {
        method: "POST",
        body: formData,
      });
      if (res.ok) {
        uploaded++;
      } else {
        problems.push(`${file.name}: ${await uploadFailureReason(res)}`);
      }
    } catch {
      problems.push(
        `${file.name}: couldn't reach the server, check your connection`,
      );
    }
  }

  if (uploaded > 0) {
    await loadSongs();
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
  songFile.value = "";
  uploadFiles(files);
});

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

["dragover", "drop"].forEach((name) => {
  window.addEventListener(name, (e) => e.preventDefault());
});

const roomLayout = document.querySelector(".layout");

function syncLayoutWithRoom() {
  const inARoom = !$("roomInfo").hidden;
  roomLayout.style.display = inARoom ? "" : "none";
  if (!inARoom) audio.pause();
}

new MutationObserver(syncLayoutWithRoom).observe($("roomInfo"), {
  attributes: true,
  attributeFilter: ["hidden"],
});
syncLayoutWithRoom();

updateControls();
updateNowPlaying();
updateSeekFill();
updateVolumeFill();
loadSongs();

readInviteFromUrl();

["roominfo.js", "visualizer.js"].forEach((file) => {
  const script = document.createElement("script");
  script.src = file;
  document.body.appendChild(script);
});
