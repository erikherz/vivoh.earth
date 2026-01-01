// Import hang web components - these self-register as custom elements
import "@kixelated/hang/publish/element";
import "@kixelated/hang/watch/element";
import "@kixelated/hang/support/element";

import {
  getCurrentUser,
  loginWithGoogle,
  loginWithMicrosoft,
  loginWithDiscord,
  logout,
  logBroadcastStart,
  logBroadcastEnd,
  logWatchStart,
  logWatchEnd,
  type User
} from "./auth";

const RELAY_URL = "https://relay.cloudflare.mediaoverquic.com";
const NAMESPACE_PREFIX = "vivoh.earth";

type View = "broadcast" | "watch";

// Generate a random stream ID
function generateStreamId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Determine current view and stream ID from URL
function getRouteInfo(): { view: View; streamId: string } {
  const path = window.location.pathname;

  // Watch view: /watch/{streamId}
  if (path.startsWith("/watch/")) {
    const streamId = path.replace("/watch/", "").split("/")[0];
    return { view: "watch", streamId: streamId || "" };
  }

  // Broadcast view: / or /?stream=xxx
  const params = new URLSearchParams(window.location.search);
  let streamId = params.get("stream");

  if (!streamId) {
    streamId = generateStreamId();
    // Update URL without reload
    const newUrl = `${window.location.pathname}?stream=${streamId}`;
    window.history.replaceState({}, "", newUrl);
  }

  return { view: "broadcast", streamId };
}

// Update the auth UI based on login state
function updateAuthUI(user: User | null) {
  const authContainer = document.getElementById("auth-container");
  const newStreamBtn = document.getElementById("new-stream-btn");

  // Hide header buttons when not logged in (login overlay will show instead)
  if (!user) {
    if (authContainer) authContainer.innerHTML = "";
    if (newStreamBtn) newStreamBtn.classList.add("hidden");
    return;
  }

  // Show New Stream button for logged in users
  if (newStreamBtn) newStreamBtn.classList.remove("hidden");

  if (!authContainer) return;

  // Show logged-in user info
  const avatarHtml = user.avatar_url
    ? `<img src="${user.avatar_url}" alt="${user.name}" class="avatar">`
    : `<div class="avatar avatar-placeholder">${user.name.charAt(0).toUpperCase()}</div>`;

  authContainer.innerHTML = `
    <div class="user-info">
      ${avatarHtml}
      <span class="user-name">${user.name}</span>
      <button id="logout-btn" class="btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
          <polyline points="16 17 21 12 16 7"/>
          <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
        Sign Out
      </button>
    </div>
  `;
  document.getElementById("logout-btn")?.addEventListener("click", logout);
}

// Show login required overlay for broadcast
function showLoginRequired() {
  const broadcastView = document.getElementById("broadcast-view");
  if (!broadcastView) return;

  const overlay = document.createElement("div");
  overlay.id = "login-overlay";
  overlay.innerHTML = `
    <div class="login-required">
      <h2>Sign in to Broadcast</h2>
      <p>Please sign in with one of the following to start broadcasting:</p>
      <div class="auth-buttons">
        <button id="overlay-login-google" class="btn btn-google">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Google
        </button>
        <button id="overlay-login-microsoft" class="btn btn-microsoft">
          <svg viewBox="0 0 21 21" width="18" height="18">
            <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
            <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
            <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
            <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
          </svg>
          Microsoft
        </button>
        <button id="overlay-login-discord" class="btn btn-discord">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
          </svg>
          Discord
        </button>
      </div>
    </div>
  `;

  broadcastView.appendChild(overlay);
  document.getElementById("overlay-login-google")?.addEventListener("click", loginWithGoogle);
  document.getElementById("overlay-login-microsoft")?.addEventListener("click", loginWithMicrosoft);
  document.getElementById("overlay-login-discord")?.addEventListener("click", loginWithDiscord);
}

