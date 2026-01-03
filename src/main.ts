// Safari WebSocket fallback - MUST install before hang components load
// Using our patched version that handles requireUnreliable gracefully
import { install as installWebTransportPolyfill } from "./webtransport-polyfill";

// Detect Safari - even Safari 17+ with WebTransport has compatibility issues with some relays
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

// Check if we need the polyfill: either no WebTransport or Safari (which has issues)
const needsPolyfill = typeof WebTransport === "undefined" || isSafari;
if (needsPolyfill) {
  const reason = typeof WebTransport === "undefined"
    ? "WebTransport not supported"
    : "Safari detected (using WebSocket for better compatibility)";
  console.log(`${reason}, installing WebSocket polyfill`);
  // Install polyfill - it will use WebSocket connections instead
  installWebTransportPolyfill();
}

// Safari fallback relay servers (WebSocket-enabled)
const FALLBACK_RELAYS = [
  "us-central.vivoh.earth",
  "eu-central.vivoh.earth",
  "ap-south.vivoh.earth",
];

// Server status tracking
interface RelayResult {
  domain: string;
  latency: number | null; // null if failed
  error?: string;
}

interface ServerStatus {
  mode: "websocket" | "webtransport";
  selectedServer: string;
  connected: boolean;
  raceResults: RelayResult[];
}

const serverStatus: ServerStatus = {
  mode: needsPolyfill ? "websocket" : "webtransport",
  selectedServer: "relay.cloudflare.mediaoverquic.com",
  connected: false,
  raceResults: [],
};

// Browser support tracking
interface CodecSupport {
  software: boolean;
  hardware?: boolean; // undefined means unknown (Firefox)
}

interface BrowserSupport {
  browser: string;
  isFirefox: boolean;
  isSafari: boolean;
  supported: boolean;
  features: {
    webTransport: boolean;
    mediaDevices: boolean;
    audio: {
      capture: boolean;
      render: boolean;
      encoding?: { aac: boolean; opus: boolean };
      decoding?: { aac: boolean; opus: boolean };
    };
    video: {
      capture: "full" | "partial" | "none";
      render: boolean;
      encoding?: { h264: CodecSupport; h265: CodecSupport; vp8: CodecSupport; vp9: CodecSupport; av1: CodecSupport };
      decoding?: { h264: CodecSupport; h265: CodecSupport; vp8: CodecSupport; vp9: CodecSupport; av1: CodecSupport };
    };
  };
}

const CODECS: Record<string, string> = {
  aac: "mp4a.40.2",
  opus: "opus",
  av1: "av01.0.08M.08",
  h264: "avc1.640028",
  h265: "hev1.1.6.L93.B0",
  vp9: "vp09.00.10.08",
  vp8: "vp8",
};

async function checkAudioEncoder(codec: string): Promise<boolean> {
  try {
    const res = await AudioEncoder.isConfigSupported({
      codec: CODECS[codec],
      numberOfChannels: 2,
      sampleRate: 48000,
    });
    return res.supported === true;
  } catch { return false; }
}

async function checkAudioDecoder(codec: string): Promise<boolean> {
  try {
    const res = await AudioDecoder.isConfigSupported({
      codec: CODECS[codec],
      numberOfChannels: 2,
      sampleRate: 48000,
    });
    return res.supported === true;
  } catch { return false; }
}

async function checkVideoEncoder(codec: string, isFirefox: boolean): Promise<CodecSupport> {
  try {
    const software = await VideoEncoder.isConfigSupported({
      codec: CODECS[codec],
      width: 1280,
      height: 720,
      hardwareAcceleration: "prefer-software",
    });
    const hardware = await VideoEncoder.isConfigSupported({
      codec: CODECS[codec],
      width: 1280,
      height: 720,
      hardwareAcceleration: "prefer-hardware",
    });
    const unknownHw = isFirefox || hardware.config?.hardwareAcceleration !== "prefer-hardware";
    return {
      software: software.supported === true,
      hardware: unknownHw ? undefined : hardware.supported === true,
    };
  } catch { return { software: false }; }
}

