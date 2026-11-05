# Wesync: Developer Documentation

This document describes how Wesync works and how to modify it. For setup and basic usage, see the [README](./README.md).

## Contents

1. [Overview](#1-overview)
2. [Rooms](#2-rooms)
3. [Playback synchronization](#3-playback-synchronization)
4. [Socket events reference](#4-socket-events-reference)
5. [HTTP endpoints](#5-http-endpoints)
6. [Songs and uploads](#6-songs-and-uploads)
7. [Queue and history](#7-queue-and-history)
8. [Private room](#8-private-room)
9. [Security measures](#9-security-measures)
10. [The client](#10-the-client)
11. [Configuration and limits](#11-configuration-and-limits)
12. [Common tasks](#12-common-tasks)
13. [Known limitations](#13-known-limitations)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Overview

Wesync runs as a single Node.js process with three responsibilities:

1. **Serving the website.** Express serves every file in `public/`.
2. **Keeping room state.** Socket.IO connects every browser to the server, and the server decides what is playing, at what position, and for whom.
3. **Storing uploaded songs.** Multer saves MP3 files into `music/<ROOM CODE>/`, and Express serves them back to the members of that room.

```
Browser A ──┐                         ┌── music/AB12/song.mp3
Browser B ──┼── Socket.IO + HTTP ──► server.js ──┤
Browser C ──┘                         └── rooms (Map, in memory)
```

The server is the **single source of truth**. Browsers send actions (play, pause, seek, change song), the server updates the room, and then it notifies the other members.

There is no database and no login. All room data lives in memory and is discarded when the room closes.

---

## 2. Rooms

A room is an object stored in a `Map` called `rooms`, keyed by its code.

| Field                                  | Meaning                                                    |
| -------------------------------------- | ---------------------------------------------------------- |
| `code`                                 | 4 characters, for example `AB12`.                          |
| `members`                              | A `Map` of socket id to nickname. Insertion order matters. |
| `currentSong`                          | File name of the loaded song, or `null`.                   |
| `pickedBy`                             | Nickname of the member who picked the current song.        |
| `isPlaying`, `position`, `lastUpdated` | The playback state (see section 3).                        |
| `queue`                                | List of `{ id, file, title, by }`.                         |
| `history`                              | Previously played songs, used by "previous".               |
| `songs`                                | A `Map` of the songs uploaded to the room.                 |
| `bytes`, `pendingUploads`              | Disk space used and uploads still in progress.             |
| `permanent`, `password`                | Set only for the private room.                             |
| `tickTimer`, `deleteTimer`             | Timers for sync ticks and for deleting an empty room.      |

### Room codes

Codes consist of 4 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. The letters `I` and `O` and the digits `0` and `1` are excluded to avoid confusion when reading or typing a code. The server generates codes until it finds one that is not in use.

### Joining and leaving

- **Create.** `createRoom` creates a room with the sender as the first member and starts its sync ticks.
- **Join.** `joinRoom` validates the nickname, the code, the room's password (if it has one), and that the nickname is not already taken in that room (case-insensitive).
- **Host.** The host is the member who joined first. If the host leaves, the next member in line becomes the host. The host has **no special privileges**: every member can play, pause, seek, change songs, and edit the queue. The host tag appears only in the member list.
- **Leave.** `leaveRoom` (or a disconnect) removes the member. If the room becomes empty, playback is frozen and a delete timer starts.

### Empty rooms and the grace period

When the last member leaves, the room is **not deleted immediately**. It is kept for `ROOM_GRACE_SECONDS` (180 by default), so a page refresh or a short network drop does not erase the songs. If a member joins in time, the timer is cancelled. Otherwise, `destroyRoom()` stops the timers, removes the room from memory, and deletes its song folder.

When the server starts, and when it stops with Ctrl+C, every room folder inside `music/` is deleted. Songs from before a restart would belong to rooms that no longer exist.

---

## 3. Playback synchronization

The server does not stream audio in sync. Each browser plays its own copy of the file, and the server only shares **the position the room should be at**.

### The room clock

The server stores three values: `isPlaying`, `position` (seconds), and `lastUpdated` (a timestamp). The current position is computed by `getCurrentPosition(room)`:

```
if paused:   position
if playing:  position + (now - lastUpdated) in seconds
```

As a result, no client needs to send its position continuously. A new listener requests the current position and calculates from there.

### Actions are not echoed

When a member presses pause, their browser pauses immediately and then sends `pause` to the server. The server updates the room and sends `pause` to every member **except** the sender (`socket.to(room.code)`), so the sender does not handle their own action twice.

Actions that change many things at once (`next`, `previous`, a song ending) use `broadcastState`, which sends the full `roomState` to **all** members, including the sender.

### Sync ticks

Every 4 seconds, the server sends each room a `syncTick` containing the correct position and the playing state. Each browser compares that position with its own audio time. If the difference exceeds **0.3 seconds** (`DRIFT_LIMIT_SECONDS` in `app.js`), the browser seeks to the correct position. Ticks are ignored while the audio is loading, while the seek bar is being dragged, and after the song has ended.

A room with no members or no current song sends no ticks.

### Joining while music is playing

Browsers block audio until the user has interacted with the page. A late joiner would otherwise hear nothing, so the page shows the **Tap to join the listening** overlay. The click satisfies the browser's requirement, and the page then seeks to the room's current position (not the position at the time the overlay opened).

---

## 4. Socket events reference

### From the browser to the server

| Event             | Data                            | What it does                                                  |
| ----------------- | ------------------------------- | ------------------------------------------------------------- |
| `createRoom`      | `{ nickname }`                  | Creates a room and joins it.                                  |
| `joinRoom`        | `{ nickname, code, password? }` | Joins a room. Also used to rejoin after a dropped connection. |
| `leaveRoom`       | none                            | Leaves the room but stays connected.                          |
| `getState`        | none                            | Requests the current room state.                              |
| `play`            | `{ position? }`                 | Starts playback. Requires a current song.                     |
| `pause`           | `{ position? }`                 | Pauses playback.                                              |
| `seek`            | `{ position }`                  | Jumps to a position.                                          |
| `changeSong`      | `{ song }`                      | Loads a song from the room's playlist, paused at 0:00.        |
| `addToQueue`      | `{ song }`                      | Adds a song to the end of the queue.                          |
| `removeFromQueue` | `{ id }`                        | Removes a queue item.                                         |
| `reorderQueue`    | `{ id, toIndex }`               | Moves a queue item to a new position.                         |
| `next`            | none                            | Plays the first song in the queue.                            |
| `previous`        | none                            | Returns to the last song that played.                         |
| `songEnded`       | `{ song }`                      | A browser reports that its audio reached the end.             |

### From the server to the browser

| Event                   | Sent to                       | Data                                                                                             |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `roomState`             | One member, or the whole room | Full snapshot: code, members, host, current song, who picked it, playing state, position, queue. |
| `membersUpdate`         | Other members                 | `{ members, host }`                                                                              |
| `queueUpdate`           | All members                   | `{ queue }`                                                                                      |
| `songsUpdate`           | All members                   | `{ by, title }`. A song was uploaded, so the playlist reloads.                                   |
| `play`, `pause`, `seek` | Other members                 | `{ position, by }`                                                                               |
| `changeSong`            | Other members                 | `{ song, by }`                                                                                   |
| `syncTick`              | All members                   | `{ position, isPlaying }`                                                                        |
| `activity`              | Other members                 | `{ type, by, title? }`. Used for the short activity messages.                                    |
| `roomError`             | One member                    | `{ message }`                                                                                    |
| `leftRoom`              | One member                    | Confirms `leaveRoom`.                                                                            |
| `onlineCount`           | All connected clients         | Number of connected browsers.                                                                    |

### Activity message types

`queueAdd`, `queueRemove`, `queueMove`, `next`, and `previous`. Play, pause, seek, and song changes have their own events, which already carry the `by` name.

### Error handling

Every event handler is wrapped in `handle()`. If a browser sends a value that is not an object, an empty object is used instead. If a handler throws, the server logs the error, sends a `roomError` to the affected member, and continues running.

---

## 5. HTTP endpoints

| Method and path                          | Purpose                                                           |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `GET /` and static files                 | Serves everything in `public/`.                                   |
| `POST /upload?room=AB12&sid=<socket id>` | Uploads one MP3 to a room.                                        |
| `GET /songs?room=AB12&sid=<socket id>`   | Lists the room's songs, newest first, as `[{ file, title }]`.     |
| `GET /music/AB12/<file>`                 | Serves the audio file. Supports range requests, so seeking works. |

### Proof of membership

The `/upload` and `/songs` endpoints require the room code **and** the caller's own socket id (`sid`). Only that browser knows its socket id, and the server verifies that the id belongs to a member of that room. This prevents listing or uploading to rooms the caller has not joined.

### JSON errors

Error responses use the shape `{ ok: false, error: "message" }`. A final Express error handler ensures that even malformed requests receive a JSON response instead of an HTML error page.

---

## 6. Songs and uploads

### Upload steps

1. **`uploadGuard`** runs **before** the file is read. It checks that the caller is in the room, that the room is under its song limit, that free space remains on the server, and that the caller has not exceeded the upload rate limit. If any check fails, the request is refused and nothing is written to disk. If all checks pass, a slot and the required space are reserved for the upload.
2. **Multer** saves the file into `music/<ROOM CODE>/`. It accepts one file of at most 20 MB, and only if the extension is `.mp3`.
3. The server records the song in `room.songs`, adds its size to the totals, and emits `songsUpdate` so every browser reloads its list.

The reserved slot is released when the request ends, whether it succeeded or not.

### Refusal codes

| Status | Reason                                       |
| ------ | -------------------------------------------- |
| `403`  | The caller is not in the room.               |
| `409`  | The room reached its song limit.             |
| `429`  | Too many uploads in a minute.                |
| `507`  | The server's storage is full.                |
| `400`  | Wrong file type, file too large, or no file. |
| `410`  | The room closed while the file was arriving. |

### File names and titles

The saved name is `<timestamp>-<cleaned original name>.mp3`. Special characters are removed and spaces become hyphens. The timestamp is incremented if two uploads arrive in the same millisecond, so names never collide. The displayed title is derived by removing the timestamp and converting hyphens back into spaces, so `1700000000000-Magnolia-Remix.mp3` is displayed as `Magnolia Remix`.

---

## 7. Queue and history

### Queue

Any member can add, remove, or reorder songs. After every change, the server sends the **entire queue** to all members, including the sender. The queue is shared state rather than an action, so no echo problem arises. The queue holds at most 50 songs.

Each item has its own `id`. Moves and removals use that id instead of the item's position, so they stay correct even if the queue changed moments earlier. The `by` field records who added the song, so the "Picked by" label is correct when the song starts playing.

### Reordering

On desktop, items can be dragged. On touch screens and with the keyboard, small up and down buttons send the same `reorderQueue` event.

### Next, previous, and song end

- **`next`** takes the first item from the queue and plays it. If the queue is empty, the sender receives the error "The queue is empty".
- **`previous`** returns to the last song in the history. The song being left is placed at the **front of the queue**, so pressing next returns to it.
- **`songEnded`** is sent by every browser when its audio ends, all at about the same time. The server acts on the **first** report and ignores the rest. It also ignores any report that arrives within 2 seconds of a song change. If nothing is queued, playback stops at 0:00.
- The history stores the last 20 songs.

A song picked from the playlist starts **paused at 0:00** on the server, and the picker's browser then sends `play`. A song started by `next`, `previous`, or the end of a song starts playing immediately.

---

## 8. Private room

A private room has a fixed code and a password, and is intended for a regular group of people. It is enabled by setting `PRIVATE_ROOM_CODE` and `PRIVATE_ROOM_PASSWORD` together (see the README).

How it differs from a normal room:

- It is created every time the server starts.
- It is **never deleted** when it empties. After the grace period, its songs, queue, and history are cleared, but the room stays open.
- Joiners must send the password. The page shows a password field only when the server reports that the room requires one.
- It has its own song limit (`PRIVATE_ROOM_MAX_SONGS`).

If only one of the two settings is provided, or the code is not 4 letters or numbers, the room is **not created** and a warning is written to the server log. The server never creates a private room without a password.

---

## 9. Security measures

| Measure                              | Where                              | Why                                                                                                                                      |
| ------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Password comparison in constant time | `samePassword()`                   | Both values are hashed with SHA-256 and compared with `timingSafeEqual`, so response timing does not reveal how many characters matched. |
| Wrong password lockout               | `passwordsLocked()`                | After 10 wrong passwords within a minute (from any source), every attempt is refused for a while.                                        |
| Password checked first               | `joinRoom`                         | Users without the password cannot learn who is in the room.                                                                              |
| Membership check on HTTP routes      | `roomForRequest()`                 | Requires the room code and the caller's socket id.                                                                                       |
| File name cleaning                   | `validSongFile()`, the music route | `path.basename()` blocks path traversal such as `../server.js`.                                                                          |
| Only known songs are served          | `/music/:code/:file`               | A file must be in the room's song list, and the room must exist.                                                                         |
| Upload rules                         | `uploadGuard`, Multer              | Type, size, count, total storage, and rate limits.                                                                                       |
| No HTML injection                    | `app.js`                           | Song titles and nicknames are written with `textContent`, never `innerHTML`.                                                             |
| Secrets kept out of Git              | `.gitignore`                       | `.env` is ignored.                                                                                                                       |

### Limitations

- The wrong password lockout is shared by all clients, so a user guessing passwords can briefly lock out legitimate users as well.
- There are no accounts. Anyone who knows a room code can join the room unless it has a password.
- Room codes are short by design. The private room is the option for anything that must not be guessable.

---

## 10. The client

All client files are plain JavaScript in `public/`, with no build step.

| File            | Purpose                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `index.html`    | Layout: landing card (nickname, create, join), room card, player, playlist, queue, and the join overlay. |
| `app.js`        | Almost all behavior: sockets, audio sync, playlist, queue, uploads, messages.                            |
| `roominfo.js`   | Adds the member count, **Copy invite link**, and **Leave room** to the room card.                        |
| `visualizer.js` | Draws animated pixel bars on a canvas, using the Web Audio API.                                          |
| `library.js`    | An older song list. It is **no longer loaded**, since the Playlist card replaced it.                     |
| `style.css`     | The honeybee theme (see [THEME.md](./THEME.md)).                                                         |

`roominfo.js` and `visualizer.js` are loaded by `app.js` at the end, one script tag each. They use some names from `app.js` (such as `socket`, `audio`, `lastRoom`, and `showMessage`), so these names must be kept if anything is renamed.

### Main parts of `app.js`

| Section                | What it does                                                       |
| ---------------------- | ------------------------------------------------------------------ |
| Songs live in the room | Builds song addresses and the `?room=...&sid=...` query.           |
| First screen           | Inline form errors and which card is visible.                      |
| Player display         | Time, sliders, LCD text, and button states.                        |
| Queue                  | Rendering the queue, drag and drop, and the up and down buttons.   |
| Audio actions          | Local audio changes that never talk to the server.                 |
| Apply room state       | Handles the full snapshot when joining or after next and previous. |
| Remote updates         | Reacts to other members' actions and shows messages.               |
| Server messages        | Connection state, errors, and all `socket.on` handlers.            |
| Local buttons          | Changes the local audio **and** notifies the server.               |
| Playlist and upload    | The song list, search, and MP3 upload with drag and drop.          |

### Invite links

The invite link is the page address plus `?room=CODE`. When a page opens with that value, it fills in the code, shows an invitation hint, and waits for a nickname.

### Reconnecting

The page remembers the last room, nickname, and password. When the connection returns after a drop, it sends `joinRoom` again automatically, because the server no longer recognizes the old socket. While waiting, a message indicates that it is reconnecting. After a final disconnect that the browser will not retry, the page shows an offline state.

### Local-only settings

**Volume and mute are local by design.** Each listener controls their own, and nothing about them is sent to the server.

### Keyboard and touch support

The seek bar moves 5 seconds with the arrow keys. The drop zone opens the file picker from the keyboard. The queue has up and down buttons for users who cannot drag. Messages and errors use `aria` roles so screen readers announce them.

---

## 11. Configuration and limits

### Environment variables

See the table in the README. Values must be positive numbers where a number is expected. Any invalid value falls back to the default.

`.env` is loaded with `process.loadEnvFile`, which requires Node 20.12 or newer. On older versions the file is skipped without an error, so the variables must be set on the host instead. Settings already defined by the host are **not** overridden by the `.env` file.

### Fixed limits in `server.js`

| Constant                         | Value | Meaning                                                        |
| -------------------------------- | ----- | -------------------------------------------------------------- |
| `MAX_FILE_BYTES`                 | 20 MB | Largest single file. The page enforces the same limit.         |
| `TICK_INTERVAL_MS`               | 4000  | How often sync ticks are sent.                                 |
| `MAX_QUEUE_LENGTH`               | 50    | Most songs in a queue.                                         |
| `MAX_HISTORY_LENGTH`             | 20    | Songs remembered for "previous".                               |
| `SONG_END_GUARD_MS`              | 2000  | `songEnded` reports this soon after a song change are ignored. |
| `MAX_WRONG_PASSWORDS_PER_MINUTE` | 10    | Password lockout threshold.                                    |

---

## 12. Common tasks

### Change a limit

Set the matching environment variable (for example `MAX_SONGS_PER_ROOM=10`) and restart the server. For the fixed limits, edit the constant in `server.js`. The 20 MB file limit is also checked in `app.js`, so both files must be changed.

### Change how often clients are resynced

Edit `TICK_INTERVAL_MS` in `server.js` and `DRIFT_LIMIT_SECONDS` in `app.js`. A smaller drift limit corrects more often but may cause small audio jumps.

### Add a new room action

1. Add a `handle(socket, "myEvent", ...)` block in `server.js`. Call `getRoomOf(socket)` first, update the room, then emit to the other members or use `broadcastState(room)`.
2. In `app.js`, send the event with `sendToRoom("myEvent", data)` and add a `socket.on("myEvent", ...)` handler.
3. To show a message to other members, call `announce(socket, room, "type", { title })` and handle the new type in the `activity` handler.

### Change the colors or fonts

Edit the variables at the top of `style.css`. See [THEME.md](./THEME.md).

### Use a different port

Set `PORT`. Most hosts set it automatically.

---

## 13. Known limitations

- **Single server only.** Rooms live in memory, so multiple instances cannot run behind a load balancer.
- **Temporary songs.** Songs are deleted when a room closes and when the server restarts. This is intentional, but it means nothing is saved between sessions.
- **MP3 only**, up to 20 MB each.
- **No accounts.** Nicknames are not unique across rooms, and anyone with a room code can join a room that has no password.
- **Autoplay rules.** A listener who joins while music is playing must tap once before sound starts.
- **Small timing differences.** Each browser plays its own copy, so listeners may differ by a fraction of a second between ticks.

---

## 14. Troubleshooting

| Problem                                               | Likely cause and fix                                                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `Port 3000 is already in use`                         | Another instance is running. Stop it with Ctrl+C in its terminal, or set a different `PORT`.                                  |
| Private room is not created                           | Both `PRIVATE_ROOM_CODE` (4 letters or numbers) and `PRIVATE_ROOM_PASSWORD` must be set. Check the warning in the server log. |
| `.env` is ignored                                     | The Node version is older than 20.12. Update Node or set the variables on the host.                                           |
| "Room XXXX not found"                                 | The room was deleted after sitting empty past the grace period, or the code contains a typo.                                  |
| "You are not in this room" when uploading             | The page lost its connection, so the socket id changed. Wait for it to reconnect and try again.                               |
| Upload refused with "room has reached its song limit" | Raise `MAX_SONGS_PER_ROOM`, or start a new room.                                                                              |
| Upload refused with "Server storage is full"          | Raise `MAX_TOTAL_MB`, or wait for old rooms to close.                                                                         |
| A listener hears nothing                              | The browser blocked audio. The listener must press **Tap to join the listening**, or click anywhere on the page.              |
| Songs vanished after a deploy or restart              | Expected behavior. The server wipes all room folders on start.                                                                |
| Sync keeps jumping                                    | The network is unstable. Raise `DRIFT_LIMIT_SECONDS` slightly so tiny differences are ignored.                                |
| Different members see different queues                | Refresh one tab. The server sends the full queue on every change and when a member joins.                                     |
