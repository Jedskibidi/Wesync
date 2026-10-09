// Room info (task 9): member count, "Copy invite link", "Leave room".
//
// Works on the #roomInfo card that index.html already has, and uses the
// existing #room element. Does not touch index.html or style.css.
//
// It uses these things from app.js:
//   socket, inRoom, lastRoom, rejoining, pendingAction,
//   clearSong(), hideOverlay(), clearUrl(), showMessage(), showError(),
//   showLanding(), clearFieldErrors()
// Keep those names if app.js is ever changed.

(() => {
  const card = document.getElementById("roomInfo");
  if (!card) return; // the page has no room card, nothing to fill

  // ---------- Build the extra parts ----------

  const count = document.createElement("p");
  count.className = "room-info";
  count.textContent = "1 person in this room";

  // Put the count right under the "Room: XXXX" line
  const roomLine = document.getElementById("room").closest("p");
  if (roomLine) roomLine.insertAdjacentElement("afterend", count);
  else card.appendChild(count);

  const buttons = document.createElement("div");
  buttons.className = "field-row";

  const copyButton = document.createElement("button");
  copyButton.className = "btn btn-sm btn-secondary";
  copyButton.type = "button";
  copyButton.textContent = "Copy invite link";

  const leaveButton = document.createElement("button");
  leaveButton.className = "btn btn-sm btn-secondary";
  leaveButton.type = "button";
  leaveButton.textContent = "Leave room";

  buttons.append(copyButton, leaveButton);
  card.appendChild(buttons);

  // ---------- Member count ----------

  function showCount(members) {
    const n = members.length;
    count.textContent =
      n === 1 ? "1 person in this room" : `${n} people in this room`;
  }

  socket.on("roomState", (state) => showCount(state.members));
  socket.on("membersUpdate", (data) => showCount(data.members));

  // ---------- Copy invite link ----------

  // The link uses the address you opened the site with, plus ?room=CODE
  function inviteLink() {
    const code = document.getElementById("room").textContent.trim();
    return `${location.origin}${location.pathname}?room=${code}`;
  }

  async function copyText(text) {
    // The modern way (needs https or localhost)
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (err) {
        // fall through to the older way
      }
    }

    // The older way, which also works on plain http addresses
    const box = document.createElement("textarea");
    box.value = text;
    box.setAttribute("readonly", "");
    box.style.position = "fixed";
    box.style.opacity = "0";
    document.body.appendChild(box);
    box.select();

    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (err) {
      ok = false;
    }
    box.remove();
    return ok;
  }

  let copiedTimer = null;

  copyButton.onclick = async () => {
    if (!inRoom) return;

    const ok = await copyText(inviteLink());
    if (!ok) {
      showError(
        "Could not copy automatically. Copy the link from the address bar.",
      );
      return;
    }

    copyButton.textContent = "Copied!";
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copyButton.textContent = "Copy invite link";
    }, 1500);
  };

  // ---------- Leave room ----------

  leaveButton.onclick = () => {
    if (!inRoom) return;
    socket.emit("leaveRoom");
  };

  // The server says we are out: go back to the first screen
  socket.on("leftRoom", () => {
    inRoom = false;
    lastRoom = null; // so we do NOT rejoin by ourselves later
    rejoining = false;
    pendingAction = null;

    clearSong();
    hideOverlay();
    clearUrl();
    clearFieldErrors();
    showMessage("");
    document.getElementById("code").value = "";
    copyButton.textContent = "Copy invite link";

    showLanding();

    // Tell other parts (like the song library) that we left
    document.dispatchEvent(new Event("roomLeft"));
  });
})();
