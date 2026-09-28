import { JarvisSession, type ServerEvent, type SessionState } from "./session";
import { loadKey, saveKey, clearKey, authHeaders, isSession } from "./key";
import { History } from "./history";
import { Settings } from "./ui/Settings";
import { Devices } from "./ui/Devices";
import { Memory } from "./ui/Memory";
import { Routines } from "./ui/Routines";
import { Jobs } from "./ui/Jobs";
import { Stage, type DisplayPayload } from "./ui/Stage";
import { Orb } from "./orb/Orb";
import { VoiceLevels } from "./audio";
import { runDelegation } from "./delegate";
import { LiveLink, releasePush, speakAlert, speakHere, speakText, syncPush, type Alert } from "./alerts";
import { askTyped } from "./chat";
import { richText } from "./ui/util";
import { PushToTalk } from "./ptt";
import { LiveVoice, wakeVoice } from "./loud";
import { Family } from "./ui/Family";
import { Chat } from "./ui/Chat";
import { relayActions } from "./relay";
import { hubStatus, inviteInfo, joinWithInvite, pairThisScreen, signInWithPasskey } from "./account";
import { passkeyError, passkeysSupported } from "./passkey";
import { describe, dropPerson, endSignIn, keepPerson, loadPeople, lockPerson, unlockPerson, type Person } from "./people";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  orb: $("orb"),
  status: $("status"),
  hint: $("hint"),
  transcript: $("transcript"),
  log: $("log"),
  logWrap: $("logWrap"),
  audio: $<HTMLAudioElement>("remote"),
  toggleLog: $("toggleLog"),
};

let key = loadKey();
let session: JarvisSession | null = null;
/** The live voice, made louder on this screen if asked (loud.ts). */
const liveVoice = new LiveVoice(els.audio);
// A louder voice needs an audio context, and the browser starts one only inside a tap.
document.addEventListener("pointerdown", wakeVoice, { capture: true });

const unlock = {
  wrap: $("unlock"),
  input: $<HTMLInputElement>("keyInput"),
  go: $<HTMLButtonElement>("keyGo"),
  err: $("keyErr"),
  name: $("unlockName"),
  signIn: $("signIn"),
  passkey: $<HTMLButtonElement>("passkeyGo"),
  pair: $<HTMLButtonElement>("pairGo"),
  pairView: $("pairView"),
  pairCode: $("pairCode"),
  pairLeft: $("pairLeft"),
  pairCancel: $<HTMLButtonElement>("pairCancel"),
  joinView: $("joinView"),
  joinText: $("joinText"),
  joinName: $<HTMLInputElement>("joinName"),
  joinGo: $<HTMLButtonElement>("joinGo"),
  keyWrap: $<HTMLDetailsElement>("keyWrap"),
  signInBack: $<HTMLButtonElement>("signInBack"),
  peopleView: $("peopleView"),
  peopleText: $("peopleText"),
  peopleList: $("peopleList"),
  peopleAdd: $<HTMLButtonElement>("peopleAdd"),
  peopleBack: $<HTMLButtonElement>("peopleBack"),
  pinView: $("pinView"),
  pinText: $("pinText"),
  pinInput: $<HTMLInputElement>("pinInput"),
  pinGo: $<HTMLButtonElement>("pinGo"),
  pinBack: $<HTMLButtonElement>("pinBack"),
};

/** An invite link (#invite=…): read once and taken off the address bar. */
const inviteToken = (() => {
  const m = /invite=([^&]+)/.exec(location.hash);
  if (!m?.[1]) return "";
  window.history.replaceState(null, "", location.pathname + location.search);
  return decodeURIComponent(m[1]);
})();

/* ---------- transcript ------------------------------------------------- */
// Full duplex means the two speakers genuinely overlap, so rows grow in place
// rather than a new row appearing per fragment.
type Row = { who: "you" | "jarvis"; el: HTMLElement; text: string };
let current: { you?: Row; jarvis?: Row } = {};

