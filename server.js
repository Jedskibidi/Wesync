const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { Server } = require("socket.io");

// Optional local settings file. .env is in .gitignore, so passwords stay out
// of GitHub. Settings already set by the host (Render, ...) are not replaced.
// (process.loadEnvFile needs Node 20.12 or newer; older Node just skips this.)
if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(path.join(__dirname, ".env"));
  } catch {
    // no .env file: fine
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MUSIC_DIR = path.join(__dirname, "music");
fs.mkdirSync(MUSIC_DIR, { recursive: true });

// ---- Per-room songs ----
// Uploaded songs live in music/<ROOMCODE>/ and belong to that room only.
// A room's folder is deleted when the room closes, and every room folder is
// wiped when the server starts. The limits below can be changed with
// environment variables, for example:  MAX_SONGS_PER_ROOM=10 npm start
const ROOM_CODE_RE = /^[A-Z0-9]{4}$/;

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Most songs one room can upload
const MAX_SONGS_PER_ROOM = numberFromEnv("MAX_SONGS_PER_ROOM", 20);

// Biggest single file, in bytes (the page checks the same 20 MB)
const MAX_FILE_BYTES = 20 * 1024 * 1024;

// Most disk space all rooms together may use, in bytes
const MAX_TOTAL_BYTES = numberFromEnv("MAX_TOTAL_MB", 2048) * 1024 * 1024;

// Most uploads one person can start per minute
const MAX_UPLOADS_PER_MINUTE = numberFromEnv("MAX_UPLOADS_PER_MINUTE", 20);

// An empty room (and its songs) is kept this long before it is deleted, so a
// page refresh or a short network drop does not wipe everything
const ROOM_GRACE_MS = numberFromEnv("ROOM_GRACE_SECONDS", 180) * 1000;

// ---- Private room: a room with a fixed code and a password ----
// It is created every time the server starts and is never deleted when it
// empties (but its songs are removed after it has been empty for a while). Set BOTH variables to turn it on (on your host's settings page, or
// in a local .env file):
//   PRIVATE_ROOM_CODE=LOVE            (4 letters or numbers)
//   PRIVATE_ROOM_PASSWORD=something-only-you-know
const PRIVATE_ROOM_CODE = String(process.env.PRIVATE_ROOM_CODE || "")
  .trim()
  .toUpperCase();
const PRIVATE_ROOM_PASSWORD = String(process.env.PRIVATE_ROOM_PASSWORD || "");
const PRIVATE_ROOM_MAX_SONGS = numberFromEnv("PRIVATE_ROOM_MAX_SONGS", 50);

// After this many wrong passwords in one minute (from anyone), the private
// room refuses every attempt for a while, so the password cannot be guessed
const MAX_WRONG_PASSWORDS_PER_MINUTE = 10;

let totalBytes = 0; // bytes stored by all rooms together
let pendingBytes = 0; // bytes of uploads that are still arriving

function roomDir(code) {
  return path.join(MUSIC_DIR, code);
}

// Delete every room folder inside music/ (other files there are left alone)
function wipeRoomFolders() {
  for (const entry of fs.readdirSync(MUSIC_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ROOM_CODE_RE.test(entry.name)) continue;
    try {
      fs.rmSync(path.join(MUSIC_DIR, entry.name), {
        recursive: true,
        force: true,
      });
    } catch (err) {
      console.error(`Could not delete music/${entry.name}:`, err.message);
    }
  }
}

// Songs from before a restart belong to rooms that no longer exist
wipeRoomFolders();

// How often every room sends a syncTick (B13), in milliseconds
const TICK_INTERVAL_MS = 4000;

// Most songs a room's queue can hold (B14)
const MAX_QUEUE_LENGTH = 50;

// How many played songs a room remembers for "previous" (B15)
const MAX_HISTORY_LENGTH = 20;

// Ignore "songEnded" this soon after a song change (B15)
const SONG_END_GUARD_MS = 2000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// "1700000000000-Magnolia-Remix.mp3" -> "Magnolia Remix"
function songTitle(file) {
  return path
    .basename(file, path.extname(file))
    .replace(/^\d{10,}-/, "")
    .replace(/-/g, " ");
}

// Rooms (B6 + B7 + B8)
const rooms = new Map();
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateRoomCode() {
  let code;
  do {
    code = Array.from(
      { length: 4 },
      () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)],
    ).join("");
  } while (rooms.has(code));
  return code;
}

