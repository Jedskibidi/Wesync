/**
 * @file server.js
 * @description Backend for Wesync: Express + Socket.IO rooms, playback sync, queue, and MP3 uploads.
 * Location: server\server.js
 */

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const cors = require("cors");
const { Server } = require("socket.io");

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(path.join(__dirname, ".env"));
  } catch {}
}

const app = express();
const server = http.createServer(app);

const CLIENT_ORIGINS = (process.env.CLIENT_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);

const io = new Server(server, { cors: { origin: CLIENT_ORIGINS } });

const PORT = process.env.PORT || 3000;
const MUSIC_DIR = path.join(__dirname, "music");
fs.mkdirSync(MUSIC_DIR, { recursive: true });

const ROOM_CODE_RE = /^[A-Z0-9]{4}$/;

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const MAX_SONGS_PER_ROOM = numberFromEnv("MAX_SONGS_PER_ROOM", 20);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = numberFromEnv("MAX_TOTAL_MB", 2048) * 1024 * 1024;
const MAX_UPLOADS_PER_MINUTE = numberFromEnv("MAX_UPLOADS_PER_MINUTE", 20);
const ROOM_GRACE_MS = numberFromEnv("ROOM_GRACE_SECONDS", 180) * 1000;
const PRIVATE_ROOM_CODE = String(process.env.PRIVATE_ROOM_CODE || "")
  .trim()
  .toUpperCase();
const PRIVATE_ROOM_PASSWORD = String(process.env.PRIVATE_ROOM_PASSWORD || "");
const PRIVATE_ROOM_MAX_SONGS = numberFromEnv("PRIVATE_ROOM_MAX_SONGS", 50);

const MAX_WRONG_PASSWORDS_PER_MINUTE = 10;

let totalBytes = 0;
let pendingBytes = 0;

function roomDir(code) {
  return path.join(MUSIC_DIR, code);
}

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

wipeRoomFolders();

const TICK_INTERVAL_MS = 4000;

const MAX_QUEUE_LENGTH = 50;

const MAX_HISTORY_LENGTH = 20;

const SONG_END_GUARD_MS = 2000;

app.use(express.json());
app.use(cors({ origin: CLIENT_ORIGINS }));

if (process.env.SERVE_CLIENT === "true") {
  app.use(express.static(path.join(__dirname, "..", "client")));
} else {
  app.get("/", (req, res) =>
    res.type("text").send("Wesync server is running."),
  );
}

function songTitle(file) {
  return path
    .basename(file, path.extname(file))
    .replace(/^\d{10,}-/, "")
    .replace(/-/g, " ");
}

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
    pickedBy: null,
    isPlaying: false,
    position: 0,
    lastUpdated: Date.now(),
    queue: [],
    nextQueueId: 1,
    history: [],
    songChangedAt: 0,
    tickTimer: null,
    maxSongs: MAX_SONGS_PER_ROOM,
    permanent: false,
    password: null,
    songs: new Map(),
    bytes: 0,
    pendingUploads: 0,
    deleteTimer: null,
    destroyed: false,
  };
}

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
        console.error(
          `Could not delete the songs of room ${room.code}:`,
          err.message,
        );
      }
    },
  );
  console.log(`Room ${room.code} deleted (${room.songs.size} song(s) removed)`);
}

function clearRoomSongs(room) {
  if (room.destroyed || room.members.size > 0 || room.pendingUploads > 0)
    return;

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
        console.error(
          `Could not delete the songs of room ${room.code}:`,
          err.message,
        );
      }
    },
  );
  console.log(
    `Room ${room.code} stays open, but ${count} song(s) were removed`,
  );
}

function keepRoom(room) {
  clearTimeout(room.deleteTimer);
  room.deleteTimer = null;
  startTicks(room);
}

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

function pushHistory(room) {
  if (!room.currentSong) return;
  room.history.push({ file: room.currentSong, by: room.pickedBy });
  if (room.history.length > MAX_HISTORY_LENGTH) room.history.shift();
}

function startSong(room, file, by) {
  updateRoom(room, {
    currentSong: file,
    pickedBy: by || null,
    isPlaying: true,
    position: 0,
  });
  room.songChangedAt = Date.now();
}

function broadcastState(room) {
  io.to(room.code).emit("roomState", roomSnapshot(room));
}

function advanceQueue(room) {
  const nextItem = room.queue.shift();
  if (!nextItem) return false;
  pushHistory(room);
  startSong(room, nextItem.file, nextItem.by);
  return true;
}

