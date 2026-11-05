# Wesync

Wesync is a web app for listening to music together in real time. A user creates a room and shares a 4-character code or an invite link. Everyone who joins hears the same song at the same moment.

Built by **Jed Manaloto** and **Christine Fauni** with Node.js, Express, and Socket.IO. The interface uses a honeybee pixel art theme.

The project has two parts: a Node.js server in `server/` and a static client in `client/`. They are hosted separately (server on Render, client on Vercel).

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
| Hosting   | Render (server), Vercel (client)               |

## Getting Started

### Requirements

[Node.js](https://nodejs.org) 18 or newer. Version 20.12 or newer is recommended, because it loads the optional `.env` file natively.

### Installation

```bash
cd server
npm install
```

Local settings are stored in `server/.env`. For development, the file contains:

```
SERVE_CLIENT=true
```

`SERVE_CLIENT=true` makes the server also serve the `client/` folder, so the whole app runs from one address during development. Without it, the server provides only the API.

```bash
npm start
```

The app is then available at <http://localhost:3000>.

### Development

`npm run dev` (inside `server/`) restarts the server whenever a file changes. On Windows, `server/start.bat` enables `SERVE_CLIENT`, opens the browser, and starts the dev server. Client files are read from disk on each request, so a browser refresh is enough to see client changes.

### Testing with multiple listeners

- **Same network:** open `http://<local-ip-of-the-host-computer>:3000` on the other device.
- **Single machine:** open the page in two browser tabs.

`client/config.js` treats `localhost`, `127.0.0.1`, and addresses starting with `192.168.` or `10.` as local and uses the same origin as the page. Other address ranges require changing the check in that file.

## Usage

1. A nickname is entered and **Create Room** is selected. A 4-character room code is generated.
2. **Copy invite link** provides a link that can be shared. The recipient enters a nickname and selects **Join Room**.
3. Songs are added with **Add songs** or by dropping MP3 files on the page.
4. Clicking a song plays it for everyone. Adding a song to the queue plays it next.
5. When music is already playing, a new listener sees a **Tap to join the listening** button. Browsers block sound until the user interacts with the page, so this single tap starts the audio in sync.

Volume is local. Each listener controls their own.

## Configuration

Settings are read by the server. They can be set as environment variables on the host or in a local `server/.env` file. The server must be restarted after a change. `CLIENT_ORIGINS` is required when the client is hosted separately; every other setting is optional.

| Variable                 | Default | Description                                                                                                                   |
| ------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                   | `3000`  | Port the server listens on.                                                                                                   |
| `MAX_SONGS_PER_ROOM`     | `20`    | Most songs one room can upload.                                                                                               |
| `MAX_TOTAL_MB`           | `2048`  | Most disk space all rooms together can use, in megabytes.                                                                     |
| `MAX_UPLOADS_PER_MINUTE` | `20`    | Most uploads one user can start per minute.                                                                                   |
| `ROOM_GRACE_SECONDS`     | `180`   | How long an empty room is kept before it is deleted.                                                                          |
| `PRIVATE_ROOM_CODE`      | none    | Code of the private room (4 letters or numbers).                                                                              |
| `PRIVATE_ROOM_PASSWORD`  | none    | Password of the private room.                                                                                                 |
| `PRIVATE_ROOM_MAX_SONGS` | `50`    | Most songs the private room can hold.                                                                                         |
| `CLIENT_ORIGINS`         | none    | Comma-separated frontend addresses allowed to connect, without a trailing slash, for example `https://wesync-one.vercel.app`. |
| `SERVE_CLIENT`           | none    | When `true`, the server also serves the `client/` folder. For local development only.                                         |

### Private room

The private room is enabled when **both** `PRIVATE_ROOM_CODE` and `PRIVATE_ROOM_PASSWORD` are set. It is created every time the server starts and is protected by the password. It is never deleted when it empties, but its songs are removed after it has been empty for a while.

## Project Structure

```
Wesync/
├── server/
│   ├── server.js      Express and Socket.IO server: rooms, sync, queue, uploads
│   ├── music/         Temporary uploaded songs, one folder per room
│   ├── start.bat      Windows shortcut to start the dev server
│   └── package.json
└── client/
    ├── index.html     Page layout
    ├── config.js      Address of the server
    ├── style.css      Honeybee pixel theme
    ├── app.js         Main client logic: rooms, audio sync, playlist, queue
    ├── roominfo.js    Member count, copy invite link, leave room
    └── visualizer.js  Animated audio bars
```

## Deployment

The server and the client are deployed separately.

### Server (Render)

The server needs a host that can run a Node.js process and keep WebSocket connections open.

- **Root directory:** `server`
- **Build command:** `npm install`
- **Start command:** `npm start`
- **Environment variables:** `CLIENT_ORIGINS` set to the address of the client (for example `https://wesync-one.vercel.app`, without a trailing slash), plus any other variable from the configuration table. `SERVE_CLIENT` is not set in production.

### Client (Vercel)

The client is a static site with no build step.

- **Root directory:** `client`
- **Framework preset:** Other
- **Build command:** none

The server's address (for example `https://wesync-shmf.onrender.com`) must be set in `client/config.js` before deploying.

### Notes

- Rooms are stored in the server's memory, so only **one instance** can run. Multiple instances do not share room data.
- Uploaded songs are temporary. They are deleted when a room closes and when the server restarts.
- On a free hosting plan, the server may sleep after a period of inactivity, which makes the first connection afterward slow.
- Only addresses listed in `CLIENT_ORIGINS` can connect. Vercel preview deployments use different addresses and are refused unless added to the list.

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