function append(who: "you" | "jarvis", delta: string) {
  let row = current[who];
  if (!row) {
    const el = document.createElement("div");
    el.className = `row ${who}`;
    el.innerHTML = `<span class="who">${who === "you" ? "You" : "Jarvis"}</span><span class="txt"></span>`;
    els.transcript.appendChild(el);
    row = current[who] = { who, el, text: "" };
  }
  row.text += delta;
  (row.el.querySelector(".txt") as HTMLElement).textContent = row.text;
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

/** A pause on one side ends that row, so the next utterance starts fresh. */
const settle = (who: "you" | "jarvis") =>
  setTimeout(() => { current[who] = undefined; }, 1500);
let settleTimers: Partial<Record<"you" | "jarvis", number>> = {};
function touch(who: "you" | "jarvis") {
  clearTimeout(settleTimers[who]);
  settleTimers[who] = settle(who);
}

/* ---------- raw event log ---------------------------------------------- */
// Phase 1 exists to observe the real event stream, so nothing is filtered out.
let logCount = 0;
const counts = new Map<string, number>();
function logEvent(ev: ServerEvent) {
  counts.set(ev.type, (counts.get(ev.type) ?? 0) + 1);
  if (++logCount > 400) {
    els.log.firstElementChild?.remove();
  }
  const line = document.createElement("div");
  line.className = "ln";
  const isErr = ev.type === "error" || ev.type === "__unparseable";
  line.innerHTML =
    `<span class="t ${isErr ? "e" : ""}">${ev.type}</span>` +
    `<span class="j">${escapeHtml(summarise(ev))}</span>`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

function summarise(ev: ServerEvent): string {
  const { type, event_id, ...rest } = ev as Record<string, unknown>;
  void type; void event_id;
  const s = JSON.stringify(rest);
  return s.length > 300 ? s.slice(0, 300) + "…" : s;
}
const escapeHtml = (s: string) =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/* ---------- orb ---------------------------------------------------------- */
// The orb is driven by continuous levels, not a state enum: GPT-Live is full
// duplex, so "listening" and "speaking" genuinely overlap and the visual has to
// blend rather than switch.
const levels = new VoiceLevels();
let orb: Orb | null = null;

try {
  orb = new Orb($<HTMLCanvasElement>("orbCanvas"));
  orb.start();
} catch (e) {
  // WebGL can be unavailable or blocked; the app must still work without it.
  $("orbWrap").classList.add("nogl");
  console.warn("orb unavailable:", e);
}
addEventListener("resize", () => orb?.resize());

let thinking = false;
let errorFlash = 0;
let orbOverride: { user?: number; agent?: number; think?: number; error?: number } | null = null;

function setOrb(...states: string[]) {
  // Only the pre-session states still need CSS; everything else is the shader.
  els.orb.className = "orb " + states.filter((s) => s === "connecting").join(" ");
}

function tick() {
  if (orb) {
    orb.set(
      orbOverride ?? {
        user: session?.live || ptt?.active ? levels.read("user") : 0,
        agent: session?.live || ptt?.active ? levels.read("agent") : 0,
        think: thinking ? 1 : 0,
        error: errorFlash,
      },
    );
  }
  errorFlash *= 0.94;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

/*
 * An answer that arrived after the session was let go.
 *
 * The voice session costs $0.05 a minute; the HTTP stream carrying the
 * delegation costs nothing. So when a tool is going to take minutes, the
 * session is dropped and the stream is kept — and whatever comes back waits
 * here until someone taps the orb, rather than being spoken to an empty car.
 */
let heldAnswer: string | null = null;
/** Set when the session was dropped to save money, so "closed" can say so. */
let droppedForCost = false;

function sayOrHold(text: string, id: string) {
  if (session) {
    session.commentary(text, id);
    return;
  }
  heldAnswer = heldAnswer ? `${heldAnswer} ${text}` : text;
  history.add("assistant", text);
  status("answer ready — tap to hear");
}

/**
 * Let the session go while a slow tool runs, keeping the stream.
 *
 * Deliberately NOT `toggle()`, which aborts the delegation — that is what an
 * explicit end should do, and the exact opposite of what is wanted here.
 */
function dropSessionKeepWaiting(why: string) {
  if (!session) return;
  logEvent({ type: "[cost.drop]", why });
  userWantsSession = false;      // stop the reconnect loop from firing
  droppedForCost = true;
  clearTimeout(reconnectTimer);
  clearTimeout(idleTimer);
  session.stop(why);
}

/* ---------- event routing ----------------------------------------------- */
function onEvent(ev: ServerEvent) {
  logEvent(ev);

  switch (ev.type) {
    case "session.input_transcript.delta":
      append("you", String(ev.delta ?? ""));
      history.add("user", String(ev.delta ?? ""));
      touch("you");
      noteDriverSpoke();
      break;

    case "session.output_transcript.delta":
      append("jarvis", String(ev.delta ?? ""));
      history.add("assistant", String(ev.delta ?? ""));
      touch("jarvis");
      break;

    case "session.delegation.created": {
      const d = ev.delegation as { id?: string; target?: string } | undefined;
      if (!d?.id || d.target !== "client") break;

      thinking = true;

      // One delegation at a time: a second request would otherwise race the
      // first and both would speak over each other.
      delegateAbort?.abort();
      delegateAbort = new AbortController();

      void runDelegation(
        key,
        d.id,
        history.snapshot(),
        {
          say: sayOrHold,
          think: (t, id) => session?.thinking(t, id),
          log: (type, data) => logEvent({ type, ...data }),
          display: (payload) => {
            if (!key) return;
            stage ??= new Stage(key);
            void stage.show(payload as unknown as DisplayPayload);
          },
          slow: (name) => dropSessionKeepWaiting(`${name} takes minutes; not paying to listen`),
          done: () => { thinking = false; },
        },
        delegateAbort.signal,
      );
      break;
    }

    case "session.usage.updated":
      if (typeof ev.duration_seconds === "number") {
        const mins = ev.duration_seconds / 60;
        els.hint.textContent = `${mins.toFixed(1)} min · ~$${(mins * 0.05).toFixed(2)}`;
      }
      break;

    case "error":
      status(`error: ${JSON.stringify(ev.error ?? ev).slice(0, 160)}`, true);
      break;
  }
}

/* ---------- ui ---------------------------------------------------------- */
function status(text: string, bad = false) {
  els.status.textContent = text;
  els.status.classList.toggle("bad", bad);
  // Every state change of a live session and of push-to-talk passes through
  // here, so this is where focus mode follows whether anyone is talking.
  document.body.classList.toggle("focus", !!(session || userWantsSession || ptt?.busy));
}

/**
 * When the live session in use went live, for Settings → Usage: GPT-Live bills
 * by the open minute, and only this screen knows when a session ended.
 */
let liveSince = 0;
function reportLiveMinutes() {
  if (!liveSince || !key) return;
  const seconds = Math.round((Date.now() - liveSince) / 1000);
  liveSince = 0; // "closed" arrives more than once
  if (seconds < 1) return;
  void fetch("/api/v1/usage/live", {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify({ seconds }),
    // Sent even if the page is closing.
    keepalive: true,
  }).catch(() => {});
}

function onState(s: SessionState, detail?: string) {
  switch (s) {
    case "requesting-mic": status("waiting for microphone permission…"); setOrb("orb", "connecting"); break;
    case "connecting":     status("connecting…"); setOrb("connecting"); break;
    case "live":
      attempt = 0; droppedAt = 0;
      if (!liveSince) liveSince = Date.now();
      status("listening — tap to end");
      els.hint.textContent = "";
      // Start the meter now, not on first speech: a session opened and never
      // spoken to is exactly the one worth closing, and it would otherwise
      // bill until the tab did.
      noteDriverSpoke();
      // Anything that arrived while the session was down gets said first. This
      // has to be here rather than at the tap: `session` is non-null well
      // before its data channel opens, and a commentary sent into a channel
      // that is not open yet is dropped without a word.
      if (heldAnswer) {
        const held = heldAnswer;
        heldAnswer = null;
        session?.commentary(held);
      }
      break;
    case "closed":
      clearTimeout(idleTimer);
      reportLiveMinutes();
      session = null;
      levels.detach("user"); levels.detach("agent");
      liveVoice.detach();
      thinking = false;
      stage?.hide();
      if (userWantsSession) break;   // a reconnect is already in flight
      // "ended" would be a lie here: the question is still being worked on,
      // the stream is still open, and the answer is coming.
      // Not self-consuming: "closed" arrives more than once — the data
      // channel and the peer connection each report it — and clearing the flag
      // on the first would let the second overwrite the message with "ended".
      // It is cleared when a session next starts instead.
      if (droppedForCost) {
        status(heldAnswer ? "answer ready — tap to hear" : "working on it — tap when ready");
        setOrb();
        break;
      }
      status(detail && detail !== "stopped" ? `ended — ${detail}` : "tap to start");
      setOrb();
      break;
    case "error":
      errorFlash = 1;
      status(detail ?? "something went wrong", true);
      setOrb("error");
      session = null;
      // A stored key can stop working (rotated, revoked). Re-prompt rather than
      // leaving the driver tapping an orb that will never start.
      if (detail?.includes("unauthorized")) { clearKey(); key = ""; void requireKey(); }
      break;
  }
}

/* ---------- reconnect ---------------------------------------------------- */
// A car on LTE drives through tunnels and dead zones, and GPT-Live has no resume
// endpoint: live.create is the only way in. So recovery means a brand new session
// seeded with the transcript so far, which the API supports via `input`.
const history = new History();
let delegateAbort: AbortController | null = null;
const BACKOFF_MS = [1000, 3000, 7000, 15000];
let attempt = 0;
let reconnectTimer = 0;
let userWantsSession = false;
let droppedAt = 0;

function scheduleReconnect(reason: string) {
  if (!userWantsSession) return;
  session = null;

  if (attempt >= BACKOFF_MS.length) {
    status(`lost connection — ${reason}. Tap to retry.`, true);
    setOrb("error");
    userWantsSession = false;
    attempt = 0;
    return;
  }

  const wait = BACKOFF_MS[attempt]!;
  attempt++;
  setOrb("connecting");

  // Burning attempts while the radio is plainly down helps nobody; wait for the
  // browser to say it is back instead.
  if (!navigator.onLine) {
    status("no signal — waiting…", true);
    addEventListener("online", () => { attempt = 0; void reconnect(); }, { once: true });
    return;
  }

  status(`reconnecting (${attempt}/${BACKOFF_MS.length})…`);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => void reconnect(), wait);
}

async function reconnect() {
  if (!userWantsSession || !key) return;
  const gapSec = Math.round((Date.now() - droppedAt) / 1000);
  await openSession(history.snapshot(), gapSec);
}

async function toggle() {
  if (session || userWantsSession) {
    userWantsSession = false;
    clearTimeout(reconnectTimer);
    attempt = 0;
    history.clear();          // an explicit end really does end the conversation
    delegateAbort?.abort();
    if (session) session.stop("ended by user");
    else { status("tap to start"); setOrb(); }
    return;
  }
  if (!key) { requireKey(); return; }
  userWantsSession = true;
  droppedForCost = false;
  attempt = 0;
  const resume = history.snapshot();
  await openSession(resume.length ? resume : undefined);
}

async function openSession(seed?: ReturnType<History["snapshot"]>, gapSec = 0) {
  session = new JarvisSession(key, {
    onDropped: (reason) => {
      delegateAbort?.abort();
      if (!droppedAt) droppedAt = Date.now();
      logEvent({ type: "[dropped]", reason });
      scheduleReconnect(reason);
    },
    onEvent,
    onState,
    onDiagnostic: (type, data) => logEvent({ type: `[${type}]`, ...data }),
    onLocalStream: (stream) => levels.attach("user", stream),
    onRemoteStream: (stream) => {
      levels.attach("agent", stream);
      els.audio.srcObject = stream;
      void liveVoice.attach(stream);
      // Autoplay is allowed here because this runs inside the tap that started
      // the session, and a granted getUserMedia already unblocks audio.
      els.audio.play().catch((e) => status(`audio blocked: ${e.message}`, true));
    },
  });
  await session.start({ history: seed });

  if (seed?.length && session?.live) {
    // Silent, not spoken: Jarvis should absorb that there was a gap and behave
    // sensibly if the user repeats themselves, without narrating every blip.
    session.thinking(
      `The connection dropped for about ${gapSec || 1} seconds and has just been ` +
      `restored. The conversation above continued across that gap. If the user ` +
      `asked something during it you never received, ask them to repeat it once. ` +
      `Do not apologise at length and do not explain the network.`,
    );
  }
}

/* ---------- alerts: Jarvis speaking first --------------------------------- */
/*
 * An alert arrives over the live socket (alerts.ts). It is always shown. If a
 * session happens to be open, the session says it — no extra cost. Otherwise
 * a short clip says it, which never opens GPT-Live: nothing automatic may
 * start the $0.05-a-minute meter.
 */
const alertsBox = $("alerts");
const MAX_CARDS = 3;
const CARD_MS = 5 * 60_000;

function showAlert(a: Alert): HTMLElement {
  alertsBox.querySelector(`[data-id="${CSS.escape(a.id)}"]`)?.remove();
  const card = document.createElement("div");
  card.className = `alert${a.urgent ? " urgent" : ""}`;
  card.dataset.id = a.id;
  const head = document.createElement("div");
  head.className = "ahead";
  const title = document.createElement("b");
  title.textContent = a.title;
  const when = document.createElement("span");
  when.textContent = new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const hear = document.createElement("button");
  hear.className = "hear";
  hear.textContent = "▶";
  hear.setAttribute("aria-label", "Hear it");
  hear.addEventListener("click", () => void speakAlert(key, a));
  const close = document.createElement("button");
  close.textContent = "✕";
  close.setAttribute("aria-label", "Dismiss");
  close.addEventListener("click", () => card.remove());
  for (const n of [title, when, hear, close]) head.appendChild(n);
  const body = document.createElement("div");
  body.className = "atext";
  body.textContent = a.text;
  card.appendChild(head);
  card.appendChild(body);
  // Passed on from someone in the family: answer it right here (relay.ts).
  if (a.relay && a.relay.kind !== "tell") {
    const acts = relayActions(key, a.relay, (said) => {
      acts.replaceWith(Object.assign(document.createElement("div"), { className: "cdone", textContent: said }));
    });
    card.appendChild(acts);
  }
  // A chat message, or anything passed on: open the conversation.
  if (a.convo || a.relay) {
    const open = document.createElement("button");
    open.className = "aopen";
    open.textContent = "Open the chat";
    open.addEventListener("click", () => {
      card.remove();
      openChat(a.convo);
    });
    card.appendChild(open);
  }
  alertsBox.insertBefore(card, alertsBox.firstChild);
  while (alertsBox.children.length > MAX_CARDS) alertsBox.lastElementChild?.remove();
  setTimeout(() => card.remove(), CARD_MS);
  return card;
}

function onAlert(a: Alert) {
  const card = showAlert(a);
  // While typing, it belongs in the chat as well as on the card.
  if (mode === "type") addRow("jarvis", a.title !== "Jarvis" ? `${a.title}: ${a.text}` : a.text);
  // Into the conversation either way: "yes, do that" after Hermes asks a
  // question in an alert must have the question to refer to.
  history.add("assistant", a.title !== "Jarvis" ? `${a.title}: ${a.text}` : a.text);
  if (session?.live) {
    session.commentary(a.title !== "Jarvis" ? `${a.title}: ${a.text}` : a.text);
    return;
  }
  if (!a.speak || !speakHere()) return;
  // The browser may refuse sound before the first tap on this page; the ▶ is then the way.
  void speakAlert(key, a).then((played) => card.classList.toggle("unplayed", !played));
}

const live = new LiveLink(key, onAlert);
if (key) {
  live.start();
  void syncPush(key);
}

/** A tapped notification: it carries only an id, so the text is fetched. */
async function openAlert(id: string) {
  if (!key || !id) return;
  try {
    const r = await fetch(`/api/v1/alerts?id=${encodeURIComponent(id)}`, { headers: authHeaders(key) });
    if (!r.ok) return;
    onAlert((await r.json() as { alert: Alert }).alert);
  } catch {
    // an alert that cannot be fetched is not worth an error on screen
  }
}

{
  const url = new URL(location.href);
  const id = url.searchParams.get("alert");
  if (id) {
    url.searchParams.delete("alert");
    window.history.replaceState(null, "", url);
    void openAlert(id);
  }
}
navigator.serviceWorker?.addEventListener("message", (e) => {
  const m = e.data as { type?: string; id?: string } | null;
  if (m?.type === "alert-open" && m.id) void openAlert(m.id);
});

/* ---------- unlock ------------------------------------------------------ */
// Verify the key against the Worker before storing it. Discovering a bad key
// only when the orb fails to start would be a miserable way to find out.
async function tryKey(candidate: string) {
  unlock.err.textContent = "";
  unlock.go.disabled = true;
  unlock.go.textContent = "checking…";
  try {
    const res = await fetch("/api/health", { headers: authHeaders(candidate) });
    if (res.ok) {
      key = saveKey(candidate);
      live.start(key);
      void syncPush(key);
      unlock.wrap.classList.remove("show");
      setMode(mode);
      // Unlocked with the owner key and no family yet: offer to set one up, once.
      void hubStatus().then((s) => {
        let asked = false;
        try {
          asked = !!localStorage.getItem("jarvis.familyOffered");
          localStorage.setItem("jarvis.familyOffered", "1");
        } catch { /* private mode */ }
        if (!s.claimed && !asked) openFamily();
      });
      return;
    }
    unlock.err.textContent =
      res.status === 401 ? "That key was not accepted." : `Server said ${res.status}.`;
    clearKey();
  } catch (e) {
    unlock.err.textContent = `Could not reach the server: ${
      e instanceof Error ? e.message : String(e)
    }`;
  } finally {
    unlock.go.disabled = false;
    unlock.go.textContent = "Unlock";
  }
}

unlock.go.addEventListener("click", () => void tryKey(unlock.input.value));
unlock.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void tryKey(unlock.input.value);
});

