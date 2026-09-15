// Nothing but a click may open a microphone.
//
//   node scripts/e2e/mic-consent.mjs
//
// This is a SOURCE guard, not a browser test, and that is deliberate — the property it
// protects is structural, and the thing most likely to break it is an ordinary-looking edit
// rather than a runtime condition.
//
// The property: nothing in our room code opens a device, and the ONE thing that causes a device
// to open — creating a capturing <moq-publish> element — happens in exactly one function, which
// is reachable only from the accept buttons. Being granted the floor must only ever OFFER.
//
// RESTATED AGAIN 14 Sep 2026, after the first live test. We had been handing @moq a MediaStream
// obtained ourselves; that API does not exist. `source` is an attribute taking "camera" |
// "screen" | "file", and the element calls getUserMedia itself. So `getUserMedia` left our code
// entirely and this guard's first assertion — "appears in exactly one place" — became FALSE by
// being satisfied zero times. The consent boundary did not move; only the thing that crosses it
// did, so the assertion had to follow it rather than be relaxed.
//
// RESTATED 14 Sep 2026, when the guest leg moved onto moq.pro. This guard went red on that
// change and it was right to: capture moved out of voice.ts into room-view.ts, and a second
// accept button appeared for video. Both facts needed saying out loud rather than being absorbed
// by loosening an assertion. The camera button is the reason the count is two and not one, and
// it is checked BY NAME below so that "two call sites" cannot quietly become two of anything.
//
// RESTATED 15 Sep 2026, and this one reverses the September 14 restatement. `getUserMedia` is
// back in our code, on purpose: a phone held in portrait published video lying on its side,
// because where MediaStreamTrackProcessor is missing @moq/publish falls back to
// `new VideoFrame(videoElement)`, which on iOS Safari returns un-rotated sensor pixels. The
// cure is to capture ourselves and draw through a canvas, exactly as the broadcaster's
// compositor already does — so `source="camera"` is gone and the count of getUserMedia calls
// went from zero back to one.
//
// The consent boundary has still not moved, which is the only thing this file is about. What
// changed is which side of it the device-opening call sits on, so the assertions below follow
// it: instead of "no getUserMedia anywhere", it is now "exactly one, and it is inside
// startGuestPublish" — a function already proven to be reachable from nowhere but the two
// accept buttons. Loosening to "at most one, anywhere" would have been the wrong repair, and
// deleting the check because it went red would have been worse.
//
// Why this needs guarding at all: browser microphone permission is per-origin and PERSISTS.
// For anyone who has previously allowed the microphone on vivoh.earth, a stray
// `startSpeaking()` in the floor handler produces no prompt, no error and no visible
// difference during development — it just silently opens a live microphone on a viewer who
// never agreed. There is no runtime signal to test for. The call site IS the control.
//
// A browser test cannot cover this today anyway: driving a real room needs a live broadcast,
// and OAuth is the only publisher door (task #87).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VIEW = path.join(ROOT, "src/room/room-view.ts");
const PUBLISH = path.join(ROOT, "src/room/guest-media.ts");

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? ` (${detail})` : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`); }
};

const view = fs.readFileSync(VIEW, "utf8");
const publish = fs.readFileSync(PUBLISH, "utf8");

/**
 * Lines that actually execute, with comments and the inline HTML template removed.
 *
 * Without this the guard reads its own explanatory prose as evidence and passes on the
 * strength of a comment mentioning the function — which is precisely the failure mode of a
 * test that cannot fail.
 */
const codeLines = (src) => {
  const out = [];
  let inBlockComment = false;
  let inTemplate = false;
  src.split("\n").forEach((raw, i) => {
    let line = raw;
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) return;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    line = line.replace(/\/\*[\s\S]*?\*\//g, "");
    const open = line.indexOf("/*");
    if (open !== -1) { inBlockComment = true; line = line.slice(0, open); }
    // NOT a bare //-to-end-of-line strip: `https://` contains one. That bug silently ate the
    // closing backtick of guest-media.ts's URL template, left an odd count, flipped the
    // template flag on and swallowed the entire rest of the file — so this guard reported
    // "getUserMedia appears in exactly one place" while a second one sat twenty lines below
    // the blind spot. Found by sabotage, which is the only reason it was found at all.
    line = line.replace(/(^|[^:\w])\/\/.*$/, "$1");

    // The component's markup is one big template literal; `container.innerHTML = \`` opens it.
    if (inTemplate) {
      if (line.includes("`")) { inTemplate = false; line = line.slice(line.indexOf("`") + 1); }
      else return;
    }
    const tick = line.indexOf("`");
    if (tick !== -1 && (line.match(/`/g) || []).length === 1) {
      inTemplate = true;
      line = line.slice(0, tick);
    }
    if (line.trim()) out.push({ n: i + 1, line });
  });
  return out;
};

const viewCode = codeLines(view);
const publishCode = codeLines(publish);

console.log("microphone consent — the call site is the control\n");

// 1. EXACTLY ONE getUserMedia, and it is in the publish module — never in the view.
//    room-view.ts is where the floor handlers and the reaction bar live, i.e. all the code
//    that runs without anybody having agreed to anything. A device call appearing there is
//    the specific accident this guard exists to catch.
const viewGum = viewCode.filter((l) => l.line.includes("getUserMedia"));
check(
  "no getUserMedia in room-view (the code that runs without consent)",
  viewGum.length === 0,
  viewGum.map((l) => `line ${l.n}`).join(", ") || "none"
);

const publishGum = publishCode.filter((l) => l.line.includes("getUserMedia"));
check(
  "exactly one getUserMedia, in the publish module",
  publishGum.length === 1,
  publishGum.map((l) => `line ${l.n}`).join(", ") || "none found"
);

// 2. ...and it is inside startGuestPublish, not merely somewhere in the same file. A helper
//    added below that function would satisfy the count above while being callable from
//    anywhere, which is exactly the hole the count alone cannot see.
const startsAt = publishCode.findIndex((l) => /export async function startGuestPublish\(/.test(l.line));
const nextExport = publishCode.findIndex(
  (l, i) => i > startsAt && /^export (async )?function |^export const /.test(l.line)
);
const bodyEnd = nextExport === -1 ? publishCode.length : nextExport;
const insideStart = publishGum.every((g) => {
  const idx = publishCode.indexOf(g);
  return idx > startsAt && idx < bodyEnd;
});
check(
  "that getUserMedia is inside startGuestPublish, not a loose helper",
  startsAt !== -1 && insideStart,
  startsAt === -1
    ? "startGuestPublish not found"
    : startsAt !== -1 && insideStart
      ? `body spans ${publishCode[startsAt].n}..${bodyEnd === publishCode.length ? "EOF" : publishCode[bodyEnd].n}`
      : "found outside the function body"
);

// 3. ...and it is reached from exactly one call site, in room-view.
const publishCalls = viewCode.filter((l) => /startGuestPublish\(/.test(l.line));
check(
  "startGuestPublish is called from exactly one place",
  publishCalls.length === 1,
  publishCalls.map((l) => `line ${l.n}`).join(", ")
);

// 4. THE ONE THAT MATTERS. startSpeaking is invoked only by the accept handlers.
//    A definition (`const startSpeaking = `) is not an invocation and must not count.
const speakInvocations = viewCode.filter(
  (l) => /\bstartSpeaking\(/.test(l.line) && !/const\s+startSpeaking/.test(l.line)
);
check(
  "startSpeaking() is invoked from exactly two places",
  speakInvocations.length === 2,
  speakInvocations.map((l) => `line ${l.n}`).join(", ")
);

// Named individually rather than counted. "Two call sites" is satisfied by any two; what the
// property actually requires is that both are accept buttons a person has to press.
const fromAudio = speakInvocations.some((l) => /inviteYes\.addEventListener/.test(l.line));
const fromVideo = speakInvocations.some((l) => /inviteCam\.addEventListener/.test(l.line));
check("one is the audio accept button (inviteYes)", fromAudio);
check("the other is the video accept button (inviteCam)", fromVideo);

// A camera is strictly more exposing than a microphone, so the plain Unmute must not turn one
// on. If both buttons passed the same argument this whole second button would be theatre.
const audioCall = speakInvocations.find((l) => /inviteYes/.test(l.line))?.line ?? "";
const videoCall = speakInvocations.find((l) => /inviteCam/.test(l.line))?.line ?? "";
check(
  "plain Unmute asks for NO camera",
  /startSpeaking\(false\)/.test(audioCall),
  audioCall.trim().slice(0, 64)
);
check(
  "only the video button asks for one",
  /startSpeaking\(true\)/.test(videoCall),
  videoCall.trim().slice(0, 64)
);

// 4. Being granted the floor offers; it does not open.
const floorBody = view.slice(view.indexOf("const applyFloor"), view.indexOf("handBtn.addEventListener"));
check(
  "applyFloor offers the microphone rather than starting it",
  /offerMic\(\)/.test(floorBody) && !/startSpeaking\(/.test(floorBody.replace(/\/\/.*$/gm, "")),
  /offerMic\(\)/.test(floorBody) ? "calls offerMic()" : "does NOT call offerMic()"
);

// 5. Declining has to actually give the floor back, or the queue stalls on someone who left.
check(
  "declining releases the floor",
  /inviteNo\.addEventListener[\s\S]{0,200}room\.drop\(\)/.test(view),
  "inviteNo -> room.drop()"
);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
