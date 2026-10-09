// Wesync client: Socket.IO + audio player + sync + queue.
//
// IDs this file needs (keep them in index.html):
//   status, message, nickname, create, code, join, room, members,
//   player, songSelect, setSong, addToQueue, queueList, audio, play, pause,
//   currentTime, seek, duration, volume, joinOverlay, joinListening
//
// Socket.IO events used:
//   send:    createRoom, joinRoom, getState, play, pause, seek, changeSong,
//            addToQueue, removeFromQueue
//   receive: roomState, membersUpdate, roomError, play, pause, seek,
//            changeSong, syncTick, queueUpdate

const socket = io();
const $ = (id) => document.getElementById(id);
const audio = $("audio");

// If our audio is more than this many seconds off the room, we jump (B13/F13)
const DRIFT_LIMIT_SECONDS = 0.3;

let inRoom = false;
let currentSong = null; // file name of the song loaded in the <audio>
let isSeeking = false; // true while the user drags the seek bar

// What the room is doing, as last told by the server (or by our own buttons).
let playback = { position: 0, isPlaying: false, receivedAt: performance.now() };
let needsSync = false; // true while we wait for the audio file to load

// ---------- Small helpers ----------

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function showMessage(text) {
  $("message").textContent = text;
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
    // Browsers block sound until the user has clicked on the page.
    if (err.name === "NotAllowedError") showOverlay();
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

// ---------- Apply the full room state (join, create, getState) ----------

function applyState(state) {
  inRoom = true;
  $("player").hidden = false;
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
});

socket.on("disconnect", () => {
  $("status").textContent = "disconnected";
  inRoom = false;
  $("player").hidden = true;
  hideOverlay();
  audio.pause();
  showMessage("Disconnected. Create or join a room again.");
});

socket.on("roomState", (state) => {
  showMessage("");
  applyState(state);
});

socket.on("membersUpdate", (data) => {
  showMembers(data.members, data.host);
});

socket.on("queueUpdate", ({ queue }) => {
  renderQueue(queue);
});

socket.on("roomError", (err) => {
  showMessage(err.message);
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

// ---------- Our own buttons: change our audio AND tell the server ----------

$("create").onclick = () => {
  showMessage("");
  socket.emit("createRoom", { nickname: $("nickname").value });
};

$("join").onclick = () => {
  showMessage("");
  socket.emit("joinRoom", {
    code: $("code").value,
    nickname: $("nickname").value,
  });
};

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
  if (!currentSong) return showMessage("Pick a song first");
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

fetch("/songs")
  .then((res) => res.json())
  .then((songs) => {
    $("songSelect").innerHTML = songs
      .map((s) => `<option value="${s.file}">${s.title}</option>`)
      .join("");
  });