/*
 * Signing in as a person (src/app/account.ts): with a passkey, by pairing
 * this screen with a phone that is signed in, or by joining from an invite.
 * The owner key stays, folded away, for a Jarvis with no family yet and as
 * the way back in. Each ends by reloading: every panel was made with the old
 * key, and a fresh start is the simple way to leave none of them behind.
 */
async function signedIn(token: string) {
  // Whoever was using this screen is put aside (locked, if they have a PIN),
  // and the new person joins the screen's people (people.ts).
  if (isSession(key) && key !== token) await lockPerson(key);
  const d = await describe(token);
  if (d && d !== "gone") {
    const replaced = keepPerson({ id: d.id, name: d.name, hasPin: d.hasPin, token });
    // The same person again: their older sign-in on this screen is not needed.
    if (replaced) await endSignIn(replaced);
  }
  key = saveKey(token);
  location.reload();
}

type UnlockView = "signin" | "pair" | "join" | "people" | "pin";
function unlockView(v: UnlockView) {
  unlock.signIn.hidden = v !== "signin";
  unlock.pairView.hidden = v !== "pair";
  unlock.joinView.hidden = v !== "join";
  unlock.peopleView.hidden = v !== "people";
  unlock.pinView.hidden = v !== "pin";
  unlock.keyWrap.hidden = v !== "signin";
  // From signing in, back to the people already here, if there are any.
  unlock.signInBack.hidden = !(v === "signin" && loadPeople().length);
}

