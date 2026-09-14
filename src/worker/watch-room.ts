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

import { mintGuestMedia } from "./auth/moq-token";

/** A socket's small, hibernation-surviving bookkeeping. Never the presence blob itself. */
interface Attachment {
  id: string;
  /** Last accepted presence write, for the presence throttle. */
  tp: number;
  /** Last accepted reaction, for the reaction throttle. */
  tr: number;
  /**
   * This socket is the broadcaster.
   *
   * Set from a query parameter the WORKER writes after checking the session cookie against the
   * streams row, never from anything the client said — see the room route in worker/index.ts.
   * It is recorded on the attachment at accept time so it survives hibernation and cannot be
   * changed for the life of the socket: there is no message below that sets it.
   */
  host: boolean;
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

/**
 * One frame of a called-on viewer's voice.
 *
 * Opus at conversational bitrate is tens of bytes per 20ms frame; this is two orders of
 * magnitude of headroom, sized to reject anything that is plainly not speech rather than to
 * trim anything real.
 */
const MAX_AUDIO = 4 * 1024;

/**
 * Storage keys for the two pieces of floor state.
 *
 * `hands` is an ORDERED array — the queue a presenter reads top-down, so the person who
 * raised first is called first. Order is the entire value of the structure; a Set would have
 * lost it and made "who's next" unanswerable.
 */
const HANDS_KEY = "hands";
/** The stream id this room belongs to. Stored on first connect; the DO cannot read its own name. */
const SID_KEY = "sid";
const FLOOR_KEY = "floor";

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

/**
 * Only what this object needs to mint a guest's turn. Deliberately not the Worker's full Env:
 * a narrower type is a narrower blast radius if someone later reaches for a binding in here.
 */
interface RoomEnv {
  MOQ_PRO_JWK?: string;
  MOQ_PRO_K?: string;
  MOQ_PRO_ROOT?: string;
}

const MOQ_PRO_RELAY = "cdn.moq.pro";

export class WatchRoom {
  private state: DurableObjectState;
  /**
   * WHY THIS OBJECT MINTS, rather than asking the Worker to.
   *
   * The token attests to exactly one fact — that this socket holds the floor — and this object
   * is the only place that fact exists. Routing it through the Worker would mean inventing a
   * nonce, handing it to the guest, and having the Worker call back here to validate it: three
   * new moving parts to relay an answer we already have. It uses the same signing key as the
   * Worker because it is the same isolate and the same account; this is not a wider trust
   * boundary, only a shorter path across the one that was already there.
   */
  private env: RoomEnv;

  /**
   * Who currently holds the floor, cached in memory.
   *
   * Every audio frame has to be checked against this, and a storage read per frame at fifty
   * frames a second would be the most expensive thing in the room. `undefined` means "not
   * loaded yet" and is distinct from `null`, which means "loaded, and nobody is speaking" —
   * collapsing the two would make a revived object re-read storage on every silent frame.
   *
   * Safe to hold in memory despite hibernation: the object cannot hibernate while audio is
   * flowing through it, and the first message after any revival reloads it from storage.
   */
  private floor: string | null | undefined = undefined;

  constructor(state: DurableObjectState, env: RoomEnv) {
    this.state = state;
    this.env = env;
  }

  private async currentFloor(): Promise<string | null> {
    if (this.floor === undefined) {
      this.floor = (await this.state.storage.get<string>(FLOOR_KEY)) ?? null;
    }
    return this.floor;
  }

