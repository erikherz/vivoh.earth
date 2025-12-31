import { DurableObject } from "cloudflare:workers";

export class RTSPSession extends DurableObject {
  private sdp: string = "";

  async fetch(request: Request) {
    const url = new URL(request.url);

    // Camera pushes the SDP
    if (request.method === "POST" && url.pathname === "/setup") {
      this.sdp = await request.text();
      return new Response("Vivoh 2.0: SDP Setup Successful", { status: 200 });
    }

    // Viewer gets the SDP
    if (url.pathname === "/describe") {
      return new Response(this.sdp || "v=0\ns=No Stream Active", {
        headers: { "Content-Type": "application/sdp" }
      });
    }

    return new Response("Vivoh.Earth RTSP 3.0 Engine is Online");
  }
}

export default {
  async fetch(request, env) {
    const id = env.SESSIONS.idFromName("global-stream");
    const stub = env.SESSIONS.get(id);
    return stub.fetch(request);
  }
};