/*
 * Who's using Jarvis: the people signed in on this screen (people.ts). Picking
 * someone puts the one in use aside — locked, if they have a PIN — and takes
 * the chosen one up, asking for their PIN if they have one.
 */
function showPeople(why = "") {
  const people = loadPeople();
  unlock.wrap.classList.add("show");
  unlockView("people");
  unlock.err.textContent = why;
  unlock.name.textContent = (document.title || "Jarvis").toUpperCase();
  unlock.peopleText.textContent = `Who's using ${document.title || "Jarvis"}?`;
  unlock.peopleList.replaceChildren(
    ...people.map((p) => {
      const b = document.createElement("button");
      b.className = p.token === key ? "now" : "";
      const n = document.createElement("span");
      n.textContent = p.name;
      const t = document.createElement("span");
      t.className = "tag";
      t.textContent = p.token === key ? "now" : p.hasPin ? "PIN" : "";
      b.appendChild(n);
      b.appendChild(t);
      b.addEventListener("click", () => void switchTo(p));
      return b;
    }),
  );
  // Back to the app only while someone is still in use here.
  unlock.peopleBack.hidden = !key;
}

let pinFor: Person | null = null;
async function switchTo(p: Person) {
  unlock.err.textContent = "";
  if (p.token === key) {
    unlock.wrap.classList.remove("show");
    return;
  }
  const d = await describe(p.token);
  if (d === "gone") {
    dropPerson(p.token);
    return showPeople(`${p.name}'s sign-in here has ended. Add them again.`);
  }
  // The one in use steps aside first, and their notifications with them.
  if (isSession(key) && (await lockPerson(key))) {
    await releasePush(key);
    clearKey();
    key = "";
  }
  if (d?.locked) {
    pinFor = p;
    unlockView("pin");
    unlock.pinText.textContent = `${p.name}'s PIN`;
    unlock.pinInput.value = "";
    unlock.pinInput.focus();
    return;
  }
  key = saveKey(p.token);
  location.reload();
}

