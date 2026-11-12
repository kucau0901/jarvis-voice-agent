/**
 * The Durable Object itself (src/worker/state.ts) in Node, over a Map, with a
 * made-up family and a scripted model: for tests of what only the object
 * does (what it tells whom, its alarm, its routines). state.ts imports
 * "cloudflare:workers", which only the Workers runtime has; a module hook
 * stands a bare DurableObject in for it, as test/state-object.test.ts does.
 */
import { registerHooks } from "node:module";
import type { Alert, Delivery } from "../src/worker/lib/alerts.ts";
import type { ComponentView } from "../src/worker/lib/components.ts";
import { handleComponents } from "../src/worker/routes/components.ts";

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "cloudflare:workers") {
      return { url: "data:text/javascript,export class DurableObject{constructor(c,e){this.ctx=c;this.env=e}}", shortCircuit: true };
    }
    return next(spec, ctx);
  },
});
const runtime: { WebSocketRequestResponsePair?: unknown } = globalThis;
runtime.WebSocketRequestResponsePair = class {};
// After the hook: a static import would be hoisted above it.
const { JarvisState } = await import("../src/worker/state.ts");

export interface Person {
  /** As they are named everywhere: "owner" for the first person, else their id. */
  person: string;
  name: string;
  role: "admin" | "adult" | "child" | "guest";
  scopes: string[];
}

/** The object, with `people` as its family, and an environment whose STATE is that object. */
export async function objectWith(people: readonly Person[], vars: Record<string, unknown> = {}) {
  const m = new Map<string, unknown>();
  let alarmAt: number | null = null;
  const storage = {
    get: async (k: string) => structuredClone(m.get(k)),
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string) => m.delete(k),
    list: async ({ prefix = "" }: { prefix?: string } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])),
    getAlarm: async () => alarmAt,
    setAlarm: async (t: number) => void (alarmAt = t),
    deleteAlarm: async () => void (alarmAt = null),
  };
  const kv = new Map<string, string>();
  const CONFIG = {
    get: async (k: string, type?: string) => (type === "json" ? JSON.parse(kv.get(k) ?? "null") : (kv.get(k) ?? null)),
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (k: string, v: string) => void kv.set(k, v),
    delete: async (k: string) => void kv.delete(k),
    list: async () => ({ keys: [], list_complete: true }),
  };
  const base = { CONFIG, ALERT_ORDER: "live,push", TIMEZONE: "Asia/Kuala_Lumpur", ...vars };
  const ctx = {
    storage,
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    setWebSocketAutoResponse() {},
    getWebSockets: () => [],
    acceptWebSocket() {},
  };
  const jarvis = new JarvisState(ctx as never, base as never);
  await new Promise((r) => setTimeout(r, 0));

  // The family, in place of the hub's own records: who each is, and what they may reach now.
  const hub: { people: Record<string, (...a: never[]) => unknown> } = jarvis as never;
  hub.people.personView = async (person: string) => {
    const p = people.find((x) => x.person === person);
    return p ? { space: { id: "s1", name: "Home", agentName: "Jarvis", createdAt: 0 }, name: p.name, prefs: {}, cars: [], scopes: p.scopes } : { space: null, name: null, prefs: {}, cars: [], scopes: null };
  };
  hub.people.familyPeople = async () => people.map((p) => ({ person: p.person, name: p.name, role: p.role, chat: p.role !== "guest" }));
  hub.people.firstPerson = async () => "u_first";

  // Everything it told anyone, in order: the alert, and whose it was.
  const told: Alert[] = [];
  const host: { logDelivery(d: Delivery): Promise<void> } = jarvis as never;
  host.logDelivery = async (d) => void told.push(d.alert);

  /** The environment a request made as `person` has (index.ts forPerson): theirs, with the object behind it. */
  const envOf = (person: string) => ({ ...base, STATE: { idFromName: () => "j", get: () => jarvis }, JARVIS_PERSON: person, JARVIS_PERSON_NAME: people.find((p) => p.person === person)?.name ?? "" }) as never;
  const toldTo = (person: string) => told.filter((a) => (a.for ?? "owner") === person);
  return { jarvis, storage, m, envOf, told, toldTo, alarmAt: () => alarmAt };
}

/** What the scripted model does with one request: words to answer with, or one tool to call. */
export type Step = { say: string } | { call: string; args: Record<string, unknown> };

export interface Asked {
  /** The tools it was offered, by name. */
  tools: string[];
  /** Everything it was sent, as one string: its instructions, and every message. */
  sent: string;
  /** What its tools answered, on a later step. */
  outputs: string[];
}

/**
 * OpenAI's Responses API, as much as the router uses: each request is kept
 * in `asked`, and answered by `script`. After its tools answer, it says what
 * they said.
 */
export function fakeModel(script: (a: Asked) => Step) {
  const asked: Asked[] = [];
  let n = 0;
  const handle = (url: string, init: RequestInit): Response | null => {
    if (!url.startsWith("https://api.openai.com/")) return null;
    const body = JSON.parse(String(init.body ?? "{}")) as { model?: string; instructions?: string; input?: unknown[]; tools?: { type: string; name?: string; tools?: { name: string }[] }[] };
    const input = Array.isArray(body.input) ? body.input : [];
    const outputs = input.flatMap((i) => (typeof i === "object" && i !== null && "type" in i && i.type === "function_call_output" && "output" in i ? [String(i.output)] : []));
    const a: Asked = { tools: (body.tools ?? []).flatMap((t) => (t.type === "function" && t.name ? [t.name] : [])), sent: JSON.stringify([body.instructions, body.input, body.tools]), outputs };
    asked.push(a);
    const step: Step = outputs.length ? { say: outputs.join(" | ") } : script(a);
    const output = "call" in step
      ? [{ type: "function_call", id: `fc_${++n}`, call_id: `call_${n}`, name: step.call, arguments: JSON.stringify(step.args), status: "completed" }]
      : [{ type: "message", id: `msg_${++n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: step.say, annotations: [] }] }];
    return Response.json({
      id: `resp_${++n}`,
      object: "response",
      created_at: 0,
      status: "completed",
      model: body.model ?? "fake",
      output,
      output_text: "say" in step ? step.say : "",
      usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 110 },
    });
  };
  return { asked, handle };
}

/**
 * Settings → Components as the owner key (routes/components.ts): `change`
 * makes one request and gives back the component it answered with, or throws
 * what it refused; `plug` adds one, has it checked, and approves what it listed.
 */
export function settings(env: never) {
  const change = async (method: string, body: unknown): Promise<ComponentView> => {
    const r = await handleComponents(new Request("https://jarvis.example.com/api/components", { method, body: JSON.stringify(body) }), env, { kind: "owner" });
    const b = (await r.json()) as { component?: ComponentView; error?: string };
    if (!b.component) throw new Error(`${method} ${JSON.stringify(body)}: ${b.error}`);
    return b.component;
  };
  const plug = async (name: string, url: string, key?: string): Promise<string> => {
    const c = await change("POST", { name, url });
    if (key) await change("PUT", { id: c.id, key });
    const checked = await change("PATCH", { id: c.id, check: true });
    await change("PATCH", { id: c.id, approve: checked.waiting?.hash });
    return c.id;
  };
  return { change, plug };
}
