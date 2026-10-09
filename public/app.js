const socket = io();
const $ = (id) => document.getElementById(id);
const audio = $("audio");

let inRoom = false;
let currentSong = null; 
let isSeeking = false; 


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

// Audio element control functions
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
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  $("seek").value = 0;
  $("currentTime").textContent = "0:00";
  $("duration").textContent = "0:00";
}

function seekTo(seconds) {
  audio.currentTime = seconds;
}

function playAudio() {
  audio.play().catch(() => {
    showMessage("Your browser blocked autoplay. Press Play.");
  });
}

// Full room state is sent to new members, and also when the host changes songs or pauses/plays/seeks. The client applies it to its UI and audio element.
function applyState(state) {
  inRoom = true;
  $("player").hidden = false;
  $("room").textContent = state.code;
  showMembers(state.members, state.host);

  if (!state.currentSong) {
    clearSong();
    return;
  }

  if (state.currentSong !== currentSong) loadSong(state.currentSong);
  seekTo(state.position);
  if (state.isPlaying) playAudio();
  else audio.pause();
}

// Message handlers sa server
socket.on("connect", () => {
  $("status").textContent = "connected";
});

socket.on("disconnect", () => {
  $("status").textContent = "disconnected";
  inRoom = false;
  $("player").hidden = true;
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

socket.on("roomError", (err) => {
  showMessage(err.message);
});

socket.on("play", ({ position }) => {
  seekTo(position);
  playAudio();
});

socket.on("pause", ({ position }) => {
  audio.pause();
  seekTo(position);
});

socket.on("seek", ({ position }) => {
  seekTo(position);
});

socket.on("changeSong", ({ song }) => {
  loadSong(song);
});

// Own buttons
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
  socket.emit("changeSong", { song });
};

$("play").onclick = () => {
  if (!inRoom) return;
  if (!currentSong) return showMessage("Pick a song first");
  playAudio();
  socket.emit("play", { position: audio.currentTime });
};

$("pause").onclick = () => {
  if (!inRoom) return;
  audio.pause();
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
  seekTo(position);
  socket.emit("seek", { position });
});

// Volume is local on purpose: everyone controls their own
$("volume").addEventListener("input", () => {
  audio.volume = Number($("volume").value);
});

//update the seek bar and time display 
audio.addEventListener("loadedmetadata", () => {
  $("seek").max = audio.duration;
  $("duration").textContent = formatTime(audio.duration);
  updateTimeDisplay();
});

audio.addEventListener("timeupdate", updateTimeDisplay);

fetch("/songs")
  .then((res) => res.json())
  .then((songs) => {
    $("songSelect").innerHTML = songs
      .map((s) => `<option value="${s.file}">${s.title}</option>`)
      .join("");
  });
