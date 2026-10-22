// The Durable Object itself (src/worker/state.ts), loaded in Node: whose phones a
// person's notification reaches, and whether its pass-throughs forward what they
// are given. Every other test calls StateHost or a fake, so the object's own
// one-line methods went unchecked, and one of them (pushTargets) dropped whose
// alert it was: from 2.0.0 to 2.1.0 everyone's notifications reached every phone.
//
// state.ts imports "cloudflare:workers", which only the Workers runtime has; a
// module hook stands in a bare DurableObject for it. Plain Node, no dependencies.
import { registerHooks } from "node:module";
import { StateHost } from "../src/worker/lib/state-host.ts";
import { deliver, makeAlert } from "../src/worker/lib/alerts.ts";
import { b64u } from "../src/worker/lib/webauthn.ts";
import { STUCK_MS, weigh } from "../src/worker/lib/proposals.ts";
import { carCommand } from "../src/worker/tools/tessie.ts";

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "cloudflare:workers") {
      return { url: "data:text/javascript,export class DurableObject{constructor(c,e){this.ctx=c;this.env=e}}", shortCircuit: true };
    }
    return next(spec, ctx);
  },
});
(globalThis as { WebSocketRequestResponsePair?: unknown }).WebSocketRequestResponsePair = class {};
// After the hook: a static import would be hoisted above it.
const { JarvisState } = await import("../src/worker/state.ts");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 400) : "");
  }
}

/** When the object's one alarm is set for, as the fake storage below was last told. */
let alarmAt: number | null = null;

function fakeStorage() {
  const m = new Map<string, unknown>();
  return {
    get: async (k: string | string[]) =>
      Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, structuredClone(m.get(x))])) : structuredClone(m.get(k)),
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string | string[]) => (Array.isArray(k) ? k.filter((x) => m.delete(x)).length : m.delete(k)),
    list: async ({ prefix = "" }: { prefix?: string } = {}) =>
      new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])),
    getAlarm: async () => alarmAt,
    setAlarm: async (t: number) => void (alarmAt = t),
    deleteAlarm: async () => void (alarmAt = null),
  };
}

const kv = new Map<string, string>();
const env = {
  CONFIG: {
    get: async (k: string) => kv.get(k) ?? null,
    put: async (k: string, v: string) => void kv.set(k, v),
    delete: async (k: string) => void kv.delete(k),
    list: async () => ({ keys: [], list_complete: true }),
  },
  ALERT_ORDER: "live,push",
  // A car in the settings: the first person's, as an approved call finds it (personEnv).
  TESSIE_TOKEN: "t",
  TESSIE_VIN: "LRWTEST0000000000",
} as never;
/** Open screens, by their tags (who, and a member's sign-in), for closeSession below. */
const sockets: { tags: string[]; closed?: number; close(code: number): void }[] = [];
/** The tags each accepted screen was given (JarvisState.fetch). */
const accepted: string[][] = [];
const storage = fakeStorage();
const ctx = {
  storage,
  blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
  setWebSocketAutoResponse() {},
  getWebSockets: (tag?: string) => (tag ? sockets.filter((s) => s.tags.includes(tag)) : []),
  acceptWebSocket: (_ws: unknown, tags: string[]) => void accepted.push(tags),
} as never;
const jarvis = new JarvisState(ctx, env);
await new Promise((r) => setTimeout(r, 0));

/** A browser as a push service sees it: a real P-256 key, so encrypting to it works. */
async function subscribe(name: string, who: string) {
  const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);
  await jarvis.addPushSub({
    endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
    p256dh: b64u(raw),
    auth: b64u(crypto.getRandomValues(new Uint8Array(16))),
    subject: "https://jarvis.example.com",
    who,
    label: name,
  });
}
// The first person's browser and device, two of Sara's, one of Adam's.
await subscribe("owner-browser", "owner");
await subscribe("owner-glasses", "d_glasses");
await subscribe("sara-browser", "u_sara");
await subscribe("sara-phone", "u_sara~d_phone");
await subscribe("adam-browser", "u_adam");

/** Which browsers a push went to, by the name at the end of their address. */
const reached = new Set<string>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://fcm.googleapis.com/")) reached.add(url.split("/").pop()!);
  return new Response(null, { status: 201 });
}) as typeof fetch;
const to = async (send: () => Promise<unknown>) => {
  reached.clear();
  await send();
  return [...reached].sort().join(",");
};
const NOW = Date.now();