async function submitPin() {
  if (!pinFor) return;
  unlock.pinGo.disabled = true;
  try {
    await unlockPerson(pinFor.token, unlock.pinInput.value.trim());
    key = saveKey(pinFor.token);
    location.reload();
  } catch (e) {
    unlock.err.textContent = e instanceof Error ? e.message : String(e);
    unlock.pinInput.value = "";
  } finally {
    unlock.pinGo.disabled = false;
  }
}
unlock.pinGo.addEventListener("click", () => void submitPin());
unlock.pinInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void submitPin();
});
unlock.pinBack.addEventListener("click", () => showPeople());
unlock.peopleBack.addEventListener("click", () => unlock.wrap.classList.remove("show"));
// Adding someone: they sign in here, with a passkey or by pairing their phone.
unlock.peopleAdd.addEventListener("click", () => {
  unlock.err.textContent = "";
  unlockView("signin");
  unlock.passkey.hidden = !passkeysSupported();
});
unlock.signInBack.addEventListener("click", () => showPeople());

async function requireKey() {
  unlock.wrap.classList.add("show");
  if (inviteToken) return void showInvite();
  // People are signed in here, just none in use: choose one.
  if (loadPeople().length) return showPeople();
  unlockView("signin");
  const s = await hubStatus();
  unlock.name.textContent = (s.agentName ?? "Jarvis").toUpperCase();
  // No family yet: the owner key is the only way in, as it always was.
  unlock.signIn.hidden = !s.claimed;
  unlock.passkey.hidden = !passkeysSupported();
  unlock.keyWrap.open = !s.claimed;
  if (!s.claimed) unlock.input.focus();
}

unlock.passkey.addEventListener("click", async () => {
  unlock.err.textContent = "";
  unlock.passkey.disabled = true;
  try {
    signedIn((await signInWithPasskey()).token);
  } catch (e) {
    unlock.err.textContent = passkeyError(e);
  } finally {
    unlock.passkey.disabled = false;
  }
});

let pairing: AbortController | null = null;
/**
 * Show a code for a signed-in phone to approve. From the sign-in screen, or
 * from Family on a screen still unlocked with the owner key: that key stays
 * until the phone says yes, so the screen is never left signed out.
 */