async function checkVideoDecoder(codec: string, isFirefox: boolean): Promise<CodecSupport> {
  try {
    const software = await VideoDecoder.isConfigSupported({
      codec: CODECS[codec],
      hardwareAcceleration: "prefer-software",
    });
    const hardware = await VideoDecoder.isConfigSupported({
      codec: CODECS[codec],
      hardwareAcceleration: "prefer-hardware",
    });
    const unknownHw = isFirefox || hardware.config?.hardwareAcceleration !== "prefer-hardware";
    return {
      software: software.supported === true,
      hardware: unknownHw ? undefined : hardware.supported === true,
    };
  } catch { return { software: false }; }
}

async function detectBrowserSupport(): Promise<BrowserSupport> {
  // Detect browser
  const ua = navigator.userAgent;
  let browser = "Unknown";
  const isFirefox = /firefox/i.test(ua);
  if (isFirefox) {
    browser = "Firefox";
  } else if (/edg/i.test(ua)) {
    browser = "Edge";
  } else if (/chrome/i.test(ua)) {
    browser = "Chrome";
  } else if (/safari/i.test(ua)) {
    browser = "Safari";
  }

  const webTransport = typeof WebTransport !== "undefined";
  const mediaDevices = typeof navigator.mediaDevices?.getUserMedia === "function";

  // Audio features
  const audioCapture = typeof AudioWorkletNode !== "undefined";
  const audioRender = typeof AudioContext !== "undefined" && typeof AudioBufferSourceNode !== "undefined";

  let audioEncoding: { aac: boolean; opus: boolean } | undefined;
  let audioDecoding: { aac: boolean; opus: boolean } | undefined;

  if (typeof AudioEncoder !== "undefined") {
    audioEncoding = {
      aac: await checkAudioEncoder("aac"),
      opus: await checkAudioEncoder("opus"),
    };
  }
  if (typeof AudioDecoder !== "undefined") {
    audioDecoding = {
      aac: await checkAudioDecoder("aac"),
      opus: await checkAudioDecoder("opus"),
    };
  }

  // Video features
  // @ts-expect-error MediaStreamTrackProcessor not in all TS libs
  const hasMediaStreamTrackProcessor = typeof MediaStreamTrackProcessor !== "undefined";
  const hasOffscreenCanvas = typeof OffscreenCanvas !== "undefined";
  const videoCapture: "full" | "partial" | "none" = hasMediaStreamTrackProcessor
    ? "full"
    : hasOffscreenCanvas
      ? "partial"
      : "none";
  const videoRender = hasOffscreenCanvas && typeof CanvasRenderingContext2D !== "undefined";

  let videoEncoding: BrowserSupport["features"]["video"]["encoding"];
  let videoDecoding: BrowserSupport["features"]["video"]["decoding"];

  if (typeof VideoEncoder !== "undefined") {
    videoEncoding = {
      h264: await checkVideoEncoder("h264", isFirefox),
      h265: await checkVideoEncoder("h265", isFirefox),
      vp8: await checkVideoEncoder("vp8", isFirefox),
      vp9: await checkVideoEncoder("vp9", isFirefox),
      av1: await checkVideoEncoder("av1", isFirefox),
    };
  }
  if (typeof VideoDecoder !== "undefined") {
    videoDecoding = {
      h264: await checkVideoDecoder("h264", isFirefox),
      h265: await checkVideoDecoder("h265", isFirefox),
      vp8: await checkVideoDecoder("vp8", isFirefox),
      vp9: await checkVideoDecoder("vp9", isFirefox),
      av1: await checkVideoDecoder("av1", isFirefox),
    };
  }

  // Supported if we have WebTransport OR Safari (which uses WebSocket fallback)
  const supported = webTransport || isSafari;

  return {
    browser,
    isFirefox,
    isSafari,
    supported,
    features: {
      webTransport,
      mediaDevices,
      audio: {
        capture: audioCapture,
        render: audioRender,
        encoding: audioEncoding,
        decoding: audioDecoding,
      },
      video: {
        capture: videoCapture,
        render: videoRender,
        encoding: videoEncoding,
        decoding: videoDecoding,
      },
    },
  };
}

let browserSupport: BrowserSupport;

