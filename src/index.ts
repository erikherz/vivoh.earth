import { DurableObject } from "cloudflare:workers";

/**
 * RTSPSession Durable Object
 * Uses the SQLite-backed storage to ensure the SDP survives restarts and deployments.
 */
export class RTSPSession extends DurableObject {
  
  async fetch(request: Request) {
    const url = new URL(request.url);

    // --- 1. SETUP: Camera pushes the SDP ---
    if (request.method === "POST" && url.pathname === "/setup") {
      const sdpText = await request.text();
      const timestamp = new Date().toISOString();

      // Save both the SDP and the time it was received to persistent storage
      await this.ctx.storage.put("current_sdp", sdpText);
      await this.ctx.storage.put("last_updated", timestamp);

      return new Response(`Vivoh 2.0: SDP Setup Successful at ${timestamp}`, { 
        status: 200 
      });
    }

    // --- 2. DESCRIBE: Viewer requests the SDP ---
    if (url.pathname === "/describe") {
      const sdp = await this.ctx.storage.get<string>("current_sdp");
      const lastUpdated = await this.ctx.storage.get<string>("last_updated");

      if (!sdp) {
        return new Response("v=0\ns=No Stream Active", {
          headers: { "Content-Type": "application/sdp" }
        });
      }

      // We append a custom 'a' attribute to the SDP to show the versioning/timestamp
      const enrichedSDP = `${sdp}\na=x-vivoh-updated:${lastUpdated}`;

      return new Response(enrichedSDP, {
        headers: { "Content-Type": "application/sdp" }
      });
    }

    // --- 3. STATUS: Basic Health Check ---
    return new Response("Vivoh.Earth RTSP 3.0 Engine is Online");
  }
}

/**
 * Main Worker Entry Point
 */
export default {
  async fetch(request: Request, env: any) {
    // For this reboot, we use a single global session named "global-stream"
    const id = env.SESSIONS.idFromName("global-stream");
    const stub = env.SESSIONS.get(id);

    return stub.fetch(request);
  }
};
