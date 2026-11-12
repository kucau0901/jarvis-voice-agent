// Components (lib/components.ts): outside systems plugged into Jarvis. What
// each offers is listed, approved by an admin and pinned; who reaches it is a
// share per person; its key and its reporting address are in no view.
import {
  ALONE_PER_DAY,
  Components,
  INBOX_PREFIX,
  MAX_COMPONENTS,
  MAX_DESCRIPTION,
  MAX_TOOLS,
  TOLD_PER_DAY,
  catalogOf,
  manifestEvents,
  type ComponentView,
  type Listed,
} from "../src/worker/lib/components.ts";
import { looksLikeToken, sha256Hex } from "../src/worker/lib/devices.ts";

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
    m,
    get: async <T,>(k: string) => (m.has(k) ? (structuredClone(m.get(k)) as T) : undefined),
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string) => m.delete(k),
    list: async <T,>({ prefix }: { prefix: string }) => new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T])),
  };
}

const DAY = "2026-11-12";
const URL_A = "https://school.example.com/mcp";
const KEY = "school-key-0123456789";
const MANIFEST = JSON.stringify({ jarvis: 1, events: [{ type: "leave_filed", says: "A teacher filed leave" }], things: [{ later: true }] });
const str = { type: "string" };
const schema = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((n) => [n, str])), required: names });
/** The made-up school, as a check finds it. */
const school = (over: Partial<Listed> = {}): Listed => ({
  url: URL_A,
  version: "1.0.0",
  manifest: MANIFEST,
  tools: [
    { name: "get_absent", description: "Who is absent on a date.", inputSchema: schema("date"), readOnly: true },
    { name: "get_timetable", description: "A teacher's timetable for a date.", inputSchema: schema("teacher", "date") },
    { name: "find_relief", description: "Relief plans for a date's absences.", inputSchema: schema("date"), readOnly: true },
    { name: "apply_relief", description: "Apply a relief plan for a date.", inputSchema: schema("date", "plan"), readOnly: false },
  ],
  ...over,
});
const ok = <T,>(v: T | string): T => {
  if (typeof v === "string") throw new Error(v);
  return v;
};
const tool = (v: ComponentView | undefined, name: string, of: "pinned" | "waiting" = "pinned") => v?.[of]?.tools.find((t) => t.name === name);

console.log("adding one");
const storage = fakeStorage();
const parts = new Components(storage);
{
  const add = (input: { name: unknown; url: unknown; label?: unknown }, taken: string[] = []) => parts.add(input, "owner", taken, 1_000);
  check("an address on the home network is refused", /https/.test(String(await add({ name: "School", url: "https://192.168.1.20/mcp" }))));
  check("so is plain http", typeof (await add({ name: "School", url: "http://school.example.com/mcp" })) === "string");
  check("it cannot be called Jarvis", /Jarvis/.test(String(await add({ name: "jarvis", url: URL_A }))));
  for (const label of ["arrived", "left", "home-assistant", "skill-notes", "jarvis", "house", "home", "family", "car"]) {
    check(`the label ${label} is kept back`, /taken/.test(String(await add({ name: "School", url: URL_A, label }))));
  }
  check("so is the label of an MCP server in force", /taken/.test(String(await add({ name: "School", url: URL_A, label: "notes" }, ["notes"]))));
  check("a label is short, lower-case, and starts with a letter", [await add({ name: "School", url: URL_A, label: "School" }), await add({ name: "School", url: URL_A, label: "9lives" }), await add({ name: "School", url: URL_A, label: "a" }), await add({ name: "School", url: URL_A, label: "much-too-long-a-label" })].every((r) => typeof r === "string"));
  check("a name with no label to be made of it asks for one", /label/.test(String(await add({ name: "学校", url: URL_A }))));
  const s = ok(await add({ name: "  Sekolah\nSeri Example ", url: URL_A, label: "school" }));
  check("added: its id, its label, its name on one line, switched on, shared with nobody", /^cp[0-9a-z]{8}$/.test(s.id) && s.label === "school" && s.name === "Sekolah Seri Example" && s.enabled && Object.keys(s.shares).length === 0 && s.createdBy === "owner" && s.createdAt === 1_000, s);
  check("nothing approved, nothing waiting, no key, no address", !s.pinned && !s.waiting && !s.hasKey && !s.address);
  const canteen = ok(await add({ name: "Canteen Till", url: "https://till.example.com/mcp" }));
  check("with no label given, one is made of its name", canteen.label === "canteen-till", canteen.label);
  check("two cannot share a name", /called/.test(String(await add({ name: "canteen till", url: "https://other.example.com/mcp", label: "till2" }))));
  await parts.remove(canteen.id);
}
const id = (await parts.list(DAY))[0]!.id;