// Update the browser support panel UI
function updateBrowserSupportPanel() {
  const supportPanel = document.getElementById("support-panel");
  if (!supportPanel || !browserSupport) return;

  const statusClass = browserSupport.supported ? "connected" : "disconnected";
  const statusText = browserSupport.supported ? "Supported" : "Not Supported";

  // Build details HTML
  const check = '<span style="color: #22c55e;">✓</span>';
  const cross = '<span style="color: #ef4444;">✗</span>';
  const partial = '<span style="color: #eab308;">◐</span>';
  const unknown = '<span style="color: #737373;">?</span>';

  const bool = (v: boolean) => v ? `${check} Yes` : `${cross} No`;
  const captureStatus = (v: "full" | "partial" | "none") => {
    if (v === "full") return `${check} Full`;
    if (v === "partial") return `${partial} Partial`;
    return `${cross} No`;
  };
  const codec = (c: CodecSupport | undefined) => {
    if (!c) return `${cross} No`;
    const sw = c.software ? "SW" : "";
    const hw = c.hardware === true ? "HW" : c.hardware === false ? "" : "";
    const parts = [sw, hw].filter(Boolean);
    if (parts.length === 0) return `${cross} No`;
    // Show hardware status: ? if unknown (Firefox), ✓ if yes, nothing if no
    const hwIcon = c.hardware === undefined ? ` ${unknown}` : c.hardware ? ` ${check}` : "";
    return `${check} ${parts.join("+")}${c.hardware === undefined ? " (HW?)" : ""}`;
  };

  const f = browserSupport.features;

  const fallbackNote = browserSupport.isSafari && !f.webTransport
    ? `<p style="margin-top: 0.75rem; color: #a3a3a3; font-size: 0.85rem;">Safari uses WebSocket fallback for compatibility.</p>`
    : "";

  // Audio codec rows
  const audioEncodingRows = f.audio.encoding
    ? `<tr><td>  AAC</td><td>${bool(f.audio.encoding.aac)}</td></tr>
       <tr><td>  Opus</td><td>${bool(f.audio.encoding.opus)}</td></tr>`
    : "";
  const audioDecodingRows = f.audio.decoding
    ? `<tr><td>  AAC</td><td>${bool(f.audio.decoding.aac)}</td></tr>
       <tr><td>  Opus</td><td>${bool(f.audio.decoding.opus)}</td></tr>`
    : "";

  // Video codec rows
  const videoEncodingRows = f.video.encoding
    ? `<tr><td>  H.264</td><td>${codec(f.video.encoding.h264)}</td></tr>
       <tr><td>  H.265</td><td>${codec(f.video.encoding.h265)}</td></tr>
       <tr><td>  VP8</td><td>${codec(f.video.encoding.vp8)}</td></tr>
       <tr><td>  VP9</td><td>${codec(f.video.encoding.vp9)}</td></tr>
       <tr><td>  AV1</td><td>${codec(f.video.encoding.av1)}</td></tr>`
    : "";
  const videoDecodingRows = f.video.decoding
    ? `<tr><td>  H.264</td><td>${codec(f.video.decoding.h264)}</td></tr>
       <tr><td>  H.265</td><td>${codec(f.video.decoding.h265)}</td></tr>
       <tr><td>  VP8</td><td>${codec(f.video.decoding.vp8)}</td></tr>
       <tr><td>  VP9</td><td>${codec(f.video.decoding.vp9)}</td></tr>
       <tr><td>  AV1</td><td>${codec(f.video.decoding.av1)}</td></tr>`
    : "";

  const detailsContent = `
    <p><strong>Browser:</strong> ${browserSupport.browser}</p>
    <table class="latency-results">
      <tbody>
        <tr><td>WebTransport</td><td>${bool(f.webTransport)}</td></tr>
        <tr><td>Media Devices</td><td>${bool(f.mediaDevices)}</td></tr>
      </tbody>
    </table>
    <p style="margin-top: 0.75rem;"><strong>Audio</strong></p>
    <table class="latency-results">
      <tbody>
        <tr><td>Capture</td><td>${bool(f.audio.capture)}</td></tr>
        <tr><td>Encoding</td><td>${f.audio.encoding ? `${check} Yes` : `${cross} No`}</td></tr>
        ${audioEncodingRows}
        <tr><td>Decoding</td><td>${f.audio.decoding ? `${check} Yes` : `${cross} No`}</td></tr>
        ${audioDecodingRows}
        <tr><td>Render</td><td>${bool(f.audio.render)}</td></tr>
      </tbody>
    </table>
    <p style="margin-top: 0.75rem;"><strong>Video</strong></p>
    <table class="latency-results">
      <tbody>
        <tr><td>Capture</td><td>${captureStatus(f.video.capture)}</td></tr>
        <tr><td>Encoding</td><td>${f.video.encoding ? `${check} Yes` : `${cross} No`}</td></tr>
        ${videoEncodingRows}
        <tr><td>Decoding</td><td>${f.video.decoding ? `${check} Yes` : `${cross} No`}</td></tr>
        ${videoDecodingRows}
        <tr><td>Render</td><td>${bool(f.video.render)}</td></tr>
      </tbody>
    </table>
    ${fallbackNote}
  `;

  supportPanel.innerHTML = `
    <div class="server-status-summary">
      <span class="status-indicator ${statusClass}"></span>
      <span>${statusText}: ${browserSupport.browser}</span>
      <button class="details-btn" id="support-details-btn">Details</button>
    </div>
    <div class="server-details hidden" id="support-details-content">
      ${detailsContent}
    </div>
  `;

  // Add details toggle handler
  document.getElementById("support-details-btn")?.addEventListener("click", () => {
    const details = document.getElementById("support-details-content");
    const btn = document.getElementById("support-details-btn");
    if (details && btn) {
      const isHidden = details.classList.contains("hidden");
      details.classList.toggle("hidden");
      btn.textContent = isHidden ? "Hide" : "Details";
    }
  });
}

