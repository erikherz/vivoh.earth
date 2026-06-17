// Safari WebSocket fallback - MUST install before hang components load
// Using our patched version that handles requireUnreliable gracefully
import { install as installWebTransportPolyfill } from "./webtransport-polyfill";
// WebCodecs polyfill for Opus audio encoding on Safari
import { install as installWebCodecsPolyfill } from "./webcodecs-polyfill";

// Detect Safari - even Safari 17+ with WebTransport has compatibility issues with some relays
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

// Check if we need the polyfill: only when WebTransport is not available
// Safari now uses native WebTransport with Cloudflare relay (fallback relays disabled)
const needsPolyfill = typeof WebTransport === "undefined";
if (needsPolyfill) {
  const reason = typeof WebTransport === "undefined"
    ? "WebTransport not supported"
    : "Safari detected (using WebSocket for better compatibility)";
  console.log(`${reason}, installing WebSocket polyfill`);
  // Install polyfill - use force=true for Safari since it has native WebTransport
  // but with compatibility issues that require using WebSocket instead
  installWebTransportPolyfill(isSafari);
}

// Safari audio track fix - Safari doesn't return channelCount in getSettings()
// which causes the hang library to fail with "expected number" error
if (isSafari) {
  const originalGetSettings = MediaStreamTrack.prototype.getSettings;
  MediaStreamTrack.prototype.getSettings = function () {
    const settings = originalGetSettings.call(this);
    // Add default channelCount for audio tracks if missing
    if (this.kind === "audio" && settings.channelCount === undefined) {
      settings.channelCount = 1; // Mono default, Safari typically captures mono
    }
    return settings;
  };
  console.log("Safari: Patched MediaStreamTrack.getSettings for channelCount");
}

