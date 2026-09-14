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
}): RoomViewHandle {
  const { container, stage, user } = opts;

  let displayName = loadName(user);
  let myAvatar: AvatarImage | null = null;
  let joined = false;
  let destroyed = false;
  const bubbles = new Map<string, Bubble>();
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
    const b = bubbles.get(id);
    if (!b) return;
    if (b.timer) clearTimeout(b.timer);
    b.el.remove();
    bubbles.delete(id);
    placeholder();
  };

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
      },
      onJoin: (m) => { upsert(m); renderHands(); },
      onUpdate: upsert,
      onLeave: (id) => { remove(id); renderHands(); },
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
      onFull: (cap) => {
        joinBox.classList.remove("hidden");
        joinBtn.disabled = true;
        (container.querySelector(".room-join-text") as HTMLElement).textContent =
          `This room is full (${cap} people). You can keep watching, but you will not appear in the grid.`;
      },
    },
  });

  placeholder();

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