  private async setFloor(id: string | null): Promise<void> {
    this.floor = id;
    if (id) await this.state.storage.put(FLOOR_KEY, id);
    else await this.state.storage.delete(FLOOR_KEY);

    if (!id) {
      this.broadcast(JSON.stringify({ t: "floor", id: null }));
      return;
    }

    // A turn begins. Mint the pair for it and fan out ASYMMETRICALLY — this is the one message
    // in this file whose payload differs per recipient, and it differs because the capabilities
    // do. Broadcasting one object with both tokens in it would hand every viewer in the room the
    // ability to publish as the guest, which is the whole thing this scoping prevents.
    const sid = (await this.state.storage.get<string>(SID_KEY)) ?? "";
    const media = sid
      ? await mintGuestMedia(
          {
            jwk: this.env.MOQ_PRO_JWK,
            k: this.env.MOQ_PRO_K,
            root: this.env.MOQ_PRO_ROOT || "erik",
            relay: MOQ_PRO_RELAY,
          },
          sid,
          id
        )
      : null;

    for (const sock of this.state.getWebSockets()) {
      const a = sock.deserializeAttachment() as Attachment | null;
      const msg: Record<string, unknown> = { t: "floor", id };
      if (media) {
        msg.relay = media.relay;
        msg.path = media.path;
        msg.exp = media.expiresAt;
        // The speaker publishes; the broadcaster subscribes; everyone else is told only that
        // somebody has the floor, which is all they need to render a ring on a bubble.
        if (a?.id === id) msg.jwt = media.publishJwt;
        else if (a?.host) msg.jwt = media.subscribeJwt;
      }
      try {
        sock.send(JSON.stringify(msg));
      } catch {
        // socket going away; ignore
      }
    }
  }

  /** Send to the broadcaster's sockets only. Used for the one-to-one voice path. */
  private toHosts(payload: string): void {
    for (const sock of this.state.getWebSockets()) {
      const a = sock.deserializeAttachment() as Attachment | null;
      if (!a?.host) continue;
      try {
        sock.send(payload);
      } catch {
        // socket going away; ignore
      }
    }
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

    // The Worker puts the stream id on the rebuilt URL; a Durable Object cannot recover the
    // name it was addressed by. Needed only to build the guest's publish path.
    const sid = new URL(request.url).searchParams.get("sid") ?? "";
    if (sid) await this.state.storage.put(SID_KEY, sid);

    const id = crypto.randomUUID().slice(0, 8);
    // `host` comes from the query string the WORKER rebuilt, never from a header or a message.
    // See the Attachment field's comment and the room route in worker/index.ts.
    const host = new URL(request.url).searchParams.get("host") === "1";

    // Deliberately NOT derived from anything about the person. A room id is per-socket and
    // per-session: reconnecting gets you a new one, and two ids can never be shown to be the
    // same human. That is the same rule watch_events lives under, applied here.
    server.serializeAttachment({ id, tp: 0, tr: 0, host } satisfies Attachment);

    // No roster yet. A socket that connects is WATCHING; it joins the roster only when it
    // sends a hello, which is the client-side opt-in. Lurking is the default.
    //
    // `host` is echoed back so the client knows to render the queue controls. It is a
    // CONVENIENCE for the UI, not the authority — every host-only action below is re-checked
    // against the attachment, so a client that lied to itself about this gains nothing.
    server.send(JSON.stringify({ t: "hi", id, cap: MAX_MEMBERS, host }));
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
    let data: { t?: unknown; p?: unknown; up?: unknown; id?: unknown };
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att?.id) return;
    const now = Date.now();
    const type = String(data.t ?? "");

    // --- Voice ----------------------------------------------------------------------------
    //
    // First, because it is by far the most frequent message and everything below it would be
    // wasted work on a path that runs fifty times a second.
    //
    // THE FLOOR CHECK IS THE ACCESS CONTROL. Without it any socket could stream audio into the
    // broadcaster's mix and be heard by the entire audience — the loudest possible failure in
    // this file. It is deliberately not a throttle: a throttle would let an interloper through
    // at a slower rate, and the correct number of interlopers is none.
    //
    // Sent to HOSTS ONLY, never fanned out. The broadcaster mixes the speaker into the
    // outgoing stream, so the audience hears the question over the ordinary encrypted CDN
    // path. Relaying to everyone here would be N sockets of egress per speaker and would cap
    // the room at the size where that stops being affordable, which is the opposite of what
    // this transport exists to do.
    if (type === "a") {
      if (att.id !== (await this.currentFloor())) return;
      const p = String(data.p ?? "");
      if (!p || p.length > MAX_AUDIO) return;
      this.toHosts(JSON.stringify({ t: "a", id: att.id, p }));
      return;
    }