// Theme initialization - must run early to prevent flash
function initTheme() {
  const savedTheme = localStorage.getItem("theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

  if (savedTheme === "light" || (!savedTheme && !prefersDark)) {
    document.documentElement.classList.add("light");
  }

  document.addEventListener("DOMContentLoaded", () => {
    const themeToggle = document.getElementById("theme-toggle");
    if (themeToggle) {
      themeToggle.addEventListener("click", () => {
        document.documentElement.classList.toggle("light");
        const isLight = document.documentElement.classList.contains("light");
        localStorage.setItem("theme", isLight ? "light" : "dark");
      });
    }
  });
}
initTheme();

// --- Minimal typings for the headless @moq/publish + @moq/watch core elements ---
// The core elements render no controls of their own; we drive them programmatically.
// @moq/signals Signals expose peek()/set()/subscribe() (subscribe returns an unsubscribe fn).
interface MoqSignal<T> {
  peek(): T;
  set(value: T): void;
  subscribe(fn: (value: T) => void): () => void;
}
type ConnStatus = "disconnected" | "connecting" | "connected";
type PublishSource = "camera" | "screen" | "file" | null | undefined;

interface MoqPublishElement extends HTMLElement {
  source: PublishSource;
  invisible: boolean;
  muted: boolean;
  connection: { status: MoqSignal<ConnStatus> };
  state: { source: MoqSignal<PublishSource> };
  // The captured tracks the encoder actually consumes (undefined until capture succeeds).
  broadcast?: {
    video?: { source: MoqSignal<unknown> };
    audio?: { source: MoqSignal<unknown> };
  };
}

interface MoqWatchElement extends HTMLElement {
  muted: boolean;
  volume: number;
  connection: { status: MoqSignal<ConnStatus> };
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
  selectedServer: "cdn.tinymoq.com",
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
  // Detect browser - use consistent detection with global isSafari
  const ua = navigator.userAgent;
  let browser = "Unknown";
  const isFirefox = /firefox/i.test(ua);
  if (isFirefox) {
    browser = "Firefox";
  } else if (/edg/i.test(ua)) {
    browser = "Edge";
  } else if (/chrome/i.test(ua)) {
    browser = "Chrome";
  } else if (isSafari) {
    // Use global isSafari which has proper negative lookahead for Chrome/Android
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

  // Determine overall status - "Partial" if using polyfill, "Full" if native WebTransport
  const isPartial = needsPolyfill;
  const statusClass = browserSupport.supported ? (isPartial ? "partial" : "connected") : "disconnected";
  const statusText = browserSupport.supported ? (isPartial ? "Partial Support" : "Full Support") : "Not Supported";

  // Build details HTML
  const green = '<span class="status-dot green"></span>';
  const red = '<span class="status-dot red"></span>';
  const yellow = '<span class="status-dot yellow"></span>';

  const bool = (v: boolean) => v ? `${green} Yes` : `${red} No`;

  // WebTransport status - show "Polyfill" if we're using the fallback
  const webTransportStatus = () => {
    if (needsPolyfill) {
      return `${yellow} Polyfill`;
    }
    return browserSupport.features.webTransport ? `${green} Full` : `${red} No`;
  };

  const captureStatus = (v: "full" | "partial" | "none") => {
    if (v === "full") return `${green} Full`;
    if (v === "partial") return `${yellow} Partial`;
    return `${red} No`;
  };

  const codecStatus = (c: CodecSupport | undefined, isFirefox: boolean) => {
    if (!c || (!c.software && !c.hardware)) return `${red} No`;
    if (c.hardware === true) return `${green} Hardware`;
    if (c.hardware === undefined && isFirefox) return `${yellow} Software*`;
    if (c.software) return `${yellow} Software`;
    return `${red} No`;
  };

  const audioCodecStatus = (supported: boolean | undefined) => {
    if (supported === undefined) return `${red} No`;
    return supported ? `${green} Yes` : `${red} No`;
  };

  const f = browserSupport.features;
  const isFirefox = browserSupport.isFirefox;

  // Note for polyfill or Firefox
  let footerNote = "";
  if (needsPolyfill) {
    footerNote = `<p class="support-note">Using WebSocket polyfill for Safari compatibility.</p>`;
  }
  if (isFirefox) {
    footerNote += `<p class="support-note">*Hardware acceleration is <a href="https://github.com/nickeltin/browser-support" target="_blank">undetectable</a> on Firefox.</p>`;
  }

  const detailsContent = `
    <table class="latency-results">
      <tbody>
        <tr><td><strong>WebTransport</strong></td><td>${webTransportStatus()}</td></tr>
        <tr><td><strong>Rendering</strong></td><td>Audio</td><td>${bool(f.audio.render)}</td></tr>
        <tr><td></td><td>Video</td><td>${bool(f.video.render)}</td></tr>
        <tr><td><strong>Decoding</strong></td><td>Opus</td><td>${f.audio.decoding ? audioCodecStatus(f.audio.decoding.opus) : `${red} No`}</td></tr>
        <tr><td></td><td>AAC</td><td>${f.audio.decoding ? audioCodecStatus(f.audio.decoding.aac) : `${red} No`}</td></tr>
        <tr><td></td><td>AV1</td><td>${f.video.decoding ? codecStatus(f.video.decoding.av1, isFirefox) : `${red} No`}</td></tr>
        <tr><td></td><td>H.265</td><td>${f.video.decoding ? codecStatus(f.video.decoding.h265, isFirefox) : `${red} No`}</td></tr>
        <tr><td></td><td>H.264</td><td>${f.video.decoding ? codecStatus(f.video.decoding.h264, isFirefox) : `${red} No`}</td></tr>
        <tr><td></td><td>VP9</td><td>${f.video.decoding ? codecStatus(f.video.decoding.vp9, isFirefox) : `${red} No`}</td></tr>
        <tr><td></td><td>VP8</td><td>${f.video.decoding ? codecStatus(f.video.decoding.vp8, isFirefox) : `${red} No`}</td></tr>
      </tbody>
    </table>
    ${footerNote}
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
  const testPath = "/fingerprint";
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
      const response = await fetch(`https://${domain}:8888${testPath}`, {
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

// tinymoq relay auth token (client publish+subscribe JWT, put/get="" = all paths, exp 2026-07-17).
// This is a client-side connection token by design (the browser must present it to connect),
// not a server secret. Passed as ?jwt= on the WebTransport connection URL per the hang README.
const TINYMOQ_JWT =
  "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiIsImtpZCI6IjkzMDlmZmRlNjRlMGJmMGYifQ.eyJwdXQiOlsiIl0sImdldCI6WyIiXSwiZXhwIjoxNzg0MzA4MjY4fQ.1wt1q75WmBL376xj19fRR_MhVmSLr5zZFfyHivwFl9o";

// Relay URL - set dynamically for Safari fallback, static for native WebTransport
// hang connects WebTransport to this URL directly; the broadcast path travels as the `name` attr.
let RELAY_URL = `https://cdn.tinymoq.com/?jwt=${TINYMOQ_JWT}`; // (was: relay.cloudflare.mediaoverquic.com)
const NAMESPACE_PREFIX = "vivoh.earth";

// Dynamic imports for the MoQ web components - MUST happen after polyfills are installed.
// These register the headless light-DOM core elements <moq-publish> and <moq-watch>
// from @moq/publish + @moq/watch (which use @moq/net, negotiating moq-lite-04).
// ES module static imports are hoisted and execute before any code runs.
const loadHangComponents = async () => {
  // Install WebCodecs polyfill for Opus audio encoding (Safari)
  // This must complete before the components try to use AudioEncoder
  await installWebCodecsPolyfill();

  await import("@moq/publish/element");
  await import("@moq/watch/element");
};

import {
  getCurrentUser,
  countryToFlag,
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
  type Geo,
  type StreamSettings,
  type LiveBroadcast,
  type LiveViewer
} from "./auth";

type View = "broadcast" | "watch" | "stats" | "stats-map" | "greet" | "stream-stats" | "stream-stats-map" | "admin";

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

  // Stats map view: /stats/map
  if (path === "/stats/map") {
    return { view: "stats-map", streamId: "" };
  }

  // Greet view: /greet (broadcasters map)
  if (path === "/greet") {
    return { view: "greet", streamId: "" };
  }

  // Admin view: /cleardata
  if (path === "/cleardata") {
    return { view: "admin", streamId: "" };
  }

  // Stats view: /stats
  if (path === "/stats") {
    return { view: "stats", streamId: "" };
  }

  // Stream-specific stats map view: /{streamId}/stats/map
  const streamStatsMapMatch = path.match(/^\/([a-z0-9]{5})\/stats\/map$/);
  if (streamStatsMapMatch) {
    return { view: "stream-stats-map", streamId: streamStatsMapMatch[1] };
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
function updateAuthUI(user: User | null, geo: Geo | null) {
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

  const flag = countryToFlag(geo?.country ?? null);
  const hasCoords = geo?.latitude && geo?.longitude;

  // Build location tooltip content
  const locationParts: string[] = [];
  if (geo?.city) locationParts.push(geo.city);
  if (geo?.region) locationParts.push(geo.region);
  if (geo?.postalCode) locationParts.push(geo.postalCode);
  if (geo?.country) locationParts.push(geo.country);

  let flagHtml = "";
  if (flag) {
    const clickable = hasCoords ? "clickable" : "";
    flagHtml = `<span class="user-flag ${clickable}" id="user-flag">${flag}</span>`;
  }

  authContainer.innerHTML = `
    <div class="user-info">
      ${avatarHtml}
      <span class="user-name">${user.name}</span>${flagHtml}
      <button id="logout-btn" class="btn btn-icon" title="Sign Out">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
          <polyline points="16 17 21 12 16 7"/>
          <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
      </button>
    </div>
    ${flag ? `<div class="geo-tooltip" id="geo-tooltip">
      <div class="geo-tooltip-content">
        ${geo?.city ? `<div class="geo-row"><span class="geo-label">City</span><span class="geo-value">${geo.city}</span></div>` : ""}
        ${geo?.region ? `<div class="geo-row"><span class="geo-label">Region</span><span class="geo-value">${geo.region}</span></div>` : ""}
        ${geo?.postalCode ? `<div class="geo-row"><span class="geo-label">Postal</span><span class="geo-value">${geo.postalCode}</span></div>` : ""}
        ${geo?.country ? `<div class="geo-row"><span class="geo-label">Country</span><span class="geo-value">${geo.country}</span></div>` : ""}
        ${geo?.continent ? `<div class="geo-row"><span class="geo-label">Continent</span><span class="geo-value">${geo.continent}</span></div>` : ""}
        ${geo?.timezone ? `<div class="geo-row"><span class="geo-label">Timezone</span><span class="geo-value">${geo.timezone}</span></div>` : ""}
        ${hasCoords ? `<div class="geo-row"><span class="geo-label">Coords</span><span class="geo-value">${geo.latitude}, ${geo.longitude}</span></div>` : ""}
        ${hasCoords ? `<div class="geo-action">Click flag to open in Google Maps</div>` : ""}
      </div>
    </div>` : ""}
  `;

  document.getElementById("logout-btn")?.addEventListener("click", logout);

  // Flag hover and click handlers
  const flagEl = document.getElementById("user-flag");
  const tooltipEl = document.getElementById("geo-tooltip");

  if (flagEl && tooltipEl) {
    flagEl.addEventListener("mouseenter", () => {
      tooltipEl.classList.add("visible");
    });
    flagEl.addEventListener("mouseleave", () => {
      tooltipEl.classList.remove("visible");
    });

    if (hasCoords) {
      flagEl.addEventListener("click", () => {
        const mapsUrl = `https://www.google.com/maps/place/${geo.latitude},${geo.longitude}/@${geo.latitude},${geo.longitude},3z`;
        window.open(mapsUrl, "_blank");
      });
    }
  }
}

// Show login required overlay for broadcast
function showLoginRequired() {
  const broadcastView = document.getElementById("broadcast-view");
  if (!broadcastView) return;

  const overlay = document.createElement("div");
  overlay.id = "login-overlay";
  overlay.innerHTML = `
    <div class="login-required">
      <div class="watch-stream-section">
        <h2>Enter Stream ID to Watch</h2>
        <div class="watch-stream-input-row">
          <input type="text" id="watch-stream-id-input" maxlength="5" placeholder="xxxxx" autocomplete="off" spellcheck="false">
          <button id="watch-stream-go-btn" type="button" title="Go to stream">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 16 16 12 12 8"/>
              <line x1="8" y1="12" x2="16" y2="12"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="login-divider"><span>or</span></div>
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

  // Watch stream functionality
  const watchInput = document.getElementById("watch-stream-id-input") as HTMLInputElement;
  const watchGoBtn = document.getElementById("watch-stream-go-btn");

  const goToStream = () => {
    const streamId = watchInput.value.trim().toLowerCase();
    if (streamId.length !== 5) {
      alert("Stream IDs are five characters long");
      watchInput.focus();
      return;
    }
    window.open(`/${streamId}`, "_blank");
  };

  watchGoBtn?.addEventListener("click", goToStream);
  watchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      goToStream();
    }
  });
  // Auto-lowercase input
  watchInput?.addEventListener("input", () => {
    watchInput.value = watchInput.value.toLowerCase();
  });
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

      updateStreamSettings(streamId, { require_auth: requireAuthCheckbox.checked });
    });
  }

  // Set viewers link to stream stats page
  const viewersLink = document.getElementById("viewers-link") as HTMLAnchorElement;
  if (viewersLink) {
    viewersLink.href = `/${streamId}/stats`;
    viewersLink.target = "_blank";
    // Prevent link click from toggling the checkbox
    viewersLink.addEventListener("click", (e) => {
      e.stopPropagation();
    });
  }

  // Drive the headless <moq-publish> core element with our own control bar.
  const publisher = document.querySelector("moq-publish") as MoqPublishElement | null;
  if (publisher) {
    publisher.setAttribute("url", RELAY_URL);
    publisher.setAttribute("name", streamName);

    type DeviceMode = "camera" | "audio" | "screen" | "off";

    // Map a control-bar selection to the element's source/invisible/muted props.
    // audio-only = camera source with video disabled (invisible); off = no source.
    const applyMode = (mode: DeviceMode) => {
      switch (mode) {
        case "camera":
          publisher.invisible = false;
          publisher.muted = false;
          publisher.source = "camera";
          break;
        case "audio":
          publisher.invisible = true;
          publisher.muted = false;
          publisher.source = "camera";
          break;
        case "screen":
          publisher.invisible = false;
          publisher.muted = false;
          publisher.source = "screen";
          break;
        case "off":
          publisher.source = null;
          break;
      }
      console.log(`[moq-publish] mode=${mode} -> source=${String(publisher.source)} invisible=${publisher.invisible} muted=${publisher.muted}`);
    };

    // --- Build the control bar (status + device buttons + overlay toggle) ---
    const bar = document.createElement("div");
    bar.className = "publish-controls";

    const statusEl = document.createElement("div");
    statusEl.className = "publish-status";
    statusEl.textContent = "⚪";
    statusEl.setAttribute("data-status-text", "Offline");
    bar.appendChild(statusEl);

    const deviceButtons: Partial<Record<DeviceMode, HTMLButtonElement>> = {};

    // Selected = dim (already chosen, de-emphasized); available = bright (click me).
    const setActiveButton = (mode: DeviceMode | null) => {
      (Object.keys(deviceButtons) as DeviceMode[]).forEach((m) => {
        const btn = deviceButtons[m];
        if (!btn) return;
        btn.classList.toggle("device-selected", m === mode);
        btn.classList.toggle("device-available", m !== mode);
      });
    };

    const makeDeviceButton = (mode: DeviceMode, emoji: string, label: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "publish-btn";
      b.title = label;
      b.textContent = emoji;
      b.addEventListener("click", () => {
        applyMode(mode);
        setActiveButton(mode);
      });
      deviceButtons[mode] = b;
      bar.appendChild(b);
    };
    makeDeviceButton("audio", "🎤", "Audio Only");
    makeDeviceButton("camera", "📹", "Camera");
    makeDeviceButton("screen", "🖥️", "Screen");
    makeDeviceButton("off", "⏹️", "Off");
    setActiveButton(null);

    // Place the control bar directly after the <moq-publish> element.
    publisher.insertAdjacentElement("afterend", bar);

    // --- Status indicator + broadcast start/end logging, driven by signals ---
    let broadcastEventId: number | null = null;
    const refreshStatus = () => {
      const conn = publisher.connection?.status?.peek?.() ?? "disconnected";
      const hasSource = !!publisher.state?.source?.peek?.();
      let emoji = "⚪";
      let text = "Offline";
      if (conn === "connected" && hasSource) {
        emoji = "🟢"; text = "Live";
      } else if (conn === "connecting") {
        emoji = "🟡"; text = "Connecting";
      } else if (conn === "connected" && !hasSource) {
        emoji = "🟡"; text = "Select Device";
      }
      statusEl.textContent = emoji;
      statusEl.setAttribute("data-status-text", text);

      // Log broadcast start/end transitions to the stats DB.
      const isLive = conn === "connected" && hasSource;
      if (isLive && !broadcastEventId) {
        logBroadcastStart(streamId).then((id) => {
          broadcastEventId = id;
          console.log("Broadcast started, event ID:", id);
        });
      } else if (!isLive && broadcastEventId) {
        logBroadcastEnd(broadcastEventId);
        console.log("Broadcast ended, event ID:", broadcastEventId);
        broadcastEventId = null;
      }
    };
    try {
      publisher.connection?.status?.subscribe?.(refreshStatus);
      publisher.state?.source?.subscribe?.(refreshStatus);
    } catch (err) {
      console.warn("Could not subscribe to publish status signals:", err);
    }
    refreshStatus();

    // --- Diagnostics: @moq silently swallows getUserMedia/encoder errors, so log
    // whether real media tracks actually attach to the broadcast encoder. ---
    const logTrack = (kind: string, track: unknown) => {
      const t = track as { label?: string; readyState?: string } | null | undefined;
      if (t && typeof t === "object") {
        console.log(`[moq-publish] ${kind} track ATTACHED:`, t.label ?? "(no label)", "readyState:", t.readyState);
      } else {
        console.warn(`[moq-publish] ${kind} track: NONE — capture not running or getUserMedia failed/denied`);
      }
    };
    try {
      publisher.broadcast?.video?.source?.subscribe?.((t) => logTrack("video", t));
      publisher.broadcast?.audio?.source?.subscribe?.((t) => logTrack("audio", t));
    } catch (err) {
      console.warn("[moq-publish] could not subscribe to media source signals:", err);
    }

    // Log end on page unload
    window.addEventListener("beforeunload", () => {
      if (broadcastEventId) {
        logBroadcastEnd(broadcastEventId);
      }
    });

    // --- HTML overlay editor (broadcaster-authored HTML shown to viewers) ---
    const overlayBtn = document.createElement("button");
    overlayBtn.type = "button";
    overlayBtn.title = "HTML Overlay";
    overlayBtn.className = "publish-btn html-overlay-btn";
    overlayBtn.textContent = "</>";
    bar.appendChild(overlayBtn);

    const overlayContainer = document.createElement("div");
    overlayContainer.className = "html-overlay-container";
    overlayContainer.innerHTML = `
      <div class="html-overlay-input" contenteditable="true"></div>
      <div class="html-overlay-hint">HTML content will be displayed below the video for all viewers</div>
    `;
    const section = document.querySelector("#broadcast-view section");
    if (section && section.parentNode) {
      section.parentNode.insertBefore(overlayContainer, section.nextSibling);
    }

    const overlayInput = overlayContainer.querySelector(".html-overlay-input") as HTMLDivElement;
    let saveTimeout: number | null = null;

    // Load existing overlay content
    getStreamSettings(streamId).then((settings) => {
      if (settings.overlay_html) {
        overlayInput.textContent = settings.overlay_html;
        overlayBtn.classList.add("active");
      }
    });

    // Save overlay content with debounce
    overlayInput.addEventListener("input", () => {
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = window.setTimeout(() => {
        const content = overlayInput.textContent || "";
        updateStreamSettings(streamId, { overlay_html: content });
        overlayBtn.classList.toggle("active", !!content.trim());
      }, 500);
    });

    // Toggle overlay input visibility
    overlayBtn.addEventListener("click", () => {
      overlayContainer.classList.toggle("visible");
      if (overlayContainer.classList.contains("visible")) {
        overlayInput.focus();
      }
    });
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

  // Set stream name on watcher (headless <moq-watch> core element)
  const watcher = document.querySelector("moq-watch") as MoqWatchElement | null;
  if (watcher) {
    watcher.setAttribute("url", RELAY_URL);
    watcher.setAttribute("name", streamName);

    // Start muted; first click/tap on the player enables audio.
    const enableAudio = () => {
      watcher.muted = false;
      watcher.removeEventListener("click", enableAudio);
    };
    watcher.addEventListener("click", enableAudio);

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

    // Create HTML overlay display div
    const watchSection = document.querySelector("#watch-view section");
    let overlayDiv = document.querySelector(".viewer-html-overlay") as HTMLDivElement;
    if (!overlayDiv && watchSection) {
      overlayDiv = document.createElement("div");
      overlayDiv.className = "viewer-html-overlay";
      watchSection.parentNode?.insertBefore(overlayDiv, watchSection.nextSibling);
    }

    // Function to update overlay content
    const updateOverlay = (overlayHtml: string) => {
      if (overlayDiv) {
        if (overlayHtml.trim()) {
          overlayDiv.innerHTML = overlayHtml;
        } else {
          overlayDiv.innerHTML = "";
        }
      }
    };

    // Load initial overlay content
    if (settings.overlay_html) {
      updateOverlay(settings.overlay_html);
    }

    // Poll for setting changes (auth and overlay)
    const settingsCheckInterval = setInterval(async () => {
      const currentSettings = await getStreamSettings(streamId);

      // Check auth requirement (anonymous viewers only)
      if (!user && currentSettings.require_auth) {
        clearInterval(settingsCheckInterval);
        if (watchEventId) {
          logWatchEnd(watchEventId);
          watchEventId = null;
        }
        showWatchLoginRequired();
        return;
      }

      // Update overlay content
      updateOverlay(currentSettings.overlay_html);
    }, 5000); // Check every 5 seconds

    // Cleanup interval on page unload
    window.addEventListener("beforeunload", () => {
      clearInterval(settingsCheckInterval);
    });
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

    const renderGeoFlag = (geo: { geo_country: string | null; geo_city: string | null; geo_region: string | null; geo_latitude: string | null; geo_longitude: string | null; geo_timezone: string | null }, id: string) => {
      const flag = countryToFlag(geo.geo_country);
      if (!flag) return "";
      const hasCoords = geo.geo_latitude && geo.geo_longitude;
      const mapsUrl = hasCoords ? `https://www.google.com/maps/place/${geo.geo_latitude},${geo.geo_longitude}/@${geo.geo_latitude},${geo.geo_longitude},3z` : null;
      const tooltip = [
        geo.geo_city,
        geo.geo_region,
        geo.geo_country,
        geo.geo_timezone,
        hasCoords ? `${geo.geo_latitude}, ${geo.geo_longitude}` : null
      ].filter(Boolean).join(" | ");
      return `<span class="stats-flag ${hasCoords ? 'clickable' : ''}" data-id="${id}" data-url="${mapsUrl || ''}" title="${tooltip}">${flag}</span>`;
    };

    const broadcastRows = stats.broadcasts.length === 0
      ? `<tr><td colspan="5" class="empty">No active broadcasts</td></tr>`
      : stats.broadcasts.map((b: LiveBroadcast) => `
          <tr>
            <td><a href="/${b.stream_id}" target="_blank">${b.stream_id}</a></td>
            <td>
              ${b.avatar_url ? `<img src="${b.avatar_url}" class="avatar-small">` : ""}
              ${b.user_name || b.user_email}
            </td>
            <td>${renderGeoFlag(b, `b-${b.id}`)}</td>
            <td>${formatDuration(b.started_at)}</td>
            <td>${stats.viewers.filter((v: LiveViewer) => v.stream_id === b.stream_id).length}</td>
          </tr>
        `).join("");

    const viewerRows = stats.viewers.length === 0
      ? `<tr><td colspan="4" class="empty">No active viewers</td></tr>`
      : stats.viewers.map((v: LiveViewer) => `
          <tr>
            <td><a href="/${v.stream_id}" target="_blank">${v.stream_id}</a></td>
            <td>
              ${v.avatar_url ? `<img src="${v.avatar_url}" class="avatar-small">` : ""}
              ${v.user_name || v.user_email || "Anonymous"}
            </td>
            <td>${renderGeoFlag(v, `v-${v.id}`)}</td>
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
                <th>Location</th>
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
                <th>Location</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>${viewerRows}</tbody>
          </table>
        </section>
      </div>
      <button id="refresh-stats" class="btn btn-primary" style="margin-top: 1rem;">Refresh</button>
    `;

    // Add click handlers for flags
    statsView.querySelectorAll(".stats-flag.clickable").forEach((el) => {
      el.addEventListener("click", () => {
        const url = (el as HTMLElement).dataset.url;
        if (url) window.open(url, "_blank");
      });
    });

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

    const renderGeoFlag = (geo: { geo_country: string | null; geo_city: string | null; geo_region: string | null; geo_latitude: string | null; geo_longitude: string | null; geo_timezone: string | null }, id: string) => {
      const flag = countryToFlag(geo.geo_country);
      if (!flag) return "";
      const hasCoords = geo.geo_latitude && geo.geo_longitude;
      const mapsUrl = hasCoords ? `https://www.google.com/maps/place/${geo.geo_latitude},${geo.geo_longitude}/@${geo.geo_latitude},${geo.geo_longitude},3z` : null;
      const tooltip = [
        geo.geo_city,
        geo.geo_region,
        geo.geo_country,
        geo.geo_timezone,
        hasCoords ? `${geo.geo_latitude}, ${geo.geo_longitude}` : null
      ].filter(Boolean).join(" | ");
      return `<span class="stats-flag ${hasCoords ? 'clickable' : ''}" data-id="${id}" data-url="${mapsUrl || ''}" title="${tooltip}">${flag}</span>`;
    };

    const viewerRows = data.viewers.length === 0
      ? `<tr><td colspan="3" class="empty">No active viewers</td></tr>`
      : data.viewers.map((v: LiveViewer) => `
          <tr>
            <td>
              ${v.avatar_url ? `<img src="${v.avatar_url}" class="avatar-small">` : ""}
              ${v.user_name || v.user_email || "Anonymous"}
            </td>
            <td>${renderGeoFlag(v, `v-${v.id}`)}</td>
            <td>${formatDuration(v.started_at)}</td>
          </tr>
        `).join("");

    statsView.innerHTML = `
      <h2>Viewers for <a href="/${streamId}" class="stream-link">${streamId}</a></h2>
      <p><a href="/${streamId}/stats/map" class="view-toggle" title="View Map">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
          <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/>
          <line x1="8" y1="2" x2="8" y2="18"/>
          <line x1="16" y1="6" x2="16" y2="22"/>
        </svg>
      </a></p>
      <section class="stats-section">
        <h3>Active Viewers (${data.viewers.length})</h3>
        <table class="stats-table">
          <thead>
            <tr>
              <th>Viewer</th>
              <th>Location</th>
              <th>Watching for</th>
            </tr>
          </thead>
          <tbody>${viewerRows}</tbody>
        </table>
      </section>
      <button id="refresh-stream-stats" class="btn btn-primary" style="margin-top: 1rem;">Refresh</button>
    `;

    // Add click handlers for flags
    statsView.querySelectorAll(".stats-flag.clickable").forEach((el) => {
      el.addEventListener("click", () => {
        const url = (el as HTMLElement).dataset.url;
        if (url) window.open(url, "_blank");
      });
    });

    document.getElementById("refresh-stream-stats")?.addEventListener("click", renderViewers);
  };

  await renderViewers();
}

// Initialize stats map view (all viewers on a map)
async function initStatsMapView(user: User | null) {
  console.log("Vivoh.Earth Stats Map");

  // Hide broadcast and watch views
  document.getElementById("broadcast-view")?.classList.add("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // Hide footer and new stream button
  const footer = document.querySelector("footer");
  if (footer) footer.classList.add("hidden");
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) newStreamBtn.classList.add("hidden");

  // Create map view container
  const container = document.querySelector(".container");
  if (!container) return;

  const mapView = document.createElement("div");
  mapView.id = "stats-map-view";
  mapView.className = "stats-view";

  // Check if logged in
  if (!user) {
    mapView.innerHTML = `
      <div class="stats-login-required">
        <h2>Sign in Required</h2>
        <p>Please sign in to view the live map.</p>
        <div class="auth-buttons">
          <button id="map-login-google" class="btn btn-google">Google</button>
          <button id="map-login-microsoft" class="btn btn-microsoft">Microsoft</button>
          <button id="map-login-discord" class="btn btn-discord">Discord</button>
        </div>
      </div>
    `;
    container.appendChild(mapView);
    document.getElementById("map-login-google")?.addEventListener("click", loginWithGoogle);
    document.getElementById("map-login-microsoft")?.addEventListener("click", loginWithMicrosoft);
    document.getElementById("map-login-discord")?.addEventListener("click", loginWithDiscord);
    return;
  }

  mapView.innerHTML = `
    <h2>Live Viewer Map</h2>
    <p><a href="/stats" class="view-toggle" title="View Table">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <line x1="3" y1="9" x2="21" y2="9"/>
        <line x1="3" y1="15" x2="21" y2="15"/>
        <line x1="9" y1="3" x2="9" y2="21"/>
      </svg>
    </a></p>
    <div id="leaflet-map" style="height: 500px; border-radius: 8px; margin-top: 1rem;"></div>
    <button id="refresh-map" class="btn btn-primary" style="margin-top: 1rem;">Refresh</button>
  `;
  container.appendChild(mapView);

  const renderMap = async () => {
    const stats = await getLiveStats();
    if (!stats) return;

    const mapEl = document.getElementById("leaflet-map");
    if (!mapEl) return;

    // Clear existing map
    mapEl.innerHTML = "";

    // @ts-expect-error Leaflet loaded from CDN
    const map = L.map("leaflet-map").setView([20, 0], 2);

    // @ts-expect-error Leaflet loaded from CDN
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: '&copy; Esri'
    }).addTo(map);

    // Add viewer markers (blue)
    stats.viewers.forEach((v: LiveViewer) => {
      if (v.geo_latitude && v.geo_longitude) {
        const lat = parseFloat(v.geo_latitude);
        const lng = parseFloat(v.geo_longitude);
        const name = v.user_name || v.user_email || "Anonymous";
        const location = [v.geo_city, v.geo_region, v.geo_country].filter(Boolean).join(", ");
        // @ts-expect-error Leaflet loaded from CDN
        L.marker([lat, lng], {
          // @ts-expect-error Leaflet loaded from CDN
          icon: L.divIcon({
            className: "viewer-marker",
            html: `<div style="background: #3b82f6; width: 12px; height: 12px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
            iconSize: [12, 12],
            iconAnchor: [6, 6]
          })
        })
          .addTo(map)
          .bindPopup(`<strong>${name}</strong><br>Watching: ${v.stream_id}<br>${location}`);
      }
    });

    // Add broadcaster markers (red)
    stats.broadcasts.forEach((b: LiveBroadcast) => {
      if (b.geo_latitude && b.geo_longitude) {
        const lat = parseFloat(b.geo_latitude);
        const lng = parseFloat(b.geo_longitude);
        const name = b.user_name || b.user_email;
        const location = [b.geo_city, b.geo_region, b.geo_country].filter(Boolean).join(", ");
        // @ts-expect-error Leaflet loaded from CDN
        L.marker([lat, lng], {
          // @ts-expect-error Leaflet loaded from CDN
          icon: L.divIcon({
            className: "broadcaster-marker",
            html: `<div style="background: #ef4444; width: 16px; height: 16px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
            iconSize: [16, 16],
            iconAnchor: [8, 8]
          })
        })
          .addTo(map)
          .bindPopup(`<strong>${name}</strong> (Broadcaster)<br>Stream: ${b.stream_id}<br>${location}`);
      }
    });
  };

  await renderMap();
  document.getElementById("refresh-map")?.addEventListener("click", renderMap);
}

// Initialize stream-specific stats map view (viewers for one stream on a map)
async function initStreamStatsMapView(streamId: string) {
  console.log(`Vivoh.Earth Stream Stats Map - Stream: ${streamId}`);

  // Hide broadcast and watch views
  document.getElementById("broadcast-view")?.classList.add("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // Hide footer and new stream button
  const footer = document.querySelector("footer");
  if (footer) footer.classList.add("hidden");
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) newStreamBtn.classList.add("hidden");

  // Create map view container
  const container = document.querySelector(".container");
  if (!container) return;

  const mapView = document.createElement("div");
  mapView.id = "stream-stats-map-view";
  mapView.className = "stats-view";

  mapView.innerHTML = `
    <h2>Viewer Map for <a href="/${streamId}" class="stream-link">${streamId}</a></h2>
    <p><a href="/${streamId}/stats" class="view-toggle" title="View Table">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <line x1="3" y1="9" x2="21" y2="9"/>
        <line x1="3" y1="15" x2="21" y2="15"/>
        <line x1="9" y1="3" x2="9" y2="21"/>
      </svg>
    </a></p>
    <div id="leaflet-map" style="height: 500px; border-radius: 8px; margin-top: 1rem;"></div>
    <button id="refresh-stream-map" class="btn btn-primary" style="margin-top: 1rem;">Refresh</button>
  `;
  container.appendChild(mapView);

  const renderMap = async () => {
    const data = await getStreamViewers(streamId);
    if (!data) return;

    const mapEl = document.getElementById("leaflet-map");
    if (!mapEl) return;

    // Clear existing map
    mapEl.innerHTML = "";

    // @ts-expect-error Leaflet loaded from CDN
    const map = L.map("leaflet-map").setView([20, 0], 2);

    // @ts-expect-error Leaflet loaded from CDN
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: '&copy; Esri'
    }).addTo(map);

    // Add viewer markers
    data.viewers.forEach((v: LiveViewer) => {
      if (v.geo_latitude && v.geo_longitude) {
        const lat = parseFloat(v.geo_latitude);
        const lng = parseFloat(v.geo_longitude);
        const name = v.user_name || v.user_email || "Anonymous";
        const location = [v.geo_city, v.geo_region, v.geo_country].filter(Boolean).join(", ");
        // @ts-expect-error Leaflet loaded from CDN
        L.marker([lat, lng], {
          // @ts-expect-error Leaflet loaded from CDN
          icon: L.divIcon({
            className: "viewer-marker",
            html: `<div style="background: #3b82f6; width: 12px; height: 12px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
            iconSize: [12, 12],
            iconAnchor: [6, 6]
          })
        })
          .addTo(map)
          .bindPopup(`<strong>${name}</strong><br>${location}`);
      }
    });

    // Fit bounds if there are markers
    const viewersWithGeo = data.viewers.filter((v: LiveViewer) => v.geo_latitude && v.geo_longitude);
    if (viewersWithGeo.length > 0) {
      // @ts-expect-error Leaflet loaded from CDN
      const bounds = L.latLngBounds(
        viewersWithGeo.map((v: LiveViewer) => [parseFloat(v.geo_latitude!), parseFloat(v.geo_longitude!)])
      );
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 4 });
    }
  };

  await renderMap();
  document.getElementById("refresh-stream-map")?.addEventListener("click", renderMap);
}

// Initialize greet view (broadcasters only map - public)
async function initGreetView() {
  console.log("Vivoh.Earth Greet - Live Broadcasters");

  // Hide broadcast and watch views
  document.getElementById("broadcast-view")?.classList.add("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // Hide footer and new stream button
  const footer = document.querySelector("footer");
  if (footer) footer.classList.add("hidden");
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) newStreamBtn.classList.add("hidden");

  // Create greet view container
  const container = document.querySelector(".container");
  if (!container) return;

  const greetView = document.createElement("div");
  greetView.id = "greet-view";
  greetView.className = "stats-view";

  greetView.innerHTML = `
    <h2>Live Broadcasts</h2>
    <p class="greet-subtitle">Click a marker to watch</p>
    <div id="leaflet-map" style="height: 600px; border-radius: 8px; margin-top: 1rem;"></div>
    <button id="refresh-greet" class="btn btn-primary" style="margin-top: 1rem;">Refresh</button>
  `;
  container.appendChild(greetView);

  interface GreetBroadcast {
    id: number;
    stream_id: string;
    started_at: string;
    user_name: string;
    geo_country: string | null;
    geo_city: string | null;
    geo_region: string | null;
    geo_latitude: string | null;
    geo_longitude: string | null;
    viewer_count: number;
  }

  const renderMap = async () => {
    // Fetch broadcasts from public greet endpoint
    const response = await fetch("/api/stats/greet");
    if (!response.ok) {
      const mapEl = document.getElementById("leaflet-map");
      if (mapEl) {
        mapEl.innerHTML = `<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #737373;">Failed to load broadcasts</div>`;
      }
      return;
    }
    const data = await response.json() as { broadcasts: GreetBroadcast[] };

    const mapEl = document.getElementById("leaflet-map");
    if (!mapEl) return;

    // Clear existing map
    mapEl.innerHTML = "";

    // @ts-expect-error Leaflet loaded from CDN
    const map = L.map("leaflet-map").setView([20, 0], 2);

    // @ts-expect-error Leaflet loaded from CDN
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: '&copy; Esri &mdash; Esri, DeLorme, NAVTEQ'
    }).addTo(map);

    // Add broadcaster markers (red) with viewer count
    data.broadcasts.forEach((b: GreetBroadcast) => {
      if (b.geo_latitude && b.geo_longitude) {
        const lat = parseFloat(b.geo_latitude);
        const lng = parseFloat(b.geo_longitude);
        const name = b.user_name || "Broadcaster";
        const location = [b.geo_city, b.geo_region, b.geo_country].filter(Boolean).join(", ");
        const viewers = b.viewer_count || 0;

        // @ts-expect-error Leaflet loaded from CDN
        const marker = L.marker([lat, lng], {
          // @ts-expect-error Leaflet loaded from CDN
          icon: L.divIcon({
            className: "broadcaster-marker",
            html: `<div style="background: #ef4444; width: 20px; height: 20px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 8px rgba(0,0,0,0.4); cursor: pointer;"></div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10]
          })
        }).addTo(map);

        // Tooltip on hover showing viewer count
        marker.bindTooltip(`<strong>${name}</strong><br>${location}<br><span style="color: #3b82f6;">${viewers} viewer${viewers !== 1 ? 's' : ''}</span>`, {
          direction: 'top',
          offset: [0, -10]
        });

        // Click to open watch page in new tab
        marker.on('click', () => {
          window.open(`/${b.stream_id}`, '_blank');
        });
      }
    });

    // If no broadcasters with geo, show message
    const broadcastersWithGeo = data.broadcasts.filter((b: GreetBroadcast) => b.geo_latitude && b.geo_longitude);
    if (broadcastersWithGeo.length === 0) {
      mapEl.innerHTML = `<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #737373;">No live broadcasts at the moment</div>`;
    }
  };

  await renderMap();
  document.getElementById("refresh-greet")?.addEventListener("click", renderMap);
}

// Initialize admin view
function initAdminView() {
  console.log("Vivoh.Earth Admin Panel");

  // Hide broadcast and watch views
  document.getElementById("broadcast-view")?.classList.add("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // Hide footer and new stream button
  const footer = document.querySelector("footer");
  if (footer) footer.classList.add("hidden");
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) newStreamBtn.classList.add("hidden");

  // Create admin view container
  const container = document.querySelector(".container");
  if (!container) return;

  const adminView = document.createElement("div");
  adminView.id = "admin-view";
  adminView.className = "stats-view";

  adminView.innerHTML = `
    <h2>Admin Panel</h2>
    <div id="admin-login" class="stats-section" style="max-width: 400px; margin: 2rem auto;">
      <h3>Password Required</h3>
      <div style="display: flex; flex-direction: column; gap: 1rem; margin-top: 1rem;">
        <input type="password" id="admin-password" placeholder="Enter admin password"
          style="background: #262626; border: 1px solid #404040; border-radius: 6px; padding: 0.75rem; color: #e5e5e5; font-size: 1rem;">
        <button id="admin-login-btn" class="btn btn-primary">Login</button>
        <p id="admin-error" style="color: #ef4444; display: none; text-align: center;"></p>
      </div>
    </div>
    <div id="admin-panel" class="stats-section" style="max-width: 600px; margin: 2rem auto; display: none;">
      <h3>Data Management</h3>
      <p style="color: #a3a3a3; margin-bottom: 1.5rem;">Warning: These actions are irreversible.</p>
      <div style="display: flex; flex-direction: column; gap: 1rem;">
        <button id="clear-broadcasts-btn" class="btn" style="background: #7f1d1d; border-color: #991b1b;">
          Clear All Broadcaster Data
        </button>
        <button id="clear-viewers-btn" class="btn" style="background: #7f1d1d; border-color: #991b1b;">
          Clear All Viewer Data
        </button>
      </div>
      <div id="admin-status" style="margin-top: 1rem; padding: 0.75rem; border-radius: 6px; display: none;"></div>
    </div>
  `;
  container.appendChild(adminView);

  let adminPassword = "";

  const showStatus = (message: string, isError: boolean) => {
    const statusEl = document.getElementById("admin-status");
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.style.display = "block";
      statusEl.style.background = isError ? "#7f1d1d" : "#14532d";
      statusEl.style.color = "#e5e5e5";
    }
  };

  // Login handler
  document.getElementById("admin-login-btn")?.addEventListener("click", async () => {
    const passwordInput = document.getElementById("admin-password") as HTMLInputElement;
    const errorEl = document.getElementById("admin-error");
    adminPassword = passwordInput?.value || "";

    // Verify the password
    try {
      const response = await fetch("/api/admin/verify", {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${adminPassword}`
        }
      });

      // If we get 401, password is wrong
      if (response.status === 401) {
        if (errorEl) {
          errorEl.textContent = "Invalid password";
          errorEl.style.display = "block";
        }
        return;
      }

      // Password is correct, show the admin panel
      document.getElementById("admin-login")!.style.display = "none";
      document.getElementById("admin-panel")!.style.display = "block";
    } catch {
      if (errorEl) {
        errorEl.textContent = "Connection error";
        errorEl.style.display = "block";
      }
    }
  });

  // Clear broadcasts handler
  document.getElementById("clear-broadcasts-btn")?.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to clear ALL broadcaster data? This cannot be undone.")) {
      return;
    }

    try {
      const response = await fetch("/api/admin/broadcasts", {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${adminPassword}`
        }
      });

      if (response.ok) {
        showStatus("All broadcaster data has been cleared.", false);
      } else {
        const data = await response.json();
        showStatus(data.error || "Failed to clear data", true);
      }
    } catch {
      showStatus("Connection error", true);
    }
  });

  // Clear viewers handler
  document.getElementById("clear-viewers-btn")?.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to clear ALL viewer data? This cannot be undone.")) {
      return;
    }

    try {
      const response = await fetch("/api/admin/viewers", {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${adminPassword}`
        }
      });

      if (response.ok) {
        showStatus("All viewer data has been cleared.", false);
      } else {
        const data = await response.json();
        showStatus(data.error || "Failed to clear data", true);
      }
    } catch {
      showStatus("Connection error", true);
    }
  });

  // Handle enter key on password input
  document.getElementById("admin-password")?.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      document.getElementById("admin-login-btn")?.click();
    }
  });
}

// Initialize the app
async function init() {
  // Detect browser support (async for codec checks)
  browserSupport = await detectBrowserSupport();

  // For Safari/polyfill mode, select the best relay server based on latency
  if (needsPolyfill) {
    const bestRelay = await selectBestFallbackRelay();
    RELAY_URL = `https://${bestRelay}`;
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
  const { user, geo } = await getCurrentUser();
  updateAuthUI(user, geo);

  if (view === "broadcast") {
    initBroadcastView(streamId, user);
  } else if (view === "stats") {
    await initStatsView(user);
  } else if (view === "stats-map") {
    await initStatsMapView(user);
  } else if (view === "greet") {
    await initGreetView();
  } else if (view === "stream-stats") {
    await initStreamStatsView(streamId);
  } else if (view === "stream-stats-map") {
    await initStreamStatsMapView(streamId);
  } else if (view === "admin") {
    initAdminView();
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