// Race requests to find the lowest-latency relay server
async function selectBestFallbackRelay(): Promise<string> {
  const testPath = "/announced/_latency_test_"; // Invalid prefix = empty but valid response
  const timeout = 5000; // 5 second timeout per server

  // Track all results for the status panel
  const results: RelayResult[] = FALLBACK_RELAYS.map(domain => ({
    domain,
    latency: null,
  }));

  // Create a promise for each server that resolves with result
  const racePromises = FALLBACK_RELAYS.map(async (domain, index) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    const startTime = performance.now();

    try {
      const response = await fetch(`https://${domain}${testPath}`, {
        signal: controller.signal,
        cache: "no-store",
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const latency = performance.now() - startTime;
        results[index].latency = latency;
        console.log(`Relay ${domain} responded in ${latency.toFixed(0)}ms`);
        return { domain, latency };
      }
      const error = `HTTP ${response.status}`;
      results[index].error = error;
      throw new Error(error);
    } catch (error) {
      clearTimeout(timeoutId);
      if (!results[index].error) {
        results[index].error = error instanceof Error ? error.message : "Failed";
      }
      console.warn(`Relay ${domain} failed:`, error);
      throw error;
    }
  });

  // Wait a bit for all results to come in (for display purposes)
  // but use Promise.any to select the winner quickly
  const winnerPromise = Promise.any(racePromises);

  // Also wait for all to settle (with a shorter timeout for UI)
  const allSettledPromise = Promise.allSettled(racePromises);

  try {
    const winner = await winnerPromise;
    console.log(`Selected relay: ${winner.domain} (${winner.latency.toFixed(0)}ms)`);

    // Wait briefly for other results to populate (for status panel)
    await Promise.race([
      allSettledPromise,
      new Promise(resolve => setTimeout(resolve, 1000)),
    ]);

    serverStatus.raceResults = results;
    serverStatus.selectedServer = winner.domain;
    serverStatus.connected = true;

    return winner.domain;
  } catch {
    console.warn("All relay servers failed latency test, using default");
    serverStatus.raceResults = results;
    serverStatus.selectedServer = FALLBACK_RELAYS[0];
    serverStatus.connected = false;
    return FALLBACK_RELAYS[0];
  }
}