console.log("whose phones a notification reaches");
try {
  let got = await to(() => deliver(env, jarvis, makeAlert({ text: "Pick up milk" }, "note", NOW, "u_sara")!, { skipLive: true }));
  check("a note for Sara: her browser and phone, nobody else's", got === "sara-browser,sara-phone", got);

  got = await to(() => deliver(env, jarvis, makeAlert({ text: "The gate is open" }, "note", NOW)!, { skipLive: true }));
  check("one for the first person: theirs alone, device included", got === "owner-browser,owner-glasses", got);

  const scheduler = await (jarvis as unknown as { schedulerDeps(): Promise<{ deliver(a: unknown): Promise<unknown> }> }).schedulerDeps();
  got = await to(() => scheduler.deliver(makeAlert({ text: "Time to leave for football" }, "routine", NOW, "u_adam")!));
  check("Adam's routine, from inside the object: Adam's browser only", got === "adam-browser", got);

  const relays = await (jarvis as unknown as { relayDeps(): Promise<{ deliver(a: unknown): Promise<unknown> }> }).relayDeps();
  got = await to(() => relays.deliver(makeAlert({ text: "No answer from Nenek", urgent: true }, "relay", NOW, "u_sara")!));
  check("an urgent one for Sara: urgent tries every channel, but still only hers", got === "sara-browser,sara-phone", got);

  // A job's result, from inside the object: kept in its starter's conversation, unless they have left the family.
  const inside: { jobs: { deps(): Promise<{ deliver(a: unknown): Promise<unknown> }> } } = jarvis as never;
  const jobDeps = await inside.jobs.deps();
  const done = (who?: string) => ({ ...makeAlert({ title: "Done: Dashcams", text: "The A229." }, "job", NOW, who)!, job: "jabc123def" });
  await jobDeps.deliver(done());
  check("a job's result for the first person: kept in their conversation", (await jarvis.conversationOf("owner", NOW)).some((s) => s.job?.id === "jabc123def"));
  await jobDeps.deliver(done("u_gone"));
  check("…not for someone no longer in the family: theirs went when they left", (await jarvis.conversationOf("u_gone", NOW)).length === 0);
} finally {
  globalThis.fetch = realFetch;
}

console.log("\nsigning out closes that sign-in's open screens, and no others");
{
  const screen = (tags: string[]) => ({ tags, closed: undefined as number | undefined, close(code: number) { this.closed = code; } });
  const phone = screen(["u_sara", "s:x_phone"]);
  const tablet = screen(["u_sara", "s:x_tablet"]);
  const car = screen(["owner"]);
  sockets.push(phone, tablet, car);
  await jarvis.closeSession("x_phone");
  check("that sign-in's screen closes, told not to reconnect (4001)", phone.closed === 4001, phone);
  check("her other sign-in's, and anyone else's, stay open", tablet.closed === undefined && car.closed === undefined);
  sockets.length = 0;

  // A screen opening after its sign-in ended (a Worker may hold the sign-in for 30 s) is refused.
  const g = globalThis as { WebSocketPair?: unknown };
  g.WebSocketPair = function () {
    return [{}, { serializeAttachment() {}, send() {} }];
  };
  const open = async (session: string) => {
    const ticket = await jarvis.mintTicket({ who: "u_sara", label: "phone", session });
    try {
      return (await jarvis.fetch(new Request(`https://jarvis.test/?ticket=${ticket}`, { headers: { upgrade: "websocket" } }))).status;
    } catch {
      return "accepted"; // Node cannot make the 101 answer itself; the object got as far as accepting it
    }
  };
  await storage.put("hub:sess:dg-live", { id: "x_live", digest: "dg-live", user: "u_sara", expiresAt: Date.now() + 86_400_000 });
  check("a screen for a sign-in that has ended is refused", (await open("x_gone")) === 401);
  check("one for a live sign-in is accepted, tagged with it", (await open("x_live")) === "accepted" && accepted.at(-1)?.join() === "u_sara,s:x_live", accepted);
}