async function pairHere() {
  unlock.err.textContent = "";
  unlock.wrap.classList.add("show");
  unlockView("pair");
  unlock.pairCode.textContent = "······";
  pairing = new AbortController();
  let tick = 0;
  try {
    const r = await pairThisScreen((code, expiresAt) => {
      unlock.pairCode.textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
      const left = () => {
        const s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
        unlock.pairLeft.textContent = `Waiting for your phone… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      };
      left();
      tick = setInterval(left, 1000);
    }, pairing.signal);
    signedIn(r.token);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (!pairing?.signal.aborted) {
      if (key) status(why, true);
      else unlock.err.textContent = why;
    }
    leavePairing();
  } finally {
    clearInterval(tick);
    pairing = null;
  }
}

/** Back to where pairing began: the app, if this screen is still unlocked; else choosing or signing in. */
function leavePairing() {
  if (key) unlock.wrap.classList.remove("show");
  else if (loadPeople().length) showPeople();
  else unlockView("signin");
}

unlock.pair.addEventListener("click", () => void pairHere());
unlock.pairCancel.addEventListener("click", () => {
  pairing?.abort();
  leavePairing();
});

async function showInvite() {
  unlockView("join");
  unlock.joinGo.disabled = true;
  try {
    const inv = await inviteInfo(inviteToken);
    unlock.name.textContent = inv.agentName.toUpperCase();
    unlock.joinText.textContent = inv.existing
      ? `A new passkey for ${inv.name} on this device, to use ${inv.agentName} with ${inv.spaceName}.`
      : `You're invited to join ${inv.spaceName}${inv.role === "admin" ? " as its admin" : ""}, and use ${inv.agentName}, its assistant.`;
    unlock.joinName.value = inv.name;
    unlock.joinName.hidden = inv.existing;
    if (!passkeysSupported()) {
      unlock.err.textContent = "This browser cannot make a passkey. Open the link on your phone; then pair this screen from Family.";
      return;
    }
    unlock.joinGo.disabled = false;
    if (!inv.existing) unlock.joinName.focus();
  } catch (e) {
    unlock.joinText.textContent = "";
    unlock.err.textContent = e instanceof Error ? e.message : String(e);
  }
}

unlock.joinGo.addEventListener("click", async () => {
  const name = unlock.joinName.value.trim();
  if (!unlock.joinName.hidden && !name) {
    unlock.err.textContent = "Your name, as the family should see it.";
    return;
  }
  unlock.err.textContent = "";
  unlock.joinGo.disabled = true;
  try {
    signedIn((await joinWithInvite(inviteToken, name)).token);
  } catch (e) {
    unlock.err.textContent = passkeyError(e);
    unlock.joinGo.disabled = false;
  }
});

let chat: Chat | null = null;
function openChat(convo?: string) {
  if (!key) { void requireKey(); return; }
  chat ??= new Chat(key, document.title);
  void chat.show(convo);
}
$("openChat").addEventListener("click", () => openChat());

/** Unread messages, on the menu: looked at now and then, and when the app comes back. */
async function unreadChat() {
  const item = $("openChat");
  if (!isSession(key) || item.hidden) return;
  try {
    const r = await fetch("/api/hub/chat", { headers: authHeaders(key) });
    if (!r.ok) return;
    const { convos } = (await r.json()) as { convos: { unread: number }[] };
    const n = convos.reduce((t, c) => t + c.unread, 0);
    item.textContent = n ? `Chat (${n})` : "Chat";
    $("menuBtn").classList.toggle("dot", n > 0);
  } catch {
    // Next time.
  }
}
setInterval(() => void unreadChat(), 60_000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void unreadChat();
});

let family: Family | null = null;
function openFamily() {
  if (!key) { void requireKey(); return; }
  family ??= new Family(key, (t) => void signedIn(t), () => void pairHere(), () => void whoAmI());
  void family.show();
}
$("openFamily").addEventListener("click", openFamily);

let devices: Devices | null = null;
let memory: Memory | null = null;
let settings: Settings | null = null;
let stage: Stage | null = null;
$("openSettings").addEventListener("click", () => {
  if (!key) { requireKey(); return; }
  settings ??= new Settings(key);
  void settings.show();
});

$("openMemory").addEventListener("click", () => {
  if (!key) { requireKey(); return; }
  memory ??= new Memory(key);
  void memory.show();
});

let jobs: Jobs | null = null;
$("openJobs").addEventListener("click", () => {
  if (!key) { requireKey(); return; }
  jobs ??= new Jobs(key);
  void jobs.show();
});

let routines: Routines | null = null;
$("openRoutines").addEventListener("click", () => {
  if (!key) { requireKey(); return; }
  routines ??= new Routines(key);
  void routines.show();
});

$("openDevices").addEventListener("click", () => {
  if (!key) { requireKey(); return; }
  devices ??= new Devices(key);
  void devices.show();
});

/* ---------- two ways to talk ----------------------------------------------- */
/*
 * Live: GPT-Live, a real conversation, $0.05 for every minute it is open.
 * Push-to-talk: one question at a time, transcribed, answered by the same
 * router and spoken back — a fraction of a cent a question (ptt.ts). Chosen
 * per screen, and remembered.
 */
type Mode = "live" | "ptt" | "type";
const MODE_KEY = "jarvis.mode";
const asMode = (v: string | null | undefined): Mode => (v === "ptt" || v === "type" ? v : "live");
let mode: Mode = (() => {
  try {
    return asMode(localStorage.getItem(MODE_KEY));
  } catch {
    return "live";
  }
})();
let ptt: PushToTalk | null = null;

function pushToTalk(): PushToTalk {
  return (ptt ??= new PushToTalk(key, levels, {
    status,
    heard: (text) => {
      current = {};
      append("you", text);
      history.add("user", text);
    },
    answered: (text, ok) => {
      append("jarvis", text);
      history.add("assistant", text);
      if (!ok) errorFlash = 1;
    },
    display: (payload) => {
      if (!key) return;
      stage ??= new Stage(key);
      void stage.show(payload as unknown as DisplayPayload);
    },
    thinking: (on) => { thinking = on; },
    history: () => history.snapshot(),
  }));
}

function setMode(m: Mode) {
  mode = m;
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    // private mode: this screen forgets, which is harmless
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("#modes button")) {
    b.classList.toggle("on", b.dataset.mode === m);
    b.setAttribute("aria-pressed", String(b.dataset.mode === m));
  }
  document.body.classList.toggle("typing", m === "type");
  // Switching away from a live session ends it: it is the thing that bills.
  if (m !== "live" && (session || userWantsSession)) void toggle();
  if (m === "type") {
    ptt?.stop();
    status(key ? "type a message" : "");
    els.hint.textContent = "or tap the orb to ask aloud";
    // A keyboard only where one is not a screen-full of glass.
    if (!matchMedia("(pointer: coarse)").matches) typed.focus();
  } else if (m === "ptt") {
    status(key ? "tap and ask" : "");
    els.hint.textContent = "push-to-talk · a fraction of a cent a question";
  } else {
    ptt?.stop();
    status(key ? "tap to start" : "");
    els.hint.textContent = "live conversation · $0.05 a minute while open";
  }
}

for (const b of document.querySelectorAll<HTMLButtonElement>("#modes button")) {
  b.addEventListener("click", () => setMode(asMode(b.dataset.mode)));
}

els.orb.addEventListener("click", () => {
  if (mode === "live") return void toggle();
  // Typing too: the orb still takes one spoken question, answered aloud.
  if (!key) return requireKey();
  const p = pushToTalk();
  p.setKey(key);
  void p.press();
});
/* ---------- typing ------------------------------------------------------ */
/*
 * The conversation so far goes to the router as text and the answer comes
 * back as text (chat.ts) — no speech either way. It shares the history with
 * the voice modes, so a typed question can be followed by a spoken one.
 */
const typebar = $<HTMLFormElement>("typebar");
const typed = $<HTMLTextAreaElement>("typed");
const sendBtn = $<HTMLButtonElement>("send");
const readAloudBtn = $<HTMLButtonElement>("readAloud");
const READ_KEY = "jarvis.readReplies";
let readAloud = (() => {
  try {
    return localStorage.getItem(READ_KEY) === "1";
  } catch {
    return false;
  }
})();
function showReadAloud() {
  readAloudBtn.setAttribute("aria-pressed", String(readAloud));
  readAloudBtn.textContent = readAloud ? "🔊" : "🔈";
  readAloudBtn.title = readAloud ? "Replies are read aloud" : "Read replies aloud";
}
showReadAloud();
readAloudBtn.addEventListener("click", () => {
  readAloud = !readAloud;
  try {
    localStorage.setItem(READ_KEY, readAloud ? "1" : "0");
  } catch {
    // remembered for this page only
  }
  showReadAloud();
});

/** A finished row of its own, with links and bold made real. */
function addRow(who: "you" | "jarvis", text: string, cls = "") {
  current = {};
  const el = document.createElement("div");
  el.className = `row ${who}${cls ? ` ${cls}` : ""}`;
  const w = document.createElement("span");
  w.className = "who";
  w.textContent = who === "you" ? "You" : "Jarvis";
  el.appendChild(w);
  el.appendChild(who === "jarvis" ? richText(text) : Object.assign(document.createElement("span"), { className: "txt", textContent: text }));
  els.transcript.appendChild(el);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  return el;
}

let typedAbort: AbortController | null = null;
async function sendTyped() {
  const text = typed.value.trim();
  if (!text || typedAbort) return;
  if (!key) return requireKey();
  typed.value = "";
  fitTyped();
  addRow("you", text);
  history.add("user", text);
  typedAbort = new AbortController();
  sendBtn.disabled = true;
  thinking = true;
  status("thinking…");
  await askTyped(key, history.snapshot(), {
    progress: (t) => status(`${t}…`),
    display: (payload) => {
      stage ??= new Stage(key);
      void stage.show(payload as unknown as DisplayPayload);
    },
    answer: (reply, ok) => {
      addRow("jarvis", reply, ok ? "" : "bad");
      history.add("assistant", reply);
      if (!ok) errorFlash = 1;
      if (ok && readAloud) void speakText(key, reply);
    },
  }, typedAbort.signal);
  typedAbort = null;
  sendBtn.disabled = false;
  thinking = false;
  if (mode === "type") status("type a message");
}

/** The box grows with what is typed, up to a limit. */
function fitTyped() {
  typed.style.height = "auto";
  typed.style.height = `${Math.min(typed.scrollHeight, innerHeight * 0.3)}px`;
}
typed.addEventListener("input", fitTyped);
// Enter sends; Shift+Enter is a new line. Escape stops a question in flight.
typed.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void sendTyped();
  } else if (e.key === "Escape" && typedAbort) {
    typedAbort.abort();
  }
});
typebar.addEventListener("submit", (e) => {
  e.preventDefault();
  void sendTyped();
});

