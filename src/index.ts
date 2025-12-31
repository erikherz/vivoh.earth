import { DurableObject } from "cloudflare:workers";

export interface Env {
  SESSIONS: DurableObjectNamespace;
  VIVOH_STREAM_KEY: string;
}

export class RTSPSession extends DurableObject {
  // Store env so we can access the secret inside the DO
  constructor(public ctx: DurableObjectState, public env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request) {
    const url = new URL(request.url);

    // --- 1. SETUP: Camera pushes the SDP (Protected) ---
    if (request.method === "POST" && url.pathname === "/setup") {
      const authKey = request.headers.get("X-Vivoh-Key");

      if (!authKey || authKey !== this.env.VIVOH_STREAM_KEY) {
        console.error(`Unauthorized access attempt from ${request.headers.get("cf-connecting-ip")}`);
        return new Response("Unauthorized: Invalid Stream Key", { status: 401 });
      }

      const sdpText = await request.text();
      const timestamp = new Date().toISOString();

      await this.ctx.storage.put("current_sdp", sdpText);
      await this.ctx.storage.put("last_updated", timestamp);

      return new Response(`Vivoh 2.0: SDP Setup Successful at ${timestamp}`, { status: 200 });
    }

    // --- 2. DESCRIBE: Publicly accessible ---
    if (url.pathname === "/describe") {
      const sdp = await this.ctx.storage.get<string>("current_sdp");
      const lastUpdated = await this.ctx.storage.get<string>("last_updated");

      if (!sdp) {
        return new Response("v=0\ns=No Stream Active", {
          headers: { "Content-Type": "application/sdp" }
        });
      }

      const enrichedSDP = `${sdp}\na=x-vivoh-updated:${lastUpdated}`;
      return new Response(enrichedSDP, {
        headers: { "Content-Type": "application/sdp" }
      });
    }

    return new Response("Vivoh.Earth RTSP 3.0 Engine is Online");
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const id = env.SESSIONS.idFromName("global-stream");
    const stub = env.SESSIONS.get(id);
    return stub.fetch(request);
  }
};
