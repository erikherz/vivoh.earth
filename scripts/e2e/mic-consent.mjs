// Nothing but a click may open a microphone.
//
//   node scripts/e2e/mic-consent.mjs
//
// This is a SOURCE guard, not a browser test, and that is deliberate — the property it
// protects is structural, and the thing most likely to break it is an ordinary-looking edit
// rather than a runtime condition.
//
// The property: `getUserMedia` lives behind exactly one door. `startVoiceSender()` is the
// only caller of it; `startSpeaking()` is the only caller of that; and `startSpeaking()` must
// be reachable from precisely one place — the Unmute button's click handler. Being granted
// the floor must only ever OFFER the microphone.
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
const VOICE = path.join(ROOT, "src/room/voice.ts");

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? ` (${detail})` : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`); }
};

const view = fs.readFileSync(VIEW, "utf8");
const voice = fs.readFileSync(VOICE, "utf8");

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
    line = line.replace(/\/\/.*$/, "");

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
const voiceCode = codeLines(voice);

console.log("microphone consent — the call site is the control\n");

// 1. getUserMedia has exactly one home.
const gumLines = [...viewCode, ...voiceCode].filter((l) => l.line.includes("getUserMedia"));
check(
  "getUserMedia appears in exactly one place in the room code",
  gumLines.length === 1,
  gumLines.map((l) => `line ${l.n}`).join(", ") || "none found"
);

// 2. ...and it is inside startVoiceSender, which has one caller.
const senderCalls = viewCode.filter((l) => l.line.includes("startVoiceSender("));
check(
  "startVoiceSender is called from exactly one place",
  senderCalls.length === 1,
  senderCalls.map((l) => `line ${l.n}`).join(", ")
);

// 3. THE ONE THAT MATTERS. startSpeaking is invoked once, and only by the Unmute handler.
//    A definition (`const startSpeaking = `) is not an invocation and must not count.
const speakInvocations = viewCode.filter(
  (l) => /\bstartSpeaking\(\)/.test(l.line) && !/const\s+startSpeaking/.test(l.line)
);
check(
  "startSpeaking() is invoked from exactly one place",
  speakInvocations.length === 1,
  speakInvocations.map((l) => `line ${l.n}`).join(", ")
);

const invokedFromUnmute =
  speakInvocations.length === 1 && /inviteYes\.addEventListener/.test(speakInvocations[0].line);
check(
  "and that place is the Unmute button's click handler",
  invokedFromUnmute,
  speakInvocations[0]?.line.trim().slice(0, 72)
);

// 4. Being granted the floor offers; it does not open.
const floorBody = view.slice(view.indexOf("const applyFloor"), view.indexOf("handBtn.addEventListener"));
check(
  "applyFloor offers the microphone rather than starting it",
  /offerMic\(\)/.test(floorBody) && !/startSpeaking\(\)/.test(floorBody.replace(/\/\/.*$/gm, "")),
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
