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

function fakeStorage() {
  const m = new Map<string, unknown>();
  return {
    get: async (k: string | string[]) =>
      Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, structuredClone(m.get(x))])) : structuredClone(m.get(k)),
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string | string[]) => (Array.isArray(k) ? k.filter((x) => m.delete(x)).length : m.delete(k)),
    list: async ({ prefix = "" }: { prefix?: string } = {}) =>
      new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])),
    getAlarm: async () => null,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
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
  check("approved only as its own person", typeof ana !== "string" && (await jarvis.proposalClaim("u_ben", ana.id, now)) === "No such proposal." && typeof (await jarvis.proposalClaim("u_ana", ana.id, now)) !== "string");
  check("finished as its own person", typeof ana !== "string" && (await jarvis.proposalFinish("u_ana", ana.id, { ok: true, text: "Locked." }, now))?.state === "done");
  const job = await jarvis.createJob({ title: "Tidy", task: "Tidy the car up after the trip.", engine: "jarvis" }, { who: "u_ana", grants: ["*"] });
  const waiting = typeof job !== "string" ? await filed("u_ana", job.id) : "no job";
  if (typeof job !== "string") await jarvis.cancelJob(job.id);
  check("its job cancelled: withdrawn", typeof waiting !== "string" && (await jarvis.proposalGet("u_ana", waiting.id, now))?.state === "withdrawn", waiting);
  const late = typeof job !== "string" ? await jarvis.proposalAdd({ who: "u_ana", person: "u_ana", from: { kind: "job", id: job.id, title: "x" }, action: { tool: "car_command", args: { command: "unlock" } }, weighed: { risk: "irreversible", says: "Car: unlock" }, grants: ["*"] }, now) : "no job";
  check("a step still running when its job was cancelled files nothing", typeof late === "string" && /cancelled/.test(late) && (await jarvis.proposalsOf("u_ana", now)).every((p) => p.action.args.command !== "unlock"), late);
  await jarvis.forgetMember("u_ana");
  check("someone who left: none of theirs kept", (await jarvis.proposalsOf("u_ana", now)).length === 0);
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
