// A Home tile's reading, through the real route, router, Durable Object and
// MCP client, against a made-up component and a made-up MCP server in
// process. A reading is run with nobody pressing anything, every time Home
// shows the tile, so it may only be a tool that only reads (lib/jobs.ts
// readsOnly): refused when the tile is made (tools/panels.ts) and each time
// it is read (lib/router.ts readTool), whatever is stored. A button may act:
// a press is a person asking.
import { objectWith, fakeModel, settings, type Person, type Step } from "./fake-object.ts";
import { fakeSchool, schemaOf, serve, type FakeComponent } from "./fake-component.ts";
import { handlePanels } from "../src/worker/routes/panels.ts";
import { readTool, run } from "../src/worker/lib/router.ts";
import { ACTS, parseTile } from "../src/worker/lib/panel-tiles.ts";
import { tileKey, type PanelItem } from "../src/worker/lib/panels.ts";
import { writeServers } from "../src/worker/lib/config-store.ts";
import { Collector } from "../src/worker/lib/collector.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 600) : "");
  }
}

const KEY = "school-key-0123456789";
const PEOPLE: Person[] = [{ person: "owner", name: "Adam", role: "admin", scopes: ["*"] }];
const o = await objectWith(PEOPLE, { OPENAI_API_KEY: "sk-test" });
const env = o.envOf("owner");

// A component: each of its tools is what an admin classed it as, whatever its name says.
const school = fakeSchool();
school.tools.push({ name: "timetable", description: "A teacher's timetable for a date.", inputSchema: schemaOf("teacher", "date") });
// An MCP server from Settings, as Home Assistant's is: its tools go by their names.
const house: FakeComponent = {
  url: "https://house.example.com/mcp",
  tools: [
    { name: "ha_get_state", description: "The state of one thing.", inputSchema: schemaOf("entity_id") },
    { name: "ha_call_service", description: "Call a service.", inputSchema: schemaOf("domain", "service", "entity_id") },
  ],
  seen: [],
  answer: (tool, args) => ({ text: `${tool} ${JSON.stringify(args)}` }),
};
/** What the scripted model does next, when it is asked. */
let next: Step = { say: "Nothing to do." };
const model = fakeModel(() => next);
const strays: string[] = [];
const restore = serve([school, house], { strays, also: model.handle });
const signal = new AbortController().signal;

/** The calls that reached a component or a server, by its tools' own names. */
const calls = (c: FakeComponent) => c.seen.filter((s) => s.rpc === "tools/call").map((s) => s.tool).join();

/** Asked in Chat as the owner: the scripted model makes one call, then says what its tool said. */
const ask = async (step: Step): Promise<string> => {
  next = step;
  const sink = new Collector();
  await run(env, [{ role: "user", text: "put it on a panel" }], sink, signal, ["*"], { surface: "chat" });
  return sink.finish().text;
};
type Call = [tool: string, args: Record<string, unknown>];
/** A tile as panel_set is given one: a reading, and buttons, each a tool with its arguments as JSON text. */
const tile = (label: string, read: Call | null, buttons: [label: string, ...call: Call][] = []) => ({
  kind: "tile",
  ref: null,
  label,
  read: read ? { tool: read[0], args: JSON.stringify(read[1]), ask: null, every_minutes: null, refresh: null } : null,
  buttons: buttons.map(([words, tool, args]) => ({ label: words, tool, args: JSON.stringify(args), ask: null, input: null })),
});
const make = (title: string, ...items: unknown[]) => ask({ call: "panel_set", args: { title, mode: "add", items } });