function createRoom(code, socketId, nickname) {
  return {
    code,
    members: socketId ? new Map([[socketId, nickname]]) : new Map(),
    currentSong: null,
    pickedBy: null, // nickname of whoever picked the current song
    isPlaying: false,
    position: 0,
    lastUpdated: Date.now(),
    queue: [], // B14: items look like { id, file, title, by }
    nextQueueId: 1, // B14: gives every queue item its own id
    history: [], // B15: songs played before, oldest first: { file, by }
    songChangedAt: 0, // B15: when the current song last changed (ms)
    tickTimer: null, // B13: the interval that sends syncTick
    maxSongs: MAX_SONGS_PER_ROOM, // most songs this room can upload
    permanent: false, // true = room never deleted when empty, only its songs (the private room)
    password: null, // set = people must give it to join
    songs: new Map(), // uploaded songs: file -> { file, title, added, size }
    bytes: 0, // disk space used by this room's songs
    pendingUploads: 0, // uploads that are still arriving
    deleteTimer: null, // runs destroyRoom() (or clearRoomSongs() for the private room) a while after the room empties
    destroyed: false,
  };
}

// Close a room for good: stop its timers and delete its songs from the disk.
function destroyRoom(room) {
  if (room.destroyed) return;
  room.destroyed = true;
  clearTimeout(room.deleteTimer);
  room.deleteTimer = null;
  stopTicks(room);
  rooms.delete(room.code);
  totalBytes = Math.max(0, totalBytes - room.bytes);

  fs.rm(
    roomDir(room.code),
    { recursive: true, force: true, maxRetries: 5, retryDelay: 200 },
    (err) => {
      if (err) {
        console.error(`Could not delete the songs of room ${room.code}:`, err.message);
      }
    },
  );
  console.log(`Room ${room.code} deleted (${room.songs.size} song(s) removed)`);
}

// Delete a room's songs but keep the room itself (used by the private room)
function clearRoomSongs(room) {
  // Someone came back, or an upload is still arriving: do nothing
  if (room.destroyed || room.members.size > 0 || room.pendingUploads > 0) return;

  room.deleteTimer = null;
  totalBytes = Math.max(0, totalBytes - room.bytes);
  const count = room.songs.size;
  room.songs.clear();
  room.bytes = 0;
  room.queue = [];
  room.history = [];
  room.currentSong = null;
  room.pickedBy = null;
  room.isPlaying = false;
  room.position = 0;

  fs.rm(
    roomDir(room.code),
    { recursive: true, force: true, maxRetries: 5, retryDelay: 200 },
    (err) => {
      if (err) {
        console.error(`Could not delete the songs of room ${room.code}:`, err.message);
      }
    },
  );
  console.log(`Room ${room.code} stays open, but ${count} song(s) were removed`);
}

// Someone is back in a room that was about to be deleted
function keepRoom(room) {
  clearTimeout(room.deleteTimer);
  room.deleteTimer = null;
  startTicks(room);
}

// The real position right now. While playing, time keeps moving.
function getCurrentPosition(room) {
  if (!room.isPlaying) return room.position;
  const elapsedSeconds = (Date.now() - room.lastUpdated) / 1000;
  return Math.max(0, room.position + elapsedSeconds);
}

function updateRoom(room, changes) {
  const position =
    changes.position !== undefined
      ? changes.position
      : getCurrentPosition(room);
  Object.assign(room, changes, { position, lastUpdated: Date.now() });
}

// ---- Song changes and history (B15) ----

// Remember the current song (and who picked it) so "previous" can go back.
function pushHistory(room) {
  if (!room.currentSong) return;
  room.history.push({ file: room.currentSong, by: room.pickedBy });
  if (room.history.length > MAX_HISTORY_LENGTH) room.history.shift();
}

// Make a song the current one and start it from 0:00 for everybody.
// "by" is the nickname of whoever picked it.
function startSong(room, file, by) {
  updateRoom(room, {
    currentSong: file,
    pickedBy: by || null,
    isPlaying: true,
    position: 0,
  });
  room.songChangedAt = Date.now();
}

// Send the full room state to EVERYONE in the room, including the sender.
function broadcastState(room) {
  io.to(room.code).emit("roomState", roomSnapshot(room));
}

