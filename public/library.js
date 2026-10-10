(() => {
  let songs = []; // [{ file, title }] from /songs
  let loadState = "loading"; // "loading" | "ready" | "error"
  let filterText = "";

  // A few rules for the parts that her theme does not cover
  const style = document.createElement("style");
  style.textContent = `
    .lib-actions { margin-left: auto; display: flex; gap: 6px; flex: none; }
    #library .track { flex-wrap: wrap; }
    #library .field-row { margin-bottom: 0.75rem; }
  `;
  document.head.appendChild(style);

  // ---------- Build the card ----------

  function createRoot() {
    const section = document.createElement("section");
    section.id = "library";
    section.className = "card";
    section.hidden = true;

    const player = document.getElementById("player");
    if (player) player.insertAdjacentElement("afterend", section);
    else (document.querySelector("main") || document.body).appendChild(section);
    return section;
  }

  const root = document.getElementById("library") || createRoot();
  root.innerHTML = "";

  const heading = document.createElement("h3");
  heading.textContent = "Song library";

  const toolbar = document.createElement("div");
  toolbar.className = "field-row";

  const search = document.createElement("input");
  search.className = "input";
  search.type = "search";
  search.placeholder = "Search songs";
  search.autocomplete = "off";
  search.setAttribute("aria-label", "Search songs");

  const refreshButton = document.createElement("button");
  refreshButton.className = "btn btn-sm btn-secondary";
  refreshButton.type = "button";
  refreshButton.textContent = "Refresh";

  toolbar.append(search, refreshButton);

  const status = document.createElement("p");
  status.className = "empty";
  status.hidden = true;

  const list = document.createElement("ul");
  list.className = "track-list";

  root.append(heading, toolbar, status, list);

  // ---------- Draw the list ----------

  function setStatus(text, loading = false) {
    status.textContent = "";
    if (loading) status.append(makeSpinner()); // from app.js
    status.append(text);
    status.hidden = !text;
  }

  // Mark the row of the song that is playing right now
  function highlight() {
    list.querySelectorAll(".track").forEach((row) => {
      const active = row.dataset.file === currentSong;
      row.classList.toggle("is-active", active);
      if (active) row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
    });
  }

  function render() {
    list.innerHTML = "";

    if (loadState === "loading") return setStatus("Loading songs...", true);
    if (loadState === "error") {
      return setStatus(
        "We couldn't load the song list. Check your connection and press Refresh.",
      );
    }
    if (songs.length === 0) return setStatus("No songs yet, upload one!");

    const query = filterText.trim().toLowerCase();
    const matches = songs.filter((song) =>
      song.title.toLowerCase().includes(query),
    );
    if (matches.length === 0) {
      return setStatus(`No songs match "${filterText.trim()}"`);
    }

    setStatus("");
    matches.forEach((song) => list.appendChild(buildRow(song)));
    highlight();
  }

  // textContent (not innerHTML) so a file name can never inject HTML
  function buildRow(song) {
    const row = document.createElement("li");
    row.className = "track";
    row.dataset.file = song.file;

    const info = document.createElement("div");
    info.className = "info";
    const title = document.createElement("span");
    title.className = "track-title";
    title.textContent = song.title;
    info.appendChild(title);

    const actions = document.createElement("div");
    actions.className = "lib-actions";

    const playButton = document.createElement("button");
    playButton.className = "btn btn-sm";
    playButton.type = "button";
    playButton.textContent = "Play";
    playButton.setAttribute("aria-label", `Play ${song.title}`);
    playButton.onclick = () => playSong(song.file);

    const queueButton = document.createElement("button");
    queueButton.className = "btn btn-sm btn-secondary";
    queueButton.type = "button";
    queueButton.textContent = "Add to queue";
    queueButton.setAttribute("aria-label", `Add to queue: ${song.title}`);
    queueButton.onclick = () => addSongToQueue(song, queueButton);

    actions.append(playButton, queueButton);
    row.append(info, actions);
    return row;
  }

  // ---------- Actions ----------

  // Play now, for everyone in the room: change the song, then press play.
  function playSong(file) {
    if (!inRoom) return showError("Join a room first");

    // Our own audio right away (same steps as the Set song + Play buttons)
    loadSong(file);
    remember(0, true);
    needsSync = true;
    playAudio();

    // Everyone else
    sendToRoom("changeSong", { song: file });
    sendToRoom("play", { position: 0 });
  }

  // The server answers with queueUpdate, which redraws "Up next" for everyone
  function addSongToQueue(song, button) {
    if (!inRoom) return showError("Join a room first");
    socket.emit("addToQueue", { song: song.file });
    // The button text changes, but a screen reader would not say it
    // (the focus stays on the button), so also say it as a toast.
    showToast(`Added to queue: ${song.title}`);

    button.textContent = "Added!";
    setTimeout(() => {
      button.textContent = "Add to queue";
    }, 1200);
  }

  // ---------- Loading the list ----------

  function loadLibrary() {
    loadState = "loading";
    render();

    fetch("/songs")
      .then((res) => {
        if (!res.ok) throw new Error("Bad response from /songs");
        return res.json();
      })
      .then((data) => {
        songs = Array.isArray(data) ? data : [];
        loadState = "ready";
        render();
      })
      .catch(() => {
        loadState = "error";
        render();
      });
  }

  // ---------- Show only while we are in a room ----------

  let wasVisible = false;

  function refreshVisibility() {
    root.hidden = !inRoom;
    // Reload the list each time we enter a room, so it matches music/
    if (inRoom && !wasVisible) loadLibrary();
    wasVisible = inRoom;
  }

  // ---------- Wiring ----------

  search.addEventListener("input", () => {
    filterText = search.value;
    render();
  });

  refreshButton.onclick = loadLibrary;

  // The upload feature can announce a new song with this event
  document.addEventListener("songsChanged", loadLibrary);

  audio.addEventListener("loadstart", highlight);
  audio.addEventListener("emptied", highlight);
  socket.on("roomState", highlight);
  socket.on("changeSong", highlight);
  socket.on("roomState", refreshVisibility);
  socket.on("disconnect", refreshVisibility);
  socket.on("roomError", refreshVisibility);
  document.addEventListener("roomLeft", refreshVisibility);

  loadLibrary();
  refreshVisibility();
})();