// Import hang web components - these self-register as custom elements
import "@kixelated/hang/publish/element";
import "@kixelated/hang/watch/element";
import "@kixelated/hang/support/element";

import { getCurrentUser, login, logout, type User } from "./auth";

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

// Update the auth UI based on login state
function updateAuthUI(user: User | null) {
  const authContainer = document.getElementById("auth-container");
  if (!authContainer) return;

  if (user) {
    authContainer.innerHTML = `
      <div class="user-info">
        <img src="${user.avatar_url}" alt="${user.name}" class="avatar">
        <span class="user-name">${user.name}</span>
        <button id="logout-btn" class="btn">Sign Out</button>
      </div>
    `;
    document.getElementById("logout-btn")?.addEventListener("click", logout);
  } else {
    authContainer.innerHTML = `
      <button id="login-btn" class="btn btn-google">
        <svg viewBox="0 0 24 24" width="18" height="18" style="margin-right: 8px;">
          <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
          <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
        </svg>
        Sign in with Google
      </button>
    `;
    document.getElementById("login-btn")?.addEventListener("click", login);
  }
}

// Initialize auth state
async function initAuth() {
  const user = await getCurrentUser();
  updateAuthUI(user);
}

// Initialize the app
async function init() {
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

  // Browser support toggle
  const supportLink = document.getElementById("support-link");
  const supportPanel = document.getElementById("support-panel");
  if (supportLink && supportPanel) {
    supportLink.addEventListener("click", (e) => {
      e.preventDefault();
      const wasHidden = supportPanel.classList.contains("hidden");
      supportPanel.classList.toggle("hidden");

      // Click the Details button inside hang-support to expand it
      if (wasHidden) {
        const hangSupport = supportPanel.querySelector("hang-support");
        if (hangSupport?.shadowRoot) {
          const detailsBtn = hangSupport.shadowRoot.querySelector("button");
          if (detailsBtn) detailsBtn.click();
        }
      }
    });
  }

  // Initialize authentication
  await initAuth();
}

// Run when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
