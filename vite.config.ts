import { defineConfig, type Plugin } from "vite";

// Force the MoQ stack to use WebTransport ONLY (no WebSocket, no race).
//
// @moq/net's connect() races a WebSocket fallback against WebTransport by
// default (500ms head start, Promise.any). tinymoq has no WebSocket endpoint
// (the relay is built without it), so the wss:// leg always fails and only adds
// latency + console noise. The web components expose no option to disable it, so
// we patch the dependency at build time: flip the WS gate from opt-out
// (`enabled !== false`) to opt-in (`enabled === true`). Since nothing enables
// WebSocket, connect() then only ever attempts WebTransport — no fallback, no race.
//
// Note: this drops the WS fallback for browsers without native WebTransport
// (old Safari, Firefox) — but those can't talk to tinymoq anyway (WT-only relay).
function moqWebTransportOnly(): Plugin {
  const WS_GATE = "props?.websocket?.enabled !== false";
  let patched = 0;
  return {
    name: "moq-webtransport-only",
    enforce: "pre",
    transform(code, id) {
      // Match @moq/net's connection/connect.js across all (possibly nested) copies.
      if (id.includes("@moq") && code.includes("connectWebSocket") && code.includes(WS_GATE)) {
        patched++;
        return { code: code.replace(WS_GATE, "props?.websocket?.enabled === true"), map: null };
      }
      return null;
    },
    buildEnd() {
      if (patched === 0) {
        this.warn(
          "moq-webtransport-only: did not patch any @moq/net connect.js — the WS gate string may have changed upstream; WebSocket race may still be active."
        );
      } else {
        // eslint-disable-next-line no-console
        console.log(`moq-webtransport-only: patched ${patched} @moq/net connect module(s) to WebTransport-only`);
      }
    },
  };
}

export default defineConfig({
  plugins: [moqWebTransportOnly()],
  build: {
    outDir: "dist",
    emptyDirBeforeWrite: true,
  },
  server: {
    port: 3000,
  },
});