// Play the first queued song. Returns false if the queue is empty.
// The song's picker is whoever added it to the queue.
function advanceQueue(room) {
  const nextItem = room.queue.shift();
  if (!nextItem) return false;
  pushHistory(room);
  startSong(room, nextItem.file, nextItem.by);
  return true;
}

// ---- Sync ticks (B13) ----
// Every few seconds, tell everyone in the room where the song should be,
// so each client can fix small drifts by itself.
function startTicks(room) {
  if (room.tickTimer) return; // never run two timers for one room
  room.tickTimer = setInterval(() => {
    if (room.members.size === 0 || !room.currentSong) return;
    io.to(room.code).emit("syncTick", {
      position: getCurrentPosition(room),
      isPlaying: room.isPlaying,
    });
  }, TICK_INTERVAL_MS);
}

function stopTicks(room) {
  if (!room.tickTimer) return;
  clearInterval(room.tickTimer);
  room.tickTimer = null;
}

// The host is whoever joined first (a Map keeps insertion order).
function getHost(room) {
  return room.members.values().next().value;
}

function membersPayload(room) {
  return { members: [...room.members.values()], host: getHost(room) };
}

function roomSnapshot(room) {
  return {
    code: room.code,
    ...membersPayload(room),
    currentSong: room.currentSong,
    pickedBy: room.pickedBy,
    isPlaying: room.isPlaying,
    position: getCurrentPosition(room),
    queue: room.queue,
  };
}

function cleanNickname(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 20);
}

function isNicknameTaken(room, nickname, exceptSocketId) {
  const wanted = nickname.toLowerCase();
  for (const [id, name] of room.members) {
    if (id !== exceptSocketId && name.toLowerCase() === wanted) return true;
  }
  return false;
}

function leaveCurrentRoom(socket) {
  const code = socket.roomCode;
  if (!code) return;

  socket.leave(code);
  socket.roomCode = null;

  const room = rooms.get(code);
  if (!room) return;

  room.members.delete(socket.id);
  if (room.members.size === 0) {
    // Nobody is left. Keep the room and its songs for a short while, so a
    // page refresh or a dropped connection does not delete everything.
    stopTicks(room); // B13: no members, so no timer
    updateRoom(room, { isPlaying: false }); // freeze the song position
    clearTimeout(room.deleteTimer);
    if (room.permanent) {
      // Private room: the room stays open, but its songs are removed
      room.deleteTimer = setTimeout(() => clearRoomSongs(room), ROOM_GRACE_MS);
      console.log(
        `Room ${code} is empty, its songs will be removed in ${Math.round(ROOM_GRACE_MS / 1000)}s unless someone joins (the room stays open)`,
      );
    } else {
      room.deleteTimer = setTimeout(() => destroyRoom(room), ROOM_GRACE_MS);
      console.log(
        `Room ${code} is empty, it will be deleted in ${Math.round(ROOM_GRACE_MS / 1000)}s unless someone joins`,
      );
    }
  } else {
    io.to(code).emit("membersUpdate", membersPayload(room));
  }
}

// Returns the room the socket is in, or tells the client it is not in one.
function getRoomOf(socket) {
  const room = rooms.get(socket.roomCode);
  if (!room) socket.emit("roomError", { message: "You are not in a room" });
  return room;
}

// Returns the position if it is a valid number, otherwise undefined.
function cleanPosition(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : undefined;
}

// ---- Room passwords ----

