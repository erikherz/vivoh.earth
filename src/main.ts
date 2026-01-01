// Import hang web components - these self-register as custom elements
import "@kixelated/hang/publish/element";
import "@kixelated/hang/watch/element";
import "@kixelated/hang/support/element";

const RELAY_URL = "https://relay.cloudflare.mediaoverquic.com";
const NAMESPACE_PREFIX = "vivoh.earth";

// Generate a random room ID
function generateRoomId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Get room ID from URL or generate new one
function getRoomId(): string {
  const params = new URLSearchParams(window.location.search);
  let room = params.get("room");

  if (!room) {
    room = generateRoomId();
    // Update URL without reload
    const newUrl = `${window.location.pathname}?room=${room}`;
    window.history.replaceState({}, "", newUrl);
  }

  return room;
}

// Initialize the app
function init() {
  const roomId = getRoomId();
  const streamName = `${NAMESPACE_PREFIX}/${roomId}`;
  const shareUrl = `${window.location.origin}?room=${roomId}`;

  console.log(`Vivoh.Earth MoQ initialized - Room: ${roomId}`);

  // Update the page with room info
  const roomDisplay = document.getElementById("room-id");
  const shareLink = document.getElementById("share-link") as HTMLInputElement;
  const copyBtn = document.getElementById("copy-btn");

  if (roomDisplay) roomDisplay.textContent = roomId;
  if (shareLink) shareLink.value = shareUrl;

  // Copy button functionality
  if (copyBtn && shareLink) {
    copyBtn.addEventListener("click", () => {
      shareLink.select();
      navigator.clipboard.writeText(shareUrl);
      copyBtn.textContent = "Copied!";
      setTimeout(() => {
        copyBtn.textContent = "Copy";
      }, 2000);
    });
  }

  // Set stream name on hang elements
  const publisher = document.querySelector("hang-publish");
  const watcher = document.querySelector("hang-watch");

  if (publisher) {
    publisher.setAttribute("url", RELAY_URL);
    publisher.setAttribute("name", streamName);
  }

  if (watcher) {
    watcher.setAttribute("url", RELAY_URL);
    watcher.setAttribute("name", streamName);
  }

  // New room button
  const newRoomBtn = document.getElementById("new-room-btn");
  if (newRoomBtn) {
    newRoomBtn.addEventListener("click", () => {
      const newRoom = generateRoomId();
      window.location.href = `?room=${newRoom}`;
    });
  }
}

// Run when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