/*
 * The on-screen keyboard. By default a phone's browser does not shrink the
 * page for it: it slides the view down to the box, which is pinned to the
 * bottom of the full-height page, so the chat vanished above and the box sat
 * half under the keyboard. Chrome is told to shrink the page instead
 * (interactive-widget in the viewport meta). Safari ignores that, so there
 * the space the keyboard takes is measured and the box and the chat are
 * lifted above it; everywhere else this measures nothing.
 */
const vv = window.visualViewport;
function keyboardSpace() {
  if (!vv) return;
  const kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
  document.documentElement.style.setProperty("--kb", `${kb}px`);
}
vv?.addEventListener("resize", keyboardSpace);
vv?.addEventListener("scroll", keyboardSpace);
// Once the keyboard is up, the newest message should be in view above it.
typed.addEventListener("focus", () => {
  setTimeout(() => {
    keyboardSpace();
    els.transcript.scrollTop = els.transcript.scrollHeight;
  }, 350);
});
// Likewise when a picture opens above the chat, or its first frame arrives and
// takes more room — unless you had scrolled up to read. Judged against the
// height before it shrank: a scroll event in the same frame already sees the
// new one, and takes the lost room for scrolling up.
let chatH = 0;
new ResizeObserver(() => {
  const t = els.transcript;
  const shrunk = chatH - t.clientHeight;
  chatH = t.clientHeight;
  if (shrunk > 0 && t.scrollHeight - t.scrollTop - t.clientHeight - shrunk < 40) t.scrollTop = t.scrollHeight;
}).observe(els.transcript);

/*
 * Who this screen is: the family's name for its assistant in the title, and
 * only the menu items this person may use. The server enforces the same; this
 * only spares someone a panel that would refuse them.
 */
async function whoAmI() {
  if (!key) return;
  try {
    const res = await fetch("/api/hub/me", { headers: authHeaders(key) });
    if (!res.ok) return;
    const me = (await res.json()) as {
      space: { agentName: string } | null;
      role: string;
      scopes: string[];
      user: { id: string; name: string } | null;
      hasPin: boolean;
      locked: boolean;
    };
    if (me.space?.agentName) document.title = me.space.agentName;
    if (me.user) keepPerson({ id: me.user.id, name: me.user.name, hasPin: me.hasPin, token: key });
    // Put aside on this screen (a shared one, left idle): choose who is using it.
    if (me.locked) {
      await releasePush(key);
      clearKey();
      key = "";
      return showPeople();
    }
    // On a screen several people share, the title says whose Jarvis this is now.
    const shared = loadPeople().length > 1;
    const first = me.user?.name.split(/\s+/)[0] ?? "";
    const title = $("title");
    title.textContent = ((me.space?.agentName ?? "Jarvis") + (shared && first ? ` · ${first}` : "")).toUpperCase();
    title.classList.toggle("switchable", isSession(key));
    const may = (need: string) => me.role === "admin" || me.scopes.includes("*") || (need !== "admin" && me.scopes.includes(need));
    for (const b of document.querySelectorAll<HTMLElement>("#topbtns [data-need]")) b.hidden = !may(b.dataset.need!);
    // The family's chat is for people in a family.
    $("openChat").hidden = !me.space || !isSession(key) || !may("chat");
    void unreadChat();
  } catch {
    // Offline: the menu stays as it is.
  }
}
void whoAmI();
$("title").addEventListener("click", () => {
  if (isSession(key)) showPeople();
});

/*
 * A shared screen left alone: after half an hour with nobody touching it, the
 * person in use is put aside if they have a PIN, so whoever sits in the car
 * next cannot carry on as them.
 */
const IDLE_LOCK_MS = 30 * 60_000;
let touchedAt = Date.now();
for (const ev of ["pointerdown", "keydown"]) document.addEventListener(ev, () => (touchedAt = Date.now()), { capture: true });
setInterval(async () => {
  const people = loadPeople();
  const me = people.find((p) => p.token === key);
  if (people.length < 2 || !me?.hasPin || Date.now() - touchedAt < IDLE_LOCK_MS) return;
  if (session || userWantsSession || ptt?.busy || typedAbort) return;
  if (await lockPerson(key)) {
    await releasePush(key);
    clearKey();
    key = "";
    document.querySelectorAll(".panel.open").forEach((el) => el.classList.remove("open"));
    showPeople();
  }
}, 60_000);

/*
 * Picking up a new version.
 *
 * A home-screen app on a phone is resumed, not reloaded: iOS keeps the page
 * alive for days, so a deploy went unseen until the app was swiped away. And
 * the car's tab can stay open for a whole drive. So when the app comes back to
 * the front (and every half hour while it stays there), it asks the server for
 * the page it would serve now; if that loads a different build, it reloads —
 * but never in the middle of anything.
 */