console.log("\nits key");
{
  check("too short a key is refused", typeof (await parts.setKey(id, "short", 2_000)) === "string");
  const k = ok(await parts.setKey(id, KEY, 2_000));
  check("set, at the time given", k.hasKey && k.updatedAt === 2_000);
  check("and in no view", !JSON.stringify(await parts.list(DAY)).includes(KEY));
  check("the Worker's check is told where to list, with it", JSON.stringify(await parts.target(id)) === JSON.stringify({ label: "school", name: "Sekolah Seri Example", url: URL_A, key: KEY }));
  check("none for one that is not there", (await parts.target("cpnone0000")) === null);
}

console.log("\nits manifest");
{
  check("none: tools only", JSON.stringify(manifestEvents(null)) === "[]");
  check("its events, and keys it does not know ignored", JSON.stringify(manifestEvents(MANIFEST)) === JSON.stringify([{ type: "leave_filed", says: "A teacher filed leave" }]));
  check("not JSON", typeof manifestEvents("{") === "string");
  check("not version 1", /"jarvis": 1/.test(String(manifestEvents(JSON.stringify({ jarvis: 2, events: [] })))));
  check("over 8 KB", /8 KB/.test(String(manifestEvents(JSON.stringify({ jarvis: 1, pad: "x".repeat(9_000) })))));
  check("more than sixteen events", /at most 16/.test(String(manifestEvents(JSON.stringify({ jarvis: 1, events: Array.from({ length: 17 }, (_, i) => ({ type: `e${i}`, says: "x" })) })))));
  check("a type that is not lower-case letters, digits and _", typeof manifestEvents(JSON.stringify({ jarvis: 1, events: [{ type: "Leave-Filed", says: "x" }] })) === "string");
  check("one declared twice", /twice/.test(String(manifestEvents(JSON.stringify({ jarvis: 1, events: [{ type: "a", says: "x" }, { type: "a", says: "y" }] })))));
  check("one that says nothing", /says/.test(String(manifestEvents(JSON.stringify({ jarvis: 1, events: [{ type: "a" }] })))));
  const long = manifestEvents(JSON.stringify({ jarvis: 1, events: [{ type: "a", says: `line one\nline two ${"x".repeat(200)}` }] }));
  check("what it says is one line, cut to a hundred characters", typeof long !== "string" && long[0]!.says.length === 100 && !long[0]!.says.includes("\n"), long);
}

console.log("\nwhat it lists");
{
  const { catalog, skipped } = ok(await catalogOf(school(), 5_000));
  const cls = Object.fromEntries(catalog.tools.map((t) => [t.name, t.reads]));
  check("a tool reads only if its own name reads and it does not say otherwise", cls.get_absent === true && cls.get_timetable === true && cls.find_relief === true && cls.apply_relief === false, cls);
  check("none starts with leave to run by itself, or switched off", catalog.tools.every((t) => !t.alone && !t.off) && skipped.length === 0);
  const odd = ok(await catalogOf(school({ tools: [
    { name: "get_grades", description: "Reads grades.", readOnly: false },
    { name: "submit_marks", description: "Says it only reads.", readOnly: true },
    { name: "Get-Roster", description: "A name Jarvis cannot use." },
    { name: "get_grades", description: "Listed again." },
    { name: "get_everything", description: "x", inputSchema: { type: "object", properties: { pad: { type: "string", description: "x".repeat(5_000) } } } },
    { name: "get_long", description: `first line\nsecond ${"y".repeat(600)}` },
  ] }), 5_000));
  const by = Object.fromEntries(odd.catalog.tools.map((t) => [t.name, t]));
  check("a reading name that says it does not only read: acts", by.get_grades?.reads === false && by.get_grades.hint === false);
  check("a name that does not read acts, whatever it says of itself", by.submit_marks?.reads === false && by.submit_marks.hint === true);
  check("left out, with why: a bad name, one listed twice, a schema over 4 KB", JSON.stringify(odd.skipped.map((s) => s.name)) === JSON.stringify(["Get-Roster", "get_grades", "get_everything"]) && /4 KB/.test(odd.skipped[2]!.why), odd.skipped);
  check("a description is one line, cut to five hundred characters", by.get_long?.description.length === MAX_DESCRIPTION && !by.get_long.description.includes("\n"));
  const many = ok(await catalogOf(school({ tools: Array.from({ length: MAX_TOOLS + 2 }, (_, i) => ({ name: `get_thing_${i}` })) }), 5_000));
  check("thirty tools at most", many.catalog.tools.length === MAX_TOOLS && many.skipped.length === 2 && /30/.test(many.skipped[0]!.why));
  check("a bad manifest is said, and nothing is kept of it", /manifest/.test(String(await catalogOf(school({ manifest: "nope" }), 5_000))));
  check("nothing it can use at all", /nothing/.test(String(await catalogOf(school({ tools: [], manifest: null }), 5_000))));
  check("events alone are enough: one that only reports", typeof (await catalogOf(school({ tools: [] }), 5_000)) !== "string");
  const shuffled = ok(await catalogOf(school({ tools: [...school().tools].reverse() }), 9_000));
  check("the same things in another order are the same approval", shuffled.catalog.hash === catalog.hash);
  const moved = ok(await catalogOf(school({ url: "https://elsewhere.example.com/mcp" }), 5_000));
  check("the same things at another address are not", moved.catalog.hash !== catalog.hash);
}

