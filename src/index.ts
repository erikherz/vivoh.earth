export interface Env {
  // Add bindings here as needed
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response("Vivoh.Earth", {
      headers: { "Content-Type": "text/plain" }
    });
  }
};
