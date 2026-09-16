// Breakout rooms: the cross-tab half.
//
// A breakout opens in a NEW TAB as an ordinary broadcast with the creator as its broadcaster.
// That tab then has to show the roster of the room it came from, and send invites into it —
// but it is a different document, with a different stream id, and no socket to the parent room.
//
// THE OBVIOUS FIX IS THE WRONG ONE. Opening a second room socket from the breakout tab would
// work, and would put the creator in the parent room TWICE: two presence blobs, two bubbles in
// everybody's grid, two entries to invite. It would also mean re-deriving the parent's room key
// in a tab that has no business holding it.
//
// So the tabs talk to each other instead. The parent tab already has the socket, the roster and
// the key; it publishes a roster snapshot over a same-origin BroadcastChannel and relays invites
// back out through the connection it already owns. The breakout tab holds no parent credentials
// at all — it renders a list and asks for sends.
//
// The consequence, stated because it is visible to a person: close the main tab and the invite
// panel goes quiet. That is honest — the thing doing the inviting really has gone away — and the
// panel says so rather than dropping clicks on the floor.

import type { AvatarImage } from "./avatar";
import { avatarToDataUrl } from "./avatar";

/** One invitable person, flattened to what the panel needs and can structured-clone. */
export interface BreakoutPeer {
  id: string;
  name: string;
  /** `{m, b, src}` — plain strings, so it crosses the channel as-is. */
  avatar: AvatarImage | null;
}

interface RosterMsg {
  t: "roster";
  members: BreakoutPeer[];
  /** The creator's own name, so the breakout can title its invites without asking. */
  meName: string;
}
interface WantRosterMsg { t: "want-roster" }
interface InviteMsg { t: "invite"; to: string[] | null; streamId: string; title: string }
interface InvitedMsg { t: "invited"; n: number }
interface GoneMsg { t: "gone" }

type BridgeMsg = RosterMsg | WantRosterMsg | InviteMsg | InvitedMsg | GoneMsg;

/**
 * Same-origin, and scoped to one parent broadcast.
 *
 * Nothing secret crosses it — a roster this browser is already displaying, and a five-character
 * id. It never carries the room key or the link secret, which is the whole reason the breakout
 * tab can stay ignorant of them.
 */
const channelName = (parentStreamId: string) => `vivoh.breakout.${parentStreamId}`;

function open(parentStreamId: string): BroadcastChannel | null {
  // Safari shipped BroadcastChannel late and some embedded webviews still lack it. Without the
  // channel a breakout still works as a broadcast — it just cannot show the parent's roster, and
  // the panel says that instead of rendering an empty list that looks broken.
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    return new BroadcastChannel(channelName(parentStreamId));
  } catch {
    return null;
  }
}

// ── The parent tab's side ─────────────────────────────────────────────────────────────

export interface ParentBridge {
  /** Push the current roster to any breakout tab listening. Safe to call on every change. */
  publish: (members: BreakoutPeer[], meName: string) => void;
  close: () => void;
}

/**
 * Serve the roster to breakout tabs, and relay their invites through this tab's room socket.
 *
 * `relay` is the room handle's inviteToBreakout. Keeping the actual send here — in the tab that
 * holds the socket and the key — is what lets the breakout tab be credential-free.
 */
