// The room's wire protocol: sealed presence and reactions over one WebSocket.
//
// Everything this module sends is sealed before it leaves the page and everything it receives
// is opened after it arrives, under a key derived from the share link's `#k=` fragment
// (deriveRoomKey). The WatchRoom Durable Object in between moves opaque strings. See
// src/worker/watch-room.ts for the server half and what it can and cannot see.
//
// TWO PAYLOAD SHAPES, sized very differently on purpose:
//
//   presence  {name, av:{m,b,src}}  — kilobytes, sent when you join or change your picture
//   reaction  {e:"👏"} | {ref:"av"} — a few dozen bytes, sent whenever someone taps
//
// A GIF reaction does NOT ship the GIF. It ships `{ref:"av"}`, meaning "throw the picture I
// already published", and every client draws it from the presence blob it is already holding.
// Sending the bytes per reaction instead would have multiplied a 48 KiB payload by the room
// size on every tap — the single most expensive thing this feature could plausibly have done.

import { openText, sealText } from "../crypto/media-crypto";
import type { AvatarImage } from "./avatar";

export interface RoomMember {
  /** Per-socket, per-session id assigned by the DO. Never stable across reconnects. */
  id: string;
  name: string;
  avatar: AvatarImage | null;
}

export interface RoomReaction {
  /** Who threw it; may be a member who has since left. */
  from: string;
  /** An emoji, or null when the reaction is the sender's own picture. */
  emoji: string | null;
  /** Set when `emoji` is null: the picture to throw, resolved from that member's presence. */
  image: AvatarImage | null;
  /** True when this client is the sender, so the UI can avoid echoing its own bubble twice. */
  mine: boolean;
}

export interface RoomHandle {
  /** Publish (or republish) who you are. Safe to call repeatedly; the DO throttles to 2s. */
  setPresence: (name: string, avatar: AvatarImage | null) => Promise<void>;
  /** Throw an emoji. */
  react: (emoji: string) => Promise<void>;
  /** Throw your own picture. Costs nothing on the wire beyond the marker. */
  reactWithAvatar: () => Promise<void>;
  destroy: () => void;
}

export interface RoomCallbacks {
  onRoster: (members: RoomMember[]) => void;
  onJoin: (member: RoomMember) => void;
  onUpdate: (member: RoomMember) => void;
  onLeave: (id: string) => void;
  onReaction: (r: RoomReaction) => void;
  onStatus: (online: boolean) => void;
  /** The room hit its participant cap; this client watches but is not in the roster. */
  onFull: (cap: number) => void;
}

interface PresencePlain {
  name?: unknown;
  av?: { m?: unknown; b?: unknown; src?: unknown } | null;
}

