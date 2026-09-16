// The room, on screen: a wall of faces under the video, and reactions that fly over it.
//
// Everything rendered here arrived sealed and was opened in this page (see room-client.ts).
// Nothing in this file talks to the network except the GIF picker, which goes through our own
// Worker so that browsing GIFs does not tell Giphy who is in the room.
//
// TWO RULES THIS FILE KEEPS, because both are easy to break by accident:
//
//   1. Every string that came from another participant is set with textContent, never
//      innerHTML. A display name is attacker-chosen text arriving in the page that holds the
//      content key; chat-client.ts carries the same rule for the same reason.
//   2. Joining is a deliberate act. Opening a room connects you and shows you the others;
//      it does NOT publish your face. That only happens when someone presses Join, and the
//      prompt says what it means before they do.

import type { User } from "../auth";
import { anonAvatar, avatarToDataUrl, giphyAvatar, oauthAvatar, type AvatarImage } from "./avatar";
import { initRoom, type GuestMedia, type RoomHandle, type RoomMember, type RoomReaction } from "./room-client";
import { serveBreakoutBridge, type BreakoutPeer, type ParentBridge } from "./breakout";
import {
  startGuestPublish,
  startGuestSubscribe,
  type GuestPublication,
  type GuestSubscription,
} from "./guest-media";

// Shared with chat on purpose: a person who named themselves in chat should not have to do it
// again to join the room, and vice versa.
const NAME_KEY = "earthseed-chat-name";

/** How long a reaction sits on the sender's bubble (screenshot: a heart replacing a face). */
const BUBBLE_REACTION_MS = 4000;
/** Ceiling on simultaneously animating elements, so a reaction storm cannot lock up a tab. */
const MAX_FLYING = 40;

const QUICK_EMOJI = ["👏", "❤️", "😂", "🎉", "👍", "🙌"];

export interface RoomViewHandle {
  destroy: () => void;
}

interface Bubble {
  el: HTMLElement;
  img: HTMLImageElement;
  badge: HTMLElement;
  label: HTMLElement;
  timer: number | null;
}

function loadName(user: User | null): string {
  const saved = localStorage.getItem(NAME_KEY);
  if (saved && saved.trim()) return saved.trim();
  if (user?.name) return user.name;
  return `Guest-${Math.random().toString(16).slice(2, 6)}`;
}

