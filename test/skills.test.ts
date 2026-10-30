// Skills (lib/skills.ts, tools/skills.ts, routes/skills.ts): outside services
// and MCP servers added in chat, in the person's own words; each service's key
// set in Settings → Skills and never shown again; requests sent only to the
// address the skill was given.
import { MAX_SKILLS, Skills, callSkill, skillRequest, type Skill } from "../src/worker/lib/skills.ts";
import { askSkill, skillAdd, skillRemove } from "../src/worker/tools/skills.ts";
import { baseTools } from "../src/worker/tools/registry.ts";
import { handleSkills } from "../src/worker/routes/skills.ts";
import { prepareRouter } from "../src/worker/lib/router.ts";
import { jobTool } from "../src/worker/lib/jobs.ts";
import { requiredScope, SCOPES } from "../src/worker/lib/scopes.ts";
import { ROLE_SCOPES } from "../src/worker/lib/hub.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 300) : "");
  }
}

function fakeStorage() {
  const m = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => (m.has(k) ? (structuredClone(m.get(k)) as T) : undefined),
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string) => m.delete(k),
    list: async <T,>({ prefix }: { prefix: string }) => new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T])),
  };
}

const KEY = "nova-key-0123456789";
const NOVA = {
  name: "Nova",
  url: "https://bots.example.com/nova",
  when: "the house, the lights, the aircon and the Tesla",
  later: true,
  keyHeader: "X-Automation-Key",
  fields: [
    { name: "mode", value: "async" },
    { name: "instruction", value: "Deliver the answer yourself: Jarvis glasses always; HA speaker too if anyone is home." },
  ],
};

/** Every request the code under test made, as fetch was given it. */
let sent: { url: string; init: RequestInit }[] = [];
let reply: () => Response | Promise<Response> = () => new Response("", { status: 202 });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  sent.push({ url: String(input), init: init ?? {} });
  return reply();
}) as typeof fetch;
const never = new AbortController().signal;

/* ---------- the list ------------------------------------------------------ */

console.log("adding one");
{
  const skills = new Skills(fakeStorage());
  const s = await skills.add(NOVA, 1_000);
  check("  added, without a key", typeof s !== "string" && s.name === "Nova" && s.url === "https://bots.example.com/nova" && s.later && !s.hasKey, s);
  check("  its fields kept as given", typeof s !== "string" && s.fields.mode === "async" && s.fields.instruction === NOVA.fields[1]!.value, s);
  check("  not offered until it has a key", (await skills.ready()).length === 0);
  for (const [why, url] of [["plain http", "http://bots.example.com/nova"], ["the home network", "https://192.168.1.20/hook"], ["this machine", "https://localhost/hook"], [".local", "https://bot.local/hook"], ["a user in it", "https://me:pw@bots.example.com/nova"], ["not a URL", "nova"]] as const) {
    check(`  refused: ${why}`, (await skills.add({ ...NOVA, name: "Other", url }, 1_000)) === "its address must be https, and not one on the home network");
  }
  check("  refused: a header Jarvis sets itself", /set by Jarvis itself/.test(String(await skills.add({ ...NOVA, name: "Other", keyHeader: "Authorization" }, 1_000))));
  check("  refused: not a header name", /header name/.test(String(await skills.add({ ...NOVA, name: "Other", keyHeader: "X Key!" }, 1_000))));
  const own = await skills.add({ ...NOVA, name: "Own", fields: [{ name: "source", value: "jarvis" }, { name: "utterance", value: "x" }, { name: "mode", value: "async" }] }, 1_000);
  check("  a field of a name Jarvis sets itself: left out, the rest kept", typeof own !== "string" && JSON.stringify(own.fields) === '{"mode":"async"}', own);
  const unsaid = await skills.add({ ...NOVA, name: "Unsaid", when: "" }, 1_000);
  check("  no when to use it: kept, with none", typeof unsaid !== "string" && unsaid.when === "", unsaid);
  check("  refused: a field's name that is not one", /letters, digits/.test(String(await skills.add({ ...NOVA, name: "Other", fields: [{ name: "a b", value: "x" }] }, 1_000))));
  check("  refused: too many fields", /at most 8/.test(String(await skills.add({ ...NOVA, name: "Other", fields: Array.from({ length: 9 }, (_, i) => ({ name: `f${i}`, value: "x" })) }, 1_000))));
  check("  refused: no name", /its name/.test(String(await skills.add({ ...NOVA, name: "  " }, 1_000))));
}

