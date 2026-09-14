// The room: live presence and reactions for one stream, backed by a Durable Object using
// the WebSocket Hibernation API (no duration charges while idle). One instance per streamId.
//
// END-TO-END ENCRYPTED, on exactly the same terms as ChatRoom next door. Every participant
// payload that passes through here — the display name, the avatar IMAGE BYTES, the emoji or
// GIF of a reaction — is one opaque `<nonce>.<ciphertext>` string sealed client-side under a
// key derived from the share link's `#k=` fragment. This object relays blobs it cannot read.
//
// That is why the avatar travels as bytes rather than as a URL. A picture is small enough to
// carry inside the envelope, and carrying it means no participant's browser ever fetches
// `lh3.googleusercontent.com` or `media.giphy.com` while watching. Had we shipped URLs, the
// room would still be private from US and would have told Google and Giphy the size and
// timing of the audience instead. Sealed bytes leak to neither.
//
// WHY A SECOND CLASS INSTEAD OF FOLDING THIS INTO ChatRoom: their state has opposite
// lifetimes. Chat persists a history so late joiners see context; a room must persist
// NOTHING, because presence that outlives the socket holding it is a roster of who watched.
// Keeping them apart means that property is structural rather than remembered.
//
// What this object still sees: how many sockets, how large each blob is, and when.

/** A socket's small, hibernation-surviving bookkeeping. Never the presence blob itself. */
interface Attachment {
  id: string;
  /** Last accepted presence write, for the presence throttle. */
  tp: number;
  /** Last accepted reaction, for the reaction throttle. */
  tr: number;
}

// Sized for a sealed presence payload carrying a small animated GIF: the client caps the raw
// image at 48 KiB, base64 inflates it by a third, and the JSON wrapper plus the display name
// and nonce ride along. 96 KiB leaves real headroom and still sits well under the 128 KiB
// ceiling on a single Durable Object storage value, which is the hard limit here.
const MAX_PRESENCE = 96 * 1024;
// A reaction is an emoji, or a short reference to one the sender already published in their
// presence blob. Nothing image-sized belongs here — it is sent far more often and fanned out
// to everyone.
const MAX_REACTION = 4 * 1024;

// A presence write is a deliberate act (join, or change your picture), so it can be slow.
const PRESENCE_INTERVAL_MS = 2000;
// Reactions are meant to be spammed a little; this only stops a script from spamming a lot.
const REACTION_INTERVAL_MS = 400;

// Bounds fanout. Every presence blob is relayed to every participant, so the cost of a room
// is quadratic in this number — 200 participants exchanging 96 KiB is already ~2 GB of DO
// egress in the worst case. Past this, further sockets may watch but cannot join the roster.
const MAX_MEMBERS = 200;

// Durable Object storage accepts at most 128 keys per bulk get.
const BULK_LIMIT = 128;

/** Storage key for one participant's sealed presence blob. */
const pkey = (id: string) => `p:${id}`;
/**
 * Storage key holding just the list of ids that currently have a presence blob.
 *
 * This exists so the roster can be assembled WITHOUT `storage.list({prefix:"p:"})`, which
 * would load every blob's value into memory — up to 200 × 96 KiB — merely to learn which
 * keys exist. The list is small enough to read on every join; the blobs are not.
 */
const IDS_KEY = "ids";

export class WatchRoom {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    // Hibernatable: the DO can be evicted between messages and revived on the next one, which
    // is why every piece of per-socket state below lives in an attachment or in storage
    // rather than on `this`.
    this.state.acceptWebSocket(server);

    const id = crypto.randomUUID().slice(0, 8);
    // Deliberately NOT derived from anything about the person. A room id is per-socket and
    // per-session: reconnecting gets you a new one, and two ids can never be shown to be the
    // same human. That is the same rule watch_events lives under, applied here.
    server.serializeAttachment({ id, tp: 0, tr: 0 } satisfies Attachment);