// Compare two passwords without leaking how many letters matched
function samePassword(given, expected) {
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const wrongPasswordTimes = []; // when the recent wrong passwords happened

function passwordsLocked() {
  const now = Date.now();
  while (wrongPasswordTimes.length && now - wrongPasswordTimes[0] > 60000) {
    wrongPasswordTimes.shift();
  }
  return wrongPasswordTimes.length >= MAX_WRONG_PASSWORDS_PER_MINUTE;
}

// Create the private room (needs both settings; never a room without a password)
function setupPrivateRoom() {
  if (!PRIVATE_ROOM_CODE && !PRIVATE_ROOM_PASSWORD) return; // not wanted
  if (!ROOM_CODE_RE.test(PRIVATE_ROOM_CODE) || !PRIVATE_ROOM_PASSWORD) {
    console.warn(
      "Private room NOT created: set PRIVATE_ROOM_CODE (4 letters or numbers) and PRIVATE_ROOM_PASSWORD together.",
    );
    return;
  }
  const room = createRoom(PRIVATE_ROOM_CODE, null, null);
  room.permanent = true;
  room.password = PRIVATE_ROOM_PASSWORD;
  room.maxSongs = PRIVATE_ROOM_MAX_SONGS;
  rooms.set(room.code, room);
  console.log(
    `Private room ${room.code} is ready (password protected, up to ${room.maxSongs} songs)`,
  );
}

// ---- Songs and uploads (per room) ----

// Finds the room a request is about and checks that the caller is really in
// it. The page sends its room code and its own socket id (only that browser
// knows it), so nobody can list or upload to a room they have not joined.
function roomForRequest(req) {
  const code = String(req.query.room || "");
  const sid = String(req.query.sid || "");
  const room = ROOM_CODE_RE.test(code) ? rooms.get(code) : undefined;
  return room && room.members.has(sid) ? room : null;
}

// Returns the clean file name if it is a song of this room, otherwise null.
// basename() blocks tricks like "../server.js".
function validSongFile(room, value) {
  const file = path.basename(String(value || ""));
  return room.songs.has(file) ? file : null;
}

// Simple limit on how often one person can start an upload
const uploadLog = new Map(); // socket id -> times of its recent uploads

function allowUpload(socketId) {
  const now = Date.now();
  const recent = (uploadLog.get(socketId) || []).filter((t) => now - t < 60000);
  const allowed = recent.length < MAX_UPLOADS_PER_MINUTE;
  if (allowed) recent.push(now);
  uploadLog.set(socketId, recent);
  return allowed;
}

// Runs BEFORE the file is read: checks the room, the limits, and reserves
// the space, so a refused upload never touches the disk.
function uploadGuard(req, res, next) {
  const room = roomForRequest(req);
  if (!room) {
    return res
      .status(403)
      .json({ ok: false, error: "You are not in this room" });
  }
  if (room.songs.size + room.pendingUploads >= room.maxSongs) {
    return res.status(409).json({
      ok: false,
      error: `This room has reached its song limit (${room.maxSongs})`,
    });
  }
  const size = Number(req.headers["content-length"]) || 0;
  if (totalBytes + pendingBytes + size > MAX_TOTAL_BYTES) {
    return res.status(507).json({ ok: false, error: "Server storage is full" });
  }
  if (!allowUpload(String(req.query.sid))) {
    return res.status(429).json({
      ok: false,
      error: "Too many uploads, please wait a minute",
    });
  }

  // Hold the slot and the space until this request is over
  room.pendingUploads++;
  pendingBytes += size;
  let released = false;
  res.on("close", () => {
    if (released) return;
    released = true;
    room.pendingUploads--;
    pendingBytes -= size;
  });

  req.room = room;
  next();
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = roomDir(req.room.code);
    fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
  },
  filename: (req, file, cb) => {
    const base =
      path
        .basename(file.originalname, path.extname(file.originalname))
        .replace(/[^a-zA-Z0-9 _-]/g, "")
        .trim()
        .replace(/\s+/g, "-") || "song";
    // Two uploads in the same millisecond must not get the same name
    let stamp = Date.now();
    while (fs.existsSync(path.join(roomDir(req.room.code), `${stamp}-${base}.mp3`))) {
      stamp++;
    }
    cb(null, `${stamp}-${base}.mp3`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const okTypes = ["audio/mpeg", "audio/mp3", "application/octet-stream", ""];
    if (ext !== ".mp3" || !okTypes.includes(file.mimetype)) {
      return cb(new Error("Only MP3 files are allowed"));
    }
    cb(null, true);
  },
});

// POST /upload?room=AB12&sid=<socket id>
app.post("/upload", uploadGuard, (req, res) => {
  const room = req.room;

  // any() accepts the file under any field name; the filter above still
  // makes sure only .mp3 files get saved.
  upload.any()(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const msg =
        err.code === "LIMIT_FILE_SIZE"
          ? "File too large (max 20 MB)"
          : err.message;
      return res.status(400).json({ ok: false, error: msg });
    }
    if (err) return res.status(400).json({ ok: false, error: err.message });
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }

    const saved = req.files[0];

    // The room may have been deleted while the file was arriving
    if (room.destroyed) {
      fs.rm(saved.path, { force: true }, () => {});
      return res.status(410).json({ ok: false, error: "This room has closed" });
    }

    room.songs.set(saved.filename, {
      file: saved.filename,
      title: songTitle(saved.filename),
      added: Date.now(),
      size: saved.size,
    });
    room.bytes += saved.size;
    totalBytes += saved.size;

    // Tell everyone in the room, so their song list updates by itself
    io.to(room.code).emit("songsUpdate", {
      by: room.members.get(String(req.query.sid)) || null,
      title: songTitle(saved.filename),
    });
    res.json({ ok: true, file: saved.filename });
  });
});