console.log("\napproved, pinned, and offered only then");
let hash = "";
{
  check("checked at an address that is no longer its own: refused", /address changed/.test(String(await parts.listed(id, school({ url: "https://old.example.com/mcp" }), 5_000))));
  const first = ok(await parts.listed(id, school(), 5_000));
  hash = first.component.waiting!.hash;
  check("what it lists waits, each tool new and classed as approving would", !first.component.pinned && first.component.waiting!.tools.length === 4 && first.component.waiting!.tools.every((t) => t.change === "new") && tool(first.component, "apply_relief", "waiting")?.reads === false);
  check("shown with its arguments by name, never its whole schema", JSON.stringify(tool(first.component, "apply_relief", "waiting")?.args) === '["date","plan"]' && !JSON.stringify(first.component).includes("inputSchema"));
  await parts.setShares(id, { owner: { level: "use" } }, ["owner"], 5_500);
  check("nothing is offered before an admin approves it", (await parts.offeredTo("owner")).length === 0);
  check("approving something else than was shown is refused", /changed since you looked/.test(String(await parts.approve(id, "0".repeat(64), null, 6_000))));
  check("so is a class that is not one", typeof (await parts.approve(id, hash, { apply_relief: "maybe" }, 6_000)) === "string");
  check("and a class for a tool it does not have", /no tool/.test(String(await parts.approve(id, hash, { delete_school: "off" }, 6_000))));
  const done = ok(await parts.approve(id, hash, { get_timetable: "off" }, 6_000));
  check("approved: pinned, in force, nothing waiting", done.pinned?.inForce === true && done.pinned.hash === hash && !done.waiting && done.pinned.at === 6_000, done);
  check("a tool can be approved as switched off", tool(done, "get_timetable")?.off === true);
  const mine = (await parts.offeredTo("owner"))[0]!;
  check("offered to who it is shared with: what is on, with its key for the Worker", mine.label === "school" && mine.key === KEY && mine.tools.map((t) => t.name).join() === "apply_relief,find_relief,get_absent" && mine.events[0]?.type === "leave_filed", mine);
  check("approving again with nothing waiting: refused", /nothing waits/.test(String(await parts.approve(id, hash, null, 6_500))));
  const again = ok(await parts.listed(id, school(), 7_000));
  check("checked again and unchanged: nothing waits", !again.component.waiting && again.component.pinned?.hash === hash);
}

console.log("\nwho reaches it");
{
  const people = ["owner", "u_sara", "u_adam"];
  check("a share is see or use", typeof (await parts.setShares(id, { u_sara: { level: "all" } }, people, 8_000)) === "string");
  check("only for someone in the family", /not in the family/.test(String(await parts.setShares(id, { u_gone: { level: "see" } }, people, 8_000))));
  check("their id there is what a header can carry", typeof (await parts.setShares(id, { u_sara: { level: "see", as: "T 1\r\nX-Evil: 1" } }, people, 8_000)) === "string");
  const shared = ok(await parts.setShares(id, { u_sara: { level: "see", tell: true, as: "T1" } }, people, 8_000));
  check("shared: only the people named change", JSON.stringify(shared.shares) === JSON.stringify({ owner: { level: "use" }, u_sara: { level: "see", tell: true, as: "T1" } }), shared.shares);
  const sara = (await parts.offeredTo("u_sara"))[0]!;
  check("see: its reading tools only, and who they are there", sara.level === "see" && sara.as === "T1" && sara.tools.map((t) => t.name).join() === "find_relief,get_absent", sara);
  check("someone with no share is offered nothing, whoever they are", (await parts.offeredTo("u_adam")).length === 0);
  const off = ok(await parts.setEnabled(id, false, 8_500));
  check("switched off: offered to nobody", !off.enabled && (await parts.offeredTo("owner")).length === 0);
  await parts.setEnabled(id, true, 8_600);
  await parts.forget("u_sara");
  check("someone who left: nothing stays shared with them", !("u_sara" in (await parts.list(DAY))[0]!.shares) && (await parts.offeredTo("u_sara")).length === 0);
  ok(await parts.setShares(id, { u_sara: { level: "see", tell: true, as: "T1" } }, people, 8_700));
  const gone = ok(await parts.setShares(id, { u_sara: null }, people, 8_800));
  check("a share taken away", !("u_sara" in gone.shares));
}

