# Wesync

Wesync is a web app for listening to music together in real time. A user creates a room and shares a 4-character code or an invite link. Everyone who joins hears the same song at the same moment.

Built by **Jed Manaloto** and **Christine Fauni** with Node.js, Express, and Socket.IO. The interface uses a honeybee pixel art theme.

**Live demo:** <https://wesync-shmf.onrender.com>

## Features

- **Rooms.** A room is created with a 4-character code. An invite link fills in the code automatically for anyone who opens it.
- **Synced playback.** Play, pause, seek, and song changes apply to every listener in the room. The server sends a sync tick every few seconds, which corrects small drifts.
- **Shared playlist.** Any member can upload MP3 files by selecting them or dragging them onto the page. Songs can be searched by title.
- **Shared queue.** Songs can be added to an "Up next" list, removed, and reordered by dragging or with the up and down buttons.
- **Next and previous.** Navigation moves through the queue or returns to the last song. The next song starts automatically when one ends.
- **Live activity messages.** Short messages report what other members do, such as pausing, skipping, or adding a song.
- **Member list.** All members in the room are listed. The first member to join is marked as the host.
- **Private room.** A room with a fixed code and a password can be enabled optionally.
- **Reconnect support.** If the connection drops, the page rejoins the room automatically.
- **Audio visualizer.** Animated pixel bars react to the music.
- **Temporary storage.** Songs belong to a single room and are deleted when the room closes.

## Tech Stack

| Area      | Tools                                          |
| --------- | ---------------------------------------------- |
| Server    | Node.js, Express 5                             |
| Real time | Socket.IO 4                                    |
| Uploads   | Multer                                         |
| Frontend  | HTML, CSS, vanilla JavaScript                  |
| Audio     | HTML audio element, Web Audio API (visualizer) |
| Fonts     | Pixelify Sans and VT323 (Google Fonts)         |

## Getting Started

### Requirements

[Node.js](https://nodejs.org) 18 or newer. Version 20.12 or newer is recommended, because it loads the optional `.env` file natively.

### Installation

```bash
npm install
npm start
```

The app is then available at <http://localhost:3000>.

### Development

`npm run dev` restarts the server whenever a file changes. On Windows, `start.bat` opens the browser and starts the dev server.

### Testing with multiple listeners

- **Same network:** open `http://<local-ip-of-the-host-computer>:3000` on the other device.
- **Single machine:** open the page in two browser tabs.

## Usage

1. Enter a nickname and select **Create Room**. A 4-character room code is generated.
2. Select **Copy invite link** and send it to another person. They enter a nickname and select **Join Room**.
3. Add songs with **Add songs** or by dropping MP3 files on the page.
4. Click a song to play it for everyone, or add it to the queue to play it next.
5. When music is already playing, a new listener sees a **Tap to join the listening** button. Browsers block sound until the user interacts with the page, so this single tap starts the audio in sync.

Volume is local. Each listener controls their own.

## Configuration

All settings are optional. They can be set as environment variables on the host or in a local `.env` file. The server must be restarted after a change.

| Variable                 | Default | Description                                               |
| ------------------------ | ------- | --------------------------------------------------------- |
| `PORT`                   | `3000`  | Port the server listens on.                               |
| `MAX_SONGS_PER_ROOM`     | `20`    | Most songs one room can upload.                           |
| `MAX_TOTAL_MB`           | `2048`  | Most disk space all rooms together can use, in megabytes. |
| `MAX_UPLOADS_PER_MINUTE` | `20`    | Most uploads one user can start per minute.               |
| `ROOM_GRACE_SECONDS`     | `180`   | How long an empty room is kept before it is deleted.      |
| `PRIVATE_ROOM_CODE`      | none    | Code of the private room (4 letters or numbers).          |
| `PRIVATE_ROOM_PASSWORD`  | none    | Password of the private room.                             |
| `PRIVATE_ROOM_MAX_SONGS` | `50`    | Most songs the private room can hold.                     |

Example `.env` file:

```
PRIVATE_ROOM_CODE=LOVE
PRIVATE_ROOM_PASSWORD=choose-something-only-you-know
PRIVATE_ROOM_MAX_SONGS=50
```

### Private room

The private room is enabled when **both** `PRIVATE_ROOM_CODE` and `PRIVATE_ROOM_PASSWORD` are set. It is created every time the server starts and is protected by the password. It is never deleted when it empties, but its songs are removed after it has been empty for a while.

The `.env` file must never be committed. It is already listed in `.gitignore`.

## Project Structure

```
Wesync/
├── server.js          Express and Socket.IO server: rooms, sync, queue, uploads
├── public/
│   ├── index.html     Page layout
│   ├── style.css      Honeybee pixel theme
│   ├── app.js         Main client logic: rooms, audio sync, playlist, queue
│   ├── roominfo.js    Member count, copy invite link, leave room
│   ├── visualizer.js  Animated audio bars
│   └── library.js     Older song list (no longer loaded)
├── music/             Temporary uploaded songs, one folder per room
├── start.bat          Windows shortcut to start the dev server
└── package.json
```

## Deployment

Wesync runs on any host that can run a Node.js server and keep WebSocket connections open, such as Render.

- **Build command:** `npm install`
- **Start command:** `npm start`
- **Environment variables:** any variable from the configuration table can be set in the host's settings.

Notes:

- Rooms are stored in the server's memory, so only **one instance** can run. Multiple instances do not share room data.
- Uploaded songs are temporary. They are deleted when a room closes and when the server restarts.
- On a free hosting plan, the service may sleep after a period of inactivity, which makes the first request afterward slow to load.

## Limits

| Limit                 | Value          |
| --------------------- | -------------- |
| File type             | MP3 only       |
| File size             | 20 MB per song |
| Queue length          | 50 songs       |
| Previous song history | 20 songs       |
| Nickname length       | 20 characters  |

## Documentation

- [DOCUMENTATION.md](./DOCUMENTATION.md): how the server and client work, with a reference for every socket event and endpoint.
- [THEME.md](./THEME.md): colors, fonts, and pixel sprites of the honeybee theme.

## A Note on Music

Only music that the uploader has the right to share should be uploaded. This repository does not include any songs.

## Authors

- **Jed Manaloto**: [GitHub](https://github.com/Jedskibidi)
- **Christine Fauni**: [GitHub](https://github.com/christinefauni)