console.log("its key");
{
  const skills = new Skills(fakeStorage());
  const s = (await skills.add(NOVA, 1_000)) as Exclude<Awaited<ReturnType<Skills["add"]>>, string>;
  check("  refused: too short, or with spaces", typeof (await skills.setKey(s.id, "short", 2_000)) === "string" && typeof (await skills.setKey(s.id, "has a space in it", 2_000)) === "string");
  check("  refused: no such skill", (await skills.setKey("knope", KEY, 2_000)) === "no such skill");
  const k = await skills.setKey(s.id, KEY, 2_000);
  check("  set", typeof k !== "string" && k.hasKey && k.updatedAt === 2_000, k);
  check("  never in the list", !JSON.stringify(await skills.list()).includes(KEY));
  check("  offered once set, with it", (await skills.ready())[0]?.key === KEY);
  const same = await skills.add({ ...NOVA, when: "the house and the car" }, 3_000);
  check("  changed by its name again: the same one, its key kept", typeof same !== "string" && same.id === s.id && same.hasKey && same.when === "the house and the car" && (await skills.list()).length === 1, same);
  const moved = await skills.add({ ...NOVA, url: "https://other.example.com/nova" }, 4_000);
  check("  given a new address, its key is dropped", typeof moved !== "string" && moved.id === s.id && !moved.hasKey && (await skills.ready()).length === 0, moved);
  check("  removed by its name", (await skills.remove("NOVA"))?.id === s.id && (await skills.list()).length === 0);
  check("  removing one not there", (await skills.remove("Friday")) === null && (await skills.remove("")) === null);
}

console.log("at most twenty");
{
  const skills = new Skills(fakeStorage());
  for (let i = 0; i < MAX_SKILLS; i++) await skills.add({ ...NOVA, name: `Bot ${i}` }, i);
  check(`  the ${MAX_SKILLS + 1}st refused`, /remove one first/.test(String(await skills.add({ ...NOVA, name: "One more" }, 99))));
  check("  one of them changed still", typeof (await skills.add({ ...NOVA, name: "Bot 3", when: "news" }, 99)) !== "string");
}

/* ---------- calling one --------------------------------------------------- */

const nova: Skill = { id: "k1", name: "Nova", url: NOVA.url, when: NOVA.when, later: true, keyHeader: "X-Automation-Key", fields: { mode: "async", instruction: NOVA.fields[1]!.value }, key: KEY, createdAt: 0, updatedAt: 0 };
const now = 1_793_000_000_123;