const myBuild = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.src ?? "";
let buildCheckedAt = 0;
function busy(): boolean {
  return !!(
    session ||
    userWantsSession ||
    ptt?.busy ||
    typedAbort ||
    typed.value.trim() ||
    pairing ||
    document.querySelector(".panel.open") ||
    !unlock.joinView.hidden ||
    !unlock.pinView.hidden
  );
}
async function freshen() {
  // Only a built app has a build to compare; the dev server's modules do not.
  if (!myBuild || document.visibilityState !== "visible" || Date.now() - buildCheckedAt < 60_000) return;
  buildCheckedAt = Date.now();
  try {
    const page = await (await fetch("/", { cache: "no-store" })).text();
    const m = /<script[^>]*type="module"[^>]*src="([^"]*\/assets\/[^"]+)"/.exec(page);
    if (!m?.[1] || new URL(m[1], location.href).href === myBuild) return;
    if (busy()) {
      buildCheckedAt = 0; // look again at the next chance
      return;
    }
    location.reload();
  } catch {
    // Offline: carry on with what is loaded.
  }
}
document.addEventListener("visibilitychange", () => void freshen());
setInterval(() => void freshen(), 30 * 60_000);

/* ---------- the menu, and focus mode ------------------------------------ */
const menuBtn = $<HTMLButtonElement>("menuBtn");
const menu = $("topbtns");
function setMenu(open: boolean) {
  menu.classList.toggle("open", open);
  menuBtn.setAttribute("aria-expanded", String(open));
}
menuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenu(!menu.classList.contains("open"));
});
// Choosing an item, or tapping anywhere else, closes it.
menu.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("button")) setMenu(false);
});
let peekTimer = 0;
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (!menu.contains(t) && t !== menuBtn) setMenu(false);
  // In focus mode, a tap on empty space shows the controls for a few seconds.
  if (!document.body.classList.contains("focus")) return;
  if (t.closest("button, a, input, select, textarea, label, #orbWrap, .panel, #stage, #alerts, #transcript, #logWrap")) return;
  document.body.classList.add("peek");
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => document.body.classList.remove("peek"), 6000);
});

els.toggleLog.addEventListener("click", () => {
  const open = els.logWrap.classList.toggle("open");
  els.toggleLog.textContent = open ? "Hide events" : "Events";
  if (open) {
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.table(Object.fromEntries(top));
  }
});

// A session left open keeps billing at $0.05/min, so never rely on the car to
// tear it down. But do not kill it the instant the page hides either — the car
// can hide the page briefly when the driver touches another control, and an
// instant kill would end the conversation with no way back. Hold it for a
// grace period and cancel if the page comes back.
const HIDDEN_GRACE_MS = 60_000;
let hiddenTimer = 0;

/*
 * Silence costs the same as conversation.
 *
 * A Live session bills $0.05 a minute from the moment it opens, and nothing
 * else in this app is close — the router that does the actual work rounds to
 * zero. So a session left open in a parked car is the whole bill, spending
 * money on an empty room.
 *
 * Keyed on the DRIVER speaking, deliberately. Resetting it when Jarvis talks
 * would mean a long wait full of "still working on it" kept the meter running
 * forever, which is the exact case this is meant to catch. Work already
 * survives the session ending — the answer is parked and spoken on reconnect —
 * so closing here loses nothing but the charge.
 */
const IDLE_MS = 120_000;
let idleTimer = 0;

function noteDriverSpoke() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    userWantsSession = false;
    session?.stop(`idle for ${IDLE_MS / 1000}s`);
    status("tap to start");
  }, IDLE_MS);
}

addEventListener("pagehide", () => { userWantsSession = false; session?.stop("page unloaded"); });

addEventListener("visibilitychange", () => {
  logEvent({ type: "[visibilitychange]", state: document.visibilityState });
  if (document.visibilityState === "hidden") {
    clearTimeout(hiddenTimer);
    hiddenTimer = setTimeout(() => {
      userWantsSession = false;
      clearTimeout(reconnectTimer);
      // History is deliberately kept: tapping the orb again resumes
      // the conversation rather than starting from nothing.
      session?.stop(`hidden for ${HIDDEN_GRACE_MS / 1000}s`);
    }, HIDDEN_GRACE_MS);
  } else {
    clearTimeout(hiddenTimer);
  }
});

/* ---------- debug handle ------------------------------------------------ */
// The Tesla browser has no devtools, so the only way to poke at a live session
// from the car is an affordance the page itself provides. The data-channel
// allowlist set in /api/session still bounds what this can actually send.
declare global {
  interface Window {
    __jarvis: {
      get session(): JarvisSession | null;
      say(text: string, delegationId?: string | null): boolean;
      think(text: string, delegationId?: string | null): boolean;
      send(ev: Record<string, unknown>): boolean;
      history(): { role: string; text: string }[];
      simulateDrop(): void;
      /** Park an answer as if a slow tool had returned while the session was down. */
      hold(text: string): void;
      orb(): { tier: number; detail: number } | null;
      orbForce(v: { user?: number; agent?: number; think?: number; error?: number } | null): void;
      speak(text: string): Promise<void>;
      events(): Record<string, number>;
      stop(): void;
    };
  }
}

window.__jarvis = {
  get session() { return session; },
  say: (t, id = null) => session?.commentary(t, id) ?? false,
  think: (t, id = null) => session?.thinking(t, id) ?? false,
  send: (ev) => session?.send(ev) ?? false,
  events: () => Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1])),
  stop: () => { userWantsSession = false; session?.stop("debug stop"); },
  simulateDrop: () => session?.simulateDrop(),
  // Verifying the held-answer path otherwise means waiting out a real
  // three-minute Hermes call, which is a poor way to test one line.
  hold: (text: string) => {
    heldAnswer = text;
    droppedForCost = true;
    status("answer ready — tap to hear");
  },
  orb: () => orb?.quality ?? null,
  orbForce: (v: { user?: number; agent?: number; think?: number; error?: number } | null) => {
    orbOverride = v;
  },
  speak: (text: string) => session?.injectSpeech(text, key) ?? Promise.resolve(),
  history: () => history.snapshot(),
};

if (key && !inviteToken) {
  setMode(mode);
} else {
  status("");
  void requireKey();
}

/*
 * Installable on a phone.
 *
 * The worker caches the shell and never /api/*, because everything this app says
 * is live state — what the car is doing, what a camera sees — and a cached answer
 * to any of that is a wrong answer. Registration failing is not fatal: the app
 * works exactly as before, it just cannot be added to a home screen.
 */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) => {
      console.warn("[pwa] service worker did not register:", e);
    });
  });
}
