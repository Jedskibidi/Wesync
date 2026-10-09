const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MUSIC_DIR = path.join(__dirname, "music");
fs.mkdirSync(MUSIC_DIR, { recursive: true });

// How often every room sends a syncTick (B13), in milliseconds
const TICK_INTERVAL_MS = 4000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/music", express.static(MUSIC_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MUSIC_DIR),
  filename: (req, file, cb) => {
    const base =
      path
        .basename(file.originalname, path.extname(file.originalname))
        .replace(/[^a-zA-Z0-9 _-]/g, "")
        .trim()
        .replace(/\s+/g, "-") || "song";
    cb(null, `${Date.now()}-${base}.mp3`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const okTypes = ["audio/mpeg", "audio/mp3", "application/octet-stream", ""];
    if (ext !== ".mp3" || !okTypes.includes(file.mimetype)) {
      return cb(new Error("Only MP3 files are allowed"));
    }
    cb(null, true);
  },
});

app.post("/upload", (req, res) => {
  upload.single("song")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const msg =
        err.code === "LIMIT_FILE_SIZE"
          ? "File too large (max 20 MB)"
          : err.message;
      return res.status(400).json({ ok: false, error: msg });
    }
    if (err) return res.status(400).json({ ok: false, error: err.message });
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: 'No file uploaded (field name must be "song")',
      });
    }
    res.json({ ok: true, file: req.file.filename });
  });
});

app.get("/songs", (req, res) => {
  const files = fs
    .readdirSync(MUSIC_DIR)
    .filter((f) => f.toLowerCase().endsWith(".mp3"));

  const songs = files
    .map((file) => {
      const added = fs.statSync(path.join(MUSIC_DIR, file)).mtimeMs;
      const title = path
        .basename(file, path.extname(file))
        .replace(/^\d{10,}-/, "")
        .replace(/-/g, " ");
      return { file, title, added };
    })
    .sort((a, b) => b.added - a.added)
    .map(({ file, title }) => ({ file, title }));

  res.json(songs);
});

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
    members: new Map([[socketId, nickname]]),
    currentSong: null,
    isPlaying: false,
    position: 0,
    lastUpdated: Date.now(),
    queue: [], // filled in B14
    tickTimer: null, // B13: the interval that sends syncTick
  };
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
    stopTicks(room); // B13: no members, so no timer
    rooms.delete(code);
    console.log(`Room ${code} deleted (empty), ticks stopped`);
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

// socket.io connection handling
io.on("connection", (socket) => {
  console.log(`Connected:    ${socket.id} (online: ${io.engine.clientsCount})`);
  io.emit("onlineCount", io.engine.clientsCount);

  socket.on("createRoom", (data = {}) => {
    const nickname = cleanNickname(data.nickname);
    if (!nickname) {
      return socket.emit("roomError", { message: "Please enter a nickname" });
    }

    leaveCurrentRoom(socket);

    const code = generateRoomCode();
    const room = createRoom(code, socket.id, nickname);
    rooms.set(code, room);
    startTicks(room); // B13

    socket.join(code);
    socket.roomCode = code;

    console.log(`Room ${code} created by ${nickname} (host)`);
    socket.emit("roomState", roomSnapshot(room));
  });

  socket.on("joinRoom", (data = {}) => {
    const nickname = cleanNickname(data.nickname);
    const code = String(data.code || "")
      .trim()
      .toUpperCase();

    if (!nickname) {
      return socket.emit("roomError", { message: "Please enter a nickname" });
    }
    const room = rooms.get(code);
    if (!room) {
      return socket.emit("roomError", {
        message: `Room ${code || "?"} not found`,
      });
    }

    // Already in this room? Just resend the state.
    if (socket.roomCode === code) {
      return socket.emit("roomState", roomSnapshot(room));
    }

    if (isNicknameTaken(room, nickname, socket.id)) {
      return socket.emit("roomError", {
        message: `The nickname "${nickname}" is already taken in this room`,
      });
    }

    leaveCurrentRoom(socket);

    room.members.set(socket.id, nickname);
    socket.join(code);
    socket.roomCode = code;

    console.log(`${nickname} joined room ${code}`);
    socket.emit("roomState", roomSnapshot(room));
    socket.to(code).emit("membersUpdate", membersPayload(room));
  });

  // Ask the server for the current room state
  socket.on("getState", () => {
    const room = getRoomOf(socket);
    if (!room) return;
    socket.emit("roomState", roomSnapshot(room));
  });

  // play {position}  (position is optional)
  socket.on("play", (data = {}) => {
    const room = getRoomOf(socket);
    if (!room) return;
    if (!room.currentSong) {
      return socket.emit("roomError", { message: "Pick a song first" });
    }
    updateRoom(room, {
      isPlaying: true,
      position: cleanPosition(data.position),
    });
    socket.to(room.code).emit("play", { position: room.position });
  });

  // pause {position}  (position is optional)
  socket.on("pause", (data = {}) => {
    const room = getRoomOf(socket);
    if (!room) return;
    updateRoom(room, {
      isPlaying: false,
      position: cleanPosition(data.position),
    });
    socket.to(room.code).emit("pause", { position: room.position });
  });

  // seek {position}  (B10)
  socket.on("seek", (data = {}) => {
    const room = getRoomOf(socket);
    if (!room) return;
    const position = cleanPosition(data.position);
    if (position === undefined) return;
    updateRoom(room, { position });
    socket.to(room.code).emit("seek", { position: room.position });
  });

  // changeSong {song}  (B11) - the new song starts paused at 0:00
  socket.on("changeSong", (data = {}) => {
    const room = getRoomOf(socket);
    if (!room) return;

    // basename() blocks tricks like "../server.js"
    const song = path.basename(String(data.song || ""));
    const exists =
      song.toLowerCase().endsWith(".mp3") &&
      fs.existsSync(path.join(MUSIC_DIR, song));
    if (!exists) {
      return socket.emit("roomError", { message: "Song not found" });
    }

    updateRoom(room, { currentSong: song, isPlaying: false, position: 0 });
    socket.to(room.code).emit("changeSong", { song });
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
    console.log(
      `Disconnected: ${socket.id} (online: ${io.engine.clientsCount})`,
    );
    io.emit("onlineCount", io.engine.clientsCount);
  });
});

server.listen(PORT, () => {
  console.log(`Wesync running at http://localhost:${PORT}`);
});
