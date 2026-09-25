import { JarvisSession, type ServerEvent, type SessionState } from "./session";
import { loadKey, saveKey, clearKey, authHeaders } from "./key";
import { History } from "./history";
import { Settings } from "./ui/Settings";
import { Devices } from "./ui/Devices";
import { Memory } from "./ui/Memory";
import { Routines } from "./ui/Routines";
import { Stage, type DisplayPayload } from "./ui/Stage";
import { Orb } from "./orb/Orb";
import { VoiceLevels } from "./audio";
import { runDelegation } from "./delegate";
import { LiveLink, speakAlert, speakHere, type Alert } from "./alerts";
import { PushToTalk } from "./ptt";

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

const unlock = {
  wrap: $("unlock"),
  input: $<HTMLInputElement>("keyInput"),
  go: $<HTMLButtonElement>("keyGo"),
  err: $("keyErr"),
};

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
  settleTimers[who] = settle(who) as unknown as number;
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
  els.orb.className = "orb " + states.filter((s) => s === "connecting" || s === "reconnecting").join(" ");
}

function refreshOrb() {
  /* levels are sampled every frame in tick(); nothing to do here */
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
}

function onState(s: SessionState, detail?: string) {
  switch (s) {
    case "requesting-mic": status("waiting for microphone permission…"); setOrb("orb", "connecting"); break;
    case "connecting":     status("connecting…"); setOrb("connecting"); break;
    case "live":
      attempt = 0; droppedAt = 0;
      status("listening — tap to end");
      els.hint.textContent = "";
      refreshOrb();
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
      session = null;
      levels.detach("user"); levels.detach("agent");
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
      if (detail?.includes("unauthorized")) { clearKey(); key = ""; requireKey(); }
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
  reconnectTimer = setTimeout(() => void reconnect(), wait) as unknown as number;
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
  alertsBox.insertBefore(card, alertsBox.firstChild);
  while (alertsBox.children.length > MAX_CARDS) alertsBox.lastElementChild?.remove();
  setTimeout(() => card.remove(), CARD_MS);
  return card;
}

function onAlert(a: Alert) {
  const card = showAlert(a);
  if (session?.live) {
    session.commentary(a.title !== "Jarvis" ? `${a.title}: ${a.text}` : a.text);
    history.add("assistant", a.text);
    return;
  }
  if (!a.speak || !speakHere()) return;
  // The browser may refuse sound before the first tap on this page; the ▶ is then the way.
  void speakAlert(key, a).then((played) => card.classList.toggle("unplayed", !played));
}

const live = new LiveLink(key, onAlert);
if (key) live.start();

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
      unlock.wrap.classList.remove("show");
      setMode(mode);
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

function requireKey() {
  unlock.wrap.classList.add("show");
  unlock.input.focus();
}

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
type Mode = "live" | "ptt";
const MODE_KEY = "jarvis.mode";
let mode: Mode = (() => {
  try {
    return localStorage.getItem(MODE_KEY) === "ptt" ? "ptt" : "live";
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
  if (m === "ptt") {
    // Switching away from a live session ends it: it is the thing that bills.
    if (session || userWantsSession) void toggle();
    status(key ? "tap and ask" : "");
    els.hint.textContent = "push-to-talk · a fraction of a cent a question";
  } else {
    ptt?.stop();
    status(key ? "tap to start" : "");
    els.hint.textContent = "live conversation · $0.05 a minute while open";
  }
}

for (const b of document.querySelectorAll<HTMLButtonElement>("#modes button")) {
  b.addEventListener("click", () => setMode(b.dataset.mode === "ptt" ? "ptt" : "live"));
}

els.orb.addEventListener("click", () => {
  if (mode === "live") return void toggle();
  if (!key) return requireKey();
  const p = pushToTalk();
  p.setKey(key);
  void p.press();
});
els.toggleLog.addEventListener("click", () => {
  const open = els.logWrap.classList.toggle("open");
  els.toggleLog.textContent = open ? "hide" : "events";
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
  }, IDLE_MS) as unknown as number;
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
    }, HIDDEN_GRACE_MS) as unknown as number;
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

if (key) {
  setMode(mode);
} else {
  status("");
  requireKey();
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