    // No roster yet. A socket that connects is WATCHING; it joins the roster only when it
    // sends a hello, which is the client-side opt-in. Lurking is the default.
    server.send(JSON.stringify({ t: "hi", id, cap: MAX_MEMBERS }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Live sockets that have opted into the roster, as id -> socket. */
  private liveIds(): Map<string, WebSocket> {
    const out = new Map<string, WebSocket>();
    for (const sock of this.state.getWebSockets()) {
      const a = sock.deserializeAttachment() as Attachment | null;
      if (a?.id) out.set(a.id, sock);
    }
    return out;
  }

  private broadcast(payload: string, except?: WebSocket): void {
    for (const sock of this.state.getWebSockets()) {
      if (sock === except) continue;
      try {
        sock.send(payload);
      } catch {
        // socket going away; ignore
      }
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    let data: { t?: unknown; p?: unknown };
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att?.id) return;
    const now = Date.now();
    const type = String(data.t ?? "");

    if (type === "r") {
      if (now - att.tr < REACTION_INTERVAL_MS) return;
      const p = String(data.p ?? "");
      if (!p || p.length > MAX_REACTION) return;
      ws.serializeAttachment({ ...att, tr: now } satisfies Attachment);
      // Echoed to the sender too, so every participant runs one code path for "a reaction
      // arrived" and a sender sees their own emoji fly with the same timing everyone else does.
      this.broadcast(JSON.stringify({ t: "r", id: att.id, p }));
      return;
    }

    if (type === "hello" || type === "p") {
      if (now - att.tp < PRESENCE_INTERVAL_MS) return;
      const p = String(data.p ?? "");
      // The only validation possible on ciphertext: that it exists and is not absurdly large.
      // Whether it opens to a name and a picture is for the recipients to find out.
      if (!p || p.length > MAX_PRESENCE) return;

      const ids = ((await this.state.storage.get<string[]>(IDS_KEY)) ?? []).slice();
      const joining = !ids.includes(att.id);
      if (joining && ids.length >= MAX_MEMBERS) {
        ws.send(JSON.stringify({ t: "full", cap: MAX_MEMBERS }));
        return;
      }

      ws.serializeAttachment({ ...att, tp: now } satisfies Attachment);
      await this.state.storage.put(pkey(att.id), p);
      if (joining) {
        ids.push(att.id);
        await this.state.storage.put(IDS_KEY, ids);
      }

      // The joiner gets everyone; everyone gets the joiner. An update (`p`) is the same
      // message without the roster, so a participant swapping their picture mid-stream costs
      // one fanout rather than a rebuild on every screen.
      if (joining) ws.send(JSON.stringify({ t: "roster", members: await this.roster(ids, att.id) }));
      this.broadcast(JSON.stringify({ t: joining ? "join" : "p", id: att.id, p }), ws);
      return;
    }
  }

  /**
   * Everyone currently in the roster except `selfId`, reconciling as it goes.
   *
   * Reconciliation is here rather than on a timer because this is the only moment the answer
   * is needed and the only moment we are already paying for the id list. An id can outlive
   * its socket if `webSocketClose` never fires — a Durable Object evicted mid-disconnect, say
   * — and a stale blob would show a face belonging to someone who had already left.
   */
  private async roster(ids: string[], selfId: string): Promise<Array<{ id: string; p: string }>> {
    const live = this.liveIds();
    const present = ids.filter((id) => live.has(id));
    const orphans = ids.filter((id) => !live.has(id));
    if (orphans.length) {
      await this.state.storage.delete(orphans.map(pkey));
      await this.state.storage.put(IDS_KEY, present);
    }

    const wanted = present.filter((id) => id !== selfId);
    const out: Array<{ id: string; p: string }> = [];
    for (let i = 0; i < wanted.length; i += BULK_LIMIT) {
      const chunk = wanted.slice(i, i + BULK_LIMIT);
      const got = await this.state.storage.get<string>(chunk.map(pkey));
      for (const id of chunk) {
        const p = got.get(pkey(id));
        if (p) out.push({ id, p });
      }
    }
    return out;
  }

  private async forget(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att?.id) return;

    const ids = (await this.state.storage.get<string[]>(IDS_KEY)) ?? [];
    if (!ids.includes(att.id)) return; // never joined the roster; nothing to announce

    const next = ids.filter((x) => x !== att.id);
    await this.state.storage.delete(pkey(att.id));

    if (next.length === 0) {
      // Last one out. deleteAll rather than writing an empty array, so an idle room holds no
      // trace of having been occupied — the "presence is live-only" promise in migration 0019
      // is this line.
      await this.state.storage.deleteAll();
    } else {
      await this.state.storage.put(IDS_KEY, next);
    }

    this.broadcast(JSON.stringify({ t: "leave", id: att.id }), ws);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await this.forget(ws);
    try {
      ws.close(code);
    } catch {
      // already closing
    }
  }

  // A socket that errors never delivers webSocketClose, so without this its face would stay
  // on every other screen until someone else's join triggered reconciliation.
  async webSocketError(ws: WebSocket): Promise<void> {
    await this.forget(ws);
  }
}