console.log("\nacting by itself");
{
  check("a reading tool needs no leave", /only reads/.test(String(await parts.setAlone(id, { get_absent: true }, 9_000))));
  check("nor one switched off", /switched off/.test(String(await parts.setAlone(id, { get_timetable: true }, 9_000))));
  check("nor one it does not have", /no tool/.test(String(await parts.setAlone(id, { delete_school: true }, 9_000))));
  const set = ok(await parts.setAlone(id, { apply_relief: true }, 9_000));
  check("an acting tool can be let run by itself", tool(set, "apply_relief")?.alone === true && (await parts.offeredTo("owner"))[0]!.tools.find((t) => t.name === "apply_relief")?.alone === true);
  const read = ok(await parts.setClasses(id, { apply_relief: "reads" }, 9_100));
  check("made a reading tool, it keeps no leave", tool(read, "apply_relief")?.reads === true && !tool(read, "apply_relief")?.alone);
  const acts = ok(await parts.setClasses(id, { apply_relief: "acts", get_timetable: "reads" }, 9_200));
  check("made an acting tool again, it asks first", tool(acts, "apply_relief")?.reads === false && !tool(acts, "apply_relief")?.alone && !tool(acts, "get_timetable")?.off);
  ok(await parts.setAlone(id, { apply_relief: true }, 9_300));
  const cleared = ok(await parts.setAlone(id, { apply_relief: false }, 9_400));
  check("and the leave can be taken back", !tool(cleared, "apply_relief")?.alone);
  ok(await parts.setAlone(id, { apply_relief: true }, 9_500));
}

console.log("\na changed description is held, and the pinned one stays");
{
  const changed = school();
  changed.tools[3] = { ...changed.tools[3]!, description: "Apply a relief plan for a date. Also emails every parent." };
  changed.tools.push({ name: "get_rooms", description: "Free rooms." });
  changed.tools.splice(2, 1);
  const held = ok(await parts.listed(id, changed, 10_000));
  const w = held.component.waiting!;
  check("it waits: what changed, what is new, what it no longer lists", tool(held.component, "apply_relief", "waiting")?.change === "changed" && tool(held.component, "get_rooms", "waiting")?.change === "new" && !tool(held.component, "get_absent", "waiting")?.change && JSON.stringify(w.gone) === '["find_relief"]', w);
  check("the pinned list stays in force meanwhile", held.component.pinned?.hash === hash && (await parts.offeredTo("owner"))[0]!.tools.find((t) => t.name === "apply_relief")?.description === "Apply a relief plan for a date.");
  check("a changed tool is shown as it would be approved: asking first", !tool(held.component, "apply_relief", "waiting")?.alone);
  const done = ok(await parts.approve(id, w.hash, null, 11_000));
  check("approved: the changed tool goes back to asking first", tool(done, "apply_relief")?.reads === false && !tool(done, "apply_relief")?.alone && tool(done, "apply_relief")?.description.endsWith("every parent."));
  check("an unchanged one keeps the class it was given", tool(done, "get_timetable")?.reads === true && tool(done, "get_absent")?.reads === true && !tool(done, "find_relief"));
  ok(await parts.setAlone(id, { apply_relief: true }, 11_100));
  const same = ok(await parts.listed(id, { ...changed, tools: [...changed.tools, { name: "get_term", description: "Term dates." }] }, 11_200));
  const kept = ok(await parts.approve(id, same.component.waiting!.hash, null, 11_300));
  check("a tool that did not change keeps its leave through another approval", tool(kept, "apply_relief")?.alone === true);
}

