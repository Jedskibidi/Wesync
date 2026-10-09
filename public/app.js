// Wesync client: Socket.IO + audio player + sync + queue + error handling.
//
// IDs this file needs (keep them in index.html):
//   status, message, nickname, create, code, join, room, members,
//   player, songSelect, setSong, addToQueue, queueList, audio,
//   previous, play, pause, next,
//   currentTime, seek, duration, volume, joinOverlay, joinListening,
//   dropZone, songFile, uploadStatus
//
// HTTP routes used: GET /songs, POST /upload (FormData field "file")
//
// Socket.IO events used:
//   send:    createRoom, joinRoom, getState, play, pause, seek, changeSong,
//            addToQueue, removeFromQueue, next, previous, songEnded
//   receive: roomState, membersUpdate, roomError, play, pause, seek,
//            changeSong, syncTick, queueUpdate

const socket = io();
const $ = (id) => document.getElementById(id);
const audio = $("audio");

// If our audio is more than this many seconds off the room, we jump (B13/F13)
const DRIFT_LIMIT_SECONDS = 0.3;

// How long an error message stays on screen, in milliseconds
const ERROR_VISIBLE_MS = 6000;

// A room code is exactly 4 letters or numbers (same rule as the server)
const ROOM_CODE_PATTERN = /^[A-Z0-9]{4}$/;

let inRoom = false;
let currentSong = null; // file name of the song loaded in the <audio>
let isSeeking = false; // true while the user drags the seek bar

// What the room is doing, as last told by the server (or by our own buttons).
let playback = { position: 0, isPlaying: false, receivedAt: performance.now() };
let needsSync = false; // true while we wait for the audio file to load

// Rejoin after a lost connection (B16)
let submittedNickname = ""; // the nickname we last used to create/join
let lastRoom = null; // { code, nickname } of the room we are in
let rejoining = false; // true while we wait for the server to take us back

// First screen: what we just asked the server to do ("create" or "join")
let pendingAction = null;

let messageTimer = null;

// ---------- Small helpers ----------

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
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

function showMembers(members, host) {
  $("members").textContent = members
    .map((name) => (name === host ? `${name} (host)` : name))
    .join(", ");
}