export function serveBreakoutBridge(opts: {
  parentStreamId: string;
  roster: () => { members: BreakoutPeer[]; meName: string };
  relay: (ids: string[] | null, streamId: string, title: string) => Promise<void>;
}): ParentBridge {
  const ch = open(opts.parentStreamId);
  if (!ch) return { publish: () => {}, close: () => {} };

  const post = (m: BridgeMsg) => {
    try {
      ch.postMessage(m);
    } catch {
      /* channel closed under us */
    }
  };

  ch.addEventListener("message", (ev: MessageEvent) => {
    const msg = ev.data as BridgeMsg | null;
    if (!msg || typeof msg !== "object") return;

    if (msg.t === "want-roster") {
      const { members, meName } = opts.roster();
      post({ t: "roster", members, meName });
      return;
    }

    if (msg.t === "invite") {
      // Shape-checked even though the sender is our own other tab: this ends up naming a
      // broadcast in somebody else's browser, and "it came from us" is an assumption, not a
      // check. Any page on this origin can post to a channel whose name it can guess.
      const streamId = typeof msg.streamId === "string" ? msg.streamId : "";
      if (!/^[a-z0-9]{5}$/.test(streamId)) return;
      const to = Array.isArray(msg.to)
        ? msg.to.filter((x): x is string => typeof x === "string")
        : null;
      const title = typeof msg.title === "string" ? msg.title.slice(0, 80) : "";
      void opts.relay(to, streamId, title).then(
        () => post({ t: "invited", n: to ? to.length : 0 }),
        () => { /* the socket refused it; the panel's own timeout says so */ }
      );
    }
  });

  // A breakout tab that is open when the main tab goes away must not sit there offering to
  // invite people through a connection that no longer exists.
  const farewell = () => post({ t: "gone" });
  window.addEventListener("pagehide", farewell);

  return {
    publish(members, meName) {
      post({ t: "roster", members, meName });
    },
    close() {
      window.removeEventListener("pagehide", farewell);
      farewell();
      try {
        ch.close();
      } catch {
        /* already closed */
      }
    },
  };
}

// ── The breakout tab's side ───────────────────────────────────────────────────────────

/**
 * The invite panel, mounted in a breakout tab.
 *
 * Renders the parent room's roster with a checkbox each, plus Invite everyone and Invite
 * selected. The counts and the empty states are doing real work here: a host who has just
 * opened a room and sees "nobody has joined the main room's participant list yet" understands
 * what to do, and one who sees an empty box does not.
 */