console.log("the request a skill is sent");
{
  sent = [];
  reply = () => new Response('{"accepted":true}', { status: 202 });
  const out = await callSkill(nova, "Turn on the porch light", never, now);
  const r = sent[0]!;
  const headers = r.init.headers as Record<string, string>;
  const body = JSON.parse(String(r.init.body)) as Record<string, string>;
  check("  one POST, to the skill's address and nowhere else", sent.length === 1 && r.url === NOVA.url && r.init.method === "POST", sent);
  check("  exactly these headers: the key as Bearer and in its own header, and JSON",
    JSON.stringify(headers) === JSON.stringify({ "Content-Type": "application/json", Authorization: `Bearer ${KEY}`, "X-Automation-Key": KEY }), headers);
  check("  exactly this body: an id, the request, who sent it, and the skill's fields",
    JSON.stringify(Object.keys(body).sort()) === JSON.stringify(["id", "instruction", "mode", "source", "utterance"]) &&
    body.utterance === "Turn on the porch light" && body.source === "jarvis" && body.mode === "async" && body.instruction === NOVA.fields[1]!.value, body);
  check("  its id is jarvis-<unix seconds>-<random>", new RegExp(`^jarvis-${Math.floor(now / 1000)}-[0-9a-z]{6}$`).test(body.id ?? ""), body.id);
  check("  a redirect is not followed", r.init.redirect === "manual");
  check("  answered later: sent, and the answer comes as a message", out.includes("Sent to Nova") && out.includes(body.id!) && out.includes("as a message") && !out.includes("accepted"), out);
  check("  never the key", !out.includes(KEY));
  check("  ids differ from one request to the next", skillRequest(nova, "x", now).id !== skillRequest(nova, "x", now).id);
  const plain = skillRequest({ ...nova, keyHeader: undefined }, "x", now).init.headers;
  check("  without a header named, the key goes as Bearer only", JSON.stringify(Object.keys(plain)) === JSON.stringify(["Content-Type", "Authorization"]), plain);
}

console.log("what comes back");
{
  reply = () => new Response(`denied: Bearer ${KEY} is not ${KEY}`, { status: 401 });
  const refused = await callSkill(nova, "x", never, now);
  check("  refused: said, the key taken out of what it said", refused.startsWith("Not sent: Nova answered 401") && !refused.includes(KEY), refused);
  check("  and what it said quoted as its words, not instructions", refused.includes("CONTENT WRITTEN BY NOVA") && refused.includes("denied:"), refused);
  reply = () => {
    throw new Error(`connect failed for https://bots.example.com/nova?key=${KEY}`);
  };
  const down = await callSkill(nova, "x", never, now);
  check("  unreachable: said, without the key", down.startsWith("Not sent: Nova could not be reached") && !down.includes(KEY), down);
  sent = [];
  reply = () => new Response("", { status: 302, headers: { location: "https://elsewhere.example.com/" } });
  const moved = await callSkill(nova, "x", never, now);
  check("  a redirect: not followed, and said", sent.length === 1 && /redirect/.test(moved) && !moved.includes(KEY), moved);
  reply = () => new Response("The porch light is on.", { status: 200 });
  const said = await callSkill({ ...nova, later: false }, "x", never, now);
  check("  answered at once: its answer, quoted as the service's words", said.includes("CONTENT WRITTEN BY NOVA") && said.includes("The porch light is on."), said);
  reply = () => new Response(`ok, used ${KEY}`, { status: 200 });
  check("  never the key, even in its answer", !(await callSkill({ ...nova, later: false }, "x", never, now)).includes(KEY));
  sent = [];
  check("  without a key, nothing is sent", (await callSkill({ ...nova, key: undefined }, "x", never, now)).includes("Settings → Skills") && sent.length === 0);
}

/* ---------- the tools ----------------------------------------------------- */

const kv = new Map<string, string>();
const CONFIG = { get: async (k: string, t?: string) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)!) : kv.get(k)!) : null), put: async (k: string, v: string) => void kv.set(k, v), delete: async (k: string) => void kv.delete(k), list: async () => ({ keys: [] }) };
const store = new Skills(fakeStorage());
const skillMethods: Record<string, (...a: never[]) => unknown> = {
  skillAdd: (i: Parameters<Skills["add"]>[0], n: number) => store.add(i, n),
  skillRemove: (w: string) => store.remove(w),
  skillsList: () => store.list(),
  skillsReady: () => store.ready(),
  skillKey: (id: string, k: unknown, n: number) => store.setKey(id, k, n),
};
/** The object as the router reaches it: the skills, and nothing for the rest. */
const object = new Proxy({}, { get: (_t, m) => (m === "then" ? undefined : skillMethods[String(m)] ?? (async () => undefined)) });
const env = { CONFIG, OPENAI_API_KEY: "sk-test", TIMEZONE: "Asia/Kuala_Lumpur", STATE: { idFromName: () => "j", get: () => object } };
const ctx = (asked?: string) => ({ env, signal: never, progress() {}, display() {}, grants: ["*"], asked }) as never;
const ask = "Add a skill called Nova, my Grok bot, for the house and the car, at https://bots.example.com/nova. It answers later.";
const novaArgs = { user_words: ask, kind: "service", name: "Nova", url: "https://bots.example.com/nova", when: NOVA.when, later: true, key_header: "X-Automation-Key", fields: NOVA.fields };