console.log("\nproposals, through the object (lib/proposals.ts)");
{
  const now = Date.now();
  const filed = (person: string, job: string) =>
    jarvis.proposalAdd({ who: person, person, from: { kind: "job", id: job, title: "x" }, action: { tool: "car_command", args: { command: "lock" } }, weighed: { risk: "reversible", says: "Car: lock", category: "car_command:lock" }, grants: ["*"] }, now);
  const first = await jarvis.createJob({ title: "Tidy", task: "Tidy the car up after the trip.", engine: "jarvis" }, { who: "u_ana", grants: ["*"] });
  const ana = typeof first !== "string" ? await filed("u_ana", first.id) : "no job";
  check("a job that does not exist files nothing", typeof (await filed("u_ana", "j_none")) === "string");
  check("filed, and listed as its person's only", typeof ana !== "string" && (await jarvis.proposalsOf("u_ana", now)).length === 1 && (await jarvis.proposalsOf("u_ben", now)).length === 0);
  check("approved only as its own person", typeof ana !== "string" && (await jarvis.proposalApprove("u_ben", ana.id, ["*"], ["*"], now)) === "No such proposal." && typeof (await jarvis.proposalApprove("u_ana", ana.id, ["*"], ["*"], now)) !== "string");
  check("finished as its own person", typeof ana !== "string" && (await jarvis.proposalFinish("u_ana", ana.id, { ok: true, text: "Locked." }, now))?.state === "done");
  const job = await jarvis.createJob({ title: "Tidy", task: "Tidy the car up after the trip.", engine: "jarvis" }, { who: "u_ana", grants: ["*"] });
  const waiting = typeof job !== "string" ? await filed("u_ana", job.id) : "no job";
  if (typeof job !== "string") await jarvis.cancelJob(job.id);
  check("its job cancelled: withdrawn", typeof waiting !== "string" && (await jarvis.proposalGet("u_ana", waiting.id, now))?.state === "withdrawn", waiting);
  const late = typeof job !== "string" ? await jarvis.proposalAdd({ who: "u_ana", person: "u_ana", from: { kind: "job", id: job.id, title: "x" }, action: { tool: "car_command", args: { command: "unlock" } }, weighed: { risk: "irreversible", says: "Car: unlock" }, grants: ["*"] }, now) : "no job";
  check("a step still running when its job was cancelled files nothing", typeof late === "string" && /cancelled/.test(late) && (await jarvis.proposalsOf("u_ana", now)).every((p) => p.action.args.command !== "unlock"), late);
  // Put back, through the object: forwarded with its person and id, and the alarm set to make it.
  const tidy = await jarvis.createJob({ title: "Tidy", task: "Tidy the inbox.", engine: "jarvis" }, { who: "u_ana", grants: ["*"] });
  const archive = { tool: "mail_archive_many", args: { ids: ["promo001x", "promo002x"], total: 2 } };
  const archived = typeof tidy !== "string"
    ? await jarvis.proposalAdd({ who: "u_ana", person: "u_ana", from: { kind: "job", id: tidy.id, title: "x" }, action: archive, weighed: { risk: "reversible", says: "Mail: archive 2 promotions older than 2 days; they stay in All Mail", verb: "Archive" }, grants: ["*"] }, now)
    : "no job";
  if (typeof archived !== "string") {
    await jarvis.proposalApprove("u_ana", archived.id, ["*"], ["*"], now);
    await jarvis.proposalFinish("u_ana", archived.id, { ok: true, text: "Archived 2 promotions." }, now);
    alarmAt = null;
    check("Put back, as someone else: no such proposal", (await jarvis.proposalUndo("u_ben", archived.id, ["*"], ["*"], now)) === "No such proposal.");
    const back = await jarvis.proposalUndo("u_ana", archived.id, ["*"], ["*"], now);
    check("Put back through the object: its undo running, and the alarm set to make it", typeof back !== "string" && back.undoes === archived.id && back.action.tool === "mail_inbox_many" && back.state === "running" && alarmAt !== null, { back, alarmAt });
  } else check("an archive to put back was filed", false, archived);
  // For later, through the object: staged, the alarm set for its time; for getting home, refused without the house.
  if (typeof tidy !== "string") {
    alarmAt = null;
    const soon = now + 3 * 3_600_000;
    const later = await jarvis.proposalAdd({ who: "u_ana", person: "u_ana", from: { kind: "job", id: tidy.id, title: "x" }, action: { tool: "car_command", args: { command: "lock" } }, weighed: { risk: "reversible", says: "Car: lock", category: "car_command:lock" }, grants: ["*"], release: { at: soon } }, now);
    // Set again (rearm): to the soonest of everything due, here a job's step, which is sooner than the errand.
    check("staged through the object: for later, and the alarm set again", typeof later !== "string" && (await jarvis.proposalsLater("u_ana")).some((s) => s.id === later.id) && alarmAt !== null && alarmAt <= soon, { alarmAt });
    const home = await jarvis.proposalAdd({ who: "u_ana", person: "u_ana", from: { kind: "job", id: tidy.id, title: "x" }, action: { tool: "car_command", args: { command: "unlock" } }, weighed: { risk: "irreversible", says: "Car: unlock" }, grants: ["*"], release: { home: "arrive" } }, now);
    check("for when they get home, with no house to say so: refused, with why", typeof home === "string" && /cannot tell when they get home/.test(home), home);
  }
  // Not left running: at most three jobs run at once, and those below need theirs.
  if (typeof tidy !== "string") await jarvis.cancelJob(tidy.id);
  await jarvis.forgetMember("u_ana");
  check("someone who left: none of theirs kept", (await jarvis.proposalsOf("u_ana", now)).length === 0);
}

