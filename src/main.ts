// Safari WebSocket fallback - MUST install before hang components load
// Using our patched version that handles requireUnreliable gracefully
import { install as installWebTransportPolyfill } from "./webtransport-polyfill";
// WebCodecs polyfill for Opus audio encoding on Safari
import { install as installWebCodecsPolyfill } from "./webcodecs-polyfill";
// Transport-layer instrumentation for the ~140s iOS stall (?diag=1 only)
import { installWtProbe, wtProbe } from "./wt-probe";

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

  // Dark is the default look (OS preference is ignored on first visit). Only an explicit
  // saved choice of "light" opts in; anything else — including no saved preference — is dark.
  if (savedTheme === "light") {
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
  // Where a caller injects its own MediaStreamTracks, as of @moq/publish 0.4.7. `in` is typed
  // Readonlys<> upstream (Getters), but readonlys() is the identity function at runtime, so the
  // signals are settable — see the `settable()` guard at the injection site, which checks that
  // rather than assuming it. Declared loosely here because the real types are not exported in a
  // shape this file can name without pulling the whole package in.
  capture?: { in?: { source?: unknown } };
  audio?: { in?: { source?: unknown }; codec?: unknown };
}

interface MoqWatchElement extends HTMLElement {
  muted: boolean;
}

// Safari fallback relay servers (WebSocket-enabled)
// Pinned to the single test box for the full end-to-end test (no prod traffic).
const FALLBACK_RELAYS = [
  "cdn.gpcmoq.com",
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
  // Display-only: the confirmed origin<->edge transport for a cross-cluster (viewer-cdn=)
  // stream, probed from the edge's /edge_xport. A ready-to-render string, or null = hide.
  originLink: string | null;
}

const serverStatus: ServerStatus = {
  mode: needsPolyfill ? "websocket" : "webtransport",
  // Not a hostname. This is the value shown before any connection exists, and it used to name
  // a self-hosted fleet box that is not in the media path at all — so the panel confidently
  // reported a server this client had never contacted and would never use. Anything real is
  // written by setActiveRelay() once a relay is actually assigned.
  selectedServer: "(not connected)",
  connected: false,
  raceResults: [],
  originLink: null,
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
    ${serverStatus.originLink ? `<div class="origin-link-line" style="font-size:0.8rem;color:var(--text-muted,#737373);margin-top:2px;">${serverStatus.originLink}</div>` : ""}
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

// Record the relay this client actually connected to (assigned/routed, possibly a
// CDN override or cross-cluster edge) and refresh the footer Server Status panel.
function setActiveRelay(relay: string | null) {
  serverStatus.selectedServer = relay ?? "(no relay assigned)";
  serverStatus.connected = !!relay;
  serverStatus.originLink = null; // stale on any relay change; the edge_xport probe refills it
  updateServerStatusPanel();
}

// Display-only origin<->edge transport probe for cross-cluster (viewer-cdn=) streams. The
// edge autoscaler exposes GET https://<edge-host>/edge_xport?broadcast=<rawId> ->
// {xport:"iroh"|"quic"|"unknown", origin:"host:port"} (public, no auth, :443). We fetch it
// ~1.5s after connect and re-poll a few times, rendering a stats line next to "Connected".
// unknown / any error => hide the line (never surface a scary state).
function startOriginLinkProbe(edgeRelay: string, rawBroadcastId: string): void {
  const host = edgeRelay.split(":")[0];
  if (!host) return;
  let stopped = false;
  window.addEventListener("beforeunload", () => { stopped = true; });
  const probe = async (): Promise<void> => {
    if (stopped) return;
    try {
      const res = await fetch(
        `https://${host}/edge_xport?broadcast=${encodeURIComponent(rawBroadcastId)}`,
        { signal: AbortSignal.timeout(3000) }
      );
      if (!res.ok) { serverStatus.originLink = null; updateServerStatusPanel(); return; }
      const data = (await res.json()) as { xport?: string; origin?: string };
      if (data.xport === "iroh") {
        serverStatus.originLink = "Origin link: iroh / DHT";
      } else if (data.xport === "quic") {
        serverStatus.originLink = `Origin link: ${data.origin ?? "host:port"} (QUIC)`;
      } else {
        serverStatus.originLink = null; // "unknown" => hide
      }
      updateServerStatusPanel();
    } catch {
      serverStatus.originLink = null; // fetch error => hide
      updateServerStatusPanel();
    }
  };
  window.setTimeout(() => {
    void probe();
    const id = window.setInterval(() => {
      if (stopped) { window.clearInterval(id); return; }
      void probe();
    }, 5000);
  }, 1500);
}

// Status pills shown in the publisher header and on the player. We make a claim at each
// layer and nothing more: "Relay-blind" is an INFRASTRUCTURE property (encryption is
// mandatory, so it shows on every stream and says nothing about who may watch); the
// audience pill carries the ACCESS claim (Public vs Invite-only); and "Security details"
// hangs the honest caveats (static key, metadata, not-DRM) off the access affordance.
// 15px rather than the pills' 13px: this one carries no label beside it, so it has to hold
// the line on its own next to a 1rem monospace stream id.
const SHIELD_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>`;
const GLOBE_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
const LOCK_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
const PILL_CSS =
  "display:inline-flex;align-items:center;gap:4px;font-size:0.72rem;font-weight:600;" +
  "border:1px solid;border-radius:999px;padding:2px 8px;line-height:1;white-space:nowrap;";

// "Relay-blind" — shown on EVERY stream (encryption is mandatory). States that the relay
// and server only ever move ciphertext they can't read. Deliberately NOT a privacy claim
// about who may watch — that is the audience pill's job.
//
// A bare shield rather than a bordered "Encrypted" pill. The claim is true of every stream
// and can never be switched off, so a badge announcing it on every screen is a permanent
// banner for a constant — it reads as something to be reckoned with rather than something
// already handled. The icon marks the state; the hover carries the sentence for anyone who
// wants it. The audience pill keeps its label because that one VARIES, and a varying claim
// has to be readable at a glance rather than hovered.
function createRelayBlindBadge(): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = "relay-blind-badge";
  badge.title = "Encrypted — your browser encrypts every frame and viewers' browsers decrypt it. The relay and server only move ciphertext they can't read.";
  badge.innerHTML = SHIELD_SVG;
  // No border, no padding, no text. Icon-only, so it needs a name of its own: a title
  // attribute is a mouse affordance and says nothing to a screen reader or a touch device.
  badge.setAttribute("role", "img");
  badge.setAttribute("aria-label", "Encrypted");
  badge.style.cssText = "display:inline-flex;align-items:center;color:#22c55e;flex-shrink:0;";
  return badge;
}

// Audience pill — carries the ACCESS claim, driven by require_auth. Public = anyone with
// the link; Invite-only = viewers must sign in to receive the key. Mutated in place so a
// single element can track the live toggle.
function setAudienceBadge(badge: HTMLSpanElement, inviteOnly: boolean): void {
  const color = inviteOnly ? "#f59e0b" : "#9ca3af";
  badge.title = inviteOnly
    ? "Invite-only — viewers must sign in to receive the key and watch."
    : "Public — anyone with the link can watch.";
  badge.innerHTML = (inviteOnly ? LOCK_SVG : GLOBE_SVG) + `<span>${inviteOnly ? "Invite-only" : "Public"}</span>`;
  badge.style.color = color;
  badge.style.borderColor = color;
}

function createAudienceBadge(inviteOnly: boolean): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = "audience-badge";
  badge.style.cssText = PILL_CSS;
  setAudienceBadge(badge, inviteOnly);
  return badge;
}

// "Security details" disclosure — the honest caveats that attach to the access claim,
// surfaced at the moment a user reasons about privacy. Click toggles a small popover;
// an outside click closes it.
// The disclosure itself, without any affordance for revealing it. Split out so it can be
// dropped into the access-control info panel as well as behind the legacy "Security
// details" link below.
//
// This text is the honest description of a DIFFERENT security model from Wallflower's, and
// the differences are the whole point of it. Wallflower's says "it takes both halves" and
// "we cannot lock anyone out of it for you". Neither is true here, and leaving that wording
// in place would be the single most misleading thing on the page.
function createSecurityBody(): HTMLDivElement {
  const body = document.createElement("div");
  body.className = "security-body";
  body.innerHTML =
    `<strong style="color:#f3f4f6;display:block;margin-bottom:6px;">What encryption does and doesn't cover</strong>` +
    `<ul style="margin:0;padding-left:16px;display:flex;flex-direction:column;gap:6px;">` +
    `<li><strong>The link is the key.</strong> Everything after the <code>#</code> is the secret that decrypts your video, and your browser never sends it to us — so we cannot decrypt your stream even if we are asked to. It also means anyone the link reaches can decrypt it, so treat forwarding the link as granting access.</li>` +
    `<li><strong>Who may watch is a separate question, and we answer it.</strong> With <strong>Require sign-in</strong> on, we refuse to connect anyone who is not signed in, and you can see exactly who is watching. That is real access control — and unlike the encryption, it depends on us: we are in a position to grant it, and could in principle be compelled to.</li>` +
    `<li><strong>Revoking.</strong> Turning off a viewer's access stops them joining, and stops them continuing within about two minutes when their access pass expires. <strong>New link</strong> is the blunter option: it starts a fresh broadcast, so every copy of the old link dies and everyone watching drops.</li>` +
    `<li><strong>Metadata in the clear.</strong> Codec, resolution, frame timing and sizes, and track names are visible to the relay.</li>` +
    `<li><strong>Not DRM.</strong> Anyone allowed to watch can screen-capture the decoded video.</li>` +
    `</ul>`;
  return body;
}

function createSecurityDetails(): HTMLSpanElement {
  const wrap = document.createElement("span");
  wrap.className = "security-details";
  wrap.style.cssText = "position:relative;display:inline-flex;align-items:center;";
  const link = document.createElement("a");
  link.href = "#";
  link.textContent = "Security details";
  link.style.cssText = "font-size:0.72rem;color:#9ca3af;text-decoration:underline;cursor:pointer;white-space:nowrap;";
  const pop = document.createElement("div");
  pop.style.cssText =
    "display:none;position:absolute;z-index:60;top:calc(100% + 6px);left:0;width:290px;" +
    "background:#1a1a1a;border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:10px 12px;" +
    "font-size:0.72rem;line-height:1.45;color:#d1d5db;box-shadow:0 8px 28px rgba(0,0,0,0.55);text-align:left;";
  pop.appendChild(createSecurityBody());
  link.addEventListener("click", (e) => {
    e.preventDefault();
    pop.style.display = pop.style.display === "none" ? "block" : "none";
  });
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target as Node)) pop.style.display = "none";
  });
  wrap.append(link, pop);
  return wrap;
}

// Per-broadcast relay tokens are minted server-side (BYOK) and returned by the Worker:
// publishers get one from POST /api/stats/broadcast, viewers from GET /route. There is no
// static client token — the browser never holds a long-lived, all-paths credential.
const NAMESPACE_PREFIX = "moqplay.com";

// Build the cdn.moq.pro connect URL from the Worker's {relay, path, jwt} (moq.pro Mode A).
// The element points at the FULL url and uses an empty name (the broadcast path lives in the
// url). When the Worker returns no `path`, the caller falls back to the fleet host:port form.
const moqUrl = (relay: string, path: string, jwt: string) =>
  `https://${relay}/${path.replace(/^\/+/, "")}?jwt=${jwt}`;

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
  consumeReturnTo,
  logout,
  logBroadcastStart,
  logBroadcastEnd,
  type BroadcastStart,
  logWatchStart,
  logWatchHeartbeat,
  logWatchEnd,
  type WatchSession,
  getStreamRoute,
  checkStreamExists,
  getStreamSettings,
  updateStreamSettings,
  getLiveStats,
  getStreamViewers,
  type User,
  type Geo,
  type StreamSettings,
  type LiveBroadcast,
  type LiveViewer,
  type StreamRoute
} from "./auth";
import { renderOverlay } from "./overlay-sanitize";
import { buildPublisherClaim } from "./publisher-claim";
import {
  armPublisher,
  armViewer,
  deriveChatKey,
  deriveMediaKey,
  deriveRouteTag,
  generateLinkSecret,
  decryptStats,
  resetMediaKey,
} from "./crypto/media-crypto";
import { initChat, type ChatHandle } from "./chat/chat-client";
import { describeLocation } from "./geo/nearest-city";
import { createCompositor, type CameraFacing, type Compositor } from "./media/pip-compositor";
import { createGeoStamp, type GeoStamp } from "./media/geo-stamp";

// /stats, /<id>/stats and /cleardata were removed: they existed to show who was broadcasting
// and watching, which is exactly the identity this app no longer holds. Rather than keep pages
// that could only render blanks, the surface is gone. The kill switch was never part of them
// and survives at /api/admin/kill and friends.
type View = "landing" | "broadcast" | "watch";

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

/**
 * The broadcaster's own address bar, which is NOT a share link and must not read like one.
 *
 * `/?stream=<id>` exists so a refresh resumes the same broadcast. The trap is that it looks
 * exactly like something you would send someone: it names the stream, it is in the address
 * bar the moment you go live, and it carries neither the `#k=` secret nor the passcode — so
 * a recipient cannot decrypt anything. Worse than a black player, `?stream=` routes to the
 * BROADCAST view, so whoever opens it lands on a publishing page for a stream they do not
 * own rather than on anything that explains itself.
 *
 * The marker rides in the fragment for two reasons: the server never sees it, and it survives
 * copy/paste — so if a broadcaster does send this URL, the warning travels with it and shows
 * up in the recipient's address bar too. The share link comes from the copy button, and only
 * from there.
 */
const DONT_SHARE_MARKER = "NOT-THE-SHARE-LINK--USE-THE-COPY-BUTTON";

const broadcastUrl = (streamId: string, suffix = ""): string =>
  `/?stream=${streamId}${suffix}#${DONT_SHARE_MARKER}`;

/**
 * Carry test-only query parameters across the broadcast URL rewrite.
 *
 * `/broadcast` and the `?stream=` resume path both replaceState to a canonical URL, which
 * silently drops anything they do not explicitly copy. That is a trap for diagnostics: a
 * parameter typed into the address bar is gone before the code that reads it ever runs, so
 * the experiment reports "no change" and the hypothesis looks disproved when it was simply
 * never tested. Keep every knob the broadcast view reads listed here.
 *
 *   geo    — origin placement override on the broker assign
 *   aframe — Opus frame duration in ms (the QUIC stream-rate experiment)
 *   diag   — on-device diagnostics panel
 *   agroup — audio frames per group (the QUIC stream-batching experiment)
 */
function carryTestParams(search: string): string {
  const from = new URLSearchParams(search);
  const out = new URLSearchParams();
  for (const key of ["geo", "aframe", "diag", "agroup"]) {
    const v = from.get(key);
    if (v !== null) out.set(key, v);
  }
  const s = out.toString();
  return s ? `&${s}` : "";
}

// Determine current view and stream ID from URL
async function getRouteInfo(): Promise<{ view: View; streamId: string }> {
  const path = window.location.pathname;

  // Watch page: /watch accepts an id directly and jumps straight to the stream —
  // /watch/<id>, /watch?stream=<id>, or /watch?id=<id>. Served by the fleet watch, same as
  // the bare /<id> path.
  if (path === "/watch" || path.startsWith("/watch/")) {
    const params = new URLSearchParams(window.location.search);
    const fromPath = path.startsWith("/watch/") ? decodeURIComponent(path.slice("/watch/".length)) : "";
    const id = (fromPath || params.get("stream") || params.get("id") || "").trim().toLowerCase();
    if (isValidStreamId(id)) {
      return { view: "watch", streamId: id };
    }
    // No id: there is nothing to dial. The old entry form is gone — a bare stream id has no
    // key and no longer even yields a token, and the form rejected a pasted share link. Land
    // on the landing page rather than on a form that cannot succeed.
    return { view: "landing", streamId: "" };
  }

  // Broadcast page: /broadcast — mint a fresh stream id and go live via the fleet. Rewrites
  // the URL to /?stream=<id> so a refresh keeps the same broadcast identity.
  if (path === "/broadcast") {
    // A 5-char stream id (collision-checked). It is only a NAME: it carries no authority and
    // is not the secret. Watching needs the key in the share link's #k= fragment, and
    // publishing under it needs the signed claim in publisher-claim.ts.
    const streamId = await generateStreamId();
    window.history.replaceState({}, "", broadcastUrl(streamId, carryTestParams(location.search)));
    return { view: "broadcast", streamId };
  }

  // Watch view: /{streamId} — served by the fleet watch path (initWatchView pulls the relay
  // and token from the Worker; the content key comes from the link fragment).
  const potentialStreamId = path.slice(1); // Remove leading /
  if (isValidStreamId(potentialStreamId)) {
    return { view: "watch", streamId: potentialStreamId };
  }

  // Resume an in-progress broadcast: /?stream=<id> (set by /broadcast; survives refresh).
  // The id is a short 5-char stream id served through the fleet (broker-assigned).
  const params = new URLSearchParams(window.location.search);
  const streamId = params.get("stream");
  if (streamId) {
    // Re-apply the warning marker for anyone who arrived here without it — a hand-typed or
    // trimmed URL should still say what it is.
    if (!location.hash.includes(DONT_SHARE_MARKER)) {
      window.history.replaceState({}, "", broadcastUrl(streamId, carryTestParams(window.location.search)));
    }
    return { view: "broadcast", streamId };
  }

  // Bare "/" — the promotional landing page (Broadcast / Watch entry points + info).
  return { view: "landing", streamId: "" };
}

/**
 * Escape text for interpolation into innerHTML.
 *
 * Load-bearing, not decorative. `user.name` and `user.avatar_url` arrive from an OAuth
 * provider and are chosen by the account holder — Discord's `global_name` is free text —
 * so they are attacker-controlled strings rendered into the page that holds the content
 * key. Wallflower carries the same header markup and is not exposed by it only because its
 * OAuth is switched off; turning sign-in on here is what makes this reachable.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** An avatar URL we are willing to put in a src. Anything else renders as initials. */
function safeAvatarUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
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

  // Show logged-in user info. Every provider-supplied string below is escaped — see
  // escapeHtml() above for why that matters here specifically.
  const safeName = escapeHtml(user.name);
  const avatarSrc = user.avatar_url ? safeAvatarUrl(user.avatar_url) : null;
  const avatarHtml = avatarSrc
    ? `<img src="${escapeHtml(avatarSrc)}" alt="${safeName}" class="avatar">`
    : `<div class="avatar avatar-placeholder">${escapeHtml(user.name.charAt(0).toUpperCase())}</div>`;

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
      <span class="user-name">${safeName}</span>${flagHtml}
      <button id="logout-btn" class="btn btn-signout" title="Sign out of ${safeName}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
          <polyline points="16 17 21 12 16 7"/>
          <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
        <span class="signout-label">Sign out</span>
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
      <h2>Sign in to broadcast</h2>
      <p>Watching needs no account — just the link someone sent you. Broadcasting does.</p>
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
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path fill="#F25022" d="M2 2h9.5v9.5H2z"/>
            <path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z"/>
            <path fill="#00A4EF" d="M2 12.5h9.5V22H2z"/>
            <path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z"/>
          </svg>
          Microsoft
        </button>
        <button id="overlay-login-discord" class="btn btn-discord">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path fill="#5865F2" d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.3.5c1.6.4 2.9 1 4.1 1.8a13.9 13.9 0 0 0-11-1.2c-.4.1-.9.3-1.3.4.4-.2.9-.4 1.4-.6l-.2-.4a19.8 19.8 0 0 0-4.9 1.4C1 9 .4 13.4.7 17.8a19.9 19.9 0 0 0 6 3l1.2-1.9c-.7-.2-1.3-.5-1.9-.9l.5-.3a14.2 14.2 0 0 0 12 0l.5.3c-.6.4-1.2.7-1.9.9l1.2 1.9a19.9 19.9 0 0 0 6-3c.4-5.1-.6-9.5-4-13.4zM8.4 15.3c-1.2 0-2.1-1.1-2.1-2.4 0-1.3.9-2.4 2.1-2.4 1.2 0 2.2 1.1 2.1 2.4 0 1.3-.9 2.4-2.1 2.4zm7.2 0c-1.2 0-2.1-1.1-2.1-2.4 0-1.3.9-2.4 2.1-2.4 1.2 0 2.2 1.1 2.1 2.4 0 1.3-.9 2.4-2.1 2.4z"/>
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

  // REMOVED: an "Enter Stream ID to Watch" box that navigated to `/<id>` with no fragment.
  //
  // It could not work, and failed dishonestly. A live broadcast registers a route_tag derived
  // from the link secret, and /api/streams/:id/route answers 404 "offline" to anyone who
  // cannot present it — deliberately, so that sweeping the id space reveals nothing. A bare
  // id has no fragment, so no tag, so a correct and currently-live stream id was reported as
  // offline. Past that it would still have had no `#k=`, hence no content key, hence nothing
  // to decrypt.
  //
  // The share link is not one way in among several. It is the only one, because it carries
  // both the decryption key and the proof that you were given it. Do not reinstate a
  // watch-by-id control without changing that design first.
}