/** The Home tab's own requests, as the owner. */
const home = async (path: string, body?: unknown): Promise<{ status: number; text: string }> => {
  const req = new Request(`https://jarvis.example.com${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const res = (await handlePanels(req, env, { kind: "owner" }))!;
  const said = (await res.json()) as { text?: string; error?: string };
  return { status: res.status, text: said.text ?? said.error ?? "" };
};
const panelOf = async (title: string) => (await o.jarvis.panelsOf("owner")).find((p) => p.title === title)!;
/** A tile's reading, and one of its buttons pressed, by the tile's name on its panel. */
const keyOn = async (title: string, label: string) => {
  const p = await panelOf(title);
  return { panel: p.id, key: tileKey(p.items.find((i) => i.label === label)!.ref) };
};
const read = async (title: string, label: string) => {
  const { panel, key } = await keyOn(title, label);
  return home(`/api/hub/panels/read?panel=${panel}&key=${key}`);
};
const press = async (title: string, label: string, action: string) => home("/api/hub/panels/act", { ...(await keyOn(title, label)), action });

const RELIEF = { date: "2026-11-13", plan: "A" };
const DAY = { date: "2026-11-13" };
const WEEK = { teacher: "T. Rahman", date: "2026-11-13" };
const PORCH = { entity_id: "light.porch" };
const OFF = { domain: "light", service: "turn_off", entity_id: "light.porch" };
const NOTE = { title: null, text: "Home by seven." };
const notShown = (tool: string) => `Not shown: ${tool} can do more than look something up, so Home no longer runs it by itself. Ask Jarvis to make this tile again, with that on a button.`;

try {
  const { change: admin, plug } = settings(env);
  const id = await plug("School", school.url, KEY);
  // The admin's word over the name's, both ways: one named like a look-up that acts, one that reads though its name does not say so.
  await admin("PATCH", { id, classes: { get_timetable: "acts", timetable: "reads" } });
  await admin("PATCH", { id, shares: { owner: { level: "use", as: "A1" } } });
  await writeServers(env, [{ label: "house", url: house.url, enabled: true }]);
  school.seen.length = 0;
  house.seen.length = 0;

  console.log("making a tile: its reading must be a tool that only reads");
  {
    const refused = async (tool: string, args: Record<string, unknown>) => {
      const said = await make("Not these", tile("Bad", [tool, args]));
      return said.startsWith(`Nothing was changed: ${tool} cannot be a tile's reading: a reading is run by itself every time Home is shown`) && said.includes("Put it on a button");
    };
    check("not a component's tool an admin classed as acting", await refused("school__apply_relief", RELIEF));
    check("…even one named like a look-up", await refused("school__get_timetable", WEEK));
    check("not an MCP server's tool whose name does not say it only reads", await refused("house__ha_call_service", OFF));
    check("not one of Jarvis's own that acts", await refused("send_note", NOTE));
    check("so nothing was kept, and nothing was run to find out",
      (await o.jarvis.panelsOf("owner")).length === 0 && calls(school) === "" && calls(house) === "" && o.told.length === 0, await o.jarvis.panelsOf("owner"));

    const said = await make(
      "Readings",
      tile("Absent", ["school__get_absent", DAY]),
      tile("Timetable", ["school__timetable", WEEK]),
      tile("Porch", ["house__ha_get_state", PORCH]),
      tile("London", ["time_in", { zone: "Europe/London" }]),
    );
    const kept = (await panelOf("Readings")).items.map((i) => (parseTile(i.ref)?.read as { tool?: string } | undefined)?.tool);
    check("what only reads is taken: a component's by its class, an MCP server's by its name, Jarvis's own that says so",
      said.startsWith("Done") && kept.join() === "school__get_absent,school__timetable,house__ha_get_state,time_in", { said, kept });

    const acts = await make("Doing", tile("Relief", ["school__get_absent", DAY], [["Apply", "school__apply_relief", RELIEF], ["Porch off", "house__ha_call_service", OFF], ["Note", "send_note", NOTE]]));
    const buttons = parseTile((await panelOf("Doing")).items[0]!.ref)?.buttons.map((b) => b.tool?.tool);
    check("the tools that act are a button's: a press is a person asking", acts.startsWith("Done") && buttons?.join() === "school__apply_relief,house__ha_call_service,send_note", { acts, buttons });
    check("and still nothing was run by making them", calls(school) === "" && calls(house) === "" && o.told.length === 0);
  }

  console.log("\nreading a tile: only a tool that only reads is run");
  {
    const absent = await read("Readings", "Absent");
    const week = await read("Readings", "Timetable");
    const porch = await read("Readings", "Porch");
    const london = await read("Readings", "London");
    check("a component's reading tool is run, as the person looking", absent.status === 200 && absent.text.includes("get_absent") && school.seen.find((s) => s.tool === "get_absent")?.person === "A1", absent);
    check("…and one an admin classed as reading, whatever its name", week.status === 200 && week.text.includes("timetable"), week);
    check("an MCP server's, by its name", porch.status === 200 && porch.text.includes("ha_get_state"), porch);
    check("one of Jarvis's own", london.status === 200 && /\d{2}:\d{2}/.test(london.text), london);
    check("each ran once, and nothing else did", calls(school) === "get_absent,timetable" && calls(house) === "ha_get_state" && strays.length === 0, { school: calls(school), house: calls(house), strays });

    // Tiles as they were kept before a reading had to only read: a tool that acts as the reading.
    const old = (label: string, tool: string, args: Record<string, unknown>): PanelItem => ({ kind: "tile", ref: JSON.stringify({ read: { tool, args }, buttons: [{ label: "Do it", tool: { tool, args } }] }), label });
    await o.jarvis.panelSet("owner", "Kept from before", [
      old("Relief", "school__apply_relief", RELIEF),
      old("Week", "school__get_timetable", WEEK),
      old("Porch off", "house__ha_call_service", OFF),
      old("Note", "send_note", NOTE),
    ], "replace");
    school.seen.length = 0;
    house.seen.length = 0;
    const relief = await read("Kept from before", "Relief");
    const named = await read("Kept from before", "Week");
    const off = await read("Kept from before", "Porch off");
    const note = await read("Kept from before", "Note");
    check("a tile kept with a component's acting tool as its reading: not run, and it says why and what to do", relief.status === 409 && relief.text === notShown("school__apply_relief"), relief);
    check("…nor one named like a look-up that an admin classed as acting", named.status === 409 && named.text === notShown("school__get_timetable"), named);
    check("…nor an MCP server's tool that acts", off.status === 409 && off.text === notShown("house__ha_call_service"), off);
    check("…nor one of Jarvis's own", note.status === 409 && note.text === notShown("send_note"), note);
    check("none of them was called, and nothing was sent", calls(school) === "" && calls(house) === "" && o.told.length === 0, { school: calls(school), house: calls(house), told: o.told.length });

    check("asked of the router itself: ACTS for one of theirs that may do more, null for what is not theirs",
      (await readTool(env, ["*"], "school__apply_relief", RELIEF, signal)) === ACTS && (await readTool(env, ["*"], "music_control", {}, signal)) === null &&
      (await readTool(env, ["ask", "screen"], "school__get_absent", DAY, signal)) === null && calls(school) === "");

    // What the owner lets run by itself with nobody there (a routine, a job) is counted and told each time: a reading is neither.
    await admin("PATCH", { id, alone: { apply_relief: true } });
    const alone = await read("Kept from before", "Relief");
    check("nor one the owner lets run by itself: a reading is not counted or told", alone.status === 409 && alone.text === notShown("school__apply_relief") && calls(school) === "" && o.told.length === 0, alone);
  }

  console.log("\npressing a button: a person asking");
  {
    const applied = await press("Kept from before", "Relief", "b0");
    const call = school.seen.find((s) => s.rpc === "tools/call");
    check("the same tool on a button is run when pressed, as the person who pressed", applied.status === 200 && call?.tool === "apply_relief" && call.person === "A1" && JSON.stringify(call.args) === JSON.stringify(RELIEF), { applied, call });
    const off = await press("Doing", "Relief", "b1");
    check("an MCP server's acting tool too", off.status === 200 && calls(house) === "ha_call_service", { off, house: calls(house) });
    const note = await press("Doing", "Relief", "b2");
    check("and one of Jarvis's own", note.status === 200 && o.told.length === 1 && o.told[0]!.text === "Home by seven.", { note, told: o.told });
  }
} finally {
  restore();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