console.log("\nmoved to another address");
{
  const NEW_URL = "https://school.example.org/mcp";
  const moved = ok(await parts.add({ name: "Sekolah Seri Example", url: NEW_URL, label: "school" }, "u_sara", [], 12_000));
  check("the same label again: that one, moved, not a second", moved.id === id && moved.url === NEW_URL && (await parts.list(DAY)).length === 1 && moved.createdBy === "owner");
  check("its key is dropped: it is typed again for the new address", !moved.hasKey && (await parts.target(id))?.key === undefined);
  check("what was approved is no longer in force, and nothing is offered", moved.pinned?.inForce === false && (await parts.offeredTo("owner")).length === 0);
  check("nothing can be let run by itself until it is approved there", /approve/.test(String(await parts.setAlone(id, { apply_relief: true }, 12_100))));
  const there = ok(await parts.listed(id, school({ url: NEW_URL }), 12_200));
  check("checked there: every tool is new", there.component.waiting!.tools.every((t) => t.change === "new"));
  const done = ok(await parts.approve(id, there.component.waiting!.hash, null, 12_300));
  check("approved there: nothing keeps leave to run by itself, and each tool has its own first class", done.pinned!.tools.every((t) => !t.alone) && tool(done, "apply_relief")?.reads === false && tool(done, "get_timetable")?.reads === true && done.pinned!.inForce);
  const back = ok(await parts.add({ name: "School", url: NEW_URL, label: "school" }, "owner", [], 12_400));
  check("the same address again only renames it", back.name === "School" && back.pinned?.inForce === true);
}

console.log("\nits reporting address");
{
  const made = ok(await parts.newAddress(id, 13_000));
  const digest = await sha256Hex(made.token);
  check("a token of its own, shown once", looksLikeToken(made.token, INBOX_PREFIX) && made.component.address?.at === 13_000 && made.component.address.hint.startsWith(INBOX_PREFIX));
  check("kept only as its digest, which is in no view either", !JSON.stringify([...storage.m]).includes(made.token) && !JSON.stringify(await parts.list(DAY)).includes(digest));
  check("found by it", (await parts.byToken(digest))?.id === id);
  check("not by another", (await parts.byToken(await sha256Hex("jcp1_" + "a".repeat(32)))) === null);
  await parts.setEnabled(id, false, 13_100);
  check("not while it is switched off", (await parts.byToken(digest)) === null);
  await parts.setEnabled(id, true, 13_200);
  const again = ok(await parts.newAddress(id, 13_300));
  check("a new one stops the old", (await parts.byToken(digest)) === null && (await parts.byToken(await sha256Hex(again.token)))?.id === id);
  const dropped = ok(await parts.dropAddress(id, 13_400));
  check("stopped", !dropped.address && (await parts.byToken(await sha256Hex(again.token))) === null);
  const third = ok(await parts.newAddress(id, 13_500));
  await parts.add({ name: "School", url: URL_A, label: "school" }, "owner", [], 13_600);
  check("moved to another address: its reporting address stops too", (await parts.byToken(await sha256Hex(third.token))) === null && !(await parts.list(DAY))[0]!.address);
}

console.log("\na day's limits");
{
  let told = 0;
  for (let i = 0; i < TOLD_PER_DAY + 3; i++) if (await parts.count(id, DAY, "told", TOLD_PER_DAY)) told++;
  let acted = 0;
  for (let i = 0; i < ALONE_PER_DAY + 3; i++) if (await parts.count(id, DAY, "acted", ALONE_PER_DAY)) acted++;
  check("thirty things told, twenty done by itself, and no more", told === TOLD_PER_DAY && acted === ALONE_PER_DAY);
  check("shown in Settings", JSON.stringify((await parts.list(DAY))[0]!.today) === JSON.stringify({ told: TOLD_PER_DAY, acted: ALONE_PER_DAY }));
  check("the next day starts again", (await parts.count(id, "2026-11-13", "acted", ALONE_PER_DAY)) && JSON.stringify((await parts.list("2026-11-13"))[0]!.today) === JSON.stringify({ told: 0, acted: 1 }));
}

console.log("\nat most twenty, and removing one");
{
  const made: string[] = [];
  const refused: string[] = [];
  for (let i = 0; i < MAX_COMPONENTS; i++) {
    const r = await parts.add({ name: `Shop ${i}`, url: `https://shop${i}.example.com/mcp` }, "owner", [], 14_000 + i);
    if (typeof r === "string") refused.push(r);
    else made.push(r.id);
  }
  check("the twenty-first is refused", made.length === MAX_COMPONENTS - 1 && refused.length === 1 && /20 components/.test(refused[0]!), refused);
  for (const m of made) await parts.remove(m);
  await parts.listed(id, school(), 15_000);
  const token = ok(await parts.newAddress(id, 15_100)).token;
  check("removed", (await parts.remove(id)) && (await parts.list(DAY)).length === 0 && !(await parts.remove(id)));
  check("with its key, what waited, its address and its counts", storage.m.size === 0 && (await parts.byToken(await sha256Hex(token))) === null, [...storage.m.keys()]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
