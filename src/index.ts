import { DurableObject } from "cloudflare:workers";

/**
 * Environment Interface
 * VIVOH_STREAM_KEY should be set via 'npx wrangler secret put'
 */
export interface Env {
  SESSIONS: DurableObjectNamespace;
  VIVOH_STREAM_KEY: string;
}

/**
 * RTSPSession Durable Object
 * Manages the state of a single RTSP-over-QUIC stream session.
 */
export class RTSPSession extends DurableObject {
  constructor(public ctx: DurableObjectState, public env: Env) {
    super(ctx, env);
  }

  // Helper to wrap responses with Vivoh branding
  private brandedResponse(body: string, init?: ResponseInit) {
    const headers = new Headers(init?.headers);
    headers.set("Server", "Vivoh-RTSP-3.0-Engine");
    headers.set("X-Vivoh-Version", "3.0.0-Reboot");
    
    return new Response(body, {
      ...init,
      headers
    });
  }

  async fetch(request: Request) {
    const url = new URL(request.url);

    // --- 1. SETUP: Camera pushes the SDP (Secure) ---
    if (request.method === "POST" && url.pathname === "/setup") {
      const authKey = request.headers.get("X-Vivoh-Key");

      if (!authKey || authKey !== this.env.VIVOH_STREAM_KEY) {
        return this.brandedResponse("Unauthorized: Invalid Stream Key", { status: 401 });
      }

      const sdpText = await request.text();
      const timestamp = new Date().toISOString();

      // Persist to SQLite-backed storage
      await this.ctx.storage.put("current_sdp", sdpText);
      await this.ctx.storage.put("last_updated", timestamp);

      return this.brandedResponse(`Vivoh 2.0: SDP Setup Successful at ${timestamp}`, { status: 200 });
    }

    // --- 2. DESCRIBE: Publicly accessible SDP ---
    if (url.pathname === "/describe") {
      const sdp = await this.ctx.storage.get<string>("current_sdp");
      const lastUpdated = await this.ctx.storage.get<string>("last_updated");

      if (!sdp) {
        return this.brandedResponse("v=0\ns=No Stream Active", {
          headers: { "Content-Type": "application/sdp" }
        });
      }

      // Append custom metadata to the SDP block
      const enrichedSDP = `${sdp}\na=x-vivoh-updated:${lastUpdated}\na=x-vivoh-server:Vivoh-RTSP-3.0`;

      return this.brandedResponse(enrichedSDP, {
        headers: { "Content-Type": "application/sdp" }
      });
    }

    // --- 3. ROOT: Health Check ---
    return this.brandedResponse("Vivoh.Earth RTSP 3.0 Engine is Online");
  }
}

/**
 * Main Worker Entry Point
 */
export default {
  async fetch(request: Request, env: Env) {
    // Routes all traffic to a single 'global-stream' Durable Object instance
    const id = env.SESSIONS.idFromName("global-stream");
    const stub = env.SESSIONS.get(id);

    return stub.fetch(request);
  }
};