    // --- Raising a hand -------------------------------------------------------------------
    //
    // No sealed payload: "this socket wants to speak" is a message TYPE, not content, and the
    // object already knows which socket sent it. Putting a blob here would have added bytes
    // and disclosed nothing extra, since a client still has to map the id to a face using the
    // presence it already holds.
    if (type === "hand") {
      const up = data.up === true;
      const hands = ((await this.state.storage.get<string[]>(HANDS_KEY)) ?? []).slice();
      const at = hands.indexOf(att.id);
      if (up && at === -1) hands.push(att.id);
      else if (!up && at !== -1) hands.splice(at, 1);
      else return; // already in the state being asked for; do not churn a broadcast

      await this.state.storage.put(HANDS_KEY, hands);
      // The whole ordered queue goes out, not a delta. It is a couple of hundred bytes at the
      // participant cap, and it means no client can drift out of agreement about who is next —
      // which is the one thing a presenter reading the queue aloud has to be able to trust.
      this.broadcast(JSON.stringify({ t: "hands", ids: hands }));
      return;
    }

    // --- Handing out and taking back the floor --------------------------------------------
    if (type === "call" || type === "drop") {
      const target = typeof data.id === "string" ? data.id : null;

      // A speaker may always put themselves down; only the host may call someone up, or cut
      // someone off. Letting a speaker end their own turn matters more than it looks: without
      // it, somebody who has finished talking stays hot-miced until the presenter notices.
      const selfRelease = type === "drop" && att.id === (await this.currentFloor());
      if (!att.host && !selfRelease) return;

      if (type === "drop") {
        await this.setFloor(null);
        return;
      }

      if (!target) return;
      // Calling someone lowers their hand: the queue is what is still outstanding, and a
      // presenter should not have to clear it by hand after every question.
      const hands = ((await this.state.storage.get<string[]>(HANDS_KEY)) ?? []).filter((x) => x !== target);
      await this.state.storage.put(HANDS_KEY, hands);
      this.broadcast(JSON.stringify({ t: "hands", ids: hands }));
      await this.setFloor(target);
      return;
    }

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
      // The roster carries the floor state with it. A late joiner who only got the member list
      // would show no raised hands and no live speaker until the next change — so someone
      // joining mid-question would see a silent room and a presenter with an empty queue.
      if (joining) {
        ws.send(JSON.stringify({
          t: "roster",
          members: await this.roster(ids, att.id),
          hands: (await this.state.storage.get<string[]>(HANDS_KEY)) ?? [],
          floor: await this.currentFloor(),
        }));
      }
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

    // THE HOT MIC. Release the floor before anything else, and do it even for a socket that
    // never joined the roster. A speaker whose connection drops mid-sentence would otherwise
    // leave the floor assigned to an id that no longer exists — and because the audio check
    // above compares against exactly that id, nobody else could be called on until the object
    // happened to restart. The presenter's only visible symptom would be a Call button that
    // did nothing.
    if (att.id === (await this.currentFloor())) await this.setFloor(null);

    const hands = (await this.state.storage.get<string[]>(HANDS_KEY)) ?? [];
    if (hands.includes(att.id)) {
      const next = hands.filter((x) => x !== att.id);
      await this.state.storage.put(HANDS_KEY, next);
      this.broadcast(JSON.stringify({ t: "hands", ids: next }), ws);
    }

    const ids = (await this.state.storage.get<string[]>(IDS_KEY)) ?? [];
    if (!ids.includes(att.id)) return; // never joined the roster; nothing further to announce

    const next = ids.filter((x) => x !== att.id);
    await this.state.storage.delete(pkey(att.id));

    if (next.length === 0) {
      // Last one out. deleteAll rather than writing an empty array, so an idle room holds no
      // trace of having been occupied — the "presence is live-only" promise in migration 0019
      // is this line.
      await this.state.storage.deleteAll();
      // deleteAll wipes storage but not this object's memory, and `floor` is cached there. Left
      // stale, a revived room would believe a long-departed id still held the microphone.
      this.floor = null;
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