// GET /songs?room=AB12&sid=<socket id>  ->  [{ file, title }], newest first
app.get("/songs", (req, res) => {
  const room = roomForRequest(req);
  if (!room) {
    return res
      .status(403)
      .json({ ok: false, error: "You are not in this room" });
  }
  const songs = [...room.songs.values()]
    .sort((a, b) => b.added - a.added)
    .map(({ file, title }) => ({ file, title }));
  res.set("Cache-Control", "no-store");
  res.json(songs);
});

// GET /music/AB12/<file>: the audio itself. Only songs that belong to a room
// that exists are served (sendFile also handles Range requests for seeking).
app.get("/music/:code/:file", (req, res) => {
  const code = String(req.params.code);
  const room = ROOM_CODE_RE.test(code) ? rooms.get(code) : undefined;
  const file = path.basename(String(req.params.file));
  if (!room || !room.songs.has(file)) return res.status(404).end();

  res.sendFile(
    path.join(roomDir(code), file),
    { headers: { "Cache-Control": "private, max-age=3600" } },
    (err) => {
      if (err && !res.headersSent) res.status(err.status || 404).end();
    },
  );
});

// ---- Error handling (B16) ----

// Listen for an event safely:
//  - if the client sends something that is not an object (null, a string,
//    a number...), we use an empty object instead
//  - if the handler crashes, we tell the client and keep the server alive
function handle(socket, event, handler) {
  socket.on(event, (data) => {
    try {
      handler(data && typeof data === "object" ? data : {});
    } catch (err) {
      console.error(`Error in "${event}":`, err);
      socket.emit("roomError", {
        message: "Something went wrong on the server. Please try again.",
      });
    }
  });
}

// Tell everyone ELSE in the room what this person just did, so their screen can
// show a small message ("Jed skipped to ..."). The person who did it already
// sees the result, so they are skipped (same idea as play and pause).
function announce(socket, room, type, extra = {}) {
  socket.to(room.code).emit("activity", {
    type,
    by: room.members.get(socket.id) || null,
    ...extra,
  });
}

