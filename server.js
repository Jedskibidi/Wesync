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

// Rooms
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

function roomSnapshot(room) {
  return { code: room.code, members: [...room.members.values()] };
}

function cleanNickname(value) {
  return String(value || "")
    .trim()
    .slice(0, 20);
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
    rooms.delete(code);
    console.log(`Room ${code} deleted (empty)`);
  } else {
    io.to(code).emit("membersUpdate", [...room.members.values()]);
  }
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
    const room = { code, members: new Map([[socket.id, nickname]]) };
    rooms.set(code, room);

    socket.join(code);
    socket.roomCode = code;

    console.log(`Room ${code} created by ${nickname}`);
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

    leaveCurrentRoom(socket);

    room.members.set(socket.id, nickname);
    socket.join(code);
    socket.roomCode = code;

    console.log(`${nickname} joined room ${code}`);
    socket.emit("roomState", roomSnapshot(room));
    socket.to(code).emit("membersUpdate", [...room.members.values()]);
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
