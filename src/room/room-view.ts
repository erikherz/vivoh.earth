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
import { initRoom, type RoomHandle, type RoomMember, type RoomReaction } from "./room-client";

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
      onJoin: upsert,
      onUpdate: upsert,
      onLeave: remove,
      onReaction,
      onStatus: (online) => container.classList.toggle("room-offline", !online),
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
      room.destroy();
      container.replaceChildren();
      for (const el of Array.from(stage.querySelectorAll(".room-fly"))) el.remove();
    },
  };
}