console.log("\na brief whose maker can no longer reach anything by its end (state.ts brief hook)");
{
  const now = Date.now();
  const hub: { people: { personView(p: string): Promise<unknown> } } = jarvis as never;
  const realView = hub.people.personView;
  const job = await jarvis.createJob({ title: "Car", task: "Lock the car tonight.", engine: "jarvis" }, { who: "u_pass", grants: ["*"] });
  const waiting = typeof job !== "string"
    ? await jarvis.proposalAdd({ who: "u_pass", person: "u_pass", from: { kind: "job", id: job.id, title: "Car" }, action: { tool: "car_command", args: { command: "lock" } }, weighed: { risk: "reversible", says: "Car: lock", category: "car_command:lock" }, grants: ["*"] }, now)
    : "no job";
  // Their pass ends while the brief is gathered: reaching everything at the start, nothing at the end.
  let looks = 0;
  hub.people.personView = async () => (looks++ === 0 ? { scopes: ["*"] } : { scopes: null });
  try {
    const inside: { schedulerDeps(): Promise<{ brief(r: unknown, now: number): Promise<{ ok: boolean; text: string }> }> } = jarvis as never;
    const deps = await inside.schedulerDeps();
    const r = { id: "rpass", name: "Morning brief", enabled: true, trigger: { kind: "daily", time: "07:00", days: [] }, action: { kind: "brief" }, grants: ["*"], createdBy: "u_pass", createdAt: now };
    const out = await deps.brief(r, now);
    check("nothing sent, and said why", !out.ok && /no longer in the family/.test(out.text), out);
    check("what was already theirs is kept: a card a job filed still waits (an ended pass keeps it)", typeof waiting !== "string" && (await jarvis.proposalGet("u_pass", waiting.id, now))?.state === "pending", waiting);
  } finally {
    hub.people.personView = realView;
    if (typeof job !== "string") await jarvis.cancelJob(job.id);
  }
}

