/**
 * @file roominfo.js
 * @description Fills the #roomInfo card in index.html with the member count,
 * a "Copy invite link" button, and a "Leave room" button. Uses the existing
 * #room element and does not touch index.html or style.css.
 * Depends on these names from app.js (keep them if app.js changes): socket,
 * inRoom, lastRoom, rejoining, pendingAction, clearSong(), hideOverlay(),
 * clearUrl(), showMessage(), showError(), showToast(), showLanding(),
 * clearFieldErrors().
 * @location client\roominfo.js
 */

(() => {
  const card = document.getElementById("roomInfo");
  if (!card) return;

  const count = document.createElement("p");
  count.className = "room-info";
  count.textContent = "1 person in this room";

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

  function showCount(members) {
    const n = members.length;
    count.textContent =
      n === 1 ? "1 person in this room" : `${n} people in this room`;
  }

  socket.on("roomState", (state) => showCount(state.members));
  socket.on("membersUpdate", (data) => showCount(data.members));

  function inviteLink() {
    const code = document.getElementById("room").textContent.trim();
    return `${location.origin}${location.pathname}?room=${code}`;
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (err) {}
    }

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
    showToast("Invite link copied");
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copyButton.textContent = "Copy invite link";
    }, 1500);
  };

  leaveButton.onclick = () => {
    if (!inRoom) return;
    socket.emit("leaveRoom");
  };

  socket.on("leftRoom", () => {
    inRoom = false;
    lastRoom = null;
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

    document.dispatchEvent(new Event("roomLeft"));
  });
})();