// Update the server status panel UI
function updateServerStatusPanel() {
  const serverPanel = document.getElementById("server-panel");
  if (!serverPanel) return;

  const statusClass = serverStatus.connected ? "connected" : "disconnected";
  const statusText = serverStatus.connected ? "Connected" : "Disconnected";
  const modeLabel = serverStatus.mode === "websocket" ? "WebSocket (Safari fallback)" : "WebTransport (native)";

  // Build details HTML
  let detailsContent = `
    <p><strong>Mode:</strong> ${modeLabel}</p>
    <p><strong>Server:</strong> ${serverStatus.selectedServer}</p>
  `;

  if (serverStatus.mode === "websocket" && serverStatus.raceResults.length > 0) {
    detailsContent += `
      <p><strong>Latency Test Results:</strong></p>
      <table class="latency-results">
        <thead><tr><th>Server</th><th>Latency</th></tr></thead>
        <tbody>
    `;

    // Sort by latency (successful first, then failed)
    const sorted = [...serverStatus.raceResults].sort((a, b) => {
      if (a.latency === null && b.latency === null) return 0;
      if (a.latency === null) return 1;
      if (b.latency === null) return -1;
      return a.latency - b.latency;
    });

    for (const result of sorted) {
      const isSelected = result.domain === serverStatus.selectedServer;
      const latencyText = result.latency !== null
        ? `${result.latency.toFixed(0)}ms`
        : `Failed: ${result.error || "timeout"}`;
      const rowClass = isSelected ? "selected" : (result.latency === null ? "failed" : "");
      detailsContent += `<tr class="${rowClass}"><td>${result.domain}</td><td>${latencyText}</td></tr>`;
    }

    detailsContent += `</tbody></table>`;
  }

  serverPanel.innerHTML = `
    <div class="server-status-summary">
      <span class="status-indicator ${statusClass}"></span>
      <span>${statusText}: ${serverStatus.selectedServer}</span>
      <button class="details-btn" id="server-details-btn">Details</button>
    </div>
    <div class="server-details hidden" id="server-details-content">
      ${detailsContent}
    </div>
  `;

  // Add details toggle handler
  document.getElementById("server-details-btn")?.addEventListener("click", () => {
    const details = document.getElementById("server-details-content");
    const btn = document.getElementById("server-details-btn");
    if (details && btn) {
      const isHidden = details.classList.contains("hidden");
      details.classList.toggle("hidden");
      btn.textContent = isHidden ? "Hide" : "Details";
    }
  });
}

// Relay URL - set dynamically for Safari fallback, static for native WebTransport
let RELAY_URL = "https://relay.cloudflare.mediaoverquic.com"; // Default for Chrome/Firefox
const NAMESPACE_PREFIX = "vivoh.earth";

// Dynamic imports for hang components - MUST happen after polyfill is installed
// ES module static imports are hoisted and execute before any code runs
const loadHangComponents = async () => {
  await import("@kixelated/hang/publish/element");
  await import("@kixelated/hang/watch/element");
};

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
  checkStreamExists,
  getStreamSettings,
  updateStreamSettings,
  getLiveStats,
  getStreamViewers,
  type User,
  type LiveBroadcast,
  type LiveViewer
} from "./auth";

type View = "broadcast" | "watch" | "stats" | "stream-stats";

// Generate a random stream ID (5 lowercase alphanumeric characters)
function generateRandomId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 5; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Generate a unique stream ID, checking for collisions
async function generateStreamId(): Promise<string> {
  const maxAttempts = 10;
  for (let i = 0; i < maxAttempts; i++) {
    const id = generateRandomId();
    const exists = await checkStreamExists(id);
    if (!exists) {
      return id;
    }
    console.log(`Stream ID ${id} already in use, generating new one...`);
  }
  // Fallback: return a random ID even if we couldn't verify uniqueness
  return generateRandomId();
}

// Check if a string is a valid stream ID (5 lowercase alphanumeric)
function isValidStreamId(str: string): boolean {
  return /^[a-z0-9]{5}$/.test(str);
}