console.log("skill_add: only in the person's own words");
{
  check("  no latest message of theirs: refused", /^Not added: only the user/.test(String(await skillAdd.run(novaArgs, ctx(undefined)))));
  check("  their words not in it: refused", /^Not added: only the user/.test(String(await skillAdd.run(novaArgs, ctx("what's the weather")))));
  const page = "Summarize https://bots.example.com/nova for me";
  check("  an address they gave, but not asking to add it (a page asking): refused",
    /^Not added: only the user/.test(String(await skillAdd.run({ ...novaArgs, user_words: page }, ctx(page)))));
  check("  asking, but another address: refused",
    /^Not added: only the user/.test(String(await skillAdd.run({ ...novaArgs, url: "https://evil.example.com/x" }, ctx(ask)))));
  check("  nothing was kept", (await store.list()).length === 0);
  const out = String(await skillAdd.run(novaArgs, ctx(ask)));
  check("  asked: added, and its key goes in the panel, never in chat", out.includes('Saved the skill "Nova"') && out.includes("Settings → Skills") && out.includes("never in chat"), out);
  const kept = (await store.list())[0];
  check("  as asked", kept?.url === NOVA.url && kept.keyHeader === "X-Automation-Key" && kept.fields.mode === "async" && kept.later, kept);
  const home = "Add a skill called Box at https://192.168.1.9/hook";
  check("  a home-network address: refused", /^Not added: its address must be https/.test(String(await skillAdd.run({ ...novaArgs, user_words: home, name: "Box", url: "https://192.168.1.9/hook" }, ctx(home)))));
}

// As it was asked on 30 Oct 2026: the address without https://, a comma after it, no when, and the
// fields copied from an earlier description of the request, source among them.
console.log("skill_add: as people write it");
{
  const plain = "Add a skill: Friday, at bots.example.com/hooks/friday-0123,";
  const fridayArgs = { ...novaArgs, user_words: plain, name: "Friday", when: "", fields: [{ name: "mode", value: "async" }, { name: "source", value: "jarvis" }] };
  const added = async (args: Record<string, unknown>, asked: string) => {
    const out = String(await skillAdd.run(args, ctx(asked)));
    const kept = (await store.list()).find((s) => s.name === "Friday");
    await store.remove("Friday");
    return { out, kept };
  };
  const want = "https://bots.example.com/hooks/friday-0123";
  for (const [how, url, words] of [
    ["the address as they wrote it, without https://", "bots.example.com/hooks/friday-0123", plain],
    ["the model adding https:// to it", want, plain],
    ["and to their words too", want, "Add a skill: Friday, at https://bots.example.com/hooks/friday-0123,"],
    ["with the comma after it", `${want},`, plain],
  ] as const) {
    const { out, kept } = await added({ ...fridayArgs, url, user_words: words }, plain);
    check(`  ${how}: added, at https, with mode and without source`, out.includes('Saved the skill "Friday"') && kept?.url === want && JSON.stringify(kept.fields) === '{"mode":"async"}' && kept.when === "", { out, kept });
  }
  const typed = "Add a skill: Friday, at https://bots.example.com/hooks/friday-0123";
  check("  written with https://, the model leaving it out: added", (await added({ ...fridayArgs, url: "bots.example.com/hooks/friday-0123", user_words: "Add a skill: Friday, at bots.example.com/hooks/friday-0123" }, typed)).kept?.url === want);
  check("  plain http as they wrote it: refused", /^Not added: its address must be https/.test((await added({ ...fridayArgs, url: "http://bots.example.com/x", user_words: "Add a skill: Friday, at http://bots.example.com/x" }, "Add a skill: Friday, at http://bots.example.com/x")).out));
  check("  another address than theirs, with or without https://: refused",
    /^Not added: only the user/.test((await added({ ...fridayArgs, url: "evil.example.com/x" }, plain)).out) &&
    /^Not added: only the user/.test((await added({ ...fridayArgs, url: "https://evil.example.com/x" }, plain)).out));
  check("  no address at all: refused", /^Not added: only the user/.test((await added({ ...fridayArgs, url: "https://", user_words: "Add a skill: Friday" }, "Add a skill: Friday")).out));
}