export function initRoom(opts: {
  streamId: string;
  /** Proof-of-link tag; the Worker rejects the upgrade without it once a broadcast has one. */
  routeTag: () => Promise<string>;
  /**
   * A GETTER, not a value — the same reason chat's key is one. The salt that feeds this key
   * only exists once /route has answered, and a rotation re-keys mid-session. Deriving per
   * use means the room follows the same inputs as the video instead of pinning stale ones.
   */
  roomKey: () => Promise<CryptoKey>;
  callbacks: RoomCallbacks;
}): RoomHandle {
  const { streamId, callbacks } = opts;

  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let myId = "";

  /**
   * The last presence we published, replayed after every reconnect.
   *
   * Without this, a network blip drops you out of everyone else's roster permanently: the DO
   * forgets a closed socket by design, the new socket is a stranger until it says hello, and
   * nothing else would ever make it say hello again.
   */
  let mine: { name: string; avatar: AvatarImage | null } | null = null;

  /** Everyone's last known presence, so a `{ref:"av"}` reaction can be drawn. */
  const known = new Map<string, RoomMember>();

  const parsePresence = (id: string, plain: string): RoomMember | null => {
    let p: PresencePlain;
    try {
      p = JSON.parse(plain);
    } catch {
      return null;
    }
    const name = typeof p.name === "string" ? p.name.slice(0, 32) : "";
    let avatar: AvatarImage | null = null;
    if (p.av && typeof p.av.m === "string" && typeof p.av.b === "string") {
      // The mime type decides what an <img> will try to decode, and it arrives from another
      // participant. Constrain it to the three we produce rather than interpolating a
      // stranger's string into a data: URL.
      const m = p.av.m;
      if (m === "image/webp" || m === "image/jpeg" || m === "image/gif" || m === "image/png") {
        const src = p.av.src === "oauth" || p.av.src === "giphy" ? p.av.src : "anon";
        avatar = { m, b: p.av.b, src };
      }
    }
    return { id, name: name || "Guest", avatar };
  };

  const openPresence = async (id: string, ct: string): Promise<RoomMember | null> => {
    // A blob sealed under a different key — history from across a salt rotation, or someone
    // holding a stale link — simply does not open. Skipping it silently is right: it is not
    // an error, it is a participant this viewer was never meant to see.
    const plain = await openText(await opts.roomKey(), ct);
    if (!plain) return null;
    const m = parsePresence(id, plain);
    if (m) known.set(id, m);
    return m;
  };

  const connect = async () => {
    if (closed) return;
    let tag = "";
    try {
      tag = await opts.routeTag();
    } catch {
      /* derive failed; the upgrade below will 404 and we retry */
    }
    if (closed) return;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const qs = tag ? `?tag=${encodeURIComponent(tag)}` : "";
    ws = new WebSocket(`${proto}//${location.host}/api/streams/${streamId}/room${qs}`);

    ws.addEventListener("open", () => {
      retry = 0;
      callbacks.onStatus(true);
    });

    ws.addEventListener("message", (ev) => {
      let data: { t?: string; id?: string; p?: string; cap?: number; members?: Array<{ id: string; p: string }> };
      try {
        data = JSON.parse(ev.data as string);
      } catch {
        return;
      }

      if (data.t === "hi") {
        myId = String(data.id ?? "");
        // Re-announce after a reconnect. A first connection has nothing to replay yet;
        // setPresence() sends it when the caller has assembled a picture.
        if (mine) void publish(mine.name, mine.avatar);
        return;
      }

      if (data.t === "full") {
        callbacks.onFull(Number(data.cap ?? 0));
        return;
      }

      if (data.t === "roster" && Array.isArray(data.members)) {
        const list = data.members;
        void (async () => {
          const out: RoomMember[] = [];
          for (const m of list) {
            const parsed = await openPresence(m.id, m.p);
            if (parsed) out.push(parsed);
          }
          callbacks.onRoster(out);
        })();
        return;
      }

      if ((data.t === "join" || data.t === "p") && data.id && data.p) {
        const id = data.id;
        const joined = data.t === "join";
        void (async () => {
          const m = await openPresence(id, data.p as string);
          if (!m) return;
          if (joined) callbacks.onJoin(m);
          else callbacks.onUpdate(m);
        })();
        return;
      }

      if (data.t === "leave" && data.id) {
        known.delete(data.id);
        callbacks.onLeave(data.id);
        return;
      }

      if (data.t === "r" && data.id && data.p) {
        const from = data.id;
        void (async () => {
          const plain = await openText(await opts.roomKey(), data.p as string);
          if (!plain) return;
          let r: { e?: unknown; ref?: unknown };
          try {
            r = JSON.parse(plain);
          } catch {
            return;
          }
          const emoji = typeof r.e === "string" ? r.e.slice(0, 8) : null;
          const image = r.ref === "av" ? known.get(from)?.avatar ?? null : null;
          if (!emoji && !image) return;
          callbacks.onReaction({ from, emoji, image, mine: from === myId });
        })();
      }
    });

    ws.addEventListener("close", () => {
      callbacks.onStatus(false);
      if (closed) return;
      const delay = Math.min(10000, 500 * 2 ** retry++);
      reconnectTimer = setTimeout(() => void connect(), delay);
    });
    ws.addEventListener("error", () => ws?.close());
  };

  const send = (obj: unknown) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  const publish = async (name: string, avatar: AvatarImage | null) => {
    const ct = await sealText(await opts.roomKey(), JSON.stringify({ name, av: avatar }));
    send({ t: "hello", p: ct });
  };

  void connect();

  return {
    async setPresence(name, avatar) {
      mine = { name, avatar };
      await publish(name, avatar);
    },
    async react(emoji) {
      send({ t: "r", p: await sealText(await opts.roomKey(), JSON.stringify({ e: emoji })) });
    },
    async reactWithAvatar() {
      send({ t: "r", p: await sealText(await opts.roomKey(), JSON.stringify({ ref: "av" })) });
    },
    destroy() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      known.clear();
    },
  };
}