console.log("\nan approved call, made on the object's alarm");
{
  const now = Date.now();
  const car = (command: string) => ({ command, value: null, temperature: null, percent: null, car: null });
  const job = await jarvis.createJob({ title: "Car", task: "Lock the car if it was left open.", engine: "jarvis" }, { who: "owner", grants: ["*"] });
  const jobId = typeof job !== "string" ? job.id : "no job";
  const file = async (command: string, says = weigh(carCommand, car(command), env)!.says, from = jobId, object = jarvis) => {
    const p = await object.proposalAdd({ who: "owner", person: "owner", from: { kind: "job", id: from, title: "Car" }, action: { tool: "car_command", args: car(command) }, weighed: { risk: "irreversible", says }, grants: ["*"] }, now);
    return typeof p === "string" ? p : p.id;
  };
  const lock = await file("lock");
  // Filed as one thing, and by the time the alarm makes it, reading as another: the card no longer matches.
  const other = await file("unlock", "Car: lock");
  const cut = await file("honk");
  const climate = await file("start_climate");
  // Someone who has left the family by the time the alarm comes, though their tap was allowed.
  const goneJob = await jarvis.createJob({ title: "Car", task: "Flash the lights.", engine: "jarvis" }, { who: "u_gone", grants: ["*"] });
  const gone = typeof goneJob !== "string" ? await jarvis.proposalAdd({ who: "u_gone", person: "u_gone", from: { kind: "job", id: goneJob.id, title: "Car" }, action: { tool: "car_command", args: car("flash_lights") }, weighed: { risk: "irreversible", says: "Car: flash lights" }, grants: ["*"] }, now) : "no job";
  /** Tessie, as the car's calls reach it: awake, and doing what it is told, or (hang) never answering. And a model that never answers (thinking). */
  const commands: string[] = [];
  let hang = false;
  let hung = false;
  let thinking = false;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (thinking && url.startsWith("https://api.openai.com/")) return new Promise<Response>(() => {});
    if (!url.startsWith("https://api.tessie.com/")) return new Response(null, { status: 201 });
    if (url.includes("/status")) return Response.json({ status: "awake" });
    commands.push(url.split("/command/")[1]?.split("?")[0] ?? url);
    if (!hang) return Response.json({ result: true });
    hung = true;
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  try {
    const claimed = await jarvis.proposalApprove("owner", lock, ["ask", "car.control", "calendar"], ["car.control", "ask"], now);
    const queued = (await storage.get(`proprun:owner:${lock}`)) as { grants?: string[] } | undefined;
    check("approved through the object: running, queued with what its tap allowed, nothing made yet", typeof claimed !== "string" && claimed.state === "running" && queued?.grants?.join() === "ask,car.control" && commands.length === 0, { claimed, queued });
    await jarvis.proposalApprove("owner", other, ["*"], ["*"], now);
    const goneId = typeof gone !== "string" ? gone.id : "none";
    await jarvis.proposalApprove("u_gone", goneId, ["*"], ["*"], now);
    await jarvis.alarm();
    const done = await jarvis.proposalGet("owner", lock, Date.now());
    check("the alarm makes the call, once, as its person", commands.join() === "lock" && done?.state === "done", { commands, done });
    const changed = await jarvis.proposalGet("owner", other, Date.now());
    check("one whose card no longer matches: failed, said so, and never made", changed?.state === "failed" && /has changed/.test(changed.outcome?.text ?? "") && !commands.includes("unlock"), changed);
    const left = await jarvis.proposalGet("u_gone", goneId, Date.now());
    check("whoever it was for has left the family when the alarm comes: failed, and nothing made", left?.state === "failed" && /no longer in the family/.test(left.outcome?.text ?? "") && !commands.includes("flash"), left);
    await jarvis.alarm();
    check("nothing made again on the next alarm, and nothing left to wake it", commands.join() === "lock" && alarmAt === null, { commands, alarmAt });

    // Still in the family, but no longer allowed the car by the time the alarm comes: the tap's grants are narrowed again.
    await jarvis.proposalApprove("owner", climate, ["*"], ["*"], Date.now());
    const hub: { people: { personView(person: string): Promise<unknown> } } = jarvis as never;
    const view = hub.people.personView;
    hub.people.personView = async () => ({ space: null, name: null, prefs: {}, cars: [], scopes: ["ask"] });
    try {
      await jarvis.alarm();
    } finally {
      hub.people.personView = view;
    }
    const narrowed = await jarvis.proposalGet("owner", climate, Date.now());
    check("a scope taken from them after the tap: not used, and nothing made", narrowed?.state === "failed" && /not yours to use now/.test(narrowed.outcome?.text ?? "") && !commands.includes("start_climate"), { narrowed, commands });

    await jarvis.proposalApprove("owner", cut, ["*"], ["*"], Date.now());
    check("approving sets the alarm, for nothing else is due", alarmAt !== null && alarmAt <= Date.now());
    // The object goes away mid-call (a deploy): the runtime tries the alarm again, on a fresh object over the same storage.
    hang = true;
    const due = await jarvis.createJob({ title: "Due", task: "Look something up.", engine: "jarvis" }, { who: "owner", grants: ["*"] });
    const dueId = typeof due !== "string" ? due.id : "none";
    void jarvis.alarm();
    for (let i = 0; i < 50 && !hung; i++) await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 200 && (await jarvis.getJob(dueId))?.status === "running"; i++) await new Promise((r) => setTimeout(r, 0));
    check("a call still being made holds up nothing else the alarm does (a job's step)", hung && (await jarvis.getJob(dueId))?.status !== "running");
    const fresh = new JarvisState(ctx, env);
    await new Promise((r) => setTimeout(r, 0));
    await fresh.alarm();
    check("cut short mid-call: the alarm tried again never makes it a second time", hung && commands.filter((c) => c === "honk").length === 1, commands);
    check("…and it reads as failed once it cannot still be going", (await fresh.proposalGet("owner", cut, Date.now()))?.state === "running" && (await fresh.proposalGet("owner", cut, Date.now() + STUCK_MS))?.state === "failed");

    // A job's step waiting on a model that does not answer: an approval in the same alarm is made all the same.
    hang = false;
    thinking = true;
    (env as { OPENAI_API_KEY?: string }).OPENAI_API_KEY = "sk-test";
    const slow = await fresh.createJob({ title: "Slow", task: "Think it over.", engine: "jarvis" }, { who: "owner", grants: ["*"] });
    const slowId = typeof slow !== "string" ? slow.id : "none";
    const warm = await file("start_climate", undefined, slowId, fresh);
    await fresh.proposalApprove("owner", warm, ["*"], ["*"], Date.now());
    void fresh.alarm();
    for (let i = 0; i < 200 && (await fresh.proposalGet("owner", warm, Date.now()))?.state === "running"; i++) await new Promise((r) => setTimeout(r, 0));
    check("an approval is not held up by a job's step still waiting on its model", (await fresh.proposalGet("owner", warm, Date.now()))?.state === "done" && commands.includes("start_climate") && (await fresh.getJob(slowId))?.status === "running");
  } finally {
    globalThis.fetch = realFetch;
    delete (env as { OPENAI_API_KEY?: string }).OPENAI_API_KEY;
  }
}