console.log("skill_add: an MCP server");
{
  const said = "Connect the MCP server Weather Tools at https://mcp.example.com/weather, for forecasts";
  const out = String(await skillAdd.run({ ...novaArgs, user_words: said, kind: "mcp", name: "Weather Tools", url: "https://mcp.example.com/weather", when: "forecasts", later: null, key_header: null, fields: null }, ctx(said)));
  const servers = (JSON.parse(kv.get("config:mcp-servers") ?? "{}") as { servers?: { label: string; url: string; hint?: string; spokenAs?: string; headers?: unknown }[] }).servers ?? [];
  const added = servers.find((s) => s.label === "weather-tools");
  check("  connected, its token in Settings → MCP servers", out.includes("Connected the MCP server") && out.includes("Settings → MCP servers"), out);
  check("  in the list, after what was in force, with no header of its own", !!added && added.url === "https://mcp.example.com/weather" && added.hint === "forecasts" && added.spokenAs === "Weather Tools" && !added.headers && servers.length > 1, servers);
  check("  the same one again: refused", /connected already/.test(String(await skillAdd.run({ ...novaArgs, user_words: said, kind: "mcp", name: "Weather Tools", url: "https://mcp.example.com/weather", when: "forecasts", later: null, key_header: null, fields: null }, ctx(said)))));
}

console.log("skill_remove");
{
  check("  not their words: refused", /^Not removed/.test(String(await skillRemove.run({ user_words: "remove Nova", name: "Nova" }, ctx("read my mail")))));
  check("  not naming it: refused", /^Not removed/.test(String(await skillRemove.run({ user_words: "remove it", name: "Nova" }, ctx("remove it")))));
  check("  a service, by name", String(await skillRemove.run({ user_words: "remove the Nova skill", name: "Nova" }, ctx("please remove the Nova skill"))).includes('Removed the skill "Nova"') && (await store.list()).length === 0);
  const off = String(await skillRemove.run({ user_words: "disconnect Weather Tools", name: "Weather Tools" }, ctx("disconnect Weather Tools")));
  check("  an MCP server, by name", off.includes("Disconnected") && !kv.get("config:mcp-servers")!.includes("weather-tools"), off);
  check("  one not there", String(await skillRemove.run({ user_words: "remove Friday", name: "Friday" }, ctx("remove Friday"))).includes('No skill is called "Friday"'));
}