// Determine current view and stream ID from URL
async function getRouteInfo(): Promise<{ view: View; streamId: string }> {
  const path = window.location.pathname;

  // Stats view: /stats
  if (path === "/stats") {
    return { view: "stats", streamId: "" };
  }

  // Stream-specific stats view: /{streamId}/stats
  const streamStatsMatch = path.match(/^\/([a-z0-9]{5})\/stats$/);
  if (streamStatsMatch) {
    return { view: "stream-stats", streamId: streamStatsMatch[1] };
  }

  // Watch view: /{streamId} (5 char alphanumeric)
  const potentialStreamId = path.slice(1); // Remove leading /
  if (isValidStreamId(potentialStreamId)) {
    return { view: "watch", streamId: potentialStreamId };
  }

  // Broadcast view: / or /?stream=xxx
  const params = new URLSearchParams(window.location.search);
  let streamId = params.get("stream");

  if (!streamId) {
    streamId = await generateStreamId();
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
      <button id="logout-btn" class="btn btn-icon" title="Sign Out">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
          <polyline points="16 17 21 12 16 7"/>
          <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
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
  const shareUrl = `${window.location.origin}/${streamId}`;

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
  const copyBtn = document.getElementById("copy-btn");

  if (streamDisplay) streamDisplay.textContent = streamId;

  // Copy button functionality
  if (copyBtn) {
    const copyIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    const checkIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(shareUrl);
      copyBtn.innerHTML = checkIcon;
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.innerHTML = copyIcon;
        copyBtn.classList.remove("copied");
      }, 2000);
    });
  }

  // Require auth toggle
  const requireAuthCheckbox = document.getElementById("require-auth-checkbox") as HTMLInputElement;
  if (requireAuthCheckbox) {
    // Load current setting
    getStreamSettings(streamId).then(settings => {
      requireAuthCheckbox.checked = settings.require_auth;
    });

    // Save on change - with confirmation for anonymous viewers
    requireAuthCheckbox.addEventListener("change", async () => {
      if (requireAuthCheckbox.checked) {
        // Check for anonymous viewers before enabling auth requirement
        const data = await getStreamViewers(streamId);
        const anonymousCount = data?.viewers.filter(v => !v.user_id).length ?? 0;

        if (anonymousCount > 0) {
          const plural = anonymousCount === 1 ? "viewer is" : "viewers are";
          const confirmed = confirm(
            `${anonymousCount} anonymous ${plural} currently watching.\n\nForce them to sign in now?`
          );

          if (!confirmed) {
            // Revert checkbox if not confirmed
            requireAuthCheckbox.checked = false;
            return;
          }
        }
      }

      updateStreamSettings(streamId, requireAuthCheckbox.checked);
    });
  }

  // Set viewers link to stream stats page
  const viewersLink = document.getElementById("viewers-link") as HTMLAnchorElement;
  if (viewersLink) {
    viewersLink.href = `/${streamId}/stats`;
    // Prevent link click from toggling the checkbox
    viewersLink.addEventListener("click", (e) => {
      e.stopPropagation();
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
    newStreamBtn.addEventListener("click", async () => {
      const newStream = await generateStreamId();
      window.location.href = `/?stream=${newStream}`;
    });
  }
}

// Show login required overlay for watch
function showWatchLoginRequired() {
  const watchView = document.getElementById("watch-view");
  if (!watchView) return;

  const section = watchView.querySelector("section");
  if (!section) return;

  section.innerHTML = `
    <div class="login-required">
      <h2>Sign in Required</h2>
      <p>The broadcaster requires viewers to sign in to watch this stream.</p>
      <div class="auth-buttons">
        <button id="watch-login-google" class="btn btn-google">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Google
        </button>
        <button id="watch-login-microsoft" class="btn btn-microsoft">
          <svg viewBox="0 0 21 21" width="18" height="18">
            <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
            <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
            <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
            <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
          </svg>
          Microsoft
        </button>
        <button id="watch-login-discord" class="btn btn-discord">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
          </svg>
          Discord
        </button>
      </div>
    </div>
  `;

  document.getElementById("watch-login-google")?.addEventListener("click", loginWithGoogle);
  document.getElementById("watch-login-microsoft")?.addEventListener("click", loginWithMicrosoft);
  document.getElementById("watch-login-discord")?.addEventListener("click", loginWithDiscord);
}

// Initialize watch view
async function initWatchView(streamId: string, user: User | null) {
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

  // Check if stream requires auth
  const settings = await getStreamSettings(streamId);
  if (settings.require_auth && !user) {
    showWatchLoginRequired();
    return;
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

    // Poll for auth setting changes (anonymous viewers only)
    if (!user) {
      const authCheckInterval = setInterval(async () => {
        const currentSettings = await getStreamSettings(streamId);
        if (currentSettings.require_auth) {
          clearInterval(authCheckInterval);
          // End the watch event
          if (watchEventId) {
            logWatchEnd(watchEventId);
            watchEventId = null;
          }
          // Show login required overlay
          showWatchLoginRequired();
        }
      }, 10000); // Check every 10 seconds
    }
  }
}

// Initialize stats view
async function initStatsView(user: User | null) {
  console.log("Vivoh.Earth Stats");

  // Hide broadcast and watch views
  document.getElementById("broadcast-view")?.classList.add("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // Hide footer and new stream button
  const footer = document.querySelector("footer");
  if (footer) footer.classList.add("hidden");
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) newStreamBtn.classList.add("hidden");

  // Create stats view container
  const container = document.querySelector(".container");
  if (!container) return;

  const statsView = document.createElement("div");
  statsView.id = "stats-view";
  statsView.className = "stats-view";

  // Check if logged in
  if (!user) {
    statsView.innerHTML = `
      <div class="stats-login-required">
        <h2>Sign in Required</h2>
        <p>Please sign in to view live statistics.</p>
        <div class="auth-buttons">
          <button id="stats-login-google" class="btn btn-google">Google</button>
          <button id="stats-login-microsoft" class="btn btn-microsoft">Microsoft</button>
          <button id="stats-login-discord" class="btn btn-discord">Discord</button>
        </div>
      </div>
    `;
    container.appendChild(statsView);
    document.getElementById("stats-login-google")?.addEventListener("click", loginWithGoogle);
    document.getElementById("stats-login-microsoft")?.addEventListener("click", loginWithMicrosoft);
    document.getElementById("stats-login-discord")?.addEventListener("click", loginWithDiscord);
    return;
  }

  // Show loading state
  statsView.innerHTML = `<p>Loading stats...</p>`;
  container.appendChild(statsView);

  // Fetch and display stats
  const renderStats = async () => {
    const stats = await getLiveStats();
    if (!stats) {
      statsView.innerHTML = `<p class="error">Failed to load stats</p>`;
      return;
    }

    const formatTime = (dateStr: string) => {
      const date = new Date(dateStr + "Z");
      return date.toLocaleTimeString();
    };

    const formatDuration = (dateStr: string) => {
      const start = new Date(dateStr + "Z");
      const now = new Date();
      const seconds = Math.floor((now.getTime() - start.getTime()) / 1000);
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
      const hours = Math.floor(minutes / 60);
      return `${hours}h ${minutes % 60}m`;
    };

    const broadcastRows = stats.broadcasts.length === 0
      ? `<tr><td colspan="4" class="empty">No active broadcasts</td></tr>`
      : stats.broadcasts.map((b: LiveBroadcast) => `
          <tr>
            <td><a href="/${b.stream_id}" target="_blank">${b.stream_id}</a></td>
            <td>
              ${b.avatar_url ? `<img src="${b.avatar_url}" class="avatar-small">` : ""}
              ${b.user_name || b.user_email}
            </td>
            <td>${formatDuration(b.started_at)}</td>
            <td>${stats.viewers.filter((v: LiveViewer) => v.stream_id === b.stream_id).length}</td>
          </tr>
        `).join("");

    const viewerRows = stats.viewers.length === 0
      ? `<tr><td colspan="3" class="empty">No active viewers</td></tr>`
      : stats.viewers.map((v: LiveViewer) => `
          <tr>
            <td><a href="/${v.stream_id}" target="_blank">${v.stream_id}</a></td>
            <td>
              ${v.avatar_url ? `<img src="${v.avatar_url}" class="avatar-small">` : ""}
              ${v.user_name || v.user_email || "Anonymous"}
            </td>
            <td>${formatDuration(v.started_at)}</td>
          </tr>
        `).join("");

    statsView.innerHTML = `
      <h2>Live Statistics</h2>
      <div class="stats-grid">
        <section class="stats-section">
          <h3>Active Broadcasts (${stats.broadcasts.length})</h3>
          <table class="stats-table">
            <thead>
              <tr>
                <th>Stream</th>
                <th>Broadcaster</th>
                <th>Duration</th>
                <th>Viewers</th>
              </tr>
            </thead>
            <tbody>${broadcastRows}</tbody>
          </table>
        </section>
        <section class="stats-section">
          <h3>Active Viewers (${stats.viewers.length})</h3>
          <table class="stats-table">
            <thead>
              <tr>
                <th>Stream</th>
                <th>Viewer</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>${viewerRows}</tbody>
          </table>
        </section>
      </div>
      <button id="refresh-stats" class="btn btn-primary">Refresh</button>
    `;

    document.getElementById("refresh-stats")?.addEventListener("click", renderStats);
  };

  await renderStats();
}

// Initialize stream-specific stats view (viewers only)
async function initStreamStatsView(streamId: string) {
  console.log(`Vivoh.Earth Stream Stats - Stream: ${streamId}`);

  // Hide broadcast and watch views
  document.getElementById("broadcast-view")?.classList.add("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // Hide footer and new stream button
  const footer = document.querySelector("footer");
  if (footer) footer.classList.add("hidden");
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) newStreamBtn.classList.add("hidden");

  // Create stats view container
  const container = document.querySelector(".container");
  if (!container) return;

  const statsView = document.createElement("div");
  statsView.id = "stream-stats-view";
  statsView.className = "stats-view";

  // Show loading state
  statsView.innerHTML = `<p>Loading viewers...</p>`;
  container.appendChild(statsView);

  // Fetch and display viewers
  const renderViewers = async () => {
    const data = await getStreamViewers(streamId);
    if (!data) {
      statsView.innerHTML = `<p class="error">Failed to load viewers</p>`;
      return;
    }

    const formatDuration = (dateStr: string) => {
      const start = new Date(dateStr + "Z");
      const now = new Date();
      const seconds = Math.floor((now.getTime() - start.getTime()) / 1000);
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
      const hours = Math.floor(minutes / 60);
      return `${hours}h ${minutes % 60}m`;
    };

    const viewerRows = data.viewers.length === 0
      ? `<tr><td colspan="2" class="empty">No active viewers</td></tr>`
      : data.viewers.map((v: LiveViewer) => `
          <tr>
            <td>
              ${v.avatar_url ? `<img src="${v.avatar_url}" class="avatar-small">` : ""}
              ${v.user_name || v.user_email || "Anonymous"}
            </td>
            <td>${formatDuration(v.started_at)}</td>
          </tr>
        `).join("");

    statsView.innerHTML = `
      <h2>Viewers for <a href="/${streamId}" class="stream-link">${streamId}</a></h2>
      <section class="stats-section">
        <h3>Active Viewers (${data.viewers.length})</h3>
        <table class="stats-table">
          <thead>
            <tr>
              <th>Viewer</th>
              <th>Watching for</th>
            </tr>
          </thead>
          <tbody>${viewerRows}</tbody>
        </table>
      </section>
      <button id="refresh-stream-stats" class="btn btn-primary">Refresh</button>
    `;

    document.getElementById("refresh-stream-stats")?.addEventListener("click", renderViewers);
  };

  await renderViewers();
}

// Initialize the app
async function init() {
  // Detect browser support (async for codec checks)
  browserSupport = await detectBrowserSupport();

  // For Safari/polyfill mode, select the best relay server based on latency
  if (needsPolyfill) {
    const bestRelay = await selectBestFallbackRelay();
    RELAY_URL = `https://${bestRelay}/moq`;
  } else {
    // WebTransport mode - assume connected
    serverStatus.connected = true;
  }

  // Update status panels
  updateBrowserSupportPanel();
  updateServerStatusPanel();

  // Load hang components dynamically AFTER polyfill is installed
  await loadHangComponents();

  const { view, streamId } = await getRouteInfo();

  // Get user first (needed for broadcast auth check)
  const user = await getCurrentUser();
  updateAuthUI(user);

  if (view === "broadcast") {
    initBroadcastView(streamId, user);
  } else if (view === "stats") {
    await initStatsView(user);
  } else if (view === "stream-stats") {
    await initStreamStatsView(streamId);
  } else {
    await initWatchView(streamId, user);
  }

  // Browser support toggle
  const supportLink = document.getElementById("support-link");
  const supportPanel = document.getElementById("support-panel");
  if (supportLink && supportPanel) {
    supportLink.addEventListener("click", (e) => {
      e.preventDefault();
      supportPanel.classList.toggle("hidden");
    });
  }

  // Server status toggle
  const serverLink = document.getElementById("server-link");
  const serverPanel = document.getElementById("server-panel");
  if (serverLink && serverPanel) {
    serverLink.addEventListener("click", (e) => {
      e.preventDefault();
      serverPanel.classList.toggle("hidden");
    });
  }
}

// Run when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