export function initRoomView(opts: {
  streamId: string;
  /** Where the grid and the reaction bar go — below the video. */
  container: HTMLElement;
  /** What the reactions fly over — the video's own wrapper, so they land on the picture. */
  stage: HTMLElement;
  user: User | null;
  routeTag: () => Promise<string>;
  roomKey: () => Promise<CryptoKey>;
  /**
   * The broadcaster's outgoing audio mix, when this page is the broadcaster.
   *
   * A called-on viewer's voice is decoded onto THIS context and connected here, so the whole
   * audience hears the question through the normal encrypted stream. Returns null on a
   * viewer's page, where there is nothing to mix into — and that is what makes a speaker's
   * audio simply not play for anyone but the host: intended behaviour, not a missing feature.
   *
   * A GETTER, not a value, because the compositor does not exist yet when this runs. The
   * broadcaster can switch the room on before ever going live, and the mix is only built when
   * the first capture source starts. Captured once at construction, this would have been null
   * for the whole session on exactly the ordinary path — room on, then go live — and the
   * audience would never have heard a single question.
   */
  mix?: () => { audioContext: AudioContext; attachAudioSource: (node: AudioNode) => () => void } | null;
  /**
   * The share link's secret, and the server-issued salt.
   *
   * Getters for the same reason the key getters are: the salt only exists once /route or
   * go-live has answered, and rotating the stream id re-keys everything mid-session. A guest's
   * turn derives its own key from these at the moment the turn starts.
   */
  linkSecret: () => string;
  salt: () => string | undefined;
  /**
   * Put a called-on guest into the outgoing picture. Broadcaster's page only.
   *
   * Takes the canvas @moq/watch decodes into, or null to remove them. Absent on a viewer's
   * page, where there is no composite to draw into.
   */
  setGuestVideo?: (source: HTMLCanvasElement | null) => void;
  /** What the compositor is holding, for the presenter-facing diagnostic. */
  guestState?: () => string;
  /**
   * Breakout rooms, if this broadcast is offering them.
   *
   * The API calls live in main.ts and arrive here as functions, so this module stays what it
   * is — a view — and never grows a second opinion about who may publish.
   */
  breakouts?: {
    /** Is the parent broadcaster offering them right now? */
    enabled: () => boolean;
    /** Broadcaster only. Absent on a viewer's page, which is what hides the toggle. */
    setEnabled?: (on: boolean) => Promise<boolean>;
    /** Open one. Resolves with the new broadcast name, or the Worker's own refusal text. */
    create?: () => Promise<{ streamId?: string; error?: string }>;
    /** Creating needs an account; an anonymous viewer is told so, not shown a dead button. */
    signedIn: boolean;
  };
}): RoomViewHandle {
  const { container, stage, user } = opts;

  let displayName = loadName(user);
  let myAvatar: AvatarImage | null = null;
  let joined = false;
  let destroyed = false;
  const bubbles = new Map<string, Bubble>();
  /** The same people as `bubbles`, as plain data, for the breakout tab across the channel. */
  const members = new Map<string, BreakoutPeer>();
  let bridge: ParentBridge | null = null;
  const publishPeers = () => bridge?.publish([...members.values()], displayName);
  let flying = 0;

  // An explicit opt-out of motion, honoured for the flying reactions (which are the only
  // thing here that moves). The bubble badge still changes, so a reaction is never invisible
  // to someone who asked for less animation — it just does not fly.
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  container.innerHTML = `
    <div class="room-join">
      <p class="room-join-text">
        Join to appear in the room. Your name and picture go to the other people watching,
        encrypted with the same key as the video — this service never sees either.
      </p>
      <div class="room-join-row">
        <input class="room-name" type="text" maxlength="32" placeholder="Your name" autocomplete="off" />
        <button class="room-join-btn" type="button">Join the room</button>
      </div>
    </div>
    <div class="room-grid" role="list" aria-label="People watching"></div>
    <div class="room-bar hidden">
      <div class="room-quick"></div>
      <button class="room-gif-btn" type="button" title="Choose a GIF as your picture">GIF</button>
      <button class="room-throw-btn" type="button" title="Throw your picture across the video">Throw</button>
      <button class="room-hand-btn" type="button" title="Raise your hand to ask a question">✋ Raise hand</button>
    </div>
    <!-- Breakout rooms. Hidden entirely unless this broadcast offers them. The broadcaster's
         own toggle lives HERE rather than in the capture control bar, which has 2px of spare
         width at 430px. It also belongs here on the merits: what an attendee invites FROM is
         this roster, so a breakout without a room is a control with nothing behind it. -->
    <div class="room-breakout hidden">
      <label class="room-bo-toggle hidden">
        <input class="room-bo-enable" type="checkbox">
        <span>Let attendees open breakout rooms</span>
      </label>
      <div class="room-bo-open hidden">
        <span class="room-bo-text"></span>
        <button class="room-bo-btn" type="button">Open a breakout</button>
      </div>
    </div>
    <!-- An invite from somebody else's breakout. One slot, newest wins: a stack of these over
         a live video is a pop-up cannon, which is what this and the server-side throttle are
         jointly there to prevent. -->
    <div class="room-bo-invite hidden" role="alertdialog" aria-live="polite">
      <span class="room-bo-invite-text"></span>
      <button class="room-bo-invite-yes" type="button">Join</button>
      <button class="room-bo-invite-no" type="button">Not now</button>
    </div>
    <!-- The presenter's queue. Rendered only for the broadcaster, and the server re-checks
         every action it offers — this panel being present is not what grants the power. -->
    <div class="room-queue hidden">
      <div class="room-queue-head">
        <span class="room-queue-title">Hands up</span>
        <span class="room-queue-count">0</span>
      </div>
      <ol class="room-queue-list"></ol>
    </div>
    <!-- The accept step. Holding the floor does NOT open a microphone; only pressing Unmute
         does. See offerMic() below for why this cannot be skipped even for someone who has
         already granted microphone permission to this origin. -->
    <div class="room-invite hidden" role="alertdialog" aria-live="assertive">
      <span class="room-invite-text">You've been asked to speak.</span>
      <button class="room-invite-yes" type="button">Unmute</button>
      <button class="room-invite-cam" type="button">Unmute with video</button>
      <button class="room-invite-no" type="button">Not now</button>
    </div>
    <!-- Shown to whoever currently holds the floor, on their own screen. -->
    <div class="room-speaking hidden" role="status" aria-live="polite">
      <span class="room-speaking-dot"></span>
      <span class="room-speaking-text"></span>
      <button class="room-speaking-done" type="button">I'm done</button>
    </div>
    <div class="room-gif-panel hidden">
      <div class="room-gif-head">
        <input class="room-gif-q" type="text" maxlength="64" placeholder="Search GIFs…" autocomplete="off" />
        <button class="room-gif-close" type="button" aria-label="Close">✕</button>
      </div>
      <div class="room-gif-results"></div>
      <p class="room-gif-note"></p>
    </div>
  `;

  const joinBox = container.querySelector(".room-join") as HTMLElement;
  const nameInput = container.querySelector(".room-name") as HTMLInputElement;
  const joinBtn = container.querySelector(".room-join-btn") as HTMLButtonElement;
  const grid = container.querySelector(".room-grid") as HTMLElement;
  const bar = container.querySelector(".room-bar") as HTMLElement;
  const quick = container.querySelector(".room-quick") as HTMLElement;
  const gifBtn = container.querySelector(".room-gif-btn") as HTMLButtonElement;
  const throwBtn = container.querySelector(".room-throw-btn") as HTMLButtonElement;
  const gifPanel = container.querySelector(".room-gif-panel") as HTMLElement;
  const gifQ = container.querySelector(".room-gif-q") as HTMLInputElement;
  const gifClose = container.querySelector(".room-gif-close") as HTMLButtonElement;
  const gifResults = container.querySelector(".room-gif-results") as HTMLElement;
  const gifNote = container.querySelector(".room-gif-note") as HTMLElement;
  const handBtn = container.querySelector(".room-hand-btn") as HTMLButtonElement;
  const boPanel = container.querySelector(".room-breakout") as HTMLElement;
  const boToggleLabel = container.querySelector(".room-bo-toggle") as HTMLElement;
  const boEnable = container.querySelector(".room-bo-enable") as HTMLInputElement;
  const boOpenRow = container.querySelector(".room-bo-open") as HTMLElement;
  const boText = container.querySelector(".room-bo-text") as HTMLElement;
  const boBtn = container.querySelector(".room-bo-btn") as HTMLButtonElement;
  const boInvite = container.querySelector(".room-bo-invite") as HTMLElement;
  const boInviteText = container.querySelector(".room-bo-invite-text") as HTMLElement;
  const boInviteYes = container.querySelector(".room-bo-invite-yes") as HTMLButtonElement;
  const boInviteNo = container.querySelector(".room-bo-invite-no") as HTMLButtonElement;
  const queuePanel = container.querySelector(".room-queue") as HTMLElement;
  const queueList = container.querySelector(".room-queue-list") as HTMLOListElement;
  const queueCount = container.querySelector(".room-queue-count") as HTMLElement;
  const invite = container.querySelector(".room-invite") as HTMLElement;
  const inviteText = container.querySelector(".room-invite-text") as HTMLElement;
  const inviteYes = container.querySelector(".room-invite-yes") as HTMLButtonElement;
  const inviteCam = container.querySelector(".room-invite-cam") as HTMLButtonElement;
  const inviteNo = container.querySelector(".room-invite-no") as HTMLButtonElement;
  const speakingBar = container.querySelector(".room-speaking") as HTMLElement;
  const speakingText = container.querySelector(".room-speaking-text") as HTMLElement;
  const speakingDone = container.querySelector(".room-speaking-done") as HTMLButtonElement;

  nameInput.value = displayName;

  for (const e of QUICK_EMOJI) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "room-emoji";
    b.textContent = e;
    b.setAttribute("aria-label", `React with ${e}`);
    b.addEventListener("click", () => void room.react(e));
    quick.appendChild(b);
  }

  // --- the grid ---------------------------------------------------------------------

  const placeholder = () => {
    if (grid.childElementCount) return;
    const p = document.createElement("p");
    p.className = "room-empty";
    p.textContent = "Nobody has joined the room yet.";
    grid.appendChild(p);
  };

  const clearPlaceholder = () => {
    const p = grid.querySelector(".room-empty");
    if (p) p.remove();
  };

  const upsert = (m: RoomMember) => {
    // Mirrored alongside the bubbles because a breakout tab needs the DATA, not the DOM: a
    // bubble is an <img> with a data URL baked into it, and reading names back out of a grid
    // is how you end up shipping "Someone" to every invite.
    members.set(m.id, { id: m.id, name: m.name, avatar: m.avatar });
    publishPeers();
    clearPlaceholder();
    let b = bubbles.get(m.id);
    if (!b) {
      const el = document.createElement("div");
      el.className = "room-bubble";
      el.setAttribute("role", "listitem");
      const img = document.createElement("img");
      img.className = "room-bubble-img";
      img.alt = "";
      const badge = document.createElement("span");
      badge.className = "room-bubble-badge hidden";
      const label = document.createElement("span");
      label.className = "room-bubble-name";
      el.append(img, badge, label);
      grid.appendChild(el);
      b = { el, img, badge, label, timer: null };
      bubbles.set(m.id, b);
    }
    // textContent, never innerHTML: this name came from another participant.
    b.label.textContent = m.name;
    b.el.title = m.name;
    b.img.src = m.avatar ? avatarToDataUrl(m.avatar) : "";
    b.img.classList.toggle("hidden", !m.avatar);
  };

  const remove = (id: string) => {
    members.delete(id);
    publishPeers();
    const b = bubbles.get(id);
    if (!b) return;
    if (b.timer) clearTimeout(b.timer);
    b.el.remove();
    bubbles.delete(id);
    placeholder();
  };

  // --- fitting the wall ---------------------------------------------------------------
  //
  // The room holds up to 200 (MAX_MEMBERS in watch-room.ts), and a 58px bubble seats 13 to a
  // row on a 1440px desktop — 65 before the panel starts scrolling — or 5 to a row on a
  // phone. Measured on the shipped CSS, not estimated. So at any real town-hall size the wall
  // must either shrink or hide people; showing 200 recognisable faces is not an option that
  // exists.
  //
  // It shrinks, down to a floor. That keeps the thing the wall is FOR — the sense that a room
  // is full — at every headcount, and it avoids paging, which asks somebody to navigate a
  // display nobody has a task in. Past the floor the tail collapses into a single "+N" chip
  // that opens a roster, because a list with names answers "who is here" far better than
  // page three of a face grid.
  //
  // Reactions are unaffected either way: they fly over the video from anyone, on screen or
  // not. What a hidden member loses is the highlight ring on their own bubble, nothing more.
  const BUBBLE_SIZES = [58, 48, 40, 34, 28];

  let moreBtn: HTMLButtonElement | null = null;

  const fitGrid = () => {
    const count = bubbles.size;
    if (!count) return;

    // clientWidth is 0 while this panel or any ancestor is hidden, and flex then reports every
    // bubble on a single row — a capacity of "everything", dressed up as a measurement. Bail
    // rather than act on it; fitGrid runs again on the next roster or resize.
    const width = grid.clientWidth;
    if (width <= 0) return;

    const styles = getComputedStyle(grid);
    const gap = parseFloat(styles.columnGap || styles.gap) || 0;
    // Read the height ceiling from the stylesheet instead of repeating `42vh` here. Two
    // constants that must agree is a bug waiting for the day one of them moves, and this one
    // would fail silently — the wall would just quietly start scrolling again.
    const maxH = parseFloat(styles.maxHeight);
    const height = Number.isFinite(maxH) ? maxH : grid.clientHeight;

    const capacity = (size: number) => {
      const perRow = Math.max(1, Math.floor((width + gap) / (size + gap)));
      const rows = Math.max(1, Math.floor((height + gap) / (size + gap)));
      return perRow * rows;
    };

    let size = BUBBLE_SIZES[BUBBLE_SIZES.length - 1];
    for (const s of BUBBLE_SIZES) {
      if (capacity(s) >= count) { size = s; break; }
    }
    const fits = capacity(size);

    grid.style.setProperty("--room-bubble", `${size}px`);

    // One slot goes to the chip itself. Without that the "+N" pushes a face off the bottom
    // and the count is wrong by one, in the direction that reads as a bug.
    const overflowing = count > fits;
    const shown = overflowing ? Math.max(1, fits - 1) : count;

    let i = 0;
    for (const b of bubbles.values()) {
      b.el.classList.toggle("room-overflow", i >= shown);
      i++;
    }

    if (!overflowing) {
      moreBtn?.remove();
      moreBtn = null;
      return;
    }

    if (!moreBtn) {
      moreBtn = document.createElement("button");
      moreBtn.type = "button";
      moreBtn.className = "room-more";
      moreBtn.addEventListener("click", openRoster);
    }
    let visible = shown;
    const paintChip = () => {
      const hidden = count - visible;
      moreBtn!.textContent = `+${hidden}`;
      moreBtn!.setAttribute("aria-label", `${hidden} more people — show everyone`);
      moreBtn!.title = `${hidden} more watching`;
      // Always last. appendChild on an element already in the grid MOVES it, which is exactly
      // what is wanted when somebody joins and the chip would otherwise sit mid-wall.
      grid.appendChild(moreBtn!);
    };
    paintChip();

    // The chip is WIDER THAN A BUBBLE — it is a pill carrying "+120", not a 28px circle — so
    // reserving one bubble-sized slot for it is not always enough. On a 390px phone at the
    // 28px floor it wrapped onto a tenth row and the wall scrolled again, which is the exact
    // failure this whole function exists to prevent, arriving one step later.
    //
    // Measured rather than predicted: the chip's width depends on its own text, its padding
    // and the font, and any arithmetic here would be a second copy of the stylesheet that
    // drifts the first time one of those changes. Hide one more face, re-measure, repeat.
    // Bounded at three because that is already more slack than a pill can need, and an
    // unbounded loop reading scrollHeight is a hang rather than a bug.
    for (let guard = 0; guard < 3 && grid.scrollHeight > grid.clientHeight + 1 && visible > 1; guard++) {
      visible--;
      let j = 0;
      for (const b of bubbles.values()) {
        b.el.classList.toggle("room-overflow", j >= visible);
        j++;
      }
      paintChip();
    }
  };

  // --- the roster ---------------------------------------------------------------------

  let rosterBack: HTMLElement | null = null;

  function onRosterKey(e: KeyboardEvent): void {
    if (e.key === "Escape") closeRoster();
  }

  function closeRoster(): void {
    window.removeEventListener("keydown", onRosterKey);
    rosterBack?.remove();
    rosterBack = null;
  }

  function openRoster(): void {
    closeRoster();

    const back = document.createElement("div");
    back.className = "room-roster-back";
    back.innerHTML = `
      <div class="room-roster" role="dialog" aria-modal="true" aria-label="Everyone watching">
        <div class="room-roster-head">
          <span class="room-roster-title">In the room</span>
          <span class="room-roster-count"></span>
          <button type="button" class="room-roster-close" aria-label="Close">&times;</button>
        </div>
        <input type="text" class="room-roster-search" placeholder="Search names" autocomplete="off">
        <ul class="room-roster-list"></ul>
      </div>`;

    const list = back.querySelector(".room-roster-list") as HTMLElement;
    const search = back.querySelector(".room-roster-search") as HTMLInputElement;
    (back.querySelector(".room-roster-count") as HTMLElement).textContent = String(bubbles.size);

    const paint = (q: string) => {
      const needle = q.trim().toLowerCase();
      list.replaceChildren();
      let shown = 0;
      for (const b of bubbles.values()) {
        const name = b.label.textContent ?? "";
        if (needle && !name.toLowerCase().includes(needle)) continue;
        const li = document.createElement("li");
        const img = document.createElement("img");
        // Reuse the bubble's already-decoded data URL rather than re-opening the sealed
        // avatar: identical bytes, and opening it twice is work for nothing.
        img.src = b.img.getAttribute("src") ?? "";
        img.alt = "";
        const span = document.createElement("span");
        // textContent, never innerHTML — this name came from another participant.
        span.textContent = name;
        li.append(img, span);
        list.append(li);
        shown++;
      }
      if (!shown) {
        const p = document.createElement("p");
        p.className = "room-roster-empty";
        p.textContent = needle ? "Nobody by that name." : "Nobody has joined yet.";
        list.append(p);
      }
    };

    paint("");
    search.addEventListener("input", () => paint(search.value));
    back.querySelector(".room-roster-close")?.addEventListener("click", closeRoster);
    // Dismiss on the backdrop, and only the backdrop: a click inside the dialog that lands on
    // padding must not close it out from under someone mid-search.
    back.addEventListener("click", (e) => { if (e.target === back) closeRoster(); });

    document.body.appendChild(back);
    rosterBack = back;
    window.addEventListener("keydown", onRosterKey);
    search.focus();
  }

  // Re-fit on a window change, not only on a roster change: rotating a phone or dragging a
  // window narrower changes how many fit per row, and without this the bubbles keep the size
  // chosen for the old width and the panel quietly starts scrolling again.
  let fitTimer: number | undefined;
  const onResize = () => {
    window.clearTimeout(fitTimer);
    fitTimer = window.setTimeout(fitGrid, 120);
  };
  window.addEventListener("resize", onResize);

  // A window listener alone is not enough, and the gap is the ordinary path rather than an
  // edge case. The room panel is built while it is still `.hidden`, so the first roster
  // arrives at zero width and fitGrid() correctly refuses to measure — and then nothing ever
  // asks it again, because showing the panel fires no window resize. The wall would sit at
  // the default 58px however many people were in it.
  //
  // Watching the grid itself catches both: the width it gains when the panel is revealed, and
  // any later change from the window being dragged narrower.
  const gridObserver = new ResizeObserver(onResize);
  gridObserver.observe(grid);

  // --- reactions --------------------------------------------------------------------

  /** Screenshot #95: the reaction takes over the sender's circle for a few seconds. */
  const badgeReaction = (r: RoomReaction) => {
    const b = bubbles.get(r.from);
    if (!b) return;
    if (b.timer) clearTimeout(b.timer);
    b.badge.classList.remove("hidden");
    if (r.emoji) {
      b.badge.textContent = r.emoji;
      b.badge.style.backgroundImage = "";
    } else if (r.image) {
      b.badge.textContent = "";
      b.badge.style.backgroundImage = `url("${avatarToDataUrl(r.image)}")`;
    }
    b.el.classList.add("reacting");
    b.timer = window.setTimeout(() => {
      b.badge.classList.add("hidden");
      b.badge.style.backgroundImage = "";
      b.el.classList.remove("reacting");
      b.timer = null;
    }, BUBBLE_REACTION_MS);
  };

  /** Screenshots #93/#94: it also drifts up across the video. */
  const flyReaction = (r: RoomReaction) => {
    if (reduceMotion || flying >= MAX_FLYING) return;
    const el = document.createElement(r.emoji ? "span" : "img");
    el.className = "room-fly";
    if (r.emoji) {
      el.textContent = r.emoji;
    } else if (r.image) {
      (el as HTMLImageElement).src = avatarToDataUrl(r.image);
      (el as HTMLImageElement).alt = "";
    }
    // Spread the launch point so a burst does not stack into one column.
    el.style.left = `${8 + Math.random() * 74}%`;
    el.style.setProperty("--drift", `${(Math.random() * 2 - 1) * 60}px`);
    el.style.animationDuration = `${2.6 + Math.random() * 1.2}s`;
    flying++;
    el.addEventListener("animationend", () => {
      el.remove();
      flying--;
    });
    stage.appendChild(el);
  };

  const onReaction = (r: RoomReaction) => {
    badgeReaction(r);
    flyReaction(r);
  };

  // --- hands and the floor ----------------------------------------------------------------

  let isHost = false;
  let handUp = false;
  let hands: string[] = [];
  let floor: string | null = null;
  let sender: GuestPublication | null = null;
  let receiver: GuestSubscription | null = null;
  /** Set for the length of a turn, on the speaker's page and the host's. Null everywhere else. */
  let guestMedia: GuestMedia | null = null;

  const nameOf = (id: string) => bubbles.get(id)?.label.textContent || "Someone";

  const renderHands = () => {
    for (const [id, b] of bubbles) b.el.classList.toggle("hand-up", hands.includes(id));

    queueCount.textContent = String(hands.length);
    queueList.replaceChildren();
    for (const id of hands) {
      const li = document.createElement("li");
      li.className = "room-queue-item";

      const face = document.createElement("img");
      face.className = "room-queue-face";
      face.alt = "";
      const av = knownAvatar(id);
      if (av) face.src = avatarToDataUrl(av);

      const label = document.createElement("span");
      label.className = "room-queue-name";
      label.textContent = nameOf(id); // textContent: another participant's chosen name

      const call = document.createElement("button");
      call.type = "button";
      call.className = "room-queue-call";
      call.textContent = floor === id ? "Speaking" : "Call on";
      call.disabled = floor === id;
      call.addEventListener("click", () => room.call(id));

      li.append(face, label, call);
      queueList.appendChild(li);
    }

    if (!hands.length) {
      const li = document.createElement("li");
      li.className = "room-queue-empty";
      li.textContent = "No hands up.";
      queueList.appendChild(li);
    }
  };

  const knownAvatar = (id: string): AvatarImage | null => {
    const b = bubbles.get(id);
    const src = b?.img.getAttribute("src") ?? "";
    if (!src.startsWith("data:")) return null;
    const m = src.match(/^data:([^;]+);base64,(.*)$/);
    return m ? { m: m[1], b: m[2], src: "anon" } : null;
  };

  const setHand = (up: boolean) => {
    handUp = up;
    room.setHand(up);
    handBtn.classList.toggle("toggle-on", up);
    handBtn.textContent = up ? "✋ Lower hand" : "✋ Raise hand";
  };

  /**
   * Start or stop actually talking.
   *
   * The microphone opens ONLY for the person who holds the floor, and only after the server
   * said so — `floor` is set from the DO's broadcast, never optimistically on the click that
   * requested it. A speaker whose page decided locally that it had the floor would be a live
   * microphone the presenter never granted.
   */
  /**
   * Being called on OFFERS the microphone. It does not open it.
   *
   * This step is the whole consent story, and it exists because browser microphone permission
   * is granted per ORIGIN and PERSISTS. Anyone who has ever allowed the microphone on
   * vivoh.earth would get no second prompt from the browser — `getUserMedia` would simply
   * succeed and audio would start flowing into a live broadcast. The gap between raising a
   * hand and being called can be many minutes; the hand may have been raised by accident; the
   * person may have walked away from the desk.
   *
   * It also closes a subtler hole for free. The server deliberately lets a host call on
   * someone who never raised a hand — "Sarah, what do you think?" is an ordinary thing to do
   * in a town hall, and forbidding it server-side would have cost a real flow. What makes
   * that safe is not a restriction on the host but this prompt: it does not matter who the
   * host picked or why, because no microphone opens until the person themselves agrees.
   *
   * Consequence worth stating: a host cannot unmute anybody. Only a viewer can.
   */
  const offerMic = () => {
    if (sender) return; // already speaking
    inviteText.textContent = "You've been asked to speak. Your microphone stays off until you choose.";
    invite.classList.remove("hidden");
    // Focus the affirmative control so a keyboard user can accept without hunting, but do NOT
    // make it a default-submit: accepting must be a deliberate press.
    inviteYes.focus({ preventScroll: true });
  };

  const hideInvite = () => {
    invite.classList.add("hidden");
  };

  /**
   * Accepting a turn. `withVideo` is the SECOND consent decision, and it is separate on purpose:
   * a camera is strictly more exposing than a microphone, so it is never the default and never
   * implied by Unmute.
   */
  const startSpeaking = async (withVideo: boolean) => {
    if (sender) return;
    hideInvite();
    speakingText.textContent = "Connecting…";
    speakingBar.classList.remove("hidden");

    const media = guestMedia;
    if (!media) {
      // The floor was granted but no token came with it, which means the CDN is unconfigured on
      // this deployment. Say so rather than pretending a turn is running.
      speakingText.textContent =
        "This broadcast cannot carry live questions right now. Ask in chat instead.";
      room.drop();
      return;
    }

    try {
      // The <moq-publish> element opens the devices itself; this call is what puts it on the
      // page, so it is the thing that must stay behind the accept click. The browser's own
      // permission prompt follows it.
      sender = await startGuestPublish({
        media,
        withVideo,
        secret: opts.linkSecret(),
        streamId: opts.streamId,
        salt: opts.salt(),
        guestId: room.myId(),
        onError: () => {
          speakingText.textContent =
            "Something went wrong publishing your turn — the presenter may not be able to hear you.";
        },
      });
    } catch (e) {
      console.error("[room] guest publish failed", e);
      speakingText.textContent = "Could not start your turn. Try asking to be called on again.";
      room.drop();
      return;
    }

    // DO NOT CLAIM "you're live" HERE. The first version did, on the strength of the publish
    // call having resolved — and it resolved happily while nothing was attached and nothing was
    // being published, so a guest was told they were on air and was not. The bar now says only
    // what is known, and upgrades itself when the presenter's subscription actually starts
    // carrying frames, which is the first moment anyone can honestly say it.
    speakingText.textContent = withVideo
      ? "Starting your microphone and camera…"
      : "Starting your microphone…";
  };

  const stopSpeaking = () => {
    // Removing the element releases the devices it opened, which is what clears the browser's
    // recording indicator. A turn that ends without that reads as "this site is still listening".
    sender?.stop();
    sender = null;
    hideInvite();
    speakingBar.classList.add("hidden");
    speakingText.textContent = "";
  };

  /** The host's side: subscribe to the guest and put them into the outgoing broadcast. */
  const startHearing = async () => {
    if (receiver) return;
    const media = guestMedia;
    const mix = opts.mix?.() ?? null;
    if (!media) return;
    if (!mix) {
      // Room on, but nothing is being captured yet, so there is no outgoing mix to join. The
      // presenter can still hand out the floor; the guest reaches nobody until the broadcast
      // starts. Saying so beats a silent no-op that looks like a broken guest.
      console.warn("[room] a guest was called on before this broadcast had a mix; nobody will hear them yet");
      return;
    }
    try {
      receiver = await startGuestSubscribe({
        media,
        mix,
        secret: opts.linkSecret(),
        streamId: opts.streamId,
        salt: opts.salt(),
        guestId: floor ?? "",
        // Shown in the presenter's queue panel. Two live tests failed with nothing to go on but
        // "no video"; the presenter is the one person who can see both ends, so they get the
        // verdict rather than a console nobody was watching.
        onStatus: (text, ok) => {
          queueCount.title = text;
          const el = queueList.querySelector(".room-queue-diag") ?? (() => {
            const li = document.createElement("li");
            li.className = "room-queue-diag";
            queueList.appendChild(li);
            return li;
          })();
          // BOTH SIDES, always. The subscriber saying "arriving" while the compositor holds
          // nothing is precisely the failure this line exists to make visible, so the draw
          // layer's own answer is printed next to it rather than inferred from it.
          const draw = opts.guestState?.() ?? "unknown";
          el.textContent = ok
            ? `Guest video arriving · compositor: ${draw}`
            : `${text} · compositor: ${draw}`;
        },
      });
      opts.setGuestVideo?.(receiver.canvas);
    } catch (e) {
      console.error("[room] guest subscribe failed", e);
    }
  };

  const stopHearing = () => {
    opts.setGuestVideo?.(null);
    receiver?.stop();
    receiver = null;
  };

  const applyFloor = (id: string | null, media: GuestMedia | null) => {
    floor = id;
    // Held for the turn. Whoever receives one — the speaker gets a publish token, the host a
    // subscribe token — uses it to reach cdn.moq.pro directly; everyone else gets null and
    // simply renders a ring on a bubble.
    guestMedia = media;
    for (const [bid, b] of bubbles) b.el.classList.toggle("speaking", bid === id);

    const mine = id !== null && id === room.myId();
    // OFFER, never open. startSpeaking() runs only from the accept buttons below.
    if (mine) offerMic();
    else stopSpeaking();

    // The host decodes whoever is up. Torn down and rebuilt between speakers rather than
    // reused: a fresh decoder starts with an empty jitter buffer, so the next person does not
    // inherit the last one's scheduling lead.
    if (isHost) {
      stopHearing();
      if (id) void startHearing();
    }

    // Holding the floor lowers your own hand — the server already removed it from the queue,
    // and leaving the button reading "Lower hand" would be the UI disagreeing with the room.
    if (mine && handUp) {
      handUp = false;
      handBtn.classList.remove("toggle-on");
      handBtn.textContent = "✋ Raise hand";
    }
    renderHands();
  };

  handBtn.addEventListener("click", () => setHand(!handUp));
  speakingDone.addEventListener("click", () => room.drop());

  // The click that opens the microphone is also the user gesture that lets iOS resume an
  // AudioContext. Calling getUserMedia straight from this handler — rather than after an
  // await — keeps that activation intact; a suspended context captures silence.
  inviteYes.addEventListener("click", () => void startSpeaking(false));
  inviteCam.addEventListener("click", () => void startSpeaking(true));

  // Declining releases the floor, so the presenter's queue moves on rather than waiting on
  // somebody who has stepped away. They keep their place in no queue — the hand is already
  // down — and can simply raise it again.
  inviteNo.addEventListener("click", () => {
    hideInvite();
    room.drop();
  });

  // --- breakout rooms -----------------------------------------------------------------
  //
  // Three separate things share this strip, and which of them you see depends on who you are:
  // the broadcaster gets the toggle that delegates the permission, a signed-in attendee gets
  // the button that uses it, and an anonymous one gets told why they do not.

  const bo = opts.breakouts;

  const paintBreakout = () => {
    if (!bo) return;                       // deployment or page without the feature at all
    const on = bo.enabled();
    const isBroadcaster = !!bo.setEnabled;

    // The strip exists for a broadcaster whether or not the toggle is on — it is where they
    // turn it on. For everyone else it exists only while it is on.
    boPanel.classList.toggle("hidden", !isBroadcaster && !on);
    boToggleLabel.classList.toggle("hidden", !isBroadcaster);
    boEnable.checked = on;

    boOpenRow.classList.toggle("hidden", isBroadcaster || !on);
    if (isBroadcaster || !on) return;

    if (!bo.signedIn) {
      // Shown rather than hidden. An attendee who can see other people opening side rooms and
      // has no control of their own should be told the reason is their account, not left to
      // conclude the feature is broken.
      boText.textContent = "Sign in to open a breakout room of your own.";
      boBtn.classList.add("hidden");
      return;
    }
    boBtn.classList.remove("hidden");
    boBtn.disabled = false;
    boText.textContent = "Start a side conversation. You broadcast it; this one keeps playing.";
  };

  boEnable.addEventListener("change", () => {
    if (!bo?.setEnabled) return;
    const want = boEnable.checked;
    boEnable.disabled = true;
    void bo.setEnabled(want).then(
      (ok) => {
        boEnable.disabled = false;
        // Follow the SERVER's answer, not the click. A checkbox that stays ticked after the
        // save failed is a broadcaster believing they delegated something they did not.
        if (!ok) boEnable.checked = !want;
        paintBreakout();
      },
      () => {
        boEnable.disabled = false;
        boEnable.checked = !want;
        paintBreakout();
      }
    );
  });

  boBtn.addEventListener("click", () => {
    if (!bo?.create) return;
    boBtn.disabled = true;
    boBtn.textContent = "Opening…";
    void bo.create().then(
      (res) => {
        boBtn.textContent = "Open a breakout";
        boBtn.disabled = false;
        if (!res.streamId) {
          boText.textContent = res.error ?? "Could not open a breakout room.";
          return;
        }
        // A NEW TAB, deliberately: this page is still playing the main event, and the whole
        // shape of the feature is that a person is in both at once. `from=` is what lets the
        // new tab find this one over the channel and show the roster.
        //
        // noopener would sever window.opener, which we do not use — but it also drops the
        // new tab into a separate process on some browsers, and the BroadcastChannel works
        // either way. Kept for the usual reason.
        window.open(
          `/?stream=${res.streamId}&from=${encodeURIComponent(opts.streamId)}#NOT-THE-SHARE-LINK--USE-THE-COPY-BUTTON`,
          "_blank",
          "noopener"
        );
        boText.textContent = "Your breakout is open in a new tab. Invite people from there.";
      },
      () => {
        boBtn.textContent = "Open a breakout";
        boBtn.disabled = false;
        boText.textContent = "Could not open a breakout room.";
      }
    );
  });

  let pendingInvite: { streamId: string } | null = null;
  const hideBoInvite = () => {
    pendingInvite = null;
    boInvite.classList.add("hidden");
  };
  boInviteNo.addEventListener("click", hideBoInvite);
  boInviteYes.addEventListener("click", () => {
    const target = pendingInvite?.streamId;
    hideBoInvite();
    // Opened as a VIEWER — the plain watch URL. The person who accepted an invite is joining
    // somebody else's room, not starting their own, and the Worker would refuse them the
    // publish grant anyway.
    if (target) window.open(`/${target}`, "_blank", "noopener");
  });

  paintBreakout();

  // --- the connection ---------------------------------------------------------------

  const room: RoomHandle = initRoom({
    streamId: opts.streamId,
    routeTag: opts.routeTag,
    roomKey: opts.roomKey,
    callbacks: {
      onRoster: (members) => {
        for (const b of bubbles.values()) {
          if (b.timer) clearTimeout(b.timer);
          b.el.remove();
        }
        bubbles.clear();
        for (const m of members) upsert(m);
        placeholder();
        fitGrid();
      },
      onJoin: (m) => { upsert(m); fitGrid(); renderHands(); },
      // onUpdate cannot change the headcount — a name or picture changed on somebody already
      // here — so it deliberately does not re-fit. Re-fitting would read layout on every
      // avatar change, which in a busy room is a great many forced reflows for no move.
      onUpdate: upsert,
      onLeave: (id) => { remove(id); fitGrid(); renderHands(); },
      onReaction,
      onStatus: (online) => container.classList.toggle("room-offline", !online),
      onReady: (host) => {
        isHost = host;
        // The presenter sees the queue as soon as the socket is up, before joining — they
        // need to watch hands go up whether or not they put their own face in the grid.
        queuePanel.classList.toggle("hidden", !host);
        if (host) renderHands();
      },
      onHands: (ids) => {
        hands = ids;
        // Trust the server's list over the local button. If a reconnect or a call-on dropped
        // this client's hand, the queue is the truth and the button follows it.
        const stillUp = ids.includes(room.myId());
        if (stillUp !== handUp) {
          handUp = stillUp;
          handBtn.classList.toggle("toggle-on", stillUp);
          handBtn.textContent = stillUp ? "✋ Lower hand" : "✋ Raise hand";
        }
        renderHands();
      },
      onFloor: applyFloor,
      // Audio no longer arrives here: a guest's voice rides their own moq.pro broadcast, which
      // the host subscribes to. The DO's audio relay stays in the protocol for now but nothing
      // sends on it; it is removed once the CDN path is confirmed live.
      onAudio: () => {},
      onInvite: (inv) => {
        // Resolve the sender against the roster so the prompt says a person's name. Falling
        // back to "Someone" rather than showing a raw socket id, which means nothing to
        // anybody and looks like a bug.
        const who = members.get(inv.from)?.name?.trim();
        pendingInvite = { streamId: inv.streamId };
        boInviteText.textContent = who
          ? `${who} invited you to a breakout room.`
          : "You have been invited to a breakout room.";
        boInvite.classList.remove("hidden");
      },
      onFull: (cap) => {
        joinBox.classList.remove("hidden");
        joinBtn.disabled = true;
        (container.querySelector(".room-join-text") as HTMLElement).textContent =
          `This room is full (${cap} people). You can keep watching, but you will not appear in the grid.`;
      },
    },
  });

  placeholder();

  // Serve the roster to any breakout tab this page opens. Created unconditionally — it is a
  // cheap same-origin channel and the creator may open a breakout at any time — but it only
  // ever carries data this tab is already displaying.
  bridge = serveBreakoutBridge({
    parentStreamId: opts.streamId,
    roster: () => ({ members: [...members.values()], meName: displayName }),
    relay: (ids, streamId, title) => room.inviteToBreakout(ids, streamId, title),
  });

  // --- joining ----------------------------------------------------------------------

  /**
   * Pick the best picture available without asking.
   *
   * Signed in, we already have a provider picture and using it is the least friction. Signed
   * out, the locally drawn silhouette contacts nothing. Either way the participant can swap
   * to a GIF afterwards — the point is that Join never blocks on a picker.
   */
  const defaultAvatar = async (): Promise<AvatarImage | null> => {
    if (user) {
      const a = await oauthAvatar();
      if (a) return a;
    }
    return anonAvatar(displayName);
  };

  const join = async () => {
    const typed = nameInput.value.trim().slice(0, 32);
    displayName = typed || displayName;
    localStorage.setItem(NAME_KEY, displayName);

    joinBtn.disabled = true;
    joinBtn.textContent = "Joining…";
    myAvatar = await defaultAvatar();
    if (destroyed) return;
    await room.setPresence(displayName, myAvatar);
    joined = true;
    joinBox.classList.add("hidden");
    bar.classList.remove("hidden");
  };

  joinBtn.addEventListener("click", () => void join());
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void join();
    }
  });

  throwBtn.addEventListener("click", () => void room.reactWithAvatar());

  // --- the GIF picker ---------------------------------------------------------------

  let gifTimer: ReturnType<typeof setTimeout> | null = null;

  const renderGifs = (gifs: Array<{ id: string; title: string; url: string }>) => {
    gifResults.replaceChildren();
    for (const g of gifs) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "room-gif-item";
      const img = document.createElement("img");
      // Through our proxy, so browsing the picker does not put this viewer's IP in front of
      // Giphy — the same reason the bytes travel sealed once chosen.
      img.src = `/api/giphy/img?u=${encodeURIComponent(g.url)}`;
      img.alt = g.title;
      img.loading = "lazy";
      b.appendChild(img);
      b.addEventListener("click", () => void chooseGif(g.url));
      gifResults.appendChild(b);
    }
  };

  const searchGifs = async (q: string) => {
    gifNote.textContent = "Searching…";
    try {
      const res = await fetch(`/api/giphy?q=${encodeURIComponent(q)}`);
      const data = (await res.json()) as {
        enabled?: boolean;
        gifs?: Array<{ id: string; title: string; url: string }>;
        error?: string;
      };
      if (!data.enabled) {
        gifNote.textContent = "GIFs are not configured on this server. Emoji reactions still work.";
        gifResults.replaceChildren();
        return;
      }
      if (data.error || !data.gifs?.length) {
        gifNote.textContent = data.error ? "Giphy is not answering right now." : "Nothing found.";
        gifResults.replaceChildren();
        return;
      }
      gifNote.textContent = "";
      renderGifs(data.gifs);
    } catch {
      gifNote.textContent = "Could not reach the GIF search.";
    }
  };

  const chooseGif = async (url: string) => {
    gifNote.textContent = "Preparing…";
    const a = await giphyAvatar(url);
    if (destroyed) return;
    if (!a) {
      gifNote.textContent = "That one could not be used. Try another.";
      return;
    }
    myAvatar = a;
    gifNote.textContent = "";
    gifPanel.classList.add("hidden");
    if (joined) await room.setPresence(displayName, myAvatar);
  };

  gifBtn.addEventListener("click", () => {
    const opening = gifPanel.classList.contains("hidden");
    gifPanel.classList.toggle("hidden", !opening);
    if (opening && !gifResults.childElementCount) void searchGifs("");
  });
  gifClose.addEventListener("click", () => gifPanel.classList.add("hidden"));
  gifQ.addEventListener("input", () => {
    if (gifTimer) clearTimeout(gifTimer);
    gifTimer = setTimeout(() => void searchGifs(gifQ.value.trim()), 350);
  });

  return {
    destroy() {
      destroyed = true;
      if (gifTimer) clearTimeout(gifTimer);
      window.clearTimeout(fitTimer);
      window.removeEventListener("resize", onResize);
      gridObserver.disconnect();
      // The roster lives on <body>, not in `container`, so replaceChildren() below would
      // leave it on screen over a room that no longer exists.
      closeRoster();
      // Tells any breakout tab that its source of invites has gone, so it shows that rather
      // than dropping clicks into a channel nobody is listening on.
      bridge?.close();
      bridge = null;
      for (const b of bubbles.values()) if (b.timer) clearTimeout(b.timer);
      bubbles.clear();
      // Before the socket goes: releasing the microphone is the one piece of teardown with a
      // consequence outside this page. A closed room that leaves getUserMedia running keeps
      // the browser's recording indicator lit, which reads as "this site is still listening".
      stopSpeaking();
      stopHearing();
      room.destroy();
      container.replaceChildren();
      for (const el of Array.from(stage.querySelectorAll(".room-fly"))) el.remove();
    },
  };
}