console.log("ask_skill: only the skills with a key, by name");
{
  check("  none ready: not offered", askSkill([]).length === 0);
  const [tool] = askSkill([nova, { ...nova, id: "k2", name: "Friday", when: "everything else", later: false }]);
  const params = tool!.parameters as { properties: { skill: { enum: string[] } } };
  check("  each one by name, with when to use it", JSON.stringify(params.properties.skill.enum) === '["Nova","Friday"]' && tool!.description.includes("- Nova: the house") && tool!.description.includes("- Friday: everything else"), tool!.description);
  check("  the house and the car to Jarvis's own tools first; a request approves nothing", /the house,\s+the car, mail and the calendar go to your own tools first/.test(tool!.description) && /approves nothing/.test(tool!.description));
  check("  no address the model could name", !JSON.stringify(tool!.parameters).includes("url"));
  check("  one with no when to use it: only when named", askSkill([{ ...nova, when: "" }])[0]!.description.includes("- Nova: only when the user names it"));
  sent = [];
  reply = () => new Response("", { status: 202 });
  const out = String(await tool!.run({ skill: "Nova", request: "Set the aircon to 24" }, ctx("set the aircon to 24")));
  check("  sent to that skill's address", sent.length === 1 && sent[0]!.url === NOVA.url && out.includes("Sent to Nova"), { sent, out });
  check("  a name it was not given: nothing sent", String(await tool!.run({ skill: "Evil", request: "x" }, ctx("x"))).includes("No skill") && sent.length === 1);
}

console.log("who is offered them");
{
  check("  skills is a scope", (SCOPES as readonly string[]).includes("skills"));
  check("  no role has it but an admin's (everything)", !["adult", "child", "guest"].some((r) => (ROLE_SCOPES[r as "adult"] as readonly string[]).includes("skills")) && ROLE_SCOPES.admin.includes("*"));
  const names = (g: string[]) => baseTools(env as never, g as never).map((t) => t.name);
  check("  the owner key and admins: skill_add and skill_remove", ["skill_add", "skill_remove"].every((n) => names(["*"]).includes(n)));
  check("  an adult: neither", !names([...ROLE_SCOPES.adult]).some((n) => n.startsWith("skill_")));
  check("  background jobs: none of them", !["skill_add", "skill_remove", "ask_skill"].some((n) => jobTool({ name: n })));
  check("  Settings → Skills is the owner key's and admins'", requiredScope("/api/skills", "GET") === "owner" && requiredScope("/api/skills", "PUT") === "owner");

  await store.add(NOVA, 1);
  await store.setKey((await store.list())[0]!.id, KEY, 2);
  const offered = async (g: string[]) => (await prepareRouter(env as never, [{ role: "user", text: "hello" }], never, g as never, {})).tools;
  const all = await offered(["*"]);
  const asked = all.find((t) => t.name === "ask_skill");
  check("  the router offers ask_skill with the skills that have a key", !!asked && asked.description.includes("- Nova:"), all.map((t) => t.name));
  check("  and never the key, in any tool it is shown", !JSON.stringify(all.map((t) => [t.description, t.parameters])).includes(KEY));
  check("  not to an adult", !(await offered([...ROLE_SCOPES.adult])).some((t) => t.name === "ask_skill"));
}

console.log("Settings → Skills");
{
  const get = await handleSkills(new Request("https://jarvis.example.com/api/skills"), env as never);
  const listed = (await get.json()) as { skills: { id: string; hasKey: boolean }[] };
  check("  listed, each saying whether it has a key, never the key", listed.skills[0]?.hasKey === true && !JSON.stringify(listed).includes(KEY), listed);
  const id = listed.skills[0]!.id;
  const put = (body: unknown) => handleSkills(new Request("https://jarvis.example.com/api/skills", { method: "PUT", body: JSON.stringify(body) }), env as never);
  const bad = await put({ id, key: "no" });
  check("  a key that cannot be one: refused, said", bad.status === 400 && /8 to 512/.test(((await bad.json()) as { error: string }).error));
  const ok = await put({ id, key: "friday-key-987654" });
  check("  a new key: saved, not echoed", ok.status === 200 && !(await ok.text()).includes("friday-key-987654") && (await store.ready())[0]?.key === "friday-key-987654");
  const del = await handleSkills(new Request(`https://jarvis.example.com/api/skills?id=${id}`, { method: "DELETE" }), env as never);
  check("  removed", del.status === 200 && (await store.list()).length === 0);
  const again = await handleSkills(new Request(`https://jarvis.example.com/api/skills?id=${id}`, { method: "DELETE" }), env as never);
  check("  one not there", again.status === 404);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
