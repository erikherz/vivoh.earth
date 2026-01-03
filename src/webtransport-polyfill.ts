// Patched WebTransport polyfill that handles requireUnreliable gracefully
// The original polyfill throws when requireUnreliable is true, but we want to
// just warn and continue since MoQ can work without datagrams (streams only)

import WebTransportWs from "@moq/web-transport-ws";

// Create a wrapper that intercepts the constructor to handle requireUnreliable
function createPatchedWebTransport() {
  return function PatchedWebTransport(url: string | URL, options?: WebTransportOptions) {
    // Remove requireUnreliable from options to avoid the throw
    const patchedOptions = options ? { ...options } : undefined;
    if (patchedOptions?.requireUnreliable) {
      console.warn("WebSocket polyfill: requireUnreliable is not supported, continuing without unreliable transport");
      delete (patchedOptions as Record<string, unknown>).requireUnreliable;
    }
    // Call the original constructor
    return new WebTransportWs(url, patchedOptions);
  };
}

// Install the patched polyfill
// Use force=true to override native WebTransport (e.g., for Safari compatibility issues)
export function install(force = false): boolean {
  if (!force && "WebTransport" in globalThis) {
    return false;
  }
  // biome-ignore lint/suspicious/noExplicitAny: polyfill
  (globalThis as any).WebTransport = createPatchedWebTransport();
  return true;
}