function updateTimeDisplay() {
  const seekBar = $("seek");
  if (!isSeeking) seekBar.value = audio.currentTime;
  $("currentTime").textContent = formatTime(
    isSeeking ? Number(seekBar.value) : audio.currentTime,
  );
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

// ---------- First screen: which part of the page is visible ----------

// Not in a room: only the create/join card
function showLanding() {
  $("roomSection").hidden = false;
  $("roomInfo").hidden = true;
  $("player").hidden = true;
}

// In a room: room info + player
function showRoomView() {
  $("roomSection").hidden = true;
  $("inviteHint").hidden = true;
  $("roomInfo").hidden = false;
  $("player").hidden = false;
}

// Keep the address bar as an invite link: ?room=AB12
function updateUrl(code) {
  const wanted = "?room=" + code;
  if (location.search !== wanted) history.replaceState(null, "", wanted);
}

function clearUrl() {
  history.replaceState(null, "", location.pathname);
}

// ---------- Queue (F14) ----------

// Draw the queue list. "queue" looks like [{ id, file, title }, ...].
// We use textContent (not innerHTML) so a song title can never inject HTML.
function renderQueue(queue) {
  const list = $("queueList");
  list.innerHTML = "";

  if (!queue || queue.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "The queue is empty";
    list.appendChild(empty);
    return;
  }

  queue.forEach((item) => {
    const li = document.createElement("li");

    const title = document.createElement("span");
    title.textContent = item.title + " ";

    const removeButton = document.createElement("button");
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

function loadSong(file) {
  currentSong = file;
  audio.src = "/music/" + encodeURIComponent(file);
  audio.load();
  audio.pause();
  $("songSelect").value = file;
  $("seek").value = 0;
  $("currentTime").textContent = "0:00";
  $("duration").textContent = "0:00";
}

function clearSong() {
  currentSong = null;
  needsSync = false;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  $("seek").value = 0;
  $("currentTime").textContent = "0:00";
  $("duration").textContent = "0:00";
}

function seekTo(seconds) {
  const max = Number.isFinite(audio.duration) ? audio.duration : seconds;
  audio.currentTime = Math.min(Math.max(0, seconds), max);
}

function playAudio() {
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
    hideOverlay();
  }
}

// ---------- Apply the full room state (join, create, getState, next...) ----------

function applyState(state) {
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

  if (state.currentSong !== currentSong) loadSong(state.currentSong);
  syncAudioToRoom();
}

// ---------- Messages from the server ----------

socket.on("connect", () => {
  $("status").textContent = "connected";

  // Connection came back after a drop: the server forgot us, so rejoin.
  if (lastRoom) {
    rejoining = true;
    showMessage("Reconnecting to your room...");
    socket.emit("joinRoom", lastRoom);
  }
});

socket.on("disconnect", () => {
  $("status").textContent = "disconnected";
  inRoom = false;
  $("player").hidden = true;
  hideOverlay();
  audio.pause();

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
  $("status").textContent = "can't reach the server";
});

socket.on("roomState", (state) => {
  showMessage("");
  clearFieldErrors();
  rejoining = false;
  pendingAction = null;
  lastRoom = { code: state.code, nickname: submittedNickname };
  applyState(state);
});

socket.on("membersUpdate", (data) => {
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
socket.on("play", ({ position }) => {
  remember(position, true);
  syncAudioToRoom();
});

socket.on("pause", ({ position }) => {
  remember(position, false);
  syncAudioToRoom();
});

socket.on("seek", ({ position }) => {
  remember(position, playback.isPlaying);
  syncAudioToRoom();
});

socket.on("changeSong", ({ song }) => {
  loadSong(song);
  remember(0, false);
  syncAudioToRoom(); // the file is still loading, so this waits for metadata
});

// Drift correction (F13): the server tells us every few seconds where the
// song should be. If we are off by more than 0.3 s, jump to the right spot.
socket.on("syncTick", ({ position, isPlaying }) => {
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
});

// ---------- First screen: create and join ----------

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

// ---------- Player buttons: change our audio AND tell the server ----------

$("setSong").onclick = () => {
  const song = $("songSelect").value;
  if (!inRoom || !song) return;
  loadSong(song);
  remember(0, false);
  needsSync = true;
  socket.emit("changeSong", { song });
};

// The server answers with queueUpdate, which redraws the list for everyone
$("addToQueue").onclick = () => {
  const song = $("songSelect").value;
  if (!inRoom || !song) return;
  socket.emit("addToQueue", { song });
};

$("play").onclick = () => {
  if (!inRoom) return;
  if (!currentSong) return showError("Pick a song first");
  remember(audio.currentTime, true);
  playAudio();
  socket.emit("play", { position: audio.currentTime });
};

$("pause").onclick = () => {
  if (!inRoom) return;
  audio.pause();
  remember(audio.currentTime, false);
  socket.emit("pause", { position: audio.currentTime });
};

// Next and previous (B15): the server decides, then sends roomState to
// everyone (including us), and applyState() loads and plays the new song.
$("next").onclick = () => {
  if (!inRoom) return;
  socket.emit("next");
};

$("previous").onclick = () => {
  if (!inRoom) return;
  socket.emit("previous");
};

// Seek bar: "input" fires while dragging, "change" fires when released.
$("seek").addEventListener("input", () => {
  isSeeking = true;
  updateTimeDisplay();
});

$("seek").addEventListener("change", () => {
  isSeeking = false;
  if (!inRoom || !currentSong) return;
  const position = Number($("seek").value);
  remember(position, playback.isPlaying);
  seekTo(position);
  socket.emit("seek", { position });
});

// Volume is local on purpose: everyone controls their own
$("volume").addEventListener("input", () => {
  audio.volume = Number($("volume").value);
});

// "Tap to join the listening": the tap allows sound, then we jump to
// where the room is right now (not where it was when the overlay opened).
$("joinListening").onclick = () => {
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

// ---------- Song list (the "library") ----------

// Fetch /songs and fill the dropdown. We call this on page load and again
// after every successful upload. Returns true if the list was loaded.
async function loadSongs() {
  const select = $("songSelect");
  const previous = select.value; // keep the user's pick if it still exists

  try {
    const res = await fetch("/songs");
    if (!res.ok) throw new Error("Bad response from /songs");
    const songs = await res.json();

    select.innerHTML = "";

    if (!Array.isArray(songs) || songs.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No songs found";
      select.appendChild(option);
      return true;
    }

    songs.forEach((song) => {
      const option = document.createElement("option");
      option.value = song.file;
      option.textContent = song.title;
      select.appendChild(option);
    });

    if (previous && songs.some((song) => song.file === previous)) {
      select.value = previous;
    }
    return true;
  } catch {
    showError("Could not load the song list. Try refreshing the page.");
    return false;
  }
}

loadSongs();

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

  // Refresh the library so the new songs show up in the dropdown
  if (uploaded > 0) await loadSongs();

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

// Click or keyboard opens the file picker
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