// Initialize broadcast view
function initBroadcastView(streamId: string, user: User | null) {
  const streamName = `${NAMESPACE_PREFIX}/${streamId}`;
  const shareUrl = `${window.location.origin}/watch/${streamId}`;

  console.log(`Vivoh.Earth Broadcast - Stream: ${streamId}`);

  // Show broadcast view, hide watch view
  document.getElementById("broadcast-view")?.classList.remove("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // If not logged in, show login required overlay
  if (!user) {
    showLoginRequired();
    return;
  }

  // Update the page with stream info
  const streamDisplay = document.getElementById("stream-id");
  const shareLink = document.getElementById("share-link") as HTMLInputElement;
  const copyBtn = document.getElementById("copy-btn");

  if (streamDisplay) streamDisplay.textContent = streamId;
  if (shareLink) shareLink.value = shareUrl;

  // Copy button functionality
  if (copyBtn && shareLink) {
    const copyIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    const checkIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

    copyBtn.addEventListener("click", () => {
      shareLink.select();
      navigator.clipboard.writeText(shareUrl);
      copyBtn.innerHTML = `${checkIcon} Copied!`;
      copyBtn.classList.add("btn-success");
      setTimeout(() => {
        copyBtn.innerHTML = `${copyIcon} Copy`;
        copyBtn.classList.remove("btn-success");
      }, 2000);
    });
  }

  // Set stream name on publisher
  const publisher = document.querySelector("hang-publish") as HTMLElement & { video: boolean; device: string };
  if (publisher) {
    publisher.setAttribute("url", RELAY_URL);
    publisher.setAttribute("name", streamName);

    // Track broadcast event
    let broadcastEventId: number | null = null;

    // Log broadcast start when user starts streaming
    const checkBroadcastStatus = () => {
      const statusDiv = publisher.querySelector(":scope > div > div:last-child");
      if (statusDiv?.textContent?.includes("Live") || statusDiv?.textContent?.includes("Audio Only")) {
        if (!broadcastEventId) {
          logBroadcastStart(streamId).then(id => {
            broadcastEventId = id;
            console.log("Broadcast started, event ID:", id);
          });
        }
      } else if (broadcastEventId && statusDiv?.textContent?.includes("Select Device")) {
        logBroadcastEnd(broadcastEventId);
        console.log("Broadcast ended, event ID:", broadcastEventId);
        broadcastEventId = null;
      }
    };

    // Observe status changes
    const statusObserver = new MutationObserver(checkBroadcastStatus);
    statusObserver.observe(publisher, { childList: true, subtree: true, characterData: true });

    // Log end on page unload
    window.addEventListener("beforeunload", () => {
      if (broadcastEventId) {
        logBroadcastEnd(broadcastEventId);
      }
    });

    // Inject audio-only button into device selector
    const injectAudioButton = () => {
      // Find the device selector container (div with flex layout containing buttons)
      const deviceContainer = publisher.querySelector(":scope > div > div");
      if (!deviceContainer || deviceContainer.querySelector(".audio-only-btn")) return;

      const audioBtn = document.createElement("button");
      audioBtn.type = "button";
      audioBtn.title = "Audio Only";
      audioBtn.className = "audio-only-btn";
      audioBtn.textContent = "🎤";
      audioBtn.style.cursor = "pointer";
      audioBtn.style.opacity = "0.5";

      audioBtn.addEventListener("click", () => {
        const isActive = audioBtn.style.opacity === "1";
        if (isActive) {
          // Turn off audio-only mode
          publisher.video = true;
          audioBtn.style.opacity = "0.5";
        } else {
          // Turn on audio-only mode
          publisher.video = false;
          publisher.device = "camera";
          audioBtn.style.opacity = "1";
        }
      });

      // Insert after the first button (camera icon)
      const buttons = deviceContainer.querySelectorAll("button");
      if (buttons.length >= 1) {
        buttons[0].after(audioBtn);
      } else {
        deviceContainer.appendChild(audioBtn);
      }
    };

    // Try after component renders and observe for changes
    const observer = new MutationObserver(() => injectAudioButton());
    observer.observe(publisher, { childList: true, subtree: true });
    setTimeout(injectAudioButton, 100);
    setTimeout(injectAudioButton, 500);
  }

  // New stream button
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) {
    newStreamBtn.addEventListener("click", () => {
      const newStream = generateStreamId();
      window.location.href = `/?stream=${newStream}`;
    });
  }
}

// Initialize watch view
function initWatchView(streamId: string) {
  const streamName = `${NAMESPACE_PREFIX}/${streamId}`;

  console.log(`Vivoh.Earth Watch - Stream: ${streamId}`);

  // Show watch view, hide broadcast view
  document.getElementById("watch-view")?.classList.remove("hidden");
  document.getElementById("broadcast-view")?.classList.add("hidden");

  // Hide the New Stream button on watch page
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) {
    newStreamBtn.classList.add("hidden");
  }

  // Set stream name on watcher
  const watcher = document.querySelector("hang-watch");
  if (watcher) {
    watcher.setAttribute("url", RELAY_URL);
    watcher.setAttribute("name", streamName);

    // Log watch event
    let watchEventId: number | null = null;

    // Start logging when page loads
    logWatchStart(streamId).then(id => {
      watchEventId = id;
      console.log("Watch started, event ID:", id);
    });

    // Log end on page unload
    window.addEventListener("beforeunload", () => {
      if (watchEventId) {
        logWatchEnd(watchEventId);
      }
    });
  }
}

// Initialize the app
async function init() {
  const { view, streamId } = getRouteInfo();

  // Get user first (needed for broadcast auth check)
  const user = await getCurrentUser();
  updateAuthUI(user);

  if (view === "broadcast") {
    initBroadcastView(streamId, user);
  } else {
    initWatchView(streamId);
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
        setTimeout(() => {
          const hangSupport = supportPanel.querySelector("hang-support");
          if (hangSupport?.shadowRoot) {
            const detailsBtn = hangSupport.shadowRoot.querySelector("button");
            if (detailsBtn) detailsBtn.click();
          }
        }, 50);
      }
    });
  }
}

// Run when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
