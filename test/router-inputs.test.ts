// What the router is given, pinned before it moves out of routes/delegate.ts
// (REFACTOR_PLAN.md steps 23-24): the tools each kind of person is offered,
// what it is told about who is asking (the family, a guest's pass, the cars
// they can reach, what waits for their answer), and ROUTER_PROMPT itself.
// Only the clock is taken out of what is compared.
import { createHash } from "node:crypto";
import { prepareRouter } from "../src/worker/routes/delegate.ts";
import { ROLE_SCOPES } from "../src/worker/lib/hub.ts";
const kv = new Map<string, string>();
const CONFIG = { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v), delete: async () => {}, list: async () => ({ keys: [] }) };
const people = [{ person: "owner", name: "Adam", role: "admin", chat: true }, { person: "u_sara", name: "Sara", role: "adult", chat: true }, { person: "u_siti", name: "Siti", role: "guest", chat: false }];
const stub = new Proxy({}, { get: (_t, m) => (m === "then" ? undefined : async () => (m === "familyPeople" ? people : m === "relaysAwaiting" ? [{ id: "r_1", kind: "ask", fromName: "Adam", text: "Coming for dinner?" }] : undefined)) });
const base = { CONFIG, OPENAI_API_KEY: "sk-test", TIMEZONE: "Asia/Kuala_Lumpur", STATE: { idFromName: () => "j", get: () => stub } };
const rich = { ...base, TESSIE_TOKEN: "t", TESSIE_VIN: "5YJTEST0000000001", HA_BASE_URL: "https://ha.example", HA_TOKEN: "h", GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s", SPOTIFY_CLIENT_ID: "a", SPOTIFY_CLIENT_SECRET: "b", GOOGLE_MAPS_API_KEY: "m", HERMES_BASE_URL: "https://hermes.example", HERMES_API_KEY: "k", JARVIS_FAMILY: "fam:s1", JARVIS_AGENT_NAME: "Friday" };
const cars = JSON.stringify([{ id: "family", name: "Adam's Model Y", level: "see", mine: false, vin: "5YJTEST0000000001", token: "t" }]);
const cases: [string, Record<string, unknown>, string[]][] = [
  ["owner key, nothing set up", base, ["*"]],
  ["admin, everything set up", { ...rich, JARVIS_PERSON: "owner", JARVIS_PERSON_NAME: "Adam" }, ["*"]],
  ["adult", { ...rich, JARVIS_PERSON: "u_sara", JARVIS_PERSON_NAME: "Sara", JARVIS_CARS: cars }, [...ROLE_SCOPES.adult]],
  ["child", { ...rich, JARVIS_PERSON: "u_aisyah", JARVIS_PERSON_NAME: "Aisyah" }, [...ROLE_SCOPES.child]],
  ["guest with a pass", { ...rich, JARVIS_PERSON: "u_siti", JARVIS_PERSON_NAME: "Siti", JARVIS_PASS: JSON.stringify([{ entity: "cover.main_gate", label: "Main gate" }]) }, [...ROLE_SCOPES.guest]],
];

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

const PROMPT_SHA256 = "e9b65b246d51cdbc73d3df3f721c9c7a72724ac5aa4bda78399f3135a243818e";
const EXPECTED: Record<string, { model: string; tools: string[]; input: string }> = {
 "owner key, nothing set up": {
  "model": "gpt-6-luna",
  "tools": [
   "forget",
   "hide_display",
   "recall",
   "remember",
   "routine_add",
   "routine_list",
   "routine_remove",
   "send_note",
   "start_job"
  ],
  "input": "802a8e76891d234f"
 },
 "admin, everything set up": {
  "model": "gpt-6-luna",
  "tools": [
   "answer_message",
   "ask_hermes",
   "calendar_add",
   "calendar_check",
   "car_command",
   "car_state",
   "chore_points",
   "contacts_lookup",
   "control_home",
   "directions",
   "family_messages",
   "forget",
   "hide_display",
   "look_at_camera",
   "mail_check",
   "mail_manage",
   "mail_search",
   "mail_send",
   "music_control",
   "music_play",
   "music_state",
   "pass_on",
   "place_info",
   "recall",
   "remember",
   "routine_add",
   "routine_list",
   "routine_remove",
   "send_note",
   "show_camera",
   "show_place",
   "start_job"
  ],
  "input": "c3e8500a4e0a9c83"
 },
 "adult": {
  "model": "gpt-6-luna",
  "tools": [
   "answer_message",
   "calendar_add",
   "calendar_check",
   "car_command",
   "car_state",
   "chore_points",
   "contacts_lookup",
   "directions",
   "family_messages",
   "forget",
   "hide_display",
   "look_at_camera",
   "mail_check",
   "mail_manage",
   "mail_search",
   "mail_send",
   "music_control",
   "music_play",
   "music_state",
   "pass_on",
   "place_info",
   "recall",
   "remember",
   "routine_add",
   "routine_list",
   "routine_remove",
   "send_note",
   "show_camera",
   "show_place",
   "start_job"
  ],
  "input": "50af82a7da439070"
 },
 "child": {
  "model": "gpt-6-luna",
  "tools": [
   "answer_message",
   "calendar_add",
   "calendar_check",
   "car_command",
   "car_state",
   "chore_points",
   "directions",
   "family_messages",
   "forget",
   "hide_display",
   "pass_on",
   "place_info",
   "recall",
   "remember",
   "routine_add",
   "routine_list",
   "routine_remove",
   "send_note",
   "show_place",
   "start_job"
  ],
  "input": "7760bbcac8b42817"
 },
 "guest with a pass": {
  "model": "gpt-6-luna",
  "tools": [
   "place_info",
   "start_job",
   "use_pass"
  ],
  "input": "3d132170346de762"
 }
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: unknown) => {
  throw new Error(`nothing here reaches the network: ${String(u)}`);
}) as typeof fetch;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const clockless = (s: string) =>
  s.replace(/RIGHT NOW it is [^(]*\(/g, "RIGHT NOW it is <now> (").replace(/The ISO form is [^.]*\.\d+Z/g, "The ISO form is <iso>").replace(/UTC[+-]\d{2}:\d{2}/g, "UTC<offset>");
try {
  for (const [name, env, grants] of cases) {
    const p = await prepareRouter(env as never, [{ role: "user", text: "hello" }], new AbortController().signal, grants as never, {});
    const input = clockless(JSON.stringify(p.input));
    const want = EXPECTED[name]!;
    console.log(name);
    check("  the prompt is ROUTER_PROMPT, unchanged", sha(p.instructions) === PROMPT_SHA256);
    check("  the model", p.model === want.model, p.model);
    check("  the tools it is offered", JSON.stringify(p.tools.map((t) => t.name).sort()) === JSON.stringify(want.tools), p.tools.map((t) => t.name).sort());
    check("  what it is told, word for word (but the clock)", sha(input).slice(0, 16) === want.input);
    if (name === "adult") {
      check("  (who is asking, the family, their cars, what waits for them)", ["You are answering Sara", "THE FAMILY: Adam, Sara (the person asking), Siti.", "CARS THEY CAN REACH", "shared with them to see only", "WAITING FOR THEIR ANSWER", "The family calls you Friday"].every((s) => input.includes(s)));
    }
    if (name === "guest with a pass") check("  (the guest's pass)", input.includes("PASS: this person is a guest. In the house they may work only: Main gate (use_pass). Nothing else."));
  }
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