// Initialize broadcast view
// Optional per-request CDN override for testing individual tinymoq destinations
// (e.g. ?publisher-cdn=cdn-01.tinymoq.com, &viewer-cdn=cdn-02.tinymoq.com).
function getCdnOverride(param: "publisher-cdn" | "viewer-cdn"): string | undefined {
  const v = new URLSearchParams(window.location.search).get(param)?.trim();
  return v || undefined;
}

// One turn of a rotate icon, so a control that replaces a value confirms it acted even when
// the replacement looks much like what it replaced. Re-triggerable: the class has to come off
// and go back on, and reading offsetWidth forces the reflow that makes the restart stick.
function spin(btn: Element): void {
  btn.classList.remove("spun");
  void (btn as HTMLElement).offsetWidth;
  btn.classList.add("spun");
  window.setTimeout(() => btn.classList.remove("spun"), 500);
}

function initBroadcastView(initialStreamId: string, user: User | null) {
  // The broadcast's identity is MUTABLE: the "new link" control (rotateIdentity, below)
  // replaces the id and the link secret together without a page reload. Everything derived
  // from them is therefore read at use rather than captured once — that is why these are
  // `let` and why streamName is recomputed rather than being a const.
  let streamId = initialStreamId;

  // The ".hang" suffix makes the catalog format explicit so the watcher can parse
  // the catalog and subscribe to video/audio tracks (otherwise detectFormat() is
  // undefined and the viewer only fetches catalog.json, never video/hd).
  let streamName = `${NAMESPACE_PREFIX}/${streamId}.hang`;

  // The content key's secret is minted HERE, in the browser, and travels only in the share
  // link's `#…` fragment. Browsers never send a fragment to a server, so this value cannot
  // reach our Worker, our database, our logs, or the CDN. That is what makes the guarantee
  // structural rather than a promise: there is no code path by which we could decrypt a
  // broadcast, because we never receive what would be required to.
  //
  // The corollary is that the link IS the access control. Anyone holding it can watch, and
  // we cannot revoke that or recover it if the broadcaster loses it.
  let linkSecret = generateLinkSecret();

  // Public HKDF salt, handed to us at go-live and to viewers by /route. Held here so that a
  // re-key uses the SAME salt across both sides — deriving with different ones would silently
  // break the stream for everyone.
  let activeSalt: string | undefined;

  // No `&p=1`. Wallflower appends it to tell a viewer to ask for a passcode; there is no
  // passcode here, so the link carries the content key and nothing else.
  //
  // Which means the link is now the whole of the CRYPTOGRAPHIC story, and `require_auth` —
  // on by default, see the checkbox below — is the access control. Anyone the link is
  // forwarded to can decrypt the media; whether they can obtain a viewer token to receive it
  // in the first place is a question the Worker answers, and it answers no without a session.
  const shareUrl = () =>
    `${window.location.origin}/${streamId}#k=${linkSecret}`;

  console.log(`MoQplay Broadcast - Stream: ${streamId}`);

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
    // Mirror the link onto the element that owns it. The clipboard is the user-facing path,
    // but it is unreadable to anything that is not a focused browser window, so the share
    // link would otherwise be unavailable to tests and to the broadcaster's own devtools.
    copyBtn.setAttribute("data-share-url", shareUrl());
    const copyIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    const checkIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

    // The checkmark must mean "it is on your clipboard", not "you clicked me". This used to
    // fire and forget the write and show the tick unconditionally, so a refused clipboard —
    // an unfocused window, a denied permission, an insecure context — looked identical to
    // success. The broadcaster would then paste whatever was previously on their clipboard
    // into the channel they meant to send the link through, and only find out when nobody
    // could watch.
    //
    // The fallback deliberately reveals the WHOLE link. Selecting the visible stream id
    // instead would be worse than nothing: it omits the `#k=` fragment, so it looks like a
    // share link, copies cleanly, and produces a stream the recipient can never decrypt.
    const shareFallback = document.createElement("input");
    shareFallback.readOnly = true;
    shareFallback.className = "share-fallback hidden";
    shareFallback.setAttribute("aria-label", "Share link — copy this");
    // Appended to the header, NOT inserted after the button: Copy and New-link have to stay
    // adjacent, and slipping an element between them would separate a deliberate pair.
    (copyBtn.closest(".stream-header") ?? copyBtn.parentElement)?.appendChild(shareFallback);

    let copyReset: number | undefined;
    copyBtn.addEventListener("click", async () => {
      window.clearTimeout(copyReset);
      const url = shareUrl();
      let ok = false;
      try {
        await navigator.clipboard.writeText(url);
        ok = true;
      } catch {
        ok = false;
      }

      if (ok) {
        shareFallback.classList.add("hidden");
        copyBtn.innerHTML = checkIcon;
        copyBtn.classList.add("copied");
        copyBtn.setAttribute("title", "Copied");
      } else {
        // Hand them the link in something they can copy by hand, and say so.
        shareFallback.value = url;
        shareFallback.classList.remove("hidden");
        shareFallback.focus();
        shareFallback.select();
        copyBtn.classList.add("copy-failed");
        copyBtn.setAttribute("title", "Couldn't reach the clipboard — the link is selected, copy it manually");
      }

      copyReset = window.setTimeout(() => {
        copyBtn.innerHTML = copyIcon;
        copyBtn.classList.remove("copied", "copy-failed");
        copyBtn.setAttribute("title", "Copy share link");
      }, ok ? 2000 : 6000);
    });
  }

  // Relay-blind E2E media encryption is MANDATORY for every stream — there is no opt-out.
  // Arm the publisher at page load, BEFORE any frame is encoded, so nothing is ever
  // published in the clear; the content key arrives at go-live and releases the queued
  // frames. `streamEncrypted` is always true so goLive requires + installs the key.
  const streamEncrypted = true;
  armPublisher();

  // The passcode control lived here: a second secret, minted per broadcast, sent by another
  // channel, mixed into key derivation. It is gone — see the note in crypto/media-crypto.ts
  // for what that trades away. Access control is now the require-auth checkbox below.
  //
  // The security disclosure it carried is NOT gone; it moves to the access checkbox, which is
  // the control a broadcaster now reasons about privacy with. Losing that disclosure entirely
  // is how a page ends up quietly claiming more than it does.
  {
    const info = document.getElementById("access-info");
    const panel = document.getElementById("access-hint");
    panel?.appendChild(createSecurityBody());
    const setPanel = (open: boolean) => {
      panel?.classList.toggle("hidden", !open);
      info?.setAttribute("aria-expanded", String(open));
    };
    info?.addEventListener("click", (e) => {
      e.preventDefault();
      setPanel(panel?.classList.contains("hidden") ?? false);
    });

    copyBtn?.setAttribute("data-share-url", shareUrl());
    void deriveMediaKey(linkSecret, { streamId, salt: activeSalt });
  }

  // "Encrypted" is shown unconditionally again: media is encrypted in this browser and
  // cdn.moq.pro carries ciphertext it cannot read. It states an INFRASTRUCTURE property, not
  // who may watch — that distinction is why it is safe to show on every stream.
  //
  // It was removed when the moq.pro migration dropped end-to-end encryption. That is no
  // longer true, so the claim is accurate again.
  const audienceBadge: HTMLSpanElement | null = null;
  // Prepended, not appended: at the head of the row it reads as a property of the stream on
  // the line, which is what it is. Appended it sat past the buttons, where it looked like one
  // more control.
  document.querySelector(".stream-header")?.prepend(createRelayBlindBadge());

  // Require auth toggle (Public vs Invite-only). Toggling re-keys the audience pill and
  // the viewer-facing access policy; the security-details disclosure (key/metadata
  // caveats) is attached next to this control.
  const requireAuthCheckbox = document.getElementById("require-auth-checkbox") as HTMLInputElement;
  if (requireAuthCheckbox) {
    // The honest caveats live right next to the access affordance.
    requireAuthCheckbox.closest("label")?.after(createSecurityDetails());

    // Load current setting
    getStreamSettings(streamId).then(settings => {
      requireAuthCheckbox.checked = settings.require_auth;
      if (audienceBadge) setAudienceBadge(audienceBadge, settings.require_auth);
    });

    // Save on change - with confirmation for anonymous viewers
    requireAuthCheckbox.addEventListener("change", async () => {
      if (requireAuthCheckbox.checked) {
        // Check for anonymous viewers before enabling auth requirement
        const data = await getStreamViewers(streamId, await deriveRouteTag(linkSecret, streamId));
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

      if (audienceBadge) setAudienceBadge(audienceBadge, requireAuthCheckbox.checked);
      updateStreamSettings(streamId, { require_auth: requireAuthCheckbox.checked });
    });
  }

  // Live chat toggle. When on, reveal the chat panel (right column on desktop, bottom
  // overlay on mobile) and connect the broadcaster to the per-stream ChatRoom; persist
  // the setting so viewers' getStreamSettings() reflects it.
  //
  // The control that drives this is a button in the capture bar under the video, built much
  // further down with the rest of that bar. So the state lives here, in a plain boolean, and
  // the button
  // registers itself when it exists — that way the settings load, the id-rotation path and
  // the button are all driving one source of truth rather than reading each other's DOM.
  const broadcastChatPanel = document.getElementById("broadcast-chat") as HTMLElement | null;
  let chatHandle: ChatHandle | null = null;
  let chatEnabled = false;
  let chatBtn: HTMLButtonElement | null = null;
  const openChat = () => {
    if (!broadcastChatPanel || chatHandle) return;
    broadcastChatPanel.classList.remove("hidden");
    chatHandle = initChat({
      streamId,
      container: broadcastChatPanel,
      user,
      // Same secret and salt as the video, different HKDF context. Derived per use so a
      // passcode change or a go-live salt arriving late is picked up automatically.
      chatKey: () => deriveChatKey(linkSecret, { streamId, salt: activeSalt }),
    });
  };
  const closeChat = () => {
    chatHandle?.destroy();
    chatHandle = null;
    broadcastChatPanel?.classList.add("hidden");
  };
  // `persist` is false when we are only catching up with what the server already says, so
  // reloading a broadcast doesn't write the setting back unchanged.
  const setChatEnabled = (on: boolean, persist = true) => {
    chatEnabled = on;
    if (on) openChat();
    else closeChat();
    chatBtn?.classList.toggle("toggle-on", on);
    if (persist) updateStreamSettings(streamId, { chat_enabled: on });
  };
  getStreamSettings(streamId).then((settings) => {
    if (settings.chat_enabled) setChatEnabled(true, false);
  });

  // Stop publishing if this broadcast is terminated.
  //
  // Its own poll, deliberately not folded into the viewer-stats refresh below: that one is
  // inside `if (vsToggle && vsCount && vsPanel)`, so hanging this off it would mean a missing
  // stats badge silently disables the broadcaster's half of the kill switch. A safety
  // mechanism should not depend on a UI element being present.
  //
  // This side matters more than the viewer side. A terminated stream whose publisher keeps
  // sending is still reaching everyone already connected; stopping the source is what ends
  // the broadcast for people we cannot otherwise reach.
  const killWatch = window.setInterval(async () => {
    const settings = await getStreamSettings(streamId);
    if (!settings.killed) return;
    window.clearInterval(killWatch);
    stopForKill("broadcaster");
  }, 5000);
  window.addEventListener("beforeunload", () => window.clearInterval(killWatch));

  // Live viewer stats: a "👁 N watching" badge in the header that expands to a
  // per-viewer list (location flag + watch duration). Polls the public viewers
  // endpoint every 5s; mirrors the /{stream}/stats renderer, inline for the broadcaster.
  const vsToggle = document.getElementById("viewer-stats-toggle");
  const vsCount = document.getElementById("viewer-count");
  const vsPanel = document.getElementById("viewer-stats-panel");
  if (vsToggle && vsCount && vsPanel) {
    let vsViewers: LiveViewer[] = [];

    const fmtDuration = (dateStr: string) => {
      const secs = Math.max(0, Math.floor((Date.now() - new Date(dateStr + "Z").getTime()) / 1000));
      if (secs < 60) return `${secs}s`;
      const mins = Math.floor(secs / 60);
      if (mins < 60) return `${mins}m ${secs % 60}s`;
      return `${Math.floor(mins / 60)}h ${mins % 60}m`;
    };

    const renderPanel = () => {
      if (vsPanel.classList.contains("hidden")) return; // only build DOM when open
      const rows = vsViewers.length === 0
        ? `<tr><td colspan="2" class="empty">No active viewers</td></tr>`
        : vsViewers.map((v) => {
            // WHO, not just how many. This is the visible half of the security model: with
            // Require sign-in on, every viewer holds an account, so a broadcaster sees their
            // audience rather than a count of anonymous sessions.
            //
            // Anonymous rows are SHOWN, not hidden. They occur only when the requirement is
            // off, and hiding them would let the count and the list disagree — leaving someone
            // convinced they knew who was watching when they did not. Seeing "Anonymous" is
            // precisely the cue to turn the checkbox back on.
            //
            // Escaped: name and email come from the OAuth provider and are chosen by the
            // account holder. Same reasoning as the sign-in header.
            const who = v.user_name
              ? `<span class="viewer-name">${escapeHtml(v.user_name)}</span>` +
                (v.user_email ? ` <span class="viewer-email">${escapeHtml(v.user_email)}</span>` : "")
              : `<span class="viewer-anon">Anonymous</span>`;
            return `<tr><td>${who}</td><td>${fmtDuration(v.started_at)}</td></tr>`;
          }).join("");
      vsPanel.innerHTML = `<table class="stats-table"><tbody>${rows}</tbody></table>`;
    };

    const refreshViewers = async () => {
      // Derived per call rather than cached: New link rotates linkSecret mid-broadcast, and a
      // stale tag would silently 404 the badge into "no viewers" for the rest of the stream.
      const data = await getStreamViewers(streamId, await deriveRouteTag(linkSecret, streamId));
      if (!data) return; // transient failure — keep the last known count
      vsViewers = data.viewers;
      vsCount.textContent = String(vsViewers.length);
      renderPanel();
    };

    vsToggle.addEventListener("click", () => {
      const open = !vsPanel.classList.toggle("hidden");
      vsToggle.setAttribute("aria-expanded", String(open));
      if (open) renderPanel();
    });

    refreshViewers();
    const vsInterval = window.setInterval(refreshViewers, 5000);
    window.addEventListener("beforeunload", () => window.clearInterval(vsInterval));
  }

  // What to tell a broadcaster when capture would not start.
  //
  // getUserMedia/getDisplayMedia report failures as DOMException *names*, and the name is the
  // only part that is stable across engines — the messages differ ("Could not start video
  // source" on Chromium, "The request is not allowed by the user agent" on WebKit), so match
  // on the name and write the sentence ourselves. NotReadableError is the one that prompted
  // this: Windows lets a single app hold the camera, so a camera already open in Teams or the
  // Camera app fails here and on no other platform.
  const captureFailureText = (e: unknown): string => {
    const name = e instanceof Error ? e.name : "";
    const detail = e instanceof Error && e.message ? ` (${e.message})` : "";
    switch (name) {
      case "NotAllowedError":
      case "SecurityError":
        return "The browser did not allow the camera or microphone. If you dismissed the prompt, " +
          "reload and allow it; if you blocked it, clear this site's camera permission first.";
      case "NotReadableError":
      case "AbortError":
        return "The camera could not be started — on Windows only one app can use it at a time. " +
          "Close anything else that has it open (Teams, Zoom, the Camera app) and try again." + detail;
      case "NotFoundError":
      case "OverconstrainedError":
        return "No camera or microphone was found. Check that one is connected, and that this " +
          "browser is allowed to use it in the system's privacy settings.";
      default:
        return `Capture could not start${detail || "."}`;
    }
  };

  // What to tell a broadcaster when going live did not.
  //
  // The Worker already writes its refusals for a person ("that broadcast name is in use",
  // "This stream has been terminated."), so those are passed through rather than re-worded —
  // re-wording them here would mean two places to keep in step, and the second one always
  // drifts. What is added is the part the Worker cannot know: what to do about it.
  //
  // `null` means go-live never got as far as asking, because no publisher claim could be
  // built: either no admission credential on this device, or the challenge was declined.
  const goLiveFailureText = (res: BroadcastStart | null): string => {
    if (!res) {
      return "Could not prove this broadcast is yours. Check that you are still signed in, " +
        "then switch a camera or microphone back on to try again.";
    }
    const said = res.error ? ` ${res.error}` : "";
    if (res.status === 0) {
      return `Could not reach ${location.host} to start the broadcast — this looks like a ` +
        `network problem at this end. Check the connection and try again.${said}`;
    }
    switch (res.status) {
      case 401:
      case 403:
        return `The server would not start this broadcast:${said || " permission was refused."} ` +
          "If you have been signed out, sign in again; if the stream was terminated, starting " +
          "a new link is the way on.";
      case 503:
        return "Broadcasting is not available right now — the server is not configured to " +
          `issue publish tokens.${said} This is at our end, not yours.`;
      default:
        // Includes the case this branch always used to claim: a 200 with no relay, which is
        // the broker being down. Everything else lands here with its own status attached.
        return "Could not start the broadcast." +
          (said || ` The server answered ${res.status ?? "nothing"}.`) +
          " Switch a camera or microphone back on to try again.";
    }
  };

  // Drive the headless <moq-publish> core element with our own control bar.
  const publisher = document.querySelector("moq-publish") as MoqPublishElement | null;
  if (publisher) {
    // The relay URL is NOT static: on go-live the Worker calls tinymoq /assign and
    // returns the relay hosting this broadcast; we point the publisher at it then.
    publisher.setAttribute("name", streamName);

    // A line under the control bar for things that happen TO a broadcast rather than because
    // someone clicked. Everything here used to be a console.error, which is to say invisible:
    // reported from Edge on Windows as "the camera does not stay open — I see it for a second
    // and then it goes away", and from another broadcaster as a Server Status card reading
    // "(no relay assigned)" with nothing anywhere to say why.
    //
    // Declared up here rather than beside the control bar because goLive() below reports
    // through it, and goLive is defined first.
    const notice = document.createElement("div");
    notice.className = "capture-notice hidden";
    notice.setAttribute("role", "status"); // announced, but does not steal focus
    /**
     * Show one sentence, or null to clear.
     *
     * `action` adds a button to it. Reserved for failures the broadcaster can actually undo
     * from here — a message that explains and then leaves you stuck is only half an answer.
     */
    const say = (msg: string | null, action?: { label: string; run: () => void }) => {
      notice.textContent = msg ?? ""; // also drops any button from a previous message
      notice.classList.toggle("hidden", !msg);
      if (!msg || !action) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "notice-action";
      btn.textContent = action.label;
      btn.addEventListener("click", action.run);
      notice.appendChild(btn);
    };

    let broadcastEventId: number | null = null;
    let goLivePromise: Promise<void> | null = null;

    // First device selection = go live: get the assigned relay, then connect to it.
    // logBroadcastStart hits POST /api/stats/broadcast which calls /assign and stores
    // the relay on the broadcast row (so viewers can co-locate). Idempotent/sticky.
    const goLive = (): Promise<void> => {
      if (goLivePromise) return goLivePromise;
      // Prove name ownership before asking for a publish token. buildPublisherClaim mints a
      // fresh Ed25519 keypair for THIS broadcast (non-extractable, never leaves the page) and
      // signs a Worker-issued challenge with it.
      //
      // Admission is NOT proved here — it rides on the session cookie, and the Worker checks
      // it against the broadcaster allow list. So a refusal below is either "not signed in"
      // or "not approved to broadcast", and both surface from the same place: the go-live
      // response. Wallflower prompts for a publish key at this point; there is nothing to
      // prompt for here, because there is nothing a broadcaster can type to admit themselves.
      goLivePromise = buildPublisherClaim(streamId).then(async (claim) => {
        if (!claim) return null;
        // Register the proof-of-link tag for this broadcast, so the Worker can require viewers
        // to demonstrate they hold the share link before it mints them a token. Derived here
        // because `linkSecret` never leaves this page in any other form.
        const routeTag = await deriveRouteTag(linkSecret, streamId);
        return logBroadcastStart(streamId, getCdnOverride("publisher-cdn"), claim, routeTag);
      }).then(async (res) => {
        broadcastEventId = res?.eventId ?? null;
        const relay = res?.relay;
        const jwt = res?.jwt;
        if (!relay || !jwt) {
          // Until 2026-08-29 this branch blamed the broker for everything and told nobody:
          // a console line, and a Server Status card reading "(no relay assigned)". At least
          // eight unrelated refusals arrive here, only one of which is actually /assign being
          // down, and the most common of them was recoverable in one click by someone who had
          // no way to know that. Allow a retry on the next device action rather than
          // connecting to a dead endpoint, but say what happened first.
          console.error(
            "[routing] go-live got no relay/token:",
            res ? `HTTP ${res.status ?? "?"} ${res.error ?? ""}` : "no publisher claim"
          );
          setActiveRelay(null);
          goLivePromise = null;
          // 409 means a row for this stream id is still open under a different publisher key.
          // Nearly always that is the SAME person: the keypair is deliberately lost on reload
          // while the id survives in ?stream=, so returning to your own tab looks to the
          // Worker like a stranger. Rotating the id both frees the old row and sidesteps it.
          if (res?.status === 409) {
            say(
              "This broadcast link is still marked as live from an earlier session, so it " +
              "cannot be started again under the same name. Starting a new link fixes it.",
              { label: "Start a new link", run: () => void rotateIdentity({ confirm: false }) }
            );
          } else {
            say(goLiveFailureText(res));
          }
          return;
        }
        // Relay-blind E2E: install the per-broadcast content key BEFORE connecting,
        // so the frames the armed publisher has been queuing get encrypted. The
        // server is authoritative on whether the stream is encrypted.
        // Relay-blind E2E applies to BOTH transports, so the key is installed here rather
        // than inside either branch. This is load-bearing: armPublisher() has already run,
        // so every encoded frame is queued awaiting this key. If it is never installed the
        // queue never drains, NOTHING is published, and a viewer subscribes successfully to
        // a track that stays silent forever -- a failure with no error on either side.
        if (res?.encrypted || streamEncrypted) {
          activeSalt = res?.salt ?? undefined;
          armPublisher(); // idempotent; covers the case where settings load lost the race
          await deriveMediaKey(linkSecret, { streamId, salt: activeSalt });
        }
        if (res?.path) {
          // moq.pro (Mode A): the broadcast path travels in the connect URL, so `name`
          // stays empty. Encryption is identical to the fleet path below.
          publisher.setAttribute("name", "");
          publisher.setAttribute("url", moqUrl(relay, res.path, jwt));
        } else {
          publisher.setAttribute("name", streamName);
          publisher.setAttribute("url", `https://${relay}/?jwt=${jwt}`);
        }
        setActiveRelay(relay);
        say(null); // whatever the last attempt failed with, it is no longer true
        console.log("[routing] broadcaster relay:", relay, "eventId:", broadcastEventId);
      });
      return goLivePromise;
    };

    // End the broadcast: mark ended + free the relay assignment (server-side /release).
    const endBroadcast = () => {
      if (broadcastEventId) {
        logBroadcastEnd(broadcastEventId);
        console.log("Broadcast ended, event ID:", broadcastEventId);
        broadcastEventId = null;
      }
      goLivePromise = null; // a later device selection re-assigns
      // Drop the content key (keep the publisher armed): a restarted broadcast
      // gets a fresh key, and frames queue until it arrives — never encrypted
      // with the previous session's key.
      resetMediaKey();
    };

    // --- Combinable capture toggles: 📹 Camera (video) + 🎤 Audio + 🖥️ Screen ---
    // Camera and/or Screen video is composited onto a single <canvas> and published as one
    // stable track (announce="always" + source=undefined so the element's own capture stands
    // down); audio is mixed (mic for camera, system/tab audio for screen) into one stable
    // track. Toggling sources changes only the compositor inputs, never the published
    // tracks, so viewers never see a reset. Audio-only uses the element's native source.
    type Toggle = "camera" | "audio" | "screen";
    const capture: Record<Toggle, boolean> = { camera: false, audio: false, screen: false };
    let anyActive = false;

    // "New link" — replace the broadcast's whole identity in place.
    //
    // This is a clean break, not a re-key: a fresh stream id AND a fresh link secret, which
    // means a fresh claim keypair, a fresh relay assignment and a fresh salt too. The old
    // share link is dead in both halves — its id no longer names a live broadcast, and its
    // secret no longer derives the right key — so it cannot be resurrected by anyone who
    // kept it, including us.
    //
    // Capture is deliberately NOT touched. Ending and restarting the broadcast while leaving
    // the compositor alone is the whole point: the broadcaster keeps their camera, mic and
    // screen exactly as they had them and only the address changes.
    const newIdBtn = document.getElementById("newid-btn");
    let rotating = false;
    const rotateIdentity = async (opts?: { confirm?: boolean }) => {
      if (rotating) return;
      // Only guard once there is an audience to lose. Before go-live nobody holds the link,
      // so a confirmation would be noise on the one click that costs nothing.
      //
      // `confirm: false` is the recovery path from a name conflict: capture is on (which is
      // what triggered go-live), so anyActive is true, but the broadcast never started and
      // nobody is watching. Warning that everyone will be cut off would be false.
      if (opts?.confirm !== false && anyActive && !window.confirm(
        "Start a new link?\n\nThis ends the current broadcast and starts a fresh one. " +
        "Everyone watching now — and anyone holding the old link — will be cut off until " +
        "you send them the new one."
      )) return;

      rotating = true;
      if (newIdBtn) spin(newIdBtn);
      try {
        const wasLive = anyActive;
        closeChat();       // the room is keyed to the old stream id
        endBroadcast();    // marks the old row ended, frees the relay, drops the media key

        streamId = await generateStreamId();
        streamName = `${NAMESPACE_PREFIX}/${streamId}.hang`;
        linkSecret = generateLinkSecret();
        activeSalt = undefined;   // the new go-live issues its own; deriving with a stale one
                                  // would silently produce a key no viewer can reproduce
        publisher.setAttribute("name", streamName);

        if (streamDisplay) streamDisplay.textContent = streamId;
        copyBtn?.setAttribute("data-share-url", shareUrl());
        // Keep the address bar honest, so a refresh resumes the NEW broadcast, not the dead one.
        // Test params ride along too, or a rotation mid-experiment quietly reverts the next
        // refresh to the defaults.
        window.history.replaceState({}, "", broadcastUrl(streamId, carryTestParams(window.location.search)));

        // Carry the broadcaster's SETTINGS onto the new id.
        //
        // Rotation used to change the id and nothing else, so the new stream had no settings
        // row and every value silently reverted to the Worker's default while the controls kept
        // showing the old ones. `require_auth` defaults to 1 (fail-closed), so a broadcaster who
        // had deliberately chosen Public got an invite-only stream, the audience badge still
        // said Public, and everyone holding the fresh link was bounced to a sign-in page. It
        // fails safe rather than open, which is why it read as a mystery rather than a leak.
        //
        // Written before goLive() so a viewer who arrives on the new link immediately cannot
        // race the settings into existence.
        await updateStreamSettings(streamId, {
          require_auth: requireAuthCheckbox?.checked ?? true,
          chat_enabled: chatEnabled,
        });

        if (wasLive) await goLive();
        if (chatEnabled) openChat();   // re-joins, now keyed to the new stream id
        console.log("[rotate] new identity:", streamId);
      } finally {
        rotating = false;
      }
    };
    newIdBtn?.addEventListener("click", () => void rotateIdentity());

    // Low-level seam: a video/audio Source is just a MediaStreamTrack signal.
    //
    // WHERE THIS LIVES NOW. Through @moq/publish 0.2.x these hung off `publisher.broadcast` as
    // `.video.source` / `.audio.source`. In 0.4.7 `broadcast` became a registry whose `video()`
    // and `audio()` are METHODS that mint renditions, and the raw-track signals moved onto the
    // ELEMENT: video feeds a shared `Video.Capture` (one capture, many renditions), audio still
    // goes straight into its encoder.
    //
    // The old path did not throw a helpful error — `publisher.broadcast.video` is now a function,
    // so `.source` was undefined and the failure surfaced as
    // "Cannot read properties of undefined (reading 'set')" inside the capture handler, which
    // reads like a camera problem rather than an API change.
    //
    // `in` is typed `Readonlys<...>`, i.e. Getters. That is a STATIC narrowing only — @moq/signals
    // documents `readonlys()` as "the identity function at runtime" — so the underlying Signal is
    // still settable and this is the intended injection point for a caller supplying its own
    // track. We composite our own canvas, so we always supply it.
    //
    // Because that relies on a type lie being safe, assert it rather than trust it: if upstream
    // ever makes these real read-only Computeds, this throws at wiring time instead of silently
    // dropping every frame into a signal nobody set.
    const settable = (v: unknown, where: string): { set(t: unknown): void } => {
      if (!v || typeof (v as { set?: unknown }).set !== "function") {
        throw new Error(
          `[publish] ${where} is not a settable signal any more — @moq/publish moved or froze it. ` +
            `The compositor track has nowhere to go, so publishing would look live and send nothing.`
        );
      }
      return v as { set(t: unknown): void };
    };

    const videoSource = settable(publisher.capture?.in?.source, "publisher.capture.in.source");
    const audioSource = settable(publisher.audio?.in?.source, "publisher.audio.in.source");
    const bcast = {
      video: { source: videoSource as { set(t: MediaStreamTrack | undefined): void } },
      audio: {
        source: audioSource as { set(t: MediaStreamTrack | undefined): void },
        codec: settable(publisher.audio?.codec, "publisher.audio.codec"),
      },
    };

    // --- Opus frame duration: ?aframe=<ms> on the BROADCAST url ------------------------------
    //
    // An experiment about a viewer-side failure, which is why it lives on the publisher.
    //
    // Audio publishes one MoQ group per encoded frame (@moq/net track.js `Track.writeFrame`
    // opens a group, writes one frame and closes it), and the publisher turns every group into
    // its own QUIC unidirectional stream. At the default 20ms Opus frame that is ~50 streams a
    // second. Video does not do this — it runs through Legacy.Producer and only starts a group
    // on a keyframe, ~0.5/s — which is why a video-only stream never stalls and audio always
    // does, at the same ~140s regardless of bitrate.
    //
    // Measured on an iPhone: delivery stopped at streams=7188 with the session still open, no
    // error, and the byte counters freezing a couple of seconds AFTER the stream counter did.
    //
    // WT_MAX_STREAMS credit is CUMULATIVE — it counts closed streams too, and the receiver has
    // to keep sending capsules with higher values to replenish it (draft-ietf-webtrans-http3).
    // If WebKit never replenishes, the relay gets a one-time budget of ~7000 streams and can
    // then never open another one: exactly what we see.
    //
    // So this knob is a MEASUREMENT before it is a mitigation. A fixed credit budget predicts
    // the ceiling is a stream COUNT, so 60ms frames (a third of the streams) should push the
    // stall out to ~7 minutes while stopping at the same ~7000 streams. If it still stalls at
    // ~140s then the ceiling is time-based and the credit theory is wrong.
    //
    // Opus only accepts certain frame durations; anything else makes the encoder throw, which
    // would look like "audio is broken" rather than "you typed a bad number".
    const OPUS_FRAME_MS = [2.5, 5, 10, 20, 40, 60, 80, 100, 120];
    const aframeRaw = new URLSearchParams(location.search).get("aframe");
    if (aframeRaw !== null) {
      const ms = Number(aframeRaw);
      if (!OPUS_FRAME_MS.includes(ms)) {
        console.warn(`[aframe] ignoring ?aframe=${aframeRaw}; Opus allows ${OPUS_FRAME_MS.join(", ")}ms`);
      } else {
        bcast.audio.codec.set({ mime: "opus", frameDuration: ms });
        console.log(`[aframe] Opus frames ${ms}ms (default 20) -> ~${(1000 / ms).toFixed(0)} QUIC streams/sec`);
      }
    }

    // Any video state (camera and/or screen) routes through ONE compositor whose canvas
    // and audio-mix tracks are published once and never re-set. Toggling camera/screen/
    // mic changes only the compositor's inputs, so the viewer never sees a track reset
    // (RESET_STREAM) — the <moq-watch> element can't re-subscribe after one and would
    // otherwise freeze. ALL capture (including audio-only) goes through the compositor so
    // the publish path never switches the element's source mode mid-broadcast — that switch
    // silently dropped audio when the sequence was audio-first-then-video.
    let comp: Compositor | null = null;
    // Filled in when the control bar is built, further down. A mutable hook rather than a
    // direct call because applyState is DEFINED above that code and would otherwise read a
    // `const` from its temporal dead zone the first time a button was clicked.
    let onCameraChanged: () => void = () => {};
    // Location + time burn-in, armed independently of capture (see the stamp button below).
    let geoStamp: GeoStamp | null = null;
    // The handle watermark, likewise armed independently (see the @ button below).
    let watermark: string | null = null;
    // Video and audio sources are wired in independently and each exactly once, so a track
    // that appears later (camera added after audio-only, or vice versa) binds without
    // re-setting the other (re-setting a live track triggers RESET_STREAM → frozen viewers).
    let boundVideo = false;
    let boundAudio = false;
    const teardownComposite = () => {
      if (!comp) return;
      comp.stop();
      comp = null;
      boundVideo = false;
      boundAudio = false;
      bcast.video.source.set(undefined);
      bcast.audio.source.set(undefined);
      const v = publisher.querySelector("video") as HTMLElement | null;
      if (v) v.style.display = ""; // restore the element's own preview
      // Switching off the LAST capture never reaches the source reconcile below — it stops
      // here — so anything watching the camera has to be told from both places, not one.
      onCameraChanged();
    };

    // Serialize because getDisplayMedia/getUserMedia show permission prompts.
    let applying = false;
    const applyState = async () => {
      if (applying) return;
      applying = true;
      try {
        const { camera, audio, screen } = capture;
        anyActive = camera || audio || screen;
        const hasVideo = camera || screen;

        // Any active capture — video and/or audio — runs through ONE compositor path.
        // Audio-only just publishes the audio mix with no video track bound. Keeping a
        // single path is what makes the sequence order-independent.
        if (anyActive) {
          try {
            if (!comp) {
              comp = createCompositor();
              const v = publisher.querySelector("video") as HTMLElement | null;
              if (v) v.style.display = "none";
              comp.canvas.className = "pip-canvas";
              publisher.insertAdjacentElement("afterbegin", comp.canvas);
              // The compositor is created and destroyed as capture comes and goes, but the
              // overlays outlive it (either can be armed before any camera is on, and both
              // must survive a stop/start). Re-attach them to each new compositor.
              if (geoStamp) comp.setStampProvider(geoStamp.line);
              if (watermark) comp.setWatermark(watermark);
            }
            // Reconcile video sources without re-prompting the ones already captured.
            if (screen && !comp.hasScreen()) {
              await comp.enableScreen({
                onEnded: () => { capture.screen = false; syncButtons(); void applyState(); },
              });
            } else if (!screen && comp.hasScreen()) {
              comp.disableScreen();
            }
            if (camera && !comp.hasCamera()) {
              await comp.enableCamera({
                // The camera going away is not a click, so nothing else would ever say so.
                onEnded: () => {
                  capture.camera = false;
                  syncButtons();
                  say(
                    "The camera stopped. Another app or the system took it — close whatever else " +
                    "is using it, then switch Camera back on."
                  );
                  void applyState();
                },
                onMuteChange: (muted) =>
                  say(
                    muted
                      ? "The camera has stopped sending frames — it is probably in use by another " +
                        "app. Anyone watching is seeing a frozen picture."
                      : null
                  ),
              });
              say(null); // a fresh start clears whatever the last one failed with
            } else if (!camera && comp.hasCamera()) comp.disableCamera();
            onCameraChanged();

            // Audio routing: the mic is captured whenever audio is on (incl. while screen
            // sharing — for narration), and tab/system audio is additionally mixed in when a
            // screen that carries audio is shared. Both feed one stable mixed output track,
            // so toggling sources never resets the published audio.
            comp.setSystemAudioEnabled(audio && screen);
            await comp.setMicEnabled(audio);

            // "always", not `true`. This was a boolean through @moq/publish 0.2.x and became an
            // enum ("always" | "source" | "never") in 0.4.x. The setter takes whatever it is
            // given, and the gate is `announce === "always" || (announce === "source" && track)`
            // — so `true` matches neither, the broadcast is never enabled, and `broadcast.net`
            // stays undefined. Nothing throws. The encoders still resolve their codecs and fill
            // in the catalog, so the publisher looks completely healthy while publishing zero
            // frames; the only outward symptom is that every viewer waits forever.
            //
            // "always" rather than "source" because we composite our own canvas and hand the
            // element a track directly, so its own capture never runs.
            publisher.announce = "always";
            publisher.source = undefined;
            publisher.invisible = !hasVideo; // audio-only -> no camera light / no video track
            publisher.muted = false; // the mixed audio track is always published (silent when audio off) to keep it stable
            // Bind each track once, when it first appears. Drop the video track if video
            // goes away while audio stays (so audio-only never publishes a black frame).
            if (!hasVideo && boundVideo) {
              bcast.video.source.set(undefined);
              boundVideo = false;
            } else if (hasVideo && !boundVideo) {
              bcast.video.source.set(comp.videoTrack);
              boundVideo = true;
            }
            if (!boundAudio) {
              bcast.audio.source.set(comp.audioTrack);
              boundAudio = true;
            }
            void goLive();
          } catch (e) {
            console.error("[media] capture failed (or cancelled):", e);
            // Until 2026-08-28 this was the whole handling: revert the toggle, log, and leave
            // the broadcaster watching a button switch itself back off for no stated reason.
            // A console.error is only visible to whoever opens devtools, which is nobody.
            say(captureFailureText(e));
            capture.screen = false;
            capture.camera = false;
            syncButtons();
            teardownComposite();
          }
          return;
        }

        // Nothing active — end the broadcast and drop the compositor.
        teardownComposite();
        publisher.announce = "source";
        publisher.source = null;
        endBroadcast();
      } finally {
        applying = false;
      }
    };

    // --- Build the control bar (status + capture toggles + overlay toggle) ---
    const bar = document.createElement("div");
    bar.className = "publish-controls";

    const statusEl = document.createElement("div");
    statusEl.className = "publish-status";
    statusEl.textContent = "⚪";
    statusEl.setAttribute("data-status-text", "Offline");
    bar.appendChild(statusEl);

    const toggleButtons: Partial<Record<Toggle, HTMLButtonElement>> = {};
    const syncButtons = () => {
      (Object.keys(toggleButtons) as Toggle[]).forEach((k) => {
        toggleButtons[k]?.classList.toggle("toggle-on", capture[k]);
      });
    };
    // Generic filled media-input icons (currentColor so they follow the button's on/off color).
    const ICONS = {
      camera:
        '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M17 10.2l4-2.6A1 1 0 0 1 22.5 8.4v7.2a1 1 0 0 1-1.5.8L17 13.8z"/></svg>',
      audio:
        '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M6 11a1 1 0 1 1 2 0 4 4 0 0 0 8 0 1 1 0 1 1 2 0 6 6 0 0 1-5 5.92V20h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-3.08A6 6 0 0 1 6 11z"/></svg>',
      screen:
        '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true"><path d="M3 4h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-7v2h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/></svg>',
      // An eye between two big arrows: one pointing right above it, one pointing left
      // below. It began as arrows curling AROUND the eye, and that failed for a reason
      // worth keeping: a ring at 18px has to be thin to stay a ring, and a thin curve is
      // the first thing to disappear. Straight arrows can be as heavy as the glyph allows,
      // so the part carrying the meaning is the part with the most ink.
      //
      // The eye is a filled lens with the pupil knocked out (fill-rule: evenodd) rather
      // than an outline, for the same reason — an outlined eye reads as a smudge beside
      // arrows this solid.
      flip:
        '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true"><path d="M2 3.1h12.2V1L22 4.2 14.2 7.4V5.3H2z"/><path d="M22 20.9H9.8V23L2 19.8 9.8 16.6V18.7H22z"/><path fill-rule="evenodd" d="M6.6 12Q12 7 17.4 12Q12 17 6.6 12ZM12 13.8a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z"/></svg>',
    } as const;
    // Icon plus a short name, the name shown only where there is room for it (see .btn-label).
    //
    // The row was six icons a first-time broadcaster could not identify — a pin with an "i" in
    // it, a bare "@", and "</>" — so it read as six unknowns rather than six features. The fix
    // is naming them, not hiding them: a label makes a feature more visible, an overflow menu
    // makes it less. On a phone there is no room, so the icons stand alone there and the
    // grouping below does the work instead.
    const faced = (glyph: string, label: string) =>
      `<span class="btn-glyph">${glyph}</span><span class="btn-label">${label}</span>`;

    const makeToggle = (key: Toggle, icon: string, label: string, name: string) => {
      const b = document.createElement("button");
      b.type = "button";
      // Screen capture (getDisplayMedia) isn't available on mobile browsers — tag the
      // screen toggle so CSS can hide it on touch devices (iOS/Android).
      b.className = "publish-btn toggle-btn" + (key === "screen" ? " cap-screen" : "");
      b.title = label;
      b.innerHTML = faced(icon, name);
      b.addEventListener("click", () => {
        capture[key] = !capture[key];
        syncButtons();
        void applyState();
      });
      toggleButtons[key] = b;
      bar.appendChild(b);
    };
    // Group one: where the picture and sound come from.
    makeToggle("camera", ICONS.camera, "Camera", "Camera");
    makeToggle("audio", ICONS.audio, "Audio (microphone; also mixes in tab/system audio when screen sharing)", "Audio");
    makeToggle("screen", ICONS.screen, "Screen", "Screen");

    // --- "More": everything that is not a camera or a microphone ------------------------
    //
    // Seven controls read as seven decisions to make before you can start. Camera and Audio
    // are the only two anyone needs to go live; the rest are things you might add once you
    // are already broadcasting.
    //
    // This reverses a call made on 2026-08-16 NOT to hide these behind a menu, so the reason
    // for that call has to survive the reversal. It was: a menu makes the least-known features
    // hardest to find, and — the part with real consequences — it can hide a control that is
    // currently ON, so a broadcaster would not see that the location burn-in is running and
    // being drawn into their picture.
    //
    // THE RULE THAT KEEPS THAT TRUE: an advanced control that is ON is never inside the menu.
    // It is promoted into the bar and stays there, lit, until it is switched off. The row
    // therefore shows exactly what is active plus a way to add more, and "hidden" only ever
    // means "off". Switching it off is what puts it away again.
    const morePanel = document.createElement("div");
    morePanel.className = "publish-more-panel hidden";
    morePanel.id = "publish-more-panel";

    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "publish-btn more-btn";
    moreBtn.id = "more-btn";
    moreBtn.setAttribute("aria-expanded", "false");
    moreBtn.setAttribute("aria-controls", "publish-more-panel");
    moreBtn.title = "More — screen sharing, chat, and what gets drawn on the picture";
    moreBtn.innerHTML = faced(
      '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">' +
      '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>' +
      "</svg>",
      "More"
    );
    moreBtn.addEventListener("click", () => {
      const open = !morePanel.classList.toggle("hidden");
      moreBtn.setAttribute("aria-expanded", String(open));
      moreBtn.classList.toggle("more-open", open);
    });

    const advancedBtns: HTMLButtonElement[] = [];
    const placeAdvanced = (): void => {
      for (const b of advancedBtns) {
        // Two classes mean "on" here: the capture and burn-in toggles use .toggle-on, the
        // Extras editor uses .active. Read both rather than normalising them, which would
        // mean touching five handlers in order to change one layout rule.
        const on = b.classList.contains("toggle-on") || b.classList.contains("active");
        const parent = on ? bar : morePanel;
        if (b.parentElement === parent) continue;
        if (on) bar.insertBefore(b, moreBtn);
        else morePanel.appendChild(b);
      }
      // Tells the stylesheet the row is carrying promoted controls and may need a second line
      // on a phone. See .publish-controls.has-promoted — measured, not guessed: with every
      // advanced control on, the row wants 352px inside 326px on a 390px iPhone.
      bar.classList.toggle(
        "has-promoted",
        advancedBtns.some((b) => b.parentElement === bar)
      );
    };
    /**
     * Hand a finished button over to the menu.
     *
     * Placement follows a MutationObserver on the class attribute rather than calls added to
     * each button's own handler. Several of these turn themselves on and off from places a
     * click never reaches — the geo stamp clears itself when permission is refused, chat
     * lights up when saved settings arrive after the bar is built, Extras toggles from inside
     * the editor — and every one of those has to move the button too. Watching the state that
     * is already the source of truth catches all of them; wiring the handlers would have
     * caught the two I happened to think of.
     */
    const advanced = (b: HTMLButtonElement): void => {
      advancedBtns.push(b);
      new MutationObserver(placeAdvanced).observe(b, {
        attributes: true,
        attributeFilter: ["class"],
      });
      placeAdvanced();
    };

    // More goes in BEFORE any advanced button is registered: promotion inserts before it, so
    // it has to already be in the bar or the first promoted control has nothing to sit against.
    bar.appendChild(moreBtn);

    // Screen is advanced, but makeToggle has already appended it to the bar.
    if (toggleButtons.screen) advanced(toggleButtons.screen);

    // --- Flip: front camera <-> back camera ---------------------------------------------
    //
    // Lives INSIDE the More panel, and the promotion rule that governs everything else there
    // does not apply to it. That rule exists so a control which is switched ON can never be
    // out of sight; Flip is an action, not a toggle, so it has no "on" to hide. Pressing it
    // changes the picture immediately and visibly, which is its own feedback.
    //
    // PHONE ONLY, via .cap-mobile. A desktop with two webcams has two cameras pointing
    // wherever they happen to point — "front" and "back" describe a phone, and Chrome reports
    // no facingMode to tell them apart anyway.
    //
    // Shown whenever the camera is live. Nothing else is consulted, and in particular NOT the
    // number of cameras enumerateDevices reports.
    //
    // That gate was here and it was wrong for the only platform this feature exists for: iOS
    // Safari reports ONE videoinput for a phone with three cameras, exposing front and back
    // through the facingMode constraint instead of as separate devices. Which is what
    // facingMode is for. Gating on the count hid the control on every iPhone.
    //
    // It went unnoticed for a day because .publish-btn's display beat the [hidden] attribute,
    // so the button was on screen no matter what this decided — the CSS fix is what made the
    // wrong gate start biting. Two mistakes, each hiding the other.
    //
    // The cost of dropping it: a phone with a single camera gets a button that re-acquires
    // the same camera. There is no way to tell that phone apart on iOS, and a rare no-op
    // beats hiding the control on every iPhone there is.
    //
    // The label never renders here — .btn-label is display:none below 601px, which is every
    // device this button appears on — so the icon carries the whole meaning and aria-label
    // carries it for anyone not looking at the icon.
    const flipBtn = document.createElement("button");
    flipBtn.type = "button";
    flipBtn.className = "publish-btn toggle-btn cap-mobile";
    flipBtn.id = "flip-camera-btn";
    flipBtn.hidden = true;

    // Name the camera you would GET, not the one you are on. A button reading "Back" while
    // the back camera is live looks like a state indicator, and gets pressed to leave it.
    const labelFlip = (live: CameraFacing): void => {
      const next = live === "environment" ? "Front" : "Back";
      const say = `Switch to the ${next.toLowerCase()} camera`;
      flipBtn.title = say;
      flipBtn.setAttribute("aria-label", say);
      flipBtn.innerHTML = faced(ICONS.flip, next);
    };
    labelFlip("user");

    let flipping = false;
    flipBtn.addEventListener("click", () => {
      if (flipping || !comp?.hasCamera()) return;
      flipping = true;
      flipBtn.disabled = true;
      void comp
        .switchCamera()
        .then((live) => {
          // null means neither camera came back. switchCamera has already fired onEnded,
          // which switches Camera off and says why, so there is nothing to add here.
          if (live) labelFlip(live);
        })
        .finally(() => {
          flipping = false;
          flipBtn.disabled = false;
        });
    });
    morePanel.appendChild(flipBtn);

    onCameraChanged = () => {
      const live = comp?.cameraFacing() ?? null;
      flipBtn.hidden = !live;
      if (live) labelFlip(live);
    };


    // --- Location + time burn-in ---
    //
    // Deliberately at odds with everything else here, and opt-in for exactly that reason.
    // Two jobs: make a frame harder to pass off as somewhere or somewhen else, and make
    // glass-to-glass latency readable by anyone who can see a clock.
    //
    // Not a capture toggle: it draws over the video, it isn't a source of one. Turning it on
    // alone won't start a broadcast or publish a black frame — it arms, and it appears the
    // moment there's a picture to sit on.
    //
    // The coordinates never leave the broadcaster's browser except as pixels: fetched from
    // our own edge, rendered to canvas, encrypted with the rest of the frame. We don't store
    // them, and the only people who see them are the ones already holding the link and the
    // passcode. See src/media/geo-stamp.ts for why the clock is the server's, not the laptop's.
    const stampBtn = document.createElement("button");
    stampBtn.type = "button";
    stampBtn.className = "publish-btn toggle-btn";
    stampBtn.id = "stamp-btn";
    stampBtn.title = "Burn in location and time — asks your browser for your location, then draws it and a UTC clock into the picture for everyone watching";
    // A map pin with an info "i" knocked out of it (evenodd), so one glyph says both
    // "where" and "this is information about the shot".
    stampBtn.innerHTML = faced(
      '<svg viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" width="18" height="18" aria-hidden="true">' +
      '<path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7z' +
      'M10.9 6.2a1.1 1.1 0 1 0 2.2 0 1.1 1.1 0 1 0-2.2 0z' +
      'M11.05 8.6h1.9v4.9h-1.9z"/></svg>',
      "Location"
    );

    let stampBusy = false;
    let stampWarned = false;
    const toggleStamp = async () => {
      if (stampBusy) return;
      stampBusy = true;
      try {
        if (geoStamp) {
          geoStamp.stop();
          geoStamp = null;
          comp?.setStampProvider(null);
        } else {
          // Ask once per session. This is the one control here that deliberately publishes
          // something about the broadcaster, it cannot be taken back out of a recording
          // someone already made, and it is one click away from the camera button.
          if (!stampWarned && !window.confirm(
            "Show your location in the video?\n\n" +
            "Your browser will ask permission for your location. If you allow it, viewers see " +
            "where you are to within a few metres. If you don't, they see an approximate " +
            "city-level location from your network address instead — the line says which.\n\n" +
            "Either way it is drawn into the picture itself, along with a UTC clock. Anyone " +
            "watching sees them, and they stay in any recording that is made.\n\n" +
            "They stay inside the encryption: only people holding your link and passcode can " +
            "see them. We never store them."
          )) return;
          stampWarned = true;
          geoStamp = await createGeoStamp();
          comp?.setStampProvider(geoStamp.line);
          // Surface how good the clock is, since the latency reading is only worth this much.
          console.log(`[stamp] on; burned-in clock good to ±${geoStamp.clockUncertaintyMs().toFixed(1)}ms`);
        }
        stampBtn.classList.toggle("toggle-on", !!geoStamp);
      } catch (e) {
        console.error("[stamp] could not start the burn-in:", e);
        geoStamp = null;
        stampBtn.classList.remove("toggle-on");
      } finally {
        stampBusy = false;
      }
    };
    stampBtn.addEventListener("click", () => void toggleStamp());
    advanced(stampBtn);

    // --- Handle watermark ---
    //
    // The broadcaster's own name on their own picture, drawn subtly in the upper left. Unlike
    // the location burn-in this reveals nothing they did not choose to type, so there is no
    // confirmation step — but it lands in the picture just as permanently, and inside the same
    // encryption, so only link+passcode holders see it.
    const HANDLE_KEY = "vivoh.handle";
    const HANDLE_MAX = 32;
    // Canvas text, not HTML, so there is no markup to escape. Strip control characters anyway:
    // a newline or a bidi override in a handle turns a watermark into a layout weapon.
    const cleanHandle = (raw: string): string =>
      raw.replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028-\u202E]/g, "")
        .replace(/^@+/, "")
        .trim()
        .slice(0, HANDLE_MAX);

    const handleBtn = document.createElement("button");
    handleBtn.type = "button";
    // glyph-btn matches the weight of the 18px icons either side, so "@" reads as one of
    // them rather than as a label. It is a class rather than an inline style so the
    // narrow-phone rules can shrink it with everything else.
    handleBtn.className = "publish-btn toggle-btn glyph-btn";
    handleBtn.id = "handle-btn";
    handleBtn.title = "Watermark — show your handle in the corner of the video";
    handleBtn.innerHTML = faced("@", "Handle");

    handleBtn.addEventListener("click", () => {
      if (watermark) {
        watermark = null;
        comp?.setWatermark(null);
        handleBtn.classList.remove("toggle-on");
        return;
      }
      // Always ask, prefilled with whatever was used last. One Enter to accept, and it is the
      // only discoverable way to change or clear a handle without inventing more UI.
      let stored = "";
      try { stored = localStorage.getItem(HANDLE_KEY) || ""; } catch { /* private mode */ }
      const raw = window.prompt("Your handle — shown in the corner of the video for viewers", stored);
      if (raw == null) return; // cancelled: stay off, keep what was stored
      const clean = cleanHandle(raw);
      if (!clean) {
        // Emptied deliberately — forget it rather than leaving it on the device.
        try { localStorage.removeItem(HANDLE_KEY); } catch { /* private mode */ }
        return;
      }
      try { localStorage.setItem(HANDLE_KEY, clean); } catch { /* private mode */ }
      watermark = `@${clean}`;
      comp?.setWatermark(watermark);
      handleBtn.classList.add("toggle-on");
    });
    advanced(handleBtn);

    // --- Live chat ---
    //
    // This was a checkbox up in the stream header, next to the id and the passcode, which put
    // it among the properties of the LINK — things a viewer has to be handed. Chat is not one
    // of those: it is a room the broadcaster opens and closes while live, in the same family
    // as the overlay editor and the capture toggles sitting either side of it here.
    //
    // The state and the open/close work live near the top of this function; this button is
    // only the surface. It registers itself so the settings load can light it up.
    // Group three, on its own: not a source and not something drawn on the picture, but a room
    // that opens for everyone watching.
    const chatBtnEl = document.createElement("button");
    chatBtnEl.type = "button";
    chatBtnEl.className = "publish-btn toggle-btn";
    chatBtnEl.id = "chat-btn";
    chatBtnEl.title = "Live chat — opens a chat panel for you and everyone watching";
    chatBtnEl.innerHTML = faced(
      '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">' +
      '<path d="M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/>' +
      "</svg>",
      "Chat"
    );
    chatBtnEl.addEventListener("click", () => setChatEnabled(!chatEnabled));
    chatBtn = chatBtnEl;
    chatBtn.classList.toggle("toggle-on", chatEnabled);   // settings may have landed first
    advanced(chatBtnEl);

    // No Stop button. It set all three capture flags false and called applyState(), which is
    // the same "nothing active" branch that turning off your last input already reaches — so
    // it was a second way to do what the toggles do, sitting in a row that had grown to eight
    // controls. Every input here is a toggle; switching one off is how it stops, and the
    // broadcast ends when the last one does.
    //
    // What it cost to remove: one click instead of two or three when several inputs are live.
    // That is a smaller price than an eighth button whose relationship to the other seven has
    // to be worked out.
    syncButtons();

    // Place the control bar directly after the <moq-publish> element, and the More panel
    // directly after the bar — it opens downward, into the space above the stream card,
    // rather than floating over the video the broadcaster is trying to watch.
    publisher.insertAdjacentElement("afterend", bar);
    bar.insertAdjacentElement("afterend", morePanel);
    morePanel.insertAdjacentElement("afterend", notice);

    // --- Status indicator (display only; go-live logging is handled by goLive) ---
    const refreshStatus = () => {
      const conn = publisher.connection?.status?.peek?.() ?? "disconnected";
      // anyActive covers PiP too (where state.source is undefined by design).
      const hasSource = anyActive || !!publisher.state?.source?.peek?.();
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
    };
    try {
      publisher.connection?.status?.subscribe?.(refreshStatus);
      publisher.state?.source?.subscribe?.(refreshStatus);
    } catch (err) {
      console.warn("Could not subscribe to publish status signals:", err);
    }
    refreshStatus();

    // Log end on page unload.
    //
    // pagehide is the load-bearing one: mobile Safari fires it on background/close where
    // beforeunload is simply never delivered, and this is the exact reasoning the watch
    // session path already carries. A missed end here is worse than a miscounted session — it
    // leaves the row open and locks this stream id out of its own next go-live with a 409.
    // beforeunload stays as desktop belt-and-braces; logBroadcastEnd is idempotent, so both
    // firing is fine.
    const endOnUnload = () => {
      if (broadcastEventId) logBroadcastEnd(broadcastEventId);
    };
    window.addEventListener("pagehide", endOnUnload);
    window.addEventListener("beforeunload", endOnUnload);

    // --- HTML overlay editor (broadcaster-authored HTML shown to viewers) ---
    const overlayBtn = document.createElement("button");
    overlayBtn.type = "button";
    overlayBtn.title = "Extras — a promo, a poll, links or notes shown below the video for viewers";
    overlayBtn.className = "publish-btn html-overlay-btn";
    overlayBtn.innerHTML = faced("&lt;/&gt;", "Extras");
    // Built here, but it belongs with the other two overlay controls rather than tacked on
    // past Chat — so it is inserted into the group instead of appended to the end.
    //
    // On the name. Not "Code": this page already has a Passcode, and a second thing called a
    // code reads as related to it. Not "Overlay" either, which was the first attempt — that is
    // our word for the mechanism, and it is wrong twice over, because this renders in a block
    // BELOW the video rather than over anything. What a broadcaster is actually doing is
    // adding something alongside the stream: a product promo, a poll widget, a couple of
    // links. "Extras", plural, because the plural reads as a category of optional additions
    // where the singular reads as an adjective missing its noun.
    advanced(overlayBtn);

    const overlayContainer = document.createElement("div");
    overlayContainer.className = "html-overlay-container";
    overlayContainer.innerHTML = `
      <div class="html-overlay-input" contenteditable="true"></div>
      <div class="html-overlay-hint">Shown below the video for everyone watching. Headings, lists, tables, links, images and embeds from other sites all work.</div>
      <div class="html-overlay-warning hidden"></div>
      <div class="html-overlay-preview-label hidden">Preview — this is exactly what viewers get</div>
      <div class="html-overlay-preview hidden"></div>
    `;
    const section = document.querySelector("#broadcast-view section");
    if (section && section.parentNode) {
      section.parentNode.insertBefore(overlayContainer, section.nextSibling);
    }

    const overlayInput = overlayContainer.querySelector(".html-overlay-input") as HTMLDivElement;
    const overlayPreview = overlayContainer.querySelector(".html-overlay-preview") as HTMLDivElement;
    const overlayPreviewLabel = overlayContainer.querySelector(".html-overlay-preview-label") as HTMLDivElement;
    const overlayWarning = overlayContainer.querySelector(".html-overlay-warning") as HTMLDivElement;
    let saveTimeout: number | null = null;

    // Preview through the same sanitiser the viewer uses, and say plainly when something was
    // dropped. Silent stripping is what made the old, much tighter allowlist read as a bug:
    // a heading came out as unstyled text and nothing anywhere said why.
    const refreshPreview = (raw: string) => {
      const source = raw.trim();
      if (!source) {
        overlayPreview.innerHTML = "";
        overlayPreview.classList.add("hidden");
        overlayPreviewLabel.classList.add("hidden");
        overlayWarning.classList.add("hidden");
        return;
      }
      const { html, removed } = renderOverlay(source);
      overlayPreview.innerHTML = html;
      overlayPreview.classList.remove("hidden");
      overlayPreviewLabel.classList.remove("hidden");
      if (removed.length) {
        // textContent, not innerHTML — this string is built from the broadcaster's own markup.
        overlayWarning.textContent = `Removed, because it could run code in a viewer's browser: ${removed.join(", ")}`;
        overlayWarning.classList.remove("hidden");
      } else {
        overlayWarning.classList.add("hidden");
      }
    };

    // Load existing overlay content
    getStreamSettings(streamId).then((settings) => {
      if (settings.overlay_html) {
        overlayInput.textContent = settings.overlay_html;
        overlayBtn.classList.add("active");
        refreshPreview(settings.overlay_html);
      }
    });

    // Save overlay content with debounce
    overlayInput.addEventListener("input", () => {
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = window.setTimeout(() => {
        const content = overlayInput.textContent || "";
        updateStreamSettings(streamId, { overlay_html: content });
        overlayBtn.classList.toggle("active", !!content.trim());
        refreshPreview(content);
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
}

// Show login required overlay for watch
/**
 * A share link whose `#k=` fragment is missing or was stripped. Common causes: the link was
 * re-typed, passed through something that drops fragments, or only the stream id was shared.
 * Nothing here can be fixed by signing in — without the fragment the stream is undecryptable
 * by anyone, us included, so the only remedy is to obtain the complete link.
 */
function showWatchKeyMissing() {
  const section = document.getElementById("watch-view")?.querySelector("section");
  if (!section) return;
  section.innerHTML = `
    <div class="login-required">
      <h2>This link is missing its key</h2>
      <p>
        Vivoh.Earth streams are encrypted in the broadcaster's browser, and the key to decrypt
        one travels only in the part of the link after the <code>#</code>. This link does not
        carry it, so the stream cannot be played.
      </p>
      <p>Ask the broadcaster for the complete link — and take care to copy all of it.</p>
    </div>`;
}

// promptPasscode() and its first/wrong/rotated variants lived here. There is no second
// secret to ask for: the key is the link. A viewer whose link does not decrypt is told so
// by the stuck-player watchdog, which can distinguish a stale salt (re-derivable) from a
// genuinely wrong link (not), rather than asking them to type something that cannot help.

// ── Reacting to a kill ────────────────────────────────────────────────────────────────
// Kill is enforced server-side at /route and at go-live, but both are request-time checks and
// an established session makes no further requests. Measured, not assumed: after a kill a
// viewer kept decoding fresh frames for a full minute and the publisher kept sending, and
// both would have continued until something made them reconnect
// (scripts/e2e/kill-live-viewer.mjs). Terminating a live broadcast therefore needs the
// clients to notice, which they do via the `killed` flag on the settings poll they already run.
//
// This is cooperative: a modified client can ignore it. That is an acceptable limit, because
// a modified client can also just record the stream — this closes the gap for the honest
// clients that every real viewer is actually running, and nothing more is claimed for it.

/**
 * Stop everything and say why. Replacing the section's contents is correct HERE — unlike the
 * passcode prompt, which must not — because tearing down <moq-watch> is exactly the goal: it
 * is what actually ends the media session rather than merely hiding it.
 */
function stopForKill(role: "viewer" | "broadcaster"): void {
  const watcher = document.querySelector("moq-watch");
  if (watcher) {
    watcher.removeAttribute("url");
    watcher.remove();
  }

  const publisher = document.querySelector("moq-publish") as (MoqPublishElement & { source?: unknown }) | null;
  if (publisher) {
    publisher.removeAttribute("url");
    try {
      publisher.announce = "never"; // was `false`; see the enum note at the go-live site
      publisher.source = null;
    } catch {
      // Older element builds expose these differently; removing the URL above is what stops
      // the connection, and the rest is best-effort tidying.
    }
    publisher.remove();
  }

  // Release the camera and microphone. Leaving the capture light on after a broadcast has
  // been terminated would be its own small betrayal.
  for (const el of document.querySelectorAll("video")) {
    const stream = (el as HTMLVideoElement).srcObject as MediaStream | null;
    stream?.getTracks?.().forEach((t) => t.stop());
    (el as HTMLVideoElement).srcObject = null;
  }

  const section =
    document.querySelector("#watch-view section") ??
    document.querySelector("#broadcast-view section") ??
    document.body;

  const panel = document.createElement("div");
  panel.className = "login-required";
  panel.style.cssText = "text-align:center;padding:2.5rem 1.5rem;max-width:34em;margin:0 auto;";
  const heading = document.createElement("h2");
  heading.textContent = "This stream has been terminated";
  const body = document.createElement("p");
  body.style.cssText = "color:#a3a3a3;line-height:1.55;";
  body.textContent =
    role === "broadcaster"
      ? "An operator stopped this broadcast. Publishing has ended and your camera and microphone have been released. Nothing that was already sent can be recalled, and nobody here can play it back."
      : "An operator stopped this broadcast in response to a report. Playback has ended.";
  panel.append(heading, body);
  section.replaceChildren(panel);
}

// ── Reporting a stream ────────────────────────────────────────────────────────────────
// We cannot see what is being broadcast — that is the point of the encryption — so we have no
// way to notice a problem ourselves. Every abuse signal has to come from someone holding a
// key, which means a viewer. This control is the only sensor the kill switch has.
//
// What travels: the stream id, a category, and whatever the viewer types. Never the key. The
// fragment is not read here, and must not be: browsers do not transmit it, and quietly
// attaching it would hand the server the one thing the whole design keeps out of its reach.

interface ReportGroup {
  label: string;
  ids: string[];
}

interface ReportConfig {
  categories: string[];
  /** Absent from a Worker older than the grouped categories; the dialog falls back to flat. */
  groups?: ReportGroup[];
  note_max: number;
  evidence_supported: boolean;
}

/**
 * Longest edge of an attached frame, in pixels.
 *
 * Not chosen for how it looks to a person — a human can judge a 200px thumbnail. It is sized
 * for the machine that will eventually read these, since vision models tokenise around this
 * scale and anything larger is bytes spent on detail nothing downstream uses.
 */
const REPORT_FRAME_LONG_EDGE = 512;

/**
 * Budget for the encoded frame, in base64 characters. Deliberately UNDER the Worker's
 * REPORT_FRAME_MAX_B64 (96,000) rather than equal to it: two constants that must agree
 * exactly is a bug waiting for the day one of them moves, and the failure would be silent —
 * the report still files, the picture just vanishes.
 */
const REPORT_FRAME_MAX_B64 = 90_000;

interface CapturedFrame {
  b64: string;
  w: number;
  h: number;
}

/**
 * A still of what this viewer is actually seeing, taken from the player's own canvas.
 *
 * Only reachable from the watch page, and only for a viewer, which is the whole reason it can
 * exist: the frame is already decrypted in this browser because this browser holds the key.
 * Nothing here is a new capability — a viewer could always screenshot — it is a way to hand
 * one frame to an operator without handing over the link that decrypts everything.
 *
 * Returns null rather than a black rectangle when there is nothing to capture. An operator
 * looking at a queue must be able to read "no frame" as "we have nothing", not wonder whether
 * the broadcast really was a dark room.
 */
function captureWatchFrame(): CapturedFrame | null {
  const canvas = document.querySelector("moq-watch canvas") as HTMLCanvasElement | null;
  if (!canvas || canvas.width < 64 || canvas.height < 64) return null;

  try {
    // Is the player showing anything? <moq-watch> paints black with fillRect before any frame
    // arrives, and a viewer who opens Report during the passcode prompt or a reconnect would
    // otherwise attach a picture of nothing. A tiny probe is enough: a real frame has spread.
    const probe = document.createElement("canvas");
    probe.width = 32;
    probe.height = 18;
    const pctx = probe.getContext("2d", { willReadFrequently: true });
    if (!pctx) return null;
    pctx.drawImage(canvas, 0, 0, 32, 18);
    const px = pctx.getImageData(0, 0, 32, 18).data;
    let lo = 255;
    let hi = 0;
    for (let i = 0; i < px.length; i += 4) {
      const luma = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
      if (luma < lo) lo = luma;
      if (luma > hi) hi = luma;
    }
    // 8 levels out of 255. A genuinely near-black shot loses its frame, which is the right
    // way to be wrong: nothing is claimed that the picture does not support.
    if (hi - lo < 8) return null;

    // Shrink, then encode, stepping quality down until it fits. Two passes over the edge
    // length as well, because a 4K screen share at 512px can still exceed the budget at the
    // lowest quality that is worth sending at all.
    const out = document.createElement("canvas");
    const octx = out.getContext("2d");
    if (!octx) return null;
    for (const edge of [REPORT_FRAME_LONG_EDGE, 384, 256]) {
      const scale = Math.min(1, edge / Math.max(canvas.width, canvas.height));
      out.width = Math.max(1, Math.round(canvas.width * scale));
      out.height = Math.max(1, Math.round(canvas.height * scale));
      octx.drawImage(canvas, 0, 0, out.width, out.height);
      for (const q of [0.72, 0.6, 0.5, 0.38]) {
        const url = out.toDataURL("image/jpeg", q);
        const b64 = url.slice(url.indexOf(",") + 1);
        if (b64.length <= REPORT_FRAME_MAX_B64) return { b64, w: out.width, h: out.height };
      }
    }
    return null;
  } catch {
    // A tainted canvas would throw here. It should not be possible — these frames were decoded
    // in this document from bytes we decrypted ourselves — but a report must not die on it.
    return null;
  }
}

/**
 * What each category says to the person reporting.
 *
 * Written for somebody upset, on a phone, who wants this over with. Every label is a plain
 * description of a thing you could be looking at — never a policy term, never a citation, and
 * never the wording of the payment rule underneath it. The Worker holds the mapping from these
 * to Stripe's prohibited-business bullets (see REPORT_GROUPS there); a reporter should not have
 * to translate "designed for the purpose of sexual gratification" into what is on their screen.
 *
 * The four sexual-content labels are deliberately distinguishable at a glance, because the
 * difference between them is the difference between a policy problem and a criminal one, and
 * a misfiled report costs a broadcaster far more than a vague one costs us.
 */
const REPORT_LABELS: Record<string, string> = {
  "sexual-content-involving-minors": "Sexual content involving a minor",
  "adult-sexual-content": "Nudity or sexual activity",
  "adult-services": "Selling or advertising sexual services",
  "adult-paid-performance": "A paid sexual performance or live sex chat",
  "adult-ai-generated": "AI-generated sexual imagery",
  "violence-or-threats": "Violence or threats",
  "non-consensual-content": "Someone filmed without their consent",
  harassment: "Harassment",
  other: "Something else",
};

/**
 * The dialog's fallback grouping, replaced by the Worker's if it answers in time.
 *
 * Present at all for the same reason the whole dialog is drawn before /api/report/config
 * returns: someone reaching for this button is not in a mood to wait on a round trip, and a
 * report filed against a slightly stale category list still reaches a person. Kept in the same
 * order as the Worker's so the two agree on which option is first — which matters, because
 * the first option is the one a misclick lands on.
 */
const REPORT_FALLBACK_GROUPS: ReportGroup[] = [
  { label: "Most serious", ids: ["sexual-content-involving-minors"] },
  {
    label: "Sexual content",
    ids: ["adult-sexual-content", "adult-services", "adult-paid-performance", "adult-ai-generated"],
  },
  {
    label: "Other harm",
    ids: ["violence-or-threats", "non-consensual-content", "harassment", "other"],
  },
];

/**
 * Draw the category list, grouped.
 *
 * Rebuilds from scratch rather than appending, because it runs twice — once immediately with
 * the built-in list, once when the Worker answers — and appending the second time would leave
 * a dropdown with every option in it twice. The reporter's current choice is carried across,
 * so a slow network cannot silently reset a selection somebody already made.
 */
function paintReportCategories(select: HTMLSelectElement, groups: ReportGroup[]): void {
  const chosen = select.value;
  select.textContent = "";

  // A PLACEHOLDER FIRST, and it is not decoration.
  //
  // A <select> selects its first option by default, and the first group here is the gravest
  // category there is. Without this, a viewer who opens the dialog, types what happened and
  // presses Send — never touching the dropdown, because it already showed something — files a
  // report of child sexual abuse against a stranger. The two-click confirmation catches that,
  // but a confirmation is the wrong place to be discovering a default nobody chose.
  //
  // `disabled` so it cannot be selected back into once a real answer is given, and so the
  // browser skips it under keyboard navigation. `selected` because on a repaint the browser
  // would otherwise fall through to the first enabled option, which is exactly the one this
  // exists to keep out of the way.
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose from a category below";
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);

  for (const group of groups) {
    const ids = group.ids.filter((id) => REPORT_LABELS[id] || id);
    if (!ids.length) continue;
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const id of ids) {
      const opt = document.createElement("option");
      opt.value = id;
      // Unknown ids are shown by their raw value rather than dropped: a Worker that knows a
      // category this bundle does not must still be reportable, and a visible slug is a far
      // smaller problem than an option nobody can pick.
      opt.textContent = REPORT_LABELS[id] ?? id;
      optgroup.appendChild(opt);
    }
    select.appendChild(optgroup);
  }
  if (chosen && select.querySelector(`option[value="${CSS.escape(chosen)}"]`)) select.value = chosen;
}

/** Small "Report" affordance in the badge pill above the player. */
function mountReportControl(streamId: string): void {
  const sec = document.querySelector("#watch-view section") as HTMLElement | null;
  if (!sec || sec.querySelector(".watch-report-btn")) return;
  if (!sec.style.position) sec.style.position = "relative";

  let pill = sec.querySelector(".watch-badges") as HTMLElement | null;
  if (!pill) {
    pill = document.createElement("div");
    pill.className = "watch-badges";
    pill.style.cssText =
      "position:absolute;top:10px;right:10px;z-index:5;display:flex;align-items:center;" +
      "gap:8px;background:rgba(0,0,0,0.6);border-radius:999px;padding:4px 10px;";
    sec.appendChild(pill);
  }

  const btn = document.createElement("button");
  btn.className = "watch-report-btn";
  btn.type = "button";
  btn.textContent = "Report";
  btn.title = "Tell the operator something is wrong with this stream";
  btn.style.cssText =
    "background:none;border:0;padding:0 0 0 8px;margin:0;color:#a3a3a3;font:inherit;" +
    "font-size:0.75rem;cursor:pointer;border-left:1px solid #444;line-height:1;";
  btn.addEventListener("mouseenter", () => { btn.style.color = "#e5e5e5"; });
  btn.addEventListener("mouseleave", () => { btn.style.color = "#a3a3a3"; });
  // Captured HERE, on the click, not later when the dialog is submitted. The moment someone
  // reaches for this button is the moment worth keeping; by the time they have picked a
  // category and typed a sentence, whatever prompted them may be thirty seconds gone.
  btn.addEventListener("click", () => openReportDialog(streamId, captureWatchFrame()));
  pill.appendChild(btn);
}

/**
 * Overlay, NOT a rewrite of the section — replacing the section's contents destroys the
 * <moq-watch> element and the stream never comes back. (Learned the hard way on the passcode
 * prompt, which had exactly this bug.)
 */
function openReportDialog(streamId: string, frame: CapturedFrame | null): void {
  // Rendered from local defaults FIRST, then reconciled with the server's config when it
  // arrives. Awaiting the fetch before drawing anything makes the button feel dead on a slow
  // connection — and someone reaching for a report button is not in a mood to wonder whether
  // they missed. A report filed against a guessed category list still reaches a person.
  const cfg: ReportConfig = {
    categories: Object.keys(REPORT_LABELS),
    groups: REPORT_FALLBACK_GROUPS,
    note_max: 500,
    evidence_supported: false,
  };

  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;" +
    "background:rgba(0,0,0,0.85);backdrop-filter:blur(2px);padding:20px;";

  const card = document.createElement("div");
  card.style.cssText =
    "max-width:30em;width:100%;color:#e5e5e5;background:#131313;border:1px solid #2a2a2a;" +
    "border-radius:8px;padding:22px;text-align:left;";
  card.innerHTML = `
    <h2 style="margin:0 0 10px;font-size:1.2rem;">Report this stream</h2>
    <p style="margin:0 0 16px;color:#a3a3a3;line-height:1.5;font-size:0.9rem;">
      This goes to the operator, who can stop the broadcast. They cannot see it — nobody can
      decrypt a Vivoh.Earth stream without <span id="report-what-it-takes">the link you were given</span>.
    </p>
    <label style="display:block;margin:0 0 6px;font-size:0.85rem;color:#d4d4d4;">What is wrong?</label>
    <select id="report-category"
            style="width:100%;padding:9px 10px;margin:0 0 14px;border-radius:4px;
                   border:1px solid #3a3a3a;background:#1a1a1a;color:#e5e5e5;font:inherit;"></select>
    <label style="display:block;margin:0 0 6px;font-size:0.85rem;color:#d4d4d4;">
      Anything else? <span style="color:#737373;">(optional)</span>
    </label>
    <textarea id="report-note" rows="3" maxlength="${cfg.note_max}"
              placeholder="Please don't include personal details about yourself or anyone else."
              style="width:100%;padding:9px 10px;border-radius:4px;border:1px solid #3a3a3a;
                     background:#1a1a1a;color:#e5e5e5;font:inherit;resize:vertical;"></textarea>
    <div id="report-frame-row" style="margin:16px 0 0;display:none;">
      <label style="display:flex;gap:9px;align-items:flex-start;font-size:0.85rem;color:#a3a3a3;
                    line-height:1.45;cursor:pointer;">
        <input type="checkbox" id="report-frame-send" checked style="margin-top:3px;flex:none;">
        <span>
          <strong style="color:#d4d4d4;font-weight:600;">Send this picture with the report.</strong>
          It is what your player was showing the moment you pressed Report — one frame, not a
          recording. Without it an operator has only your description to act on.
        </span>
      </label>
      <img id="report-frame-img" alt="The single frame that will be sent with this report"
           style="display:block;width:100%;max-width:19em;margin:10px 0 0 27px;border-radius:4px;
                  border:1px solid #2a2a2a;background:#000;">
    </div>
    <div id="report-evidence-row" style="margin:14px 0 0;display:none;">
      <label style="display:flex;gap:9px;align-items:flex-start;font-size:0.85rem;color:#a3a3a3;
                    line-height:1.45;cursor:pointer;">
        <input type="checkbox" id="report-evidence" style="margin-top:3px;flex:none;">
        <span>
          <strong style="color:#d4d4d4;font-weight:600;">Send my viewing link so they can check.</strong>
          <span id="report-evidence-detail"></span>
        </span>
      </label>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin:20px 0 0;">
      <button id="report-cancel"
              style="padding:9px 16px;border-radius:4px;border:1px solid #3a3a3a;background:none;
                     color:#a3a3a3;font:inherit;cursor:pointer;">Cancel</button>
      <button id="report-send"
              style="padding:9px 18px;border-radius:4px;border:0;background:#33ddc0;color:#0a0a0a;
                     font:inherit;font-weight:600;cursor:pointer;">Send report</button>
    </div>`;
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // Options built through the DOM rather than interpolated into innerHTML: the category list
  // arrives over the network, and this page is holding a content key.
  const select = card.querySelector("#report-category") as HTMLSelectElement;
  paintReportCategories(select, cfg.groups ?? REPORT_FALLBACK_GROUPS);

  // Shown, never sent silently. The frame is broadcast content leaving the encrypted side of
  // the design, and the reporter is the only person in a position to consent to that — so they
  // see exactly what will go, and one click removes it. `src` is assigned as a property rather
  // than interpolated into the innerHTML above: no reason to put a 90 KB data URL through an
  // HTML parser on a page holding a content key.
  if (frame) {
    const row = card.querySelector("#report-frame-row") as HTMLElement | null;
    const img = card.querySelector("#report-frame-img") as HTMLImageElement | null;
    if (row && img) {
      img.src = `data:image/jpeg;base64,${frame.b64}`;
      row.style.display = "block";
    }
  }

  // There is no passcode variant to account for any more: the link carries `#k=` and that is
  // the whole of the key material, so attaching it really does hand over the ability to
  // decrypt. Wallflower has to hedge this text because on a passcode stream the link alone
  // unlocks nothing — asking someone to share it under a false account of what it unlocks
  // would be the wrong way round. Here the plain statement is the accurate one.
  const detail = card.querySelector("#report-evidence-detail");
  if (detail) {
    detail.textContent =
      " Your link contains the key that decrypts this stream. Ticking this shares it with the " +
      "operator, letting them see the stream before deciding. Leave it unticked and they will " +
      "act on your description alone.";
  }

  // Reconcile with the server. The evidence option appears only if there is a webhook to send
  // it to — with none configured there is nowhere for a key to go that is not the database,
  // and it is not going in the database.
  void fetch("/api/report/config")
    .then((r) => (r.ok ? r.json() : null))
    .then((live: ReportConfig | null) => {
      if (!live || !overlay.isConnected) return;
      if (live.note_max) {
        (card.querySelector("#report-note") as HTMLTextAreaElement | null)?.setAttribute("maxlength", String(live.note_max));
      }
      // Repaint from the Worker's grouping when it sends one. A Worker too old to know about
      // groups still sends the flat `categories`, so anything in that list which no group
      // claims is swept into a trailing bucket rather than lost — the alternative is a
      // category the server accepts and the dialog cannot offer.
      const groups = (live.groups ?? []).map((g) => ({ label: g.label, ids: [...g.ids] }));
      const claimed = new Set(groups.flatMap((g) => g.ids));
      const orphans = (live.categories ?? []).filter((id) => !claimed.has(id));
      if (orphans.length) groups.push({ label: "Other harm", ids: orphans });
      if (groups.length) paintReportCategories(select, groups);
      if (live.evidence_supported) {
        const row = card.querySelector("#report-evidence-row") as HTMLElement | null;
        if (row) row.style.display = "block";
      }
    })
    .catch(() => {
      // Offline or blocked: the dialog is already usable, which is the point of drawing first.
    });

  const close = () => overlay.remove();
  card.querySelector("#report-cancel")?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  // The gravest category, confirmed once before it can be filed.
  //
  // Added after a real misfire: a report went in under this category, with a frame attached,
  // by accident — the select was one click off and there was nothing between that and a filed
  // accusation. This category is different in kind from the others. It is the one an operator
  // is obliged to act on fastest, and the one that is worst to be on the wrong end of.
  //
  // Deliberately a SECOND CLICK rather than a checkbox or a browser confirm(): it costs one
  // click in the rare case and nothing at all in the common one, and it makes the reporter
  // read the category back rather than acknowledge a dialog they did not read.
  const SEVERE = "sexual-content-involving-minors";
  let severeConfirmed = false;

  card.querySelector("#report-send")?.addEventListener("click", async () => {
    const sendBtn = card.querySelector("#report-send") as HTMLButtonElement;

    // Nothing chosen yet. Refuse, and say where to look rather than what went wrong — the
    // placeholder is three lines up the dialog and pointing at it beats naming an error.
    //
    // Not silently defaulting to "other": a report filed under a category nobody picked is a
    // report an operator has to guess at, and guessing is the thing this whole list exists to
    // stop. Note the Worker also maps an unknown category to "other" rather than rejecting,
    // so a client that skips this guard still gets the report through — it just arrives
    // vaguer, which is the right way for the two halves to disagree.
    if (!select.value) {
      let hint = card.querySelector("#report-need-category") as HTMLElement | null;
      if (!hint) {
        hint = document.createElement("div");
        hint.id = "report-need-category";
        hint.style.cssText = "margin:10px 0 0;color:#e8b0b0;font-size:0.85rem;";
        hint.textContent = "Please choose a category above.";
        select.after(hint);
        select.addEventListener("change", () => hint?.remove(), { once: true });
      }
      select.focus();
      return;
    }

    if (select.value === SEVERE && !severeConfirmed) {
      severeConfirmed = true;
      sendBtn.textContent = "Yes — file this report";
      sendBtn.style.background = "#e06060";
      sendBtn.style.color = "#ffffff";
      const warn = document.createElement("div");
      warn.id = "report-severe-warn";
      warn.style.cssText =
        "margin:14px 0 0;padding:10px 12px;border-radius:4px;background:#2a1414;" +
        "border:1px solid #5a2626;color:#e8b0b0;font-size:0.85rem;line-height:1.45;";
      warn.textContent =
        "You are reporting sexual content involving a minor. This is the most serious report " +
        "there is and an operator will act on it immediately. If you picked it by mistake, " +
        "change the category above — the button will go back to normal.";
      card.querySelector("#report-frame-row")?.before(warn);
      // Choosing something else takes the confirmation back down. A warning that outlives the
      // reason for it is one people learn to click past.
      select.addEventListener("change", () => {
        severeConfirmed = false;
        card.querySelector("#report-severe-warn")?.remove();
        sendBtn.textContent = "Send report";
        sendBtn.style.background = "#33ddc0";
        sendBtn.style.color = "#0a0a0a";
      }, { once: true });
      return;
    }

    sendBtn.disabled = true;
    sendBtn.textContent = "Sending…";

    const shareEvidence = (card.querySelector("#report-evidence") as HTMLInputElement | null)?.checked;
    const sendFrame =
      !!frame && (card.querySelector("#report-frame-send") as HTMLInputElement | null)?.checked !== false;
    try {
      await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stream_id: streamId,
          category: select.value,
          note: (card.querySelector("#report-note") as HTMLTextAreaElement).value,
          // location.href carries the fragment, and therefore the key. Read ONLY inside this
          // branch, so the only path by which a key can leave a viewer's browser is a person
          // deliberately ticking a box.
          ...(shareEvidence ? { evidence_url: location.href } : {}),
          // Bare base64. The server refuses anything whose bytes are not a JPEG and stamps
          // the type itself — a client that got to name its own MIME type could put a script
          // in an operator's browser, and this queue is read on the page holding the admin
          // password.
          ...(sendFrame && frame ? { frame: frame.b64 } : {}),
        }),
      });
    } catch {
      // Swallowed on purpose. A failed report must not leave the reporter staring at an error
      // that invites them to retry in a loop; the operator's copy either arrived or did not.
    }

    card.innerHTML = `
      <h2 style="margin:0 0 10px;font-size:1.2rem;">Thank you</h2>
      <p style="margin:0 0 18px;color:#a3a3a3;line-height:1.5;font-size:0.9rem;">
        A person will read this${sendFrame ? ", and look at the frame you sent" : ""}. There is
        no automatic action — reports are not a vote, and a stream is never stopped by a count.
      </p>
      <div style="display:flex;justify-content:flex-end;">
        <button id="report-done"
                style="padding:9px 18px;border-radius:4px;border:0;background:#33ddc0;
                       color:#0a0a0a;font:inherit;font-weight:600;cursor:pointer;">Close</button>
      </div>`;
    card.querySelector("#report-done")?.addEventListener("click", close);
  });
}

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
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path fill="#F25022" d="M2 2h9.5v9.5H2z"/>
            <path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z"/>
            <path fill="#00A4EF" d="M2 12.5h9.5V22H2z"/>
            <path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z"/>
          </svg>
          Microsoft
        </button>
        <button id="watch-login-discord" class="btn btn-discord">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path fill="#5865F2" d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.3.5c1.6.4 2.9 1 4.1 1.8a13.9 13.9 0 0 0-11-1.2c-.4.1-.9.3-1.3.4.4-.2.9-.4 1.4-.6l-.2-.4a19.8 19.8 0 0 0-4.9 1.4C1 9 .4 13.4.7 17.8a19.9 19.9 0 0 0 6 3l1.2-1.9c-.7-.2-1.3-.5-1.9-.9l.5-.3a14.2 14.2 0 0 0 12 0l.5.3c-.6.4-1.2.7-1.9.9l1.2 1.9a19.9 19.9 0 0 0 6-3c.4-5.1-.6-9.5-4-13.4zM8.4 15.3c-1.2 0-2.1-1.1-2.1-2.4 0-1.3.9-2.4 2.1-2.4 1.2 0 2.2 1.1 2.1 2.4 0 1.3-.9 2.4-2.1 2.4zm7.2 0c-1.2 0-2.1-1.1-2.1-2.4 0-1.3.9-2.4 2.1-2.4 1.2 0 2.2 1.1 2.1 2.4 0 1.3-.9 2.4-2.1 2.4z"/>
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
// Mode C (Enterprise): turn an enterprise route into a connectable QUIC endpoint via the
// autoscaler's proven two-step /assign flow — run from the BROWSER because only it can
// reach the PRIVATE on-net relay. Step 1: tell the local relay to pull the broadcast from
// the remote edge (origin) using the cluster pull pass; it replies "host:port". Step 2 is
// the returned URL: connect there with the watchToken and subscribe to <broadcast>.
// C1 contract: auth is the BYOK watch token as a `jwt=` QUERY PARAM (not an Authorization
// header — a header would trigger a CORS preflight on this cross-origin call; a query param
// doesn't). The edge resolves the tenant by the token's kid, validates it against this
// tenant's verify_jwk, and requires a valid subscribe <broadcast> scope. No provisioning
// bearer ever enters the browser → relay-blind preserved. `origin`/`pull` are added ONLY for
// cross-pull (edge pulls the broadcast from the publisher's origin relay); in standalone mode
// the worker omits edgeHost/pullToken because the publisher is already on the edge. The
// response body is the EDGE's media endpoint "host:port" as plain text (some builds wrap it as
// JSON {relay}, so we accept both). The browser MUST dial that returned value (NOT `origin`,
// which is only the upstream the edge pulls from). The same watch token then drives the QUIC
// connect. Returns null on any failure → caller falls to B/A.
async function resolveEnterpriseConnectUrl(route: StreamRoute): Promise<string | null> {
  if (!route.broadcast || !route.watchToken) return null;
  try {
    const q = new URLSearchParams({
      broadcast: route.broadcast,
      jwt: route.watchToken, // same watch token used on the QUIC connect step
    });
    if (route.edgeHost) q.set("origin", route.edgeHost); // cross-pull only (upstream, not dialed)
    if (route.pullToken) q.set("pull", route.pullToken); // cross-pull only
    // Transport hint from the viewer URL (?xport=): forwarded verbatim to the edge's /assign.
    // Not secret and not part of any token, so read it straight from the page URL rather than
    // threading it through the route resolver. xport=iroh makes the edge pull from the origin
    // over iroh/DHT; any other value or absent leaves today's host:port behavior unchanged.
    const xport = new URLSearchParams(location.search).get("xport");
    if (xport) q.set("xport", xport);
    const res = await fetch(`https://${route.relay}/assign?${q.toString()}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const body = (await res.text()).trim();
    if (!body) return null;
    // Plain "host:port" or JSON {relay:"host:port"} (mirrors the Worker's dual-mode /assign parse).
    let hostPort = body;
    if (body.startsWith("{")) {
      try {
        hostPort = String((JSON.parse(body) as { relay?: string }).relay ?? "").trim();
      } catch {
        return null;
      }
    }
    if (!hostPort) return null;
    return `https://${hostPort}/?jwt=${route.watchToken}`;
  } catch (e) {
    console.warn("[route] enterprise /assign preflight failed", e);
    return null;
  }
}

// Mode C fallback: reload forcing ?noEnterprise=1 so the Worker skips Mode C and returns
// B/A — the viewer always ends up watching even when the private relay is unreachable.
function forceBAFallback(): void {
  const u = new URL(window.location.href);
  u.searchParams.set("noEnterprise", "1");
  window.location.replace(u.toString());
}

// Promotional landing page (bare "/"). The content is static HTML in index.html; this
// just reveals the section. The Broadcast / Watch entry points are plain links to
// /broadcast and /watch (see getRouteInfo).
function initLandingView() {
  document.getElementById("landing-view")?.classList.remove("hidden");
  // The byline is redundant on the promo page (the hero says the same thing); hide it
  // here only — it stays in the header on the broadcast and watch pages.
  document.getElementById("site-tagline")?.classList.add("hidden");
  // The footer used to be hidden here, on the reasoning that MoQ | TinyMoQ | Browser Support
  // | Server Status were operator-ish links with no place on a promo page. That reasoning
  // expired when "How it works" moved into it: hiding the footer would leave a first-time
  // visitor with no way to read the one explanation this product is actually selling.
  document.querySelector("footer")?.classList.remove("hidden");
  // Server Status is meaningless here — no relay has been assigned, so the panel can only
  // report a placeholder, and it previously reported a fleet host this client never contacts.
  // It belongs on the pages where a connection actually exists.
  document.getElementById("server-status-item")?.classList.add("hidden");
}

async function initWatchView(streamId: string, user: User | null) {
  // The ".hang" suffix makes the catalog format explicit so the watcher can parse
  // the catalog and subscribe to video/audio tracks (otherwise detectFormat() is
  // undefined and the viewer only fetches catalog.json, never video/hd).
  const streamName = `${NAMESPACE_PREFIX}/${streamId}.hang`;

  console.log(`MoQplay Watch - Stream: ${streamId}`);

  // Link secret, populated once the encryption block below runs. Declared here because the
  // chat panel is created earlier in this function and derives its key lazily from whatever
  // these hold at the moment a message is sent or received.
  let watchLinkSecret = "";
  let watchSalt: string | undefined;

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

  // Live chat for viewers, when the broadcaster enabled it (right column on desktop,
  // bottom overlay on mobile). The WS is also gated server-side on chat_enabled.
  // Kept as open/close helpers so the settings poll below can react to the broadcaster
  // toggling chat mid-stream (mirrors the broadcaster's own openChat/closeChat).
  const watchChatPanel = document.getElementById("watch-chat") as HTMLElement | null;
  let watchChatHandle: ChatHandle | null = null;
  const openWatchChat = () => {
    if (!watchChatPanel || watchChatHandle) return;
    watchChatPanel.classList.remove("hidden");
    watchChatHandle = initChat({
      streamId,
      container: watchChatPanel,
      user,
      chatKey: () => deriveChatKey(watchLinkSecret, { streamId, salt: watchSalt }),
    });
  };
  const closeWatchChat = () => {
    watchChatHandle?.destroy();
    watchChatHandle = null;
    watchChatPanel?.classList.add("hidden");
  };
  if (settings.chat_enabled) openWatchChat();

  // Set stream name on watcher (headless <moq-watch> core element)
  const watcher = document.querySelector("moq-watch") as MoqWatchElement | null;
  if (watcher) {
    // --- TEMP timing probe: localize viewer join latency by phase ---
    const t0 = performance.now();
    const ms = () => `${Math.round(performance.now() - t0)}ms`;
    // Strongest "we're actually playing" signal — the Mode-C fallback watchdog reads it.
    let gotFirstFrame = false;
    const wDiag = watcher as unknown as {
      connection?: { status?: { subscribe?: (fn: (s: string) => void) => void } };
      broadcast?: { catalog?: { subscribe?: (fn: (c: unknown) => void) => void } };
    };
    try {
      wDiag.connection?.status?.subscribe?.((s) => console.log(`[watch-timing] connection ${s} @ ${ms()}`));
      let gotCatalog = false;
      wDiag.broadcast?.catalog?.subscribe?.((c) => {
        if (c && !gotCatalog) { gotCatalog = true; console.log(`[watch-timing] catalog received @ ${ms()}`); }
      });
    } catch { /* ignore */ }

    // --- Time to first frame ---
    // The renderer draws decoded frames to the <canvas> 2D context via drawImage
    // (black background uses fillRect, so drawImage = a real video frame). Hook it
    // once to capture time-to-first-frame from page load and show it in the footer.
    const canvas = watcher.querySelector("canvas") as HTMLCanvasElement | null;
    const ctx = canvas?.getContext("2d");
    if (ctx) {
      const origDrawImage = ctx.drawImage as (...a: unknown[]) => unknown;
      (ctx as unknown as { drawImage: unknown }).drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
        const result = origDrawImage.apply(this, args);
        // First real frame: report, then restore the prototype method (no per-frame overhead).
        delete (ctx as unknown as { drawImage?: unknown }).drawImage;
        gotFirstFrame = true;
        const sinceLoad = performance.now(); // ms since page navigation start
        // Console only. This used to print into the footer beside the nav links, where it read
        // as a permanent status field on a page that is otherwise a player — the number is
        // diagnostic, and diagnostics do not belong in a viewer's chrome.
        console.log(`[watch-timing] FIRST FRAME painted @ ${ms()} (from page load: ${Math.round(sinceLoad)}ms)`);
        return result;
      };
    }

    // Co-locate on the publisher's relay: look up the broadcast→relay route.
    // Relays are islands, so the viewer MUST use the same relay as the broadcaster.
    // Falls back to the static relay if the stream isn't routed yet / lookup fails.
    const viewerCdn = getCdnOverride("viewer-cdn");
    // Optional forced cross-cluster origin (publisher relay host:port) for testing;
    // normally the Worker derives it from the publisher's stored relay in D1.
    const originOverride = new URLSearchParams(window.location.search).get("origin")?.trim() || undefined;
    if (viewerCdn) console.log("[routing] viewer CDN override:", viewerCdn, originOverride ? `(forced origin ${originOverride})` : "");

    // Resolve the relay via /route. There is NO static relay to fall back to — every
    // connection must use the dynamic host:port from the directory. If the broadcast
    // isn't live yet (404), poll until it is, showing a "waiting" state. Connect once.
    // After a failed enterprise (Mode C) attempt we reload with ?noEnterprise=1 so the
    // Worker skips Mode C and returns B/A — guaranteeing the viewer ends up watching.
    const noEnterprise = new URLSearchParams(window.location.search).get("noEnterprise") === "1";

    // Prove we hold the share link before asking for a token. Derived here, ahead of the
    // route call, because every /route request needs it — the first one, the offline polling
    // loop, and each token renewal. A viewer without a fragment simply has no tag and gets
    // "offline", which is the correct answer for someone who was never given the link.
    const routeTag = await (async () => {
      const secret = new URLSearchParams(location.hash.replace(/^#/, "")).get("k");
      return secret ? deriveRouteTag(secret, streamId) : undefined;
    })();

    let routeInfo = await getStreamRoute(streamId, viewerCdn, originOverride, { noEnterprise, routeTag });
    console.log(`[watch-timing] route resolved @ ${ms()} ->`, routeInfo?.relay ?? "(offline, polling)", routeInfo?.mode ? `(mode=${routeInfo.mode})` : "");

    if (!routeInfo) {
      const section = document.querySelector("#watch-view section");
      const waitingEl = document.createElement("div");
      waitingEl.className = "watch-waiting";
      waitingEl.textContent = "Waiting for broadcaster…";
      waitingEl.style.cssText = "text-align:center;padding:1.5rem;color:var(--text-muted);";
      section?.appendChild(waitingEl);

      let stopped = false;
      window.addEventListener("beforeunload", () => { stopped = true; });
      while (!routeInfo && !stopped) {
        await new Promise((r) => setTimeout(r, 1500));
        routeInfo = await getStreamRoute(streamId, viewerCdn, originOverride, { noEnterprise, routeTag });
      }
      waitingEl.remove();
      if (stopped) return;
      console.log(`[watch-timing] route became available @ ${ms()} ->`, routeInfo?.relay);
    }

    if (!routeInfo) return; // stopped before a route resolved
    // Relay-blind E2E: if the stream is encrypted, arm decryption and install the
    // content key BEFORE connecting. If the key was withheld (auth-gated stream,
    // viewer not signed in) we can't decrypt — surface the sign-in requirement.
    // The content key is per-broadcast and relay-independent, so it survives any
    // later relay change in the refresh loop without re-fetching.
    if (routeInfo.encrypted) {
      // The key comes from OUR OWN URL fragment, never from the server response. The Worker
      // has no content key to withhold or release, so this is not an access-control check —
      // possessing the complete link simply is the ability to decrypt.
      const frag = new URLSearchParams(location.hash.replace(/^#/, ""));
      const linkSecret = frag.get("k");
      watchLinkSecret = linkSecret ?? "";
      if (!linkSecret) {
        console.warn("[crypto] share link carries no #k= secret; the stream cannot be decrypted");
        showWatchKeyMissing();
        return;
      }
      // No passcode prompt. Wallflower asks here when the link carries `p=1`; this deployment
      // has no second secret, so the `#k=` fragment is the whole of the key material and the
      // stream decrypts (or does not) on the strength of the link alone.
      watchSalt = routeInfo.salt ?? undefined;
      armViewer();
      await deriveMediaKey(linkSecret, { streamId, salt: watchSalt });

      // Tell the viewer what protects what, where they form the expectation.
      const sec = document.querySelector("#watch-view section") as HTMLElement | null;
      if (sec) {
        if (!sec.style.position) sec.style.position = "relative";
        const overlay = document.createElement("div");
        overlay.className = "watch-badges";
        overlay.style.cssText =
          "position:absolute;top:10px;right:10px;z-index:5;display:flex;align-items:center;" +
          "gap:8px;background:rgba(0,0,0,0.6);border-radius:999px;padding:4px 10px;";
        const rb = createRelayBlindBadge();
        rb.style.border = "none";
        rb.style.padding = "0";
        overlay.append(rb);
        sec.appendChild(overlay);
      }
    }

    // Mounted outside the encryption branch: a viewer must be able to report a stream whether
    // or not decryption was set up. It creates its own pill if the badge above did not run.
    mountReportControl(streamId);

    // The connect SHAPE this stream actually used, captured so anything that rebuilds the
    // player can reproduce it. The two paths differ (moq.pro carries the broadcast in the URL
    // with an empty name; the fleet uses a name attribute), and swapInPlayer defaulted to the
    // moq.pro shape — so every watchdog rebuild on the fleet reconnected with an empty name,
    // subscribed to nothing, and quietly failed. Assigned in each branch below.
    let connectForm: { name: string; catalogFormat: string | null } = {
      name: streamName,
      catalogFormat: null,
    };
    if (routeInfo.mode === "enterprise") {
      // Mode C: an ASN match does NOT guarantee the user can actually reach the private
      // relay (VPN off-net, relay down…). Step 1 = /assign preflight to make it pull.
      console.log(`[route] played mode=enterprise relay=${routeInfo.relay} edge=${routeInfo.edgeHost ?? "?"}`);
      const connectUrl = await resolveEnterpriseConnectUrl(routeInfo);
      if (!connectUrl) {
        // Couldn't reach / provision the private relay — fall back to B/A right away.
        console.warn("[route] enterprise relay unreachable (/assign); falling back to B/A");
        forceBAFallback();
        return;
      }
      // Step 2: connect + subscribe. Watchdog still guards the case where /assign
      // succeeded but no frame ever paints (QUIC blocked, pull stalled…).
      setActiveRelay(routeInfo.relay);
      connectForm = { name: routeInfo.broadcast ?? streamName, catalogFormat: null };
      watcher.setAttribute("url", connectUrl);
      watcher.setAttribute("name", connectForm.name);
      window.setTimeout(() => {
        if (gotFirstFrame) return;
        console.warn("[route] enterprise connected but no frame; falling back to B/A");
        forceBAFallback();
      }, 6000);
    } else {
      // Modes A/B (unchanged): publisher origin relay, or a cross-cluster edge.
      // (Worker logs which of A/B; the player only sees a host:port here.)
      console.log(`[route] played mode=edge/origin relay=${routeInfo.relay}${noEnterprise ? " (enterprise fell back)" : ""}`);
      setActiveRelay(routeInfo.relay);
      if (routeInfo.path) {
        // moq.pro (Mode A): full connect URL + empty name + explicit hang catalog.
        connectForm = { name: "", catalogFormat: "hang" };
        watcher.setAttribute("catalog-format", "hang");
        watcher.setAttribute("name", "");
        watcher.setAttribute("url", moqUrl(routeInfo.relay, routeInfo.path, routeInfo.jwt ?? ""));
      } else {
        connectForm = { name: streamName, catalogFormat: null };
        watcher.setAttribute("url", `https://${routeInfo.relay}/?jwt=${routeInfo.jwt}`);
        watcher.setAttribute("name", streamName);
      }
      // Cross-cluster (viewer-cdn=): the relay above is an edge that pulls from the origin.
      // Show the confirmed origin<->edge transport (iroh/DHT vs QUIC host:port) as a stats line.
      if (viewerCdn) startOriginLinkProbe(routeInfo.relay, streamId);
    }
    console.log(`[watch-timing] url set, connecting @ ${ms()}`);

    // ── Viewer token renewal: REMOVED ───────────────────────────────────────────────────
    //
    // The viewer token is issued for its full lifetime and never renewed, so nothing here
    // reconnects and the player is never rebuilt on a timer.
    //
    // Renewal was what made termination enforceable against a client MODIFIED to ignore the
    // kill flag: no renewal, and the relay dropped it within one token lifetime. Modified
    // clients are not a supported case, so that bought nothing — while costing every viewer a
    // reconnect every 90 seconds. On Safari/iOS that reconnect rebuilt the AudioContext with
    // no user gesture behind it, so it came back suspended and the stream went silent.
    //
    // Measured on 2026-08-17 with scripts/e2e/audio-across-renewal.mjs, which is worth keeping
    // for the next person: the context's currentTime resets across a renewal (87.5 -> 1.9),
    // proving it is rebuilt, and it is rebuilt whether the player is swapped OR the url is
    // re-pointed. There was no version of renewal that left audio alone.
    //
    // Also removed with it: the tap-to-restore experiment. It worked — a tap does revive the
    // rebuilt context on iOS — but with no renewals there is nothing left to restore.
    //
    // Termination still works for every supported client: the settings poll sees `killed` and
    // stops within ~5s with the transport closed.

    let live = watcher;

    const isPainting = (el: Element): boolean => {
      const canvas = el.querySelector("canvas") as HTMLCanvasElement | null;
      if (!canvas || canvas.width < 64) return false;
      const probe = document.createElement("canvas");
      probe.width = 32;
      probe.height = 18;
      const cx = probe.getContext("2d", { willReadFrequently: true });
      if (!cx) return false;
      try { cx.drawImage(canvas, 0, 0, 32, 18); } catch { return false; }
      const d = cx.getImageData(0, 0, 32, 18).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
      return lit > (d.length / 4) * 0.05;
    };

    // Start muted; first click/tap on the player enables audio. Declared before the swap so a
    // replacement element can re-arm it — `live` changes identity, this handler must follow.
    const enableAudio = () => {
      live.muted = false;
      live.removeEventListener("click", enableAudio);
    };
    watcher.addEventListener("click", enableAudio);

    /**
     * `form` is the connect shape, and the two paths genuinely differ:
     *
     *   moq.pro — a full connect URL carrying the broadcast path, an EMPTY name, and an
     *             explicit `catalog-format=hang`.
     *   fleet   — `https://<relay>/?jwt=<token>` with the broadcast NAME as an attribute and
     *             no catalog-format override.
     *
     * This used to hardcode the moq.pro shape, which is why renewal refused to run anywhere
     * else: a swapped-in element would have connected with an empty name and subscribed to
     * nothing. Mirror whatever the initial connect above does, or the renewal silently
     * produces a black player instead of a fresh one.
     */
    /**
     * Is this element actually receiving media?
     *
     * Painting alone is the wrong test, and it is why the watchdog could never recover an
     * AUDIO-ONLY stream: isPainting() needs a lit canvas, an audio-only broadcast has no video
     * track to light one, so every rebuild was judged a failure and retried forever. Audio
     * bytes are the other half of the answer — a fresh element starts at zero, so anything
     * above it means media is flowing.
     */
    const isReceiving = (el: Element): boolean => {
      if (isPainting(el)) return true;
      const bytes = (el as unknown as {
        backend?: { audio?: { stats?: { peek?: () => { bytesReceived?: number } | undefined } } };
      })?.backend?.audio?.stats?.peek?.()?.bytesReceived;
      return typeof bytes === "number" && bytes > 0;
    };

    async function swapInPlayer(
      url: string,
      why: string,
      form: { name: string; catalogFormat: string | null } = connectForm
    ): Promise<boolean> {
      const parent = live.parentElement;
      if (!parent) return false;
      const started = performance.now();

      const next = document.createElement("moq-watch");
      next.setAttribute("muted", "");
      next.setAttribute("visible", "always");
      if (form.catalogFormat) next.setAttribute("catalog-format", form.catalogFormat);
      next.setAttribute("name", form.name);
      next.appendChild(document.createElement("canvas"));
      // Stacked underneath rather than hidden: display:none would give the element no layout,
      // and a canvas with no box does not decode.
      next.style.cssText = "position:absolute;inset:0;opacity:0;pointer-events:none;";
      if (!parent.style.position) parent.style.position = "relative";
      parent.appendChild(next);
      next.setAttribute("url", url);

      const deadline = performance.now() + 15000;
      while (performance.now() < deadline) {
        if (isReceiving(next)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!isReceiving(next)) {
        // Keep the old element: a frozen picture beats a black one, and the caller decides
        // whether to try again.
        console.warn(`[${why}] replacement never painted in ${(performance.now() - started).toFixed(0)}ms; keeping the old session`);
        next.remove();
        return false;
      }

      const old = live;
      const wasUnmuted = !old.muted;
      live = next as unknown as typeof watcher;
      next.style.cssText = "";
      // The audio enabler lived on the retired element; without re-arming it, a click after a
      // swap silently stops unmuting the stream.
      live.muted = !wasUnmuted;
      live.addEventListener("click", enableAudio);
      old.remove();
      console.log(`[${why}] swapped in a fresh player in ${(performance.now() - started).toFixed(0)}ms`);

      // The rebuild just created a new AudioContext with no user gesture behind it. On iOS
      // that context is suspended and the viewer has no way back — video returns, sound does
      // not, and tapping the player cannot help because muted is already false. Give it a
      // moment to exist, then offer the restore IF it really did come back suspended.
      //
      // Only when audio was on before the swap: someone watching muted has nothing to restore
      // and should not be shown a button about it.
      if (wasUnmuted) window.setTimeout(offerAudioRestore, 2000);
      return true;
    }

    /**
     * Give a viewer their audio back after the player has been rebuilt.
     *
     * WHY THIS EXISTS, from a measurement rather than a theory. When the stuck-player watchdog
     * recovers a stalled stream it builds a fresh <moq-watch>, and a fresh element builds a
     * fresh AudioContext. On iOS that context has no transient user gesture behind it, so it
     * starts SUSPENDED — captured on an iPhone as `audio suspended t=0.0` while video flowed
     * normally, t=0.0 being proof the context is new. Tapping the player does nothing there,
     * because enableAudio only sets muted=false and it is already false.
     *
     * A tap CAN revive such a context — confirmed on the device before this was made
     * permanent. So offer one, and only when it is genuinely needed.
     *
     * Deliberately kept OFF the initial-unmute path. Earlier attempts called resume() from the
     * ordinary player click and BROKE audio at start on Safari. This appears only once a
     * rebuild has actually left the context suspended, so the working path cannot be affected.
     *
     * It reports the transition it achieved, so a failure is legible rather than mysterious.
     */
    const audioCtxNow = (): AudioContext | undefined =>
      (live as unknown as {
        backend?: { audio?: { context?: { peek?: () => AudioContext | undefined } } };
      })?.backend?.audio?.context?.peek?.();

    let restoreBtn: HTMLButtonElement | null = null;

    const offerAudioRestore = () => {
      const ctx = audioCtxNow();
      if (!ctx || ctx.state === "running") return; // nothing to restore
      if (restoreBtn) return; // already offered

      const host = document.querySelector("#watch-view section") as HTMLElement | null;
      if (!host) return;
      if (!host.style.position) host.style.position = "relative";

      const btn = document.createElement("button");
      restoreBtn = btn;
      btn.type = "button";
      btn.textContent = `🔇 Tap to restore audio (${ctx.state})`;
      btn.style.cssText =
        "position:absolute;left:50%;bottom:16px;transform:translateX(-50%);z-index:20;" +
        "padding:0.7rem 1.3rem;border:0;border-radius:999px;background:#f59e0b;color:#0a0a0a;" +
        "font:inherit;font-weight:700;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,0.4);";

      btn.addEventListener("click", async (e) => {
        e.stopPropagation(); // do not also trigger enableAudio on the player beneath
        const c = audioCtxNow();
        if (!c) { btn.textContent = "no audio context"; return; }
        const before = c.state;
        try {
          await c.resume();
        } catch (err) {
          btn.textContent = `resume refused (${before} -> ${c.state})`;
          console.warn("[audio-restore] resume rejected", err);
          return;
        }
        // Report the honest outcome rather than assuming success.
        console.log(`[audio-restore] resume: ${before} -> ${c.state}`);
        if (c.state === "running") {
          btn.textContent = "✅ audio restored";
          window.setTimeout(() => { btn.remove(); restoreBtn = null; }, 1500);
        } else {
          btn.textContent = `still ${c.state} after resume`;
        }
      });

      host.appendChild(btn);
      console.log(`[audio-restore] offering restore; context is ${ctx.state}`);
    };

    // --- Bare mode: add ?bare=1 to the watch URL ---------------------------------------------
    //
    // Turns OFF every background loop this page runs, leaving nothing but connect-and-play.
    // It exists to answer one question that repeated fixes could not: is the stalling caused
    // by OUR JavaScript, or by the transport underneath it?
    //
    // Disabled in bare mode:
    //   • the stuck-player watchdog  — polls decrypt counters and REBUILDS the player, which
    //     is the loudest suspect: a false positive here would itself produce a stall, and the
    //     rebuild is what strands audio on iOS
    //   • the viewing-session heartbeat — a fetch every 30s
    //   • the settings poll — a fetch every 5s, which also carries kill detection
    //
    // Consequences worth knowing while testing: a killed stream will NOT stop for this viewer,
    // the audience count will not include them, and a genuinely dead decoder will not recover
    // on its own. That is the point — it is a diagnostic, not a mode to ship anyone into.
    const BARE = new URLSearchParams(location.search).get("bare") === "1";
    if (BARE) console.warn("[bare] all background loops disabled: no watchdog, no heartbeat, no settings poll");

    // --- On-device diagnostics: add ?diag=1 to the watch URL ---------------------------------
    //
    // Exists because a freeze reproduces on an iPhone and NOT in the headless harness. Seven
    // minutes of scripts/e2e/audio-across-renewal.mjs against the same stream showed continuous
    // flow — context running, currentTime and byte counters climbing, one element, no rebuild —
    // so whatever stops on the device is invisible from here. The device has to report it.
    //
    // Deliberately opt-in by query parameter: no ordinary viewer sees this, and it reads state
    // without touching any of it. Everything shown is already in the page; nothing is sent
    // anywhere, which matters on a product whose whole claim is that we cannot see your stream.
    //
    // What to look for when it freezes: WHICH counter stops first is the diagnosis.
    //   bytes stop      -> nothing is arriving; publisher, relay, or the OS suspended the socket
    //   bytes climb but
    //     ok stops      -> arriving but not decrypting; a key or salt problem
    //   ok climbs but
    //     painted stops -> decrypting but not rendering; the decoder died
    //   ctxTime stops   -> the AudioContext itself was suspended, typically by iOS
    if (new URLSearchParams(location.search).get("diag") === "1") {
      const panel = document.createElement("div");
      panel.style.cssText =
        "position:fixed;left:6px;bottom:6px;z-index:9999;max-width:96vw;padding:7px 9px;" +
        "background:rgba(0,0,0,0.82);color:#0f0;font:11px/1.45 ui-monospace,Menlo,monospace;" +
        "border-radius:6px;white-space:pre;pointer-events:none;";
      document.body.appendChild(panel);

      const t0 = performance.now();
      let lastBytes = -1;
      let lastVBytes = -1;
      let lastOk = -1;
      let stalledFor = 0;
      let lastAudioMove = 0;
      let lastVideoMove = 0;
      let lastDecMove = 0;
      // Which transport the page ACTUALLY chose. iOS Safari has no WebTransport and falls back
      // to the WebSocket polyfill; every clean headless run used native WebTransport, so this
      // is the single most important line for telling those two worlds apart.
      const TRANSPORT = needsPolyfill ? "TRANSPORT=websocket-polyfill" : "TRANSPORT=native-webtransport";

      const tick = () => {
        const el = live as unknown as {
          backend?: {
            audio?: {
              context?: { peek?: () => AudioContext | undefined };
              stats?: { peek?: () => { bytesReceived?: number } | undefined };
              buffered?: { peek?: () => unknown };
            };
            video?: {
              stats?: { peek?: () => { bytesReceived?: number } | undefined };
              stalled?: { peek?: () => boolean };
              timestamp?: { peek?: () => number };
            };
          };
          connection?: { established?: { peek?: () => unknown }; url?: { peek?: () => URL | undefined } };
          broadcast?: { status?: { peek?: () => string }; active?: { peek?: () => unknown } };
        };
        const a = el?.backend?.audio;
        const v = el?.backend?.video;
        const ctx = a?.context?.peek?.();
        const bytes = a?.stats?.peek?.()?.bytesReceived ?? -1;
        // VIDEO bytes separately from audio. If both stop together the connection died; if
        // only one stops it is that track's pipeline, which is a completely different fault.
        const vbytes = v?.stats?.peek?.()?.bytesReceived ?? -1;
        const vstalled = v?.stalled?.peek?.() ?? null;
        const vts = v?.timestamp?.peek?.() ?? null;
        // Is the CONNECTION still up? A live socket with no bytes means the relay stopped
        // sending; a dead one means the transport dropped and nothing re-established it.
        const conn = el?.connection?.established?.peek?.() ? "up" : "DOWN";
        const bstatus = el?.broadcast?.status?.peek?.() ?? "?";
        const bactive = el?.broadcast?.active?.peek?.() ? "yes" : "no";
        const { successes, failures } = decryptStats();
        const canvas = live.querySelector("canvas") as HTMLCanvasElement | null;

        // "Stalled" here means the two counters that should never stop both stopped. Reported
        // in seconds so the freeze can be timed against whatever else was happening.
        // Order matters, and getting it wrong made this panel lie: the "moved Ns ago" fields
        // below compare against lastBytes/lastOk, so those must NOT be overwritten until the
        // comparison has happened. A first version assigned them here and every audio/decrypt
        // field then reported the full session length, which is exactly the sort of confident
        // wrong number that sends an investigation down a blind alley.
        const nowSec = (performance.now() - t0) / 1000;
        if (bytes !== lastBytes) lastAudioMove = nowSec;
        if (successes !== lastOk) lastDecMove = nowSec;
        if (vbytes !== lastVBytes) lastVideoMove = nowSec;

        const frozen = bytes === lastBytes && successes === lastOk;
        stalledFor = frozen ? stalledFor + 1 : 0;
        lastBytes = bytes;
        lastOk = successes;
        lastVBytes = vbytes;

        const nowS = nowSec;
        const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;

        // The QUIC session itself, from src/wt-probe.ts. `conn` above is the hang element's
        // belief and cannot go false; these two CAN, which is the point of showing them.
        //
        //   closed=...     the session really did die, with a code and reason. Read this first.
        //   streams        MoQ sends each media group on a fresh server-opened uni stream. If
        //                  this freezes with the session still open, delivery stopped without
        //                  anyone reporting an error — and a halt on a round number (64/100/128)
        //                  points at MAX_STREAMS_UNI credit rather than at the relay.
        const quicClosed = wtProbe.closedHow;
        const uniAgo = wtProbe.lastUniAt ? (performance.now() - wtProbe.lastUniAt) / 1000 : -1;
        // Streams per second says whether an ?aframe= change actually reached the wire: ~50/s is
        // 20ms Opus frames, ~17/s is 60ms.
        //
        // It MUST be measured over the span in which streams were actually arriving, not over
        // uptime. Dividing by uptime looks right and silently lies once the stream stalls: a run
        // that delivered 6489 streams in 131s and then sat dead for 358s reported "13.3/s",
        // which reads exactly like 60ms frames working when the true rate was 49.5/s and the
        // setting had not been applied at all. A wrong number that resembles the number you are
        // hoping for is worse than no number.
        const uniSpan = wtProbe.lastUniAt ? (wtProbe.lastUniAt - t0) / 1000 : 0;
        const uniRate = uniSpan > 0.5 ? wtProbe.uni / uniSpan : 0;
        const quicLine = wtProbe.installed
          ? `quic    streams=${wtProbe.uni} (${uniRate.toFixed(1)}/s over ${uniSpan.toFixed(0)}s)\n` +
            `        ${uniAgo >= 0 ? `last ${uniAgo.toFixed(0)}s ago` : "none yet"}  sess=${wtProbe.constructed}` +
            (wtProbe.anticipated > 0 ? `  wtmax=${wtProbe.anticipated}` : "") +
            `\nclosed  ${quicClosed ?? "no — session still open"}\n`
          : "";

        panel.style.color = stalledFor >= 3 ? "#f87171" : "#4ade80";
        panel.textContent =
          `up ${nowS.toFixed(0)}s   ${stalledFor >= 3 ? `STALLED ${stalledFor}s` : "flowing"}\n` +
          `conn    ${conn}  bcast=${bstatus}/${bactive}  ${TRANSPORT}\n` +
          quicLine +
          `audio B ${bytes}  (moved ${(nowS - lastAudioMove).toFixed(0)}s ago)\n` +
          `video B ${vbytes}  (moved ${(nowS - lastVideoMove).toFixed(0)}s ago)  stalled=${vstalled}\n` +
          `decrypt ok ${successes} fail ${failures}  (moved ${(nowS - lastDecMove).toFixed(0)}s ago)\n` +
          `vts     ${vts === null ? "?" : Math.round(vts as number)}\n` +
          `canvas  ${canvas ? `${canvas.width}x${canvas.height}` : "none"}\n` +
          `actx    ${ctx ? `${ctx.state} t=${ctx.currentTime.toFixed(1)}` : "none"}  muted=${live.muted}\n` +
          `page    ${document.visibilityState}` +
          (mem ? `  heap ${(mem.usedJSHeapSize / 1048576).toFixed(0)}MB` : "");
      };

      tick();
      const diagTimer = window.setInterval(tick, 1000);
      window.addEventListener("beforeunload", () => window.clearInterval(diagTimer));
    }

    // --- Player rebuild before the stream ceiling --------------------------------------------
    //
    // WebKit stops delivering after ~6500-7600 cumulative incoming unidirectional streams on one
    // WebTransport session. Rebuilding the player opens a NEW session with a fresh budget, so
    // rebuilding before the ceiling means never reaching it. Free in bandwidth terms.
    //
    // It costs the viewer a TAP. A new element builds a new AudioContext, and on iOS that
    // context has no user gesture behind it so it starts suspended. Video returns, sound does
    // not, and tapping the player cannot fix it because `muted` is already false —
    // offerAudioRestore() below puts up a dedicated button whose own click calls resume(). So
    // every rebuild is an interruption, and the goal is the FEWEST that still avoid a stall.
    //
    // COUNTED, NOT TIMED, because the budget is spent per stream and streams do not arrive at a
    // fixed rate. One clock cannot serve every stream: 20ms audio burns the budget in ~135s,
    // ?aframe=60 takes ~450s, and a video-only stream at ~0.5 streams/s would take hours. A
    // timer set safely for the first interrupts the third for no reason, and this is exactly how
    // the previous version broke — 360s was chosen when audio batching made the headroom ~10
    // minutes, batching was then reverted, and the timer was left behind, firing a full four
    // minutes AFTER the stream it was supposed to protect had already died.
    //
    // Do NOT "improve" this back into a timer.
    //
    // NOT a page reload. The element is swapped in the DOM and all page state survives: the
    // derived content key, the salt, the viewing session, and on Wallflower the passcode. A
    // viewer is never asked to re-enter anything.
    //
    // ON BY DEFAULT, but only on WebKit, because only WebKit has the ceiling. Gating on iOS
    // would be the obvious choice and the wrong one: macOS Safari runs the same WebTransport
    // implementation, and every clean desktop run in this investigation was Chrome — so Safari
    // on a Mac is untested and most likely affected. Chrome and Firefox get nothing, and pay
    // nothing.
    //
    // NOT in bare mode. A rebuild is a new WebTransport session with a fresh stream budget, so
    // leaving this on would reset the very counter ?bare=1 exists to measure.
    // Sized on the LOW end of the measured ceiling, not the average. The four unbatched runs
    // stalled between 6489 and 7596 incoming streams; 5500 sits 15% under the worst of them.
    // Overshooting costs a dead stream and a confused viewer, undershooting costs one extra tap,
    // so the asymmetry decides it.
    const STREAM_BUDGET = 5500;

    const refreshParam = new URLSearchParams(location.search).get("refresh");
    const refreshEvery = Number(refreshParam);
    const useTimer = refreshParam !== null && Number.isFinite(refreshEvery) && refreshEvery > 0;
    // ?refresh=0 turns everything off; a positive value forces the old fixed timer for testing.
    const useBudget = refreshParam === null && isSafari;

    let rebuilding = false;
    const rebuild = async (why: string): Promise<boolean> => {
      // setInterval does not await, so without this a slow rebuild would be re-entered by the
      // next tick and swap the player twice.
      if (rebuilding) return false;
      rebuilding = true;
      try {
        const url = live.getAttribute("url");
        if (!url) return false;
        const ok = await swapInPlayer(url, why);
        console.log(`[refresh] rebuild ${ok ? "succeeded" : "FAILED (kept the old player)"}`);
        return ok;
      } finally {
        rebuilding = false;
      }
    };

    if (!BARE && useBudget) {
      console.log(`[refresh] rebuilding after ${STREAM_BUDGET} incoming streams`);
      // wtProbe.uni is cumulative across sessions, so measure a DELTA from the last rebuild —
      // an absolute compare would fire forever once the total passed the budget.
      let base = wtProbe.uni;
      const budgetTimer = window.setInterval(async () => {
        const used = wtProbe.uni - base;
        if (used < STREAM_BUDGET) return;
        console.log(`[refresh] ${used} streams used — rebuilding before the ceiling`);
        if (await rebuild("stream budget")) base = wtProbe.uni;
      }, 2000);
      window.addEventListener("beforeunload", () => window.clearInterval(budgetTimer));
    } else if (!BARE && useTimer) {
      console.log(`[refresh] rebuilding the player every ${refreshEvery}s (fixed timer)`);
      const refreshTimer = window.setInterval(() => void rebuild("refresh"), refreshEvery * 1000);
      window.addEventListener("beforeunload", () => window.clearInterval(refreshTimer));
    }

    // --- Stuck-player watchdog --------------------------------------------------------------
    //
    // A viewer had no way back from either failure this page can produce, and both end in the
    // same silent black rectangle, so neither could be told from a stream that simply stopped:
    //
    //   Wrong key. The broadcaster cycled the passcode; frames arrive and none authenticate.
    //   Recoverable without touching the connection — ask for the new passcode and re-derive.
    //
    //   Dead decoder. Frames decrypt but nothing paints, because a WebCodecs decoder that was
    //   handed deltas without a keyframe has errored and stays closed. Nothing short of a new
    //   element recovers it (see swapInPlayer), which is why "just wait" never worked.
    //
    // Decrypt counters separate the two: it is the SUCCESS delta that says whether we hold the
    // right key, and painting that says whether the decoder survived. Failures alone cannot
    // distinguish them, which is what made the old check blame the viewer's passcode for a
    // decoder that had died holding a perfectly good one.
    let lastStats = decryptStats();
    let blankPolls = 0;
    let recovering = false;
    // Latched, so a link that cannot decrypt says so ONCE rather than rebuilding the overlay
    // every poll for as long as the tab is open.
    let keyMismatchReported = false;

    const watchdog = window.setInterval(async () => {
      if (BARE) return;
      if (recovering) return;
      const now = decryptStats();
      const gotFrames = now.successes - lastStats.successes;
      const failed = now.failures - lastStats.failures;
      lastStats = now;
      const painting = isPainting(live);

      // Nothing arriving at all: the broadcast may have paused or ended. Not our business —
      // the settings poll owns "terminated" and the route poll owns "offline".
      if (gotFrames === 0 && failed === 0) { blankPolls = 0; return; }

      // Frames are arriving and every one is failing authentication: the key we derived does
      // not match the key they were encrypted with.
      //
      // Wallflower re-prompts for the passcode here, because that was the input a viewer could
      // fix. Nothing here is fixable by asking — the key comes from the link, and a link that
      // does not decrypt is the wrong link or a stale one. The remaining honest cause is a
      // salt rotation we have not picked up yet, so re-derive once from the CURRENT route
      // before concluding anything; only if that still fails do we say so.
      if (gotFrames === 0 && failed > 0) {
        recovering = true;
        try {
          const fresh = await getStreamRoute(streamId, viewerCdn, originOverride, { noEnterprise, routeTag });
          const freshSalt = fresh?.salt ?? undefined;
          if (fresh && freshSalt !== watchSalt) {
            // The broadcaster re-keyed. Pick up the new salt and carry on without bothering
            // the viewer, which is the whole point of the salt riding on /route.
            watchSalt = freshSalt;
            await deriveMediaKey(watchLinkSecret, { streamId, salt: watchSalt });
            blankPolls = 0;
          } else if (!keyMismatchReported) {
            // Same salt, still nothing decrypts. This link cannot play this stream, and
            // saying "still loading" forever would be the dishonest answer.
            keyMismatchReported = true;
            showWatchKeyMissing();
          }
        } finally {
          recovering = false;
          lastStats = decryptStats();
        }
        return;
      }

      if (painting) { blankPolls = 0; return; }

      // Decrypting but not painting. Give it a few ticks — a viewer that joined mid-group is
      // legitimately blank until the next keyframe — then rebuild the player.
      if (++blankPolls < 4) return;
      blankPolls = 0;
      recovering = true;
      try {
        const url = live.getAttribute("url");
        if (url) await swapInPlayer(url, "watchdog");
      } finally {
        recovering = false;
        lastStats = decryptStats();
      }
    }, 2000);
    window.addEventListener("beforeunload", () => window.clearInterval(watchdog));

    // --- Viewing session ------------------------------------------------------------------
    //
    // A measured session, not a page-load ping. The old version opened a row and closed it
    // from beforeunload alone, which does not fire on iOS backgrounding, a crash, a dead
    // network or force-quit — so rows leaked and the viewer count only ever went up.
    //
    // Three parts keep it honest: a heartbeat that proves we are still here, sendBeacon on
    // pagehide (the one page-close signal mobile Safari actually delivers), and a server-side
    // reaper for everything neither of those catches.
    let watchSession: WatchSession | null = null;
    let heartbeat: number | null = null;

    const stopHeartbeat = () => {
      if (heartbeat !== null) window.clearInterval(heartbeat);
      heartbeat = null;
    };

    const startSession = async () => {
      if (watchSession) return;
      // routeTag is the proof we hold the share link; without it the Worker will not open a
      // session, which is what stops audience being manufactured for a guessed stream id.
      watchSession = await logWatchStart(streamId, routeTag);
      if (!watchSession) return;
      stopHeartbeat();
      heartbeat = window.setInterval(async () => {
        if (BARE) return;
        if (!watchSession) return;
        if (await logWatchHeartbeat(watchSession)) return;
        // The server has forgotten this session — the tab was suspended long enough to be
        // reaped. Start a fresh one rather than beat against a closed row: the viewer really
        // did stop watching for that gap, and stitching over it would over-report.
        watchSession = null;
        stopHeartbeat();
        void startSession();
      }, watchSession.heartbeatSeconds * 1000);
    };

    const endSession = () => {
      stopHeartbeat();
      if (!watchSession) return;
      logWatchEnd(watchSession);
      watchSession = null;
    };

    void startSession();

    // pagehide is the reliable one — mobile Safari fires it on background/close where
    // beforeunload is simply never delivered. beforeunload stays as a desktop belt-and-braces;
    // end is idempotent, so both firing costs nothing.
    window.addEventListener("pagehide", endSession);
    window.addEventListener("beforeunload", endSession);

    // Deliberately NOT ending on visibilitychange: switching apps for a moment is not leaving.
    // A hidden tab keeps beating (browsers throttle to ~1/min, still inside the reaper's
    // window); if the OS suspends it outright the reaper closes the session at its last
    // heartbeat, and coming back opens a new one through the handler above.

    // Create HTML overlay display div. It sits as a full-width block BELOW the video/chat
    // row (its CSS is width:100%/max-width:900px/margin:auto). It must stay a direct child
    // of #watch-view, NOT inside the flex .video-chat-layout row — flex would override the
    // width and park it beside the video — so insert it right after the layout row.
    const watchView = document.querySelector("#watch-view");
    const watchLayout = watchView?.querySelector(".video-chat-layout");
    let overlayDiv = document.querySelector(".viewer-html-overlay") as HTMLDivElement;
    if (!overlayDiv && watchView && watchLayout) {
      overlayDiv = document.createElement("div");
      overlayDiv.className = "viewer-html-overlay";
      watchLayout.after(overlayDiv);
    }

    // Render the broadcaster's overlay, SANITISED. The policy and the reasoning behind every
    // rule in it live in src/overlay-sanitize.ts; the broadcaster's editor previews through
    // the same function, so what they see there is what lands here.
    const updateOverlay = (overlayHtml: string) => {
      if (!overlayDiv) return;
      overlayDiv.innerHTML = overlayHtml.trim() ? renderOverlay(overlayHtml).html : "";
    };

    // Load initial overlay content
    if (settings.overlay_html) {
      updateOverlay(settings.overlay_html);
    }

    // Poll for setting changes (auth and overlay)
    const settingsCheckInterval = setInterval(async () => {
      if (BARE) return;
      const currentSettings = await getStreamSettings(streamId);

      // Terminated: checked first, because nothing below it matters afterwards.
      if (currentSettings.killed) {
        clearInterval(settingsCheckInterval);
        endSession();
        closeWatchChat();
        stopForKill("viewer");
        return;
      }

      // Check auth requirement (anonymous viewers only)
      if (!user && currentSettings.require_auth) {
        clearInterval(settingsCheckInterval);
        endSession();
        showWatchLoginRequired();
        return;
      }

      // Update overlay content
      updateOverlay(currentSettings.overlay_html);

      // React to the broadcaster toggling live chat on/off mid-stream.
      if (currentSettings.chat_enabled) openWatchChat();
      else closeWatchChat();
    }, 5000); // Check every 5 seconds

    // Cleanup interval on page unload
    window.addEventListener("beforeunload", () => {
      clearInterval(settingsCheckInterval);
    });
  }
}


// Initialize the app
// TEMP diagnostic: time WebTransport bidi-stream creation. If a stream takes
// ~15s to OPEN after being requested, the stall is QUIC stream-credit/flow-control
// (relay grants MAX_STREAMS slowly) — NOT client logic. If "called" itself is late,
// it's client-side. Distinguishes the two for the ~15s subscribe gaps.
function instrumentWebTransportStreams() {
  if (typeof WebTransport === "undefined") return;
  const proto = WebTransport.prototype as unknown as {
    __streamTimed?: boolean;
    createBidirectionalStream: (...args: unknown[]) => Promise<unknown>;
  };
  if (proto.__streamTimed) return;
  proto.__streamTimed = true;
  const orig = proto.createBidirectionalStream;
  let n = 0;
  proto.createBidirectionalStream = function (this: unknown, ...args: unknown[]) {
    const i = ++n;
    if (i > 8) return orig.apply(this, args);
    const t = performance.now();
    console.log(`[wt-stream] #${i} createBidirectionalStream() called @ ${Math.round(t)}ms`);
    const p = orig.apply(this, args);
    Promise.resolve(p).then(
      () => console.log(`[wt-stream] #${i} OPENED after ${Math.round(performance.now() - t)}ms`),
      (e: unknown) => console.log(`[wt-stream] #${i} failed after ${Math.round(performance.now() - t)}ms`, e)
    );
    return p;
  };
}

// TEMP diagnostic: prefix every console line with a wall-clock timestamp
// (HH:MM:SS.mmm) so the @moq MoQ request logs (connected, negotiated ALPN,
// announced, subscribe start/ok catalog.json + video/hd, received catalog,
// sync[video]) can be correlated directly against the relay's server-side timeline.
function timestampConsole() {
  const w = window as unknown as { __consoleTimestamped?: boolean };
  if (w.__consoleTimestamped) return;
  w.__consoleTimestamped = true;
  (["debug", "log", "info", "warn", "error"] as const).forEach((m) => {
    const orig = console[m].bind(console);
    console[m] = (...args: unknown[]) => orig(`[${new Date().toISOString().slice(11, 23)}]`, ...args);
  });
}

// How many 20ms Opus frames share one MoQ group, and therefore one QUIC unidirectional stream.
//
// OFF (1) pending investigation. Turned on at 5 and measured worse where it matters.
//
// The reasoning was sound for AUDIO-ONLY streams: 5 frames per group is ~10 streams/sec instead
// of ~50, and the iOS stream-count ceiling (~6500-7600, replicated four times at two rates) then
// arrives after ~10 minutes instead of 2.5. That much still holds.
//
// It does not survive contact with video. Two iPhone runs of camera+audio at agroup=5 stalled
// after 46s (484 streams) and 66s (690 streams), against ~147s and 7188 streams for the same
// content unbatched — an order of magnitude fewer streams and it failed THREE TIMES SOONER.
// Nothing was constant between those two runs either: not streams, not bytes, not frame count,
// where the audio-only ceiling had been stable to within 15%. Chrome consumed the identical
// stream for 202s without a hiccup, so the publisher is producing correct groups.
//
// So there are two distinct failures and the evidence for batching came entirely from the
// audio-only one. Do not re-enable this default without a video run that beats the unbatched
// ~147s baseline. `?agroup=N` still forces it on for experiments.
const AUDIO_FRAMES_PER_GROUP = 1;

async function init() {
  timestampConsole();
  instrumentWebTransportStreams();

  // Set before any frame is encoded. Publisher-side only in effect (viewers never call
  // writeFrame), so it is safe to apply unconditionally.
  const agroupRaw = new URLSearchParams(location.search).get("agroup");
  const agroup = Number(agroupRaw ?? AUDIO_FRAMES_PER_GROUP);
  const agroupApplied =
    Number.isFinite(agroup) && agroup >= 1 ? Math.floor(agroup) : AUDIO_FRAMES_PER_GROUP;
  (globalThis as unknown as { __VIVOH_AUDIO_GROUP__?: number }).__VIVOH_AUDIO_GROUP__ = agroupApplied;
  // Say so, out loud. A silent knob is a knob that gets tested without being on: a run at
  // ?agroup=5 that quietly batched 1 frame per group looks exactly like "batching does not
  // work", and the only place the truth showed up was the viewer's stream RATE on a different
  // device. Announce whenever it differs from the built-in default, and warn on a value that
  // was supplied but rejected rather than silently falling back.
  if (agroupRaw !== null && !(Number.isFinite(agroup) && agroup >= 1)) {
    console.warn(`[agroup] ignoring ?agroup=${agroupRaw} — want an integer >= 1; using ${agroupApplied}`);
  } else if (agroupApplied !== 1) {
    console.log(`[agroup] audio batching ON: ${agroupApplied} frames per group (~${(50 / agroupApplied).toFixed(0)} QUIC streams/s)`);
  }
  // Wrap WebTransport before anything connects, so the ?diag=1 panel can report the QUIC
  // session itself rather than the hang element's opinion of it. @moq resolves
  // `new WebTransport(...)` off the global at call time (net/connection/connect.js), and the
  // first connection happens well after this, so installing here is early enough. Gated
  // inside installWtProbe's caller rather than the module so a normal viewer runs untouched
  // code in the media path.
  //
  // ?wtmax=<n> additionally asks for a bigger initial unidirectional stream budget — the one
  // lever JS has over the ~7200-stream ceiling. See src/wt-probe.ts for why it might work and
  // why it might not. It implies the probe, since there is no point setting it blind.
  const params = new URLSearchParams(location.search);
  const wtmax = Number(params.get("wtmax") ?? 0);
  // Installed for EVERY viewer, not just ?diag=1, because the stream count is no longer only a
  // diagnostic: the watch page rebuilds the player on it (see STREAM_BUDGET). A clock cannot do
  // that job — the budget is spent per STREAM, so the same 360s timer is far too late for 20ms
  // audio (~50/s, gone in ~135s) and far too eager for a video-only stream (~0.5/s, which would
  // take hours). Counting is the only thing that adapts to what the stream actually sends.
  installWtProbe(Number.isFinite(wtmax) && wtmax > 0 ? wtmax : 0);
  // Detect browser support (async for codec checks)
  browserSupport = await detectBrowserSupport();

  // For Safari/polyfill mode, select the best relay server based on latency
  if (needsPolyfill) {
    // Safari/polyfill path is disabled (tinymoq is WebTransport-only); kept for the
    // serverStatus side effect only. No static relay URL is used anymore — relays and
    // per-broadcast tokens are resolved dynamically at go-live / watch time.
    await selectBestFallbackRelay();
  } else {
    // WebTransport mode - assume connected
    serverStatus.connected = true;
  }

  // Update status panels
  updateBrowserSupportPanel();
  updateServerStatusPanel();

  // Load hang components dynamically AFTER polyfill is installed
  await loadHangComponents();

  // Wallflower harvests ?pk= into localStorage here, before routing rewrites the URL. There
  // is no publish key to harvest in this deployment — admission is the session cookie.

  // Just back from an OAuth round trip? Go where they were actually trying to go.
  //
  // The callback can only redirect to the origin, because the share link's key is in the
  // fragment and no server ever sees it — so without this, a viewer who signed in because a
  // stream demanded it landed on the landing page and had to find their link again.
  //
  // Checked BEFORE routing, so the landing page never renders and there is no flash of the
  // wrong view. Returns true only when it is actually navigating away.
  if (consumeReturnTo()) return;

  const { view, streamId } = await getRouteInfo();

  // Get user first (needed for broadcast auth check)
  const { user, geo } = await getCurrentUser();
  updateAuthUI(user, geo);

  if (view === "landing") {
    initLandingView();
  } else if (view === "broadcast") {
    initBroadcastView(streamId, user);
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

  // "How it works" toggle. Moved out of the landing page into the footer so it is reachable
  // while broadcasting or watching — which is when someone actually wonders what protects what.
  const howLink = document.getElementById("howitworks-link");
  const howPanel = document.getElementById("howitworks-panel");
  if (howLink && howPanel) {
    howLink.addEventListener("click", (e) => {
      e.preventDefault();
      const open = !howPanel.classList.toggle("hidden");
      // Browser Support now opens from inside this panel, so closing it would otherwise leave
      // the support box stranded below with nothing on screen to close it again.
      if (!open) supportPanel?.classList.add("hidden");
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