console.log("\nevery pass-through to StateHost forwards what it is given");
{
  /** The parameter names in a method's source: after type stripping, `a, b = x(), c` and the like. */
  const params = (fn: (...a: unknown[]) => unknown): string[] => {
    const src = fn.toString();
    let depth = 0;
    let start = -1;
    let out = "";
    for (let i = 0; i < src.length; i++) {
      const c = src[i]!;
      if (c === "(") {
        if (depth++ === 0) start = i + 1;
      } else if (c === ")" && --depth === 0) {
        out = src.slice(start, i);
        break;
      }
    }
    const names: string[] = [];
    let part = "";
    depth = 0;
    for (const c of out + ",") {
      if ("([{".includes(c)) depth++;
      if (")]}".includes(c)) depth--;
      if (c === "," && depth === 0) {
        const name = part.split("=")[0]!.replace(/\.\.\./, "").trim();
        if (name) names.push(name);
        part = "";
      } else part += c;
    }
    return names;
  };

  const proto = JarvisState.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const hostProto = StateHost.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const names = Object.getOwnPropertyNames(JarvisState.prototype).filter(
    (k) => k !== "constructor" && typeof proto[k] === "function" && typeof hostProto[k] === "function",
  );
  const wrong: string[] = [];
  for (const k of names) {
    const want = params(hostProto[k]!);
    // Every argument up to the last one that is not the clock: a method may leave `now` to its default.
    let last = want.length - 1;
    while (last >= 0 && want[last] === "now") last--;
    const sent = Array.from({ length: 6 }, (_, i) => ({ sentinel: i }));
    let got: unknown[] | undefined;
    const host = new Proxy({}, { get: (_t, m) => (...a: unknown[]) => { if (m === k) got = a; } });
    try {
      await proto[k]!.call({ host, rearm: async () => {} }, ...sent);
    } catch {
      /* what happens after the host call is not this check's business */
    }
    const ok = got !== undefined && sent.slice(0, last + 1).every((s, i) => got![i] === s);
    if (!ok) wrong.push(`${k}: host takes (${want.join(", ")}), object passed ${got ? got.length : "nothing"}`);
  }
  check(`all ${names.length} of them forward every argument but the clock`, names.length > 10 && wrong.length === 0, wrong);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