function startTicks(room) {
  if (room.tickTimer) return;
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
    stopTicks(room);
    updateRoom(room, { isPlaying: false });
    clearTimeout(room.deleteTimer);
    if (room.permanent) {
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

function getRoomOf(socket) {
  const room = rooms.get(socket.roomCode);
  if (!room) socket.emit("roomError", { message: "You are not in a room" });
  return room;
}

function cleanPosition(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : undefined;
}

function samePassword(given, expected) {
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const wrongPasswordTimes = [];

function passwordsLocked() {
  const now = Date.now();
  while (wrongPasswordTimes.length && now - wrongPasswordTimes[0] > 60000) {
    wrongPasswordTimes.shift();
  }
  return wrongPasswordTimes.length >= MAX_WRONG_PASSWORDS_PER_MINUTE;
}

function setupPrivateRoom() {
  if (!PRIVATE_ROOM_CODE && !PRIVATE_ROOM_PASSWORD) return;
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

function roomForRequest(req) {
  const code = String(req.query.room || "");
  const sid = String(req.query.sid || "");
  const room = ROOM_CODE_RE.test(code) ? rooms.get(code) : undefined;
  return room && room.members.has(sid) ? room : null;
}

function validSongFile(room, value) {
  const file = path.basename(String(value || ""));
  return room.songs.has(file) ? file : null;
}

const uploadLog = new Map();

function allowUpload(socketId) {
  const now = Date.now();
  const recent = (uploadLog.get(socketId) || []).filter((t) => now - t < 60000);
  const allowed = recent.length < MAX_UPLOADS_PER_MINUTE;
  if (allowed) recent.push(now);
  uploadLog.set(socketId, recent);
  return allowed;
}

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
    let stamp = Date.now();
    while (
      fs.existsSync(path.join(roomDir(req.room.code), `${stamp}-${base}.mp3`))
    ) {
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

app.post("/upload", uploadGuard, (req, res) => {
  const room = req.room;

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

    io.to(room.code).emit("songsUpdate", {
      by: room.members.get(String(req.query.sid)) || null,
      title: songTitle(saved.filename),
    });
    res.json({ ok: true, file: saved.filename });
  });
});

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

function announce(socket, room, type, extra = {}) {
  socket.to(room.code).emit("activity", {
    type,
    by: room.members.get(socket.id) || null,
    ...extra,
  });
}

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
    try {
      fs.rmSync(roomDir(code), { recursive: true, force: true });
    } catch (err) {
      console.error(`Could not clean music/${code}:`, err.message);
    }
    const room = createRoom(code, socket.id, nickname);
    rooms.set(code, room);
    startTicks(room);

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

    if (socket.roomCode === code) {
      return socket.emit("roomState", roomSnapshot(room));
    }

    if (room.password) {
      const given = typeof data.password === "string" ? data.password : "";
      if (!given) {
        return socket.emit("roomError", {
          message: "This room needs a password",
        });
      }
      if (passwordsLocked()) {
        return socket.emit("roomError", {
          message:
            "Too many wrong passwords, please wait a minute and try again",
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
    keepRoom(room);
    socket.join(code);
    socket.roomCode = code;

    console.log(`${nickname} joined room ${code}`);
    socket.emit("roomState", roomSnapshot(room));
    socket.to(code).emit("membersUpdate", membersPayload(room));
  });

  handle(socket, "getState", () => {
    const room = getRoomOf(socket);
    if (!room) return;
    socket.emit("roomState", roomSnapshot(room));
  });

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
      by: room.members.get(socket.id) || null,
    });
  });

  handle(socket, "pause", (data) => {
    const room = getRoomOf(socket);
    if (!room) return;
    updateRoom(room, {
      isPlaying: false,
      position: cleanPosition(data.position),
    });
    socket.to(room.code).emit("pause", {
      position: room.position,
      by: room.members.get(socket.id) || null,
    });
  });

  handle(socket, "seek", (data) => {
    const room = getRoomOf(socket);
    if (!room) return;
    const position = cleanPosition(data.position);
    if (position === undefined) return;
    updateRoom(room, { position });
    socket.to(room.code).emit("seek", {
      position: room.position,
      by: room.members.get(socket.id) || null,
    });
  });

  handle(socket, "changeSong", (data) => {
    const room = getRoomOf(socket);
    if (!room) return;

    const song = validSongFile(room, data.song);
    if (!song) {
      return socket.emit("roomError", { message: "Song not found" });
    }

    const by = room.members.get(socket.id) || null;

    if (song !== room.currentSong) pushHistory(room);
    updateRoom(room, {
      currentSong: song,
      pickedBy: by,
      isPlaying: false,
      position: 0,
    });
    room.songChangedAt = Date.now();
    socket.to(room.code).emit("changeSong", { song, by });
  });

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
    io.to(room.code).emit("queueUpdate", { queue: room.queue });
  });

  handle(socket, "next", () => {
    const room = getRoomOf(socket);
    if (!room) return;
    if (!advanceQueue(room)) {
      return socket.emit("roomError", { message: "The queue is empty" });
    }
    broadcastState(room);
    announce(socket, room, "next", { title: songTitle(room.currentSong) });
  });

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

  handle(socket, "songEnded", (data) => {
    const room = getRoomOf(socket);
    if (!room) return;

    if (!room.currentSong || data.song !== room.currentSong) return;
    if (Date.now() - room.songChangedAt < SONG_END_GUARD_MS) return;

    if (!advanceQueue(room)) {
      updateRoom(room, { isPlaying: false, position: 0 });
    }
    broadcastState(room);
  });

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

app.use((err, req, res, next) => {
  console.error("Request error:", err);
  const status = err.status && err.status < 500 ? err.status : 500;
  res.status(status).json({
    ok: false,
    error: status < 500 ? "Bad request" : "Server error",
  });
});

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

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    wipeRoomFolders();
    process.exit(0);
  });
}

server.listen(PORT, () => {
  console.log(`Wesync server running at http://localhost:${PORT}`);
});