export function mountBreakoutInvites(opts: {
  container: HTMLElement;
  parentStreamId: string;
  breakoutStreamId: string;
}): () => void {
  const { container, parentStreamId, breakoutStreamId } = opts;

  const ch = open(parentStreamId);

  let peers: BreakoutPeer[] = [];
  let meName = "";
  const selected = new Set<string>();
  let parentGone = false;
  let statusTimer = 0;

  container.classList.add("bo-panel");
  container.innerHTML = `
    <div class="bo-head">
      <h3>Invite from the main room</h3>
      <a class="bo-back" href="/${parentStreamId}" target="_blank" rel="noopener">Main event ↗</a>
    </div>
    <p class="bo-note" id="bo-note"></p>
    <div class="bo-list" id="bo-list"></div>
    <div class="bo-actions">
      <label class="bo-all"><input type="checkbox" id="bo-select-all"> <span>Select everyone</span></label>
      <button type="button" class="bo-btn" id="bo-invite-sel" disabled>Invite selected</button>
      <button type="button" class="bo-btn bo-btn-primary" id="bo-invite-all" disabled>Invite everyone</button>
    </div>
    <p class="bo-status" id="bo-status" role="status"></p>`;

  const list = container.querySelector("#bo-list") as HTMLElement;
  const note = container.querySelector("#bo-note") as HTMLElement;
  const status = container.querySelector("#bo-status") as HTMLElement;
  const selectAll = container.querySelector("#bo-select-all") as HTMLInputElement;
  const inviteSel = container.querySelector("#bo-invite-sel") as HTMLButtonElement;
  const inviteAll = container.querySelector("#bo-invite-all") as HTMLButtonElement;

  const say = (text: string) => {
    status.textContent = text;
    if (statusTimer) window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => { status.textContent = ""; }, 4000);
  };

  const paint = () => {
    if (parentGone) {
      note.textContent =
        "The main event's tab was closed, so there is nobody to invite through. Reopen it and this list comes back.";
      list.replaceChildren();
      inviteSel.disabled = true;
      inviteAll.disabled = true;
      selectAll.disabled = true;
      return;
    }
    if (!ch) {
      note.textContent =
        "This browser cannot pass the participant list between tabs, so invites are not available here. Your room works normally — share its link instead.";
      return;
    }
    if (!peers.length) {
      note.textContent = "Nobody has joined the main room's participant list yet.";
      list.replaceChildren();
      inviteSel.disabled = true;
      inviteAll.disabled = true;
      selectAll.disabled = true;
      return;
    }

    note.textContent = `${peers.length} ${peers.length === 1 ? "person" : "people"} in the main room.`;
    selectAll.disabled = false;
    inviteAll.disabled = false;
    inviteSel.disabled = selected.size === 0;

    list.replaceChildren();
    for (const p of peers) {
      const row = document.createElement("label");
      row.className = "bo-row";

      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = selected.has(p.id);
      box.addEventListener("change", () => {
        if (box.checked) selected.add(p.id);
        else selected.delete(p.id);
        inviteSel.disabled = selected.size === 0;
        selectAll.checked = selected.size === peers.length;
      });

      const face = document.createElement("span");
      face.className = "bo-face";
      if (p.avatar) {
        const img = document.createElement("img");
        img.src = avatarToDataUrl(p.avatar);
        img.alt = "";
        face.append(img);
      } else {
        // textContent, never innerHTML: a display name comes from an OAuth provider and is
        // chosen by its owner.
        face.textContent = (p.name || "?").trim().charAt(0).toUpperCase();
      }

      const name = document.createElement("span");
      name.className = "bo-name";
      name.textContent = p.name || "Someone";

      row.append(box, face, name);
      list.append(row);
    }
  };

  const title = () => (meName ? `${meName}'s breakout` : "A breakout room");

  const invite = (ids: string[] | null) => {
    if (!ch || parentGone) return;
    try {
      ch.postMessage({ t: "invite", to: ids, streamId: breakoutStreamId, title: title() } satisfies InviteMsg);
    } catch {
      say("Could not reach the main room's tab.");
      return;
    }
    // Said here rather than on the ack, because the ack only proves the other TAB heard us —
    // the invite itself is fire-and-forget through a throttled relay. Claiming delivery we
    // have not observed would be the dishonest version of this message.
    const n = ids ? ids.length : peers.length;
    say(`Invite sent to ${n} ${n === 1 ? "person" : "people"}.`);
  };

  selectAll.addEventListener("change", () => {
    selected.clear();
    if (selectAll.checked) for (const p of peers) selected.add(p.id);
    paint();
    selectAll.checked = selected.size > 0 && selected.size === peers.length;
  });
  inviteSel.addEventListener("click", () => invite([...selected]));
  inviteAll.addEventListener("click", () => invite(null));

  if (ch) {
    ch.addEventListener("message", (ev: MessageEvent) => {
      const msg = ev.data as BridgeMsg | null;
      if (!msg || typeof msg !== "object") return;
      if (msg.t === "roster") {
        parentGone = false;
        peers = Array.isArray(msg.members) ? msg.members : [];
        meName = typeof msg.meName === "string" ? msg.meName : "";
        // Drop selections for people who have left, or "Invite selected" would name ids the
        // Durable Object no longer has a socket for and silently reach nobody.
        const live = new Set(peers.map((p) => p.id));
        for (const id of [...selected]) if (!live.has(id)) selected.delete(id);
        paint();
        return;
      }
      if (msg.t === "gone") {
        parentGone = true;
        paint();
      }
    });
    try {
      ch.postMessage({ t: "want-roster" } satisfies WantRosterMsg);
    } catch {
      /* handled by the empty state */
    }
  }

  paint();

  return () => {
    if (statusTimer) window.clearTimeout(statusTimer);
    try {
      ch?.close();
    } catch {
      /* already closed */
    }
  };
}