// socket.io connection handling
io.on("connection", (socket) => {
  console.log(`Connected:    ${socket.id} (online: ${io.engine.clientsCount})`);
  io.emit("onlineCount", io.engine.clientsCount);

  handle(socket, "createRoom", (data) => {
    const nickname = cleanNickname(data.nickname);
    if (!nickname) {
      return socket.emit("roomError", { message: "Please enter a nickname" });
    }

    leaveCurrentRoom(socket);

    const code = generateRoomCode();
    // Start clean, in case a folder from an earlier room could not be deleted
    try {
      fs.rmSync(roomDir(code), { recursive: true, force: true });
    } catch (err) {
      console.error(`Could not clean music/${code}:`, err.message);
    }
    const room = createRoom(code, socket.id, nickname);
    rooms.set(code, room);
    startTicks(room); // B13

    socket.join(code);
    socket.roomCode = code;

    console.log(`Room ${code} created by ${nickname} (host)`);
    socket.emit("roomState", roomSnapshot(room));
  });

  handle(socket, "joinRoom", (data) => {
    const nickname = cleanNickname(data.nickname);
    const code = String(data.code || "")
      .trim()
      .toUpperCase();

    if (!nickname) {
      return socket.emit("roomError", { message: "Please enter a nickname" });
    }
    if (!/^[A-Z0-9]{4}$/.test(code)) {
      return socket.emit("roomError", {
        message: "A room code has 4 letters or numbers",
      });
    }
    const room = rooms.get(code);
    if (!room) {
      return socket.emit("roomError", { message: `Room ${code} not found` });
    }

    // Already in this room? Just resend the state.
    if (socket.roomCode === code) {
      return socket.emit("roomState", roomSnapshot(room));
    }

    // Password first, so nobody without it can learn who is in the room
    if (room.password) {
      const given = typeof data.password === "string" ? data.password : "";
      if (!given) {
        return socket.emit("roomError", {
          message: "This room needs a password",
        });
      }
      if (passwordsLocked()) {
        return socket.emit("roomError", {
          message: "Too many wrong passwords, please wait a minute and try again",
        });
      }
      if (!samePassword(given, room.password)) {
        wrongPasswordTimes.push(Date.now());
        console.log(`Wrong password for room ${code}`);
        return socket.emit("roomError", { message: "Wrong password" });
      }
    }

    if (isNicknameTaken(room, nickname, socket.id)) {
      return socket.emit("roomError", {
        message: `The nickname "${nickname}" is already taken in this room`,
      });
    }

    leaveCurrentRoom(socket);

    room.members.set(socket.id, nickname);
    keepRoom(room); // the room may have been waiting to be deleted
    socket.join(code);
    socket.roomCode = code;

    console.log(`${nickname} joined room ${code}`);
    socket.emit("roomState", roomSnapshot(room));
    socket.to(code).emit("membersUpdate", membersPayload(room));
  });

  // Ask the server for the current room state
  handle(socket, "getState", () => {
    const room = getRoomOf(socket);
    if (!room) return;
    socket.emit("roomState", roomSnapshot(room));
  });

  // play {position}  (position is optional)
  handle(socket, "play", (data) => {
    const room = getRoomOf(socket);
    if (!room) return;
    if (!room.currentSong) {
      return socket.emit("roomError", { message: "Pick a song first" });
    }
    updateRoom(room, {
      isPlaying: true,
      position: cleanPosition(data.position),
    });
    socket.to(room.code).emit("play", {
      position: room.position,
      by: room.members.get(socket.id) || null, // for the "Jed played" toast
    });
  });

  // pause {position}  (position is optional)
  handle(socket, "pause", (data) => {
    const room = getRoomOf(socket);
    if (!room) return;
    updateRoom(room, {
      isPlaying: false,
      position: cleanPosition(data.position),
    });
    socket.to(room.code).emit("pause", {
      position: room.position,
      by: room.members.get(socket.id) || null, // for the "Jed paused" toast
    });
  });

  // seek {position}  (B10)
  handle(socket, "seek", (data) => {
    const room = getRoomOf(socket);
    if (!room) return;
    const position = cleanPosition(data.position);
    if (position === undefined) return;
    updateRoom(room, { position });
    socket.to(room.code).emit("seek", {
      position: room.position,
      by: room.members.get(socket.id) || null, // for the "Jed jumped to" toast
    });
  });

  // changeSong {song}  (B11) - the new song starts paused at 0:00
  // The person who sent it is the one who picked the song.
  handle(socket, "changeSong", (data) => {
    const room = getRoomOf(socket);
    if (!room) return;

    const song = validSongFile(room, data.song);
    if (!song) {
      return socket.emit("roomError", { message: "Song not found" });
    }

    const by = room.members.get(socket.id) || null;

    if (song !== room.currentSong) pushHistory(room); // B15
    updateRoom(room, {
      currentSong: song,
      pickedBy: by,
      isPlaying: false,
      position: 0,
    });
    room.songChangedAt = Date.now();
    socket.to(room.code).emit("changeSong", { song, by });
  });

  // ---- Queue (B14) ----
  // Anyone in the room can add or remove. After every change we send the
  // whole queue to EVERYONE in the room, including the sender. (This is
  // shared state, not an action, so there is no echo problem.)

  // addToQueue {song}
  // "by" remembers who added it, so "Picked by" works when it starts playing.
  handle(socket, "addToQueue", (data) => {
    const room = getRoomOf(socket);
    if (!room) return;

    const file = validSongFile(room, data.song);
    if (!file) {
      return socket.emit("roomError", { message: "Song not found" });
    }
    if (room.queue.length >= MAX_QUEUE_LENGTH) {
      return socket.emit("roomError", {
        message: `The queue is full (max ${MAX_QUEUE_LENGTH} songs)`,
      });
    }

    room.queue.push({
      id: room.nextQueueId++,
      file,
      title: songTitle(file),
      by: room.members.get(socket.id) || null,
    });
    io.to(room.code).emit("queueUpdate", { queue: room.queue });
    announce(socket, room, "queueAdd", { title: songTitle(file) });
  });

  // removeFromQueue {id}
  handle(socket, "removeFromQueue", (data) => {
    const room = getRoomOf(socket);
    if (!room) return;

    const index = room.queue.findIndex((item) => item.id === data.id);
    if (index === -1) {
      return socket.emit("roomError", {
        message: "That song is not in the queue",
      });
    }

    const [removed] = room.queue.splice(index, 1);
    io.to(room.code).emit("queueUpdate", { queue: room.queue });
    announce(socket, room, "queueRemove", { title: removed.title });
  });

  // reorderQueue {id, toIndex}
  // Move one queue item to a new place. We use the item's id (not its old
  // position) so the move is still right if the queue changed a moment ago.
  handle(socket, "reorderQueue", (data) => {
    const room = getRoomOf(socket);
    if (!room) return;

    const from = room.queue.findIndex((item) => item.id === data.id);
    if (from === -1) {
      return socket.emit("roomError", {
        message: "That song is not in the queue",
      });
    }
    if (!Number.isInteger(data.toIndex)) return;

    const to = Math.min(Math.max(data.toIndex, 0), room.queue.length - 1);
    if (to !== from) {
      const [moved] = room.queue.splice(from, 1);
      room.queue.splice(to, 0, moved);
      announce(socket, room, "queueMove", { title: moved.title });
    }
    // Always answer, so a tab that showed the move early is put right
    io.to(room.code).emit("queueUpdate", { queue: room.queue });
  });

  // ---- Next, previous, auto-advance (B15) ----

  // next: play the first song in the queue
  handle(socket, "next", () => {
    const room = getRoomOf(socket);
    if (!room) return;
    if (!advanceQueue(room)) {
      return socket.emit("roomError", { message: "The queue is empty" });
    }
    broadcastState(room);
    announce(socket, room, "next", { title: songTitle(room.currentSong) });
  });

  // previous: go back to the last song that played.
  // The song we leave goes to the front of the queue, so "next" returns to it.
  handle(socket, "previous", () => {
    const room = getRoomOf(socket);
    if (!room) return;

    const previous = room.history.pop();
    if (!previous) {
      return socket.emit("roomError", { message: "No previous song" });
    }

    if (room.currentSong) {
      room.queue.unshift({
        id: room.nextQueueId++,
        file: room.currentSong,
        title: songTitle(room.currentSong),
        by: room.pickedBy,
      });
    }
    startSong(room, previous.file, previous.by);
    broadcastState(room);
    announce(socket, room, "previous", { title: songTitle(previous.file) });
  });

  // songEnded {song}: a client says its audio reached the end.
  // Every tab reports this at about the same time, so we only act on the
  // first report and ignore the rest.
  handle(socket, "songEnded", (data) => {
    const room = getRoomOf(socket);
    if (!room) return;

    if (!room.currentSong || data.song !== room.currentSong) return;
    if (Date.now() - room.songChangedAt < SONG_END_GUARD_MS) return;

    if (!advanceQueue(room)) {
      // Nothing queued: stop at the start and wait
      updateRoom(room, { isPlaying: false, position: 0 });
    }
    broadcastState(room);
  });

  // leaveRoom: the user pressed "Leave room". Same cleanup as disconnecting
  // (host passes on, empty rooms are deleted), but the socket stays connected.
  handle(socket, "leaveRoom", () => {
    leaveCurrentRoom(socket);
    socket.emit("leftRoom");
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
    uploadLog.delete(socket.id);
    console.log(
      `Disconnected: ${socket.id} (online: ${io.engine.clientsCount})`,
    );
    io.emit("onlineCount", io.engine.clientsCount);
  });
});

// Any error from an Express route (for example broken JSON in a request)
// gets a clean JSON answer instead of an HTML error page.
app.use((err, req, res, next) => {
  console.error("Request error:", err);
  const status = err.status && err.status < 500 ? err.status : 500;
  res.status(status).json({
    ok: false,
    error: status < 500 ? "Bad request" : "Server error",
  });
});

// Friendly message if the port is already taken (server started twice)
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Stop the other server (Ctrl+C in its terminal) and try again.`,
    );
  } else {
    console.error("Server error:", err);
  }
  process.exit(1);
});

setupPrivateRoom();

// Ctrl+C or a stop signal: delete the room songs before the server quits
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    wipeRoomFolders();
    process.exit(0);
  });
}

server.listen(PORT, () => {
  console.log(`Wesync running at http://localhost:${PORT}`);
});