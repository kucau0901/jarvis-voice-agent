// Panels on a person's Home tab: what is kept (lib/panels.ts), how each thing
// is read and which buttons its state offers (lib/panel-view.ts), what a press
// is checked against, and what the tool will put on one (tools/panels.ts).
import { MAX_HOUSE, MAX_ITEMS, MAX_PANELS, Panels, type Panel } from "../src/worker/lib/panels.ts";
import { actOn, carActions, houseActions, houseActive, houseIcon, houseValue, viewPanels, type PanelSources } from "../src/worker/lib/panel-view.ts";
import { panelRemove, panelSet } from "../src/worker/tools/panels.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 300) : ""); }
}

function fakeStorage() {
  const m = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => (m.has(k) ? (structuredClone(m.get(k)) as T) : undefined),
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string) => m.delete(k),
    list: async <T,>({ prefix }: { prefix: string }) =>
      new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T])),
  };
}

console.log("what is kept");
{
  const panels = new Panels(fakeStorage());
  const gate = { kind: "home" as const, ref: "cover.main_gate", label: "Main gate" };
  const porch = { kind: "home" as const, ref: "light.porch", label: "Porch light" };
  const made = await panels.set("u_sara", "Home Controls", [gate], "add", 1);
  check("a new panel is made under its name", typeof made !== "string" && made.title === "Home Controls" && made.items.length === 1, made);
  await panels.set("u_sara", "home controls", [gate, porch], "add", 2);
  const [one] = await panels.list("u_sara");
  check("adding to it, by its name in any case, does not double what is there", (await panels.list("u_sara")).length === 1 && one!.items.map((i) => i.ref).join() === "cover.main_gate,light.porch", one);
  await panels.set("u_sara", "Home Controls", [porch], "replace", 3);
  check("replace makes these all it holds", (await panels.list("u_sara"))[0]!.items.map((i) => i.ref).join() === "light.porch");
  check("each person's are their own", (await panels.list("owner")).length === 0);
  const many = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ kind: "note" as const, ref: "", label: `note ${i}` }));
  const tooMany = await panels.set("u_sara", "Too many", many, "add");
  check("a panel holds at most MAX_ITEMS (20), and says to put the rest on a second panel",
    MAX_ITEMS === 20 && typeof tooMany === "string" && tooMany.includes("second panel"), tooMany);
  for (let i = 1; i < MAX_PANELS; i++) await panels.set("u_sara", `P${i}`, [], "add");
  check("a person has at most MAX_PANELS", typeof (await panels.set("u_sara", "One more", [], "add")) === "string" && (await panels.list("u_sara")).length === MAX_PANELS);
  const notes = await panels.set("owner", "To do", [{ kind: "note", ref: "", label: "Renew the <b>road tax</b>\n" }], "add");
  check("text is kept plain: no markup, no control characters", typeof notes !== "string" && notes.items[0]!.label === "Renew the  b road tax /b".replace(/\s+/g, " "), notes);
  const off = await panels.remove("u_sara", "Home Controls", "porch light");
  check("one thing comes off a panel by its name", typeof off !== "string" && off.find((p) => p.title === "Home Controls")!.items.length === 0);
  check("removing what is not there says so, and lists the panels", String(await panels.remove("u_sara", "Nope", null)).includes("P1"));
  const gone = await panels.remove("u_sara", "P1", null);
  check("a whole panel comes off", typeof gone !== "string" && !gone.some((p) => p.title === "P1"));
  const long = await panels.set("u_sara", "The <very> long name of a panel that goes on and on", [{ kind: "note", ref: "", label: "Pay the bill > RM100" }], "add");
  check("a name or note changed when kept can still be removed by what was said",
    typeof long !== "string" && typeof (await panels.remove("u_sara", "The <very> long name of a panel that goes on and on", "Pay the bill > RM100")) !== "string");
  check("an empty name removes nothing, not every note", typeof (await panels.remove("owner", "To do", "")) === "string" && (await panels.list("owner"))[0]!.items.length === 1);
  check("not there: says what the panel does hold", String(await panels.remove("owner", "To do", "nothing like it")).includes("It holds:"));
  const lots = new Panels(fakeStorage());
  const things = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ kind: "home" as const, ref: `light.l${from + i}`, label: `L${from + i}` }));
  const first = await lots.set("owner", "House A", things(0, MAX_ITEMS), "add");
  const second = await lots.set("owner", "House B", things(MAX_ITEMS, MAX_HOUSE - MAX_ITEMS), "add");
  const over = await lots.set("owner", "House C", things(MAX_HOUSE, 1), "add");
  check("at most MAX_HOUSE things in the house across a person's panels (each is a request when shown)",
    MAX_HOUSE === 30 && typeof first !== "string" && typeof second !== "string" && typeof over === "string" && over.includes(String(MAX_HOUSE)), { first, second, over });
  check("…counting a thing on two panels once", typeof (await lots.set("owner", "House C", things(0, 6), "add")) !== "string");
  await panels.forget("u_sara");
  check("someone who leaves takes their panels with them", (await panels.list("u_sara")).length === 0 && (await panels.list("owner")).length === 1);
}

console.log("buttons follow the state");
check("a closed gate offers Open, an open one Close, a moving one Stop",
  houseActions("cover.main_gate", "closed").join() === "open" && houseActions("cover.main_gate", "open").join() === "close" && houseActions("cover.main_gate", "opening").join() === "stop");
check("a locked door offers Unlock, an unlocked one Lock, a jammed one nothing",
  houseActions("lock.front_door", "locked").join() === "unlock" && houseActions("lock.front_door", "unlocked").join() === "lock" && houseActions("lock.front_door", "jammed").length === 0);
check("a light that is on offers Turn off, and off Turn on", houseActions("light.porch", "on").join() === "off" && houseActions("switch.pump", "off").join() === "on");
check("unavailable or unknown offers nothing", houseActions("light.porch", "unavailable").length === 0 && houseActions("cover.main_gate", "unknown").length === 0);
check("a button or scene never yet used (state unknown) still offers Press or Run, with nothing to say",
  houseActions("button.gate_open", "unknown").join() === "press" && houseActions("scene.movie", "unknown").join() === "run" && houseValue("scene.movie", "unknown", {}) === "");
check("…but not when it is unavailable", houseActions("button.gate_open", "unavailable").length === 0 && houseValue("button.gate_open", "unavailable", {}) === "Unavailable");
check("a sensor or the weather is read, never worked", houseActions("sensor.outside", "31").length === 0 && houseActions("weather.home", "sunny").length === 0);
check("a sensor reads with its unit", houseValue("sensor.outside", "31", { unit_of_measurement: "°C" }) === "31 °C");
check("a room's light group is one row: on offers All off, off All on",
  houseActions("group.master_bedroom_light", "on").join() === "off" && houseActions("group.master_bedroom_light", "off").join() === "on");
check("…and says how many lights are in it",
  houseValue("group.master_bedroom_light", "on", { entity_id: ["light.a", "light.b", "switch.c"] }) === "On, 3 lights");
check("the weather reads with its temperature", houseValue("weather.home", "partlycloudy", { temperature: 31, temperature_unit: "°C" }) === "Partlycloudy, 31 °C", houseValue("weather.home", "partlycloudy", { temperature: 31, temperature_unit: "°C" }));
check("a door sensor says Open or Closed", houseValue("binary_sensor.back_door", "on", { device_class: "door" }) === "Open" && houseValue("binary_sensor.back_door", "off", { device_class: "door" }) === "Closed");
check("a cover says what it is doing", houseValue("cover.main_gate", "closed", {}) === "Closed");
check("a locked car offers Unlock and climate on; charging stopped offers Start charging",
  carActions({ locked: true, climateOn: false, charging: "Stopped" }).join() === "unlock,start_climate,start_charging");
check("an unlocked car with climate on, charging, offers Lock, climate off and Stop charging",
  carActions({ locked: false, climateOn: true, charging: "Charging" }).join() === "lock,stop_climate,stop_charging");
check("unplugged or full offers no charging button", carActions({ locked: null, climateOn: null, charging: "Disconnected" }).length === 0 && carActions({ locked: null, climateOn: null, charging: "Complete" }).length === 0);

console.log("how each thing is drawn");
check("a gate is a gate by its class, or by its name when it has none",
  houseIcon("cover.side", "closed", { device_class: "gate" }) === "gate" && houseIcon("cover.main_gate", "closed", {}) === "gate" && houseIcon("button.x", "unknown", { friendly_name: "Open the gate" }) === "gate");
check("a cover with no class or telling name is a blind", houseIcon("cover.study", "open", {}) === "blind");
check("a lock is drawn locked or open, as it is", houseIcon("lock.front_door", "locked", {}) === "lock" && houseIcon("lock.front_door", "unlocked", {}) === "unlock");
check("a switch named for a light is a light, a socket a plug, any other a power switch",
  houseIcon("switch.master_toilet", "off", { friendly_name: "Master toilet light" }) === "light" &&
  houseIcon("switch.kettle", "off", { device_class: "outlet" }) === "plug" && houseIcon("switch.pump", "off", {}) === "power");
check("a sensor by what it senses",
  houseIcon("sensor.outside", "31", { device_class: "temperature" }) === "temp" && houseIcon("sensor.bath", "60", { device_class: "humidity" }) === "drop" &&
  houseIcon("binary_sensor.hall", "on", { device_class: "motion" }) === "motion" && houseIcon("sensor.odd", "3", {}) === "sensor");
check("lit, open, moving, unlocked or cooling is drawn in colour",
  houseActive("light.porch", "on") && houseActive("cover.main_gate", "opening") && houseActive("lock.front_door", "unlocked") && houseActive("climate.bedroom", "cool"));
check("…and off, closed, locked or a reading is not",
  !houseActive("light.porch", "off") && !houseActive("cover.main_gate", "closed") && !houseActive("lock.front_door", "locked") &&
  !houseActive("climate.bedroom", "off") && !houseActive("sensor.outside", "31"));

/* A house, a car and the usage, faked, counting what is asked of them. */
function sources(over: Partial<PanelSources> = {}) {
  const house: Record<string, { state: string; attributes: Record<string, unknown> }> = {
    "cover.main_gate": { state: "closed", attributes: { friendly_name: "Main gate" } },
    "light.porch": { state: "on", attributes: {} },
  };
  const asked = { reads: 0, calls: [] as string[], snapshots: 0, woke: 0, commands: [] as string[] };
  const cfg = { token: "t", vin: "VIN1" };
  const src: PanelSources = {
    grants: ["*"],
    units: "metric",
    house: { base: "https://ha.example", token: "h" },
    read: async (_c, id) => (asked.reads++, house[id] ?? null),
    call: async (_c, d, s, id) => void asked.calls.push(`${d}.${s} ${id}`),
    car: (id) => (id === "c_1" ? { cfg, car: { id: "c_1", name: "Comet", level: "own", mine: true, vin: "VIN1", token: "t" } } : id === "c_see" ? { cfg, car: { id: "c_see", name: "Mum's", level: "see", mine: false, vin: "VIN1", token: "t" } } : null),
    snapshot: async () => (asked.snapshots++, { battery: 69, rangeMiles: 176, charging: "Disconnected", locked: true, climateOn: false, insideTemp: 31.4 }),
    wake: async () => void asked.woke++,
    command: async (_c, name) => (asked.commands.push(name), true),
    usage: async () => ({ month: "2026-10", total: { day: "", questions: 40, byHouse: 0, cost: { router: 1, live: 0.5, jobs: 0.25 }, liveSeconds: 600, jobs: 1, unpriced: 0 }, today: { day: "", questions: 3, byHouse: 0, cost: { router: 0, live: 0, jobs: 0 }, liveSeconds: 0, jobs: 0, unpriced: 0 }, medianMs: null, slowest: [], recent: [] }),
    ...over,
  };
  return { src, asked };
}

const panel: Panel = {
  id: "p_1",
  title: "Home Controls",
  at: 0,
  items: [
    { kind: "home", ref: "cover.main_gate", label: "Main gate" },
    { kind: "home", ref: "light.porch", label: "Porch light" },
    { kind: "car", ref: "c_1", label: "Comet" },
    { kind: "usage", ref: "usage", label: "What you have used" },
    { kind: "note", ref: "", label: "Renew the road tax" },
  ],
};

console.log("reading a panel");
{
  const { src, asked } = sources();
  const [view] = await viewPanels([panel, { ...panel, id: "p_2" }], src);
  const row = (k: string) => view!.rows.find((r) => r.key === k)!;
  check("the gate as it is now, with the button its state offers", row("cover.main_gate").value === "Closed" && row("cover.main_gate").actions.map((a) => a.label).join() === "Open", row("cover.main_gate"));
  check("the porch light, on, offers Turn off", row("light.porch").actions.map((a) => a.action).join() === "off");
  check("the gate drawn as a gate, closed; the porch light lit", row("cover.main_gate").icon === "gate" && !row("cover.main_gate").active && row("light.porch").icon === "light" && row("light.porch").active);
  const car = view!.rows.filter((r) => r.key === "c_1");
  check("the car is its tile (battery, range in km, unplugged), then its locks and its climate, each with its state",
    car.map((r) => `${r.label}: ${r.value}`).join("|") === "Comet: 283 km range · Unplugged|Locks: Locked|Climate: Off · 31°C inside" && car[0]!.level === 69, car);
  check("…each with the button its state offers, and none to charge while unplugged", car.map((r) => r.actions.map((a) => a.label).join("+")).join("|") === "|Unlock|Climate on", car);
  check("…drawn as the car, a lock and the climate", car.map((r) => r.icon).join() === "car,lock,climate");
  check("the usage as tiles", row("usage").tiles.map((t) => t.value).join("|") === "3 asked|40 asked|$1.75|10 min", row("usage").tiles);
  check("a note as itself", view!.rows.some((r) => r.kind === "note" && r.label === "Renew the road tax"));
  check("a thing on two panels is read once", asked.reads === 2 && asked.snapshots === 1, asked);
}
{
  const { src } = sources({ grants: ["screen", "car.read"] });
  const [view] = await viewPanels([panel], src);
  check("without home, the house is not read and says why", view!.rows[0]!.note?.includes("not yours") === true && view!.rows[0]!.actions.length === 0, view!.rows[0]);
  const car = view!.rows.filter((r) => r.key === "c_1");
  check("without car.control, the car is shown but offers nothing", car.length === 3 && car.every((r) => r.actions.length === 0), car);
}
{
  const [view] = await viewPanels([panel], sources({ units: "imperial" }).src);
  const car = view!.rows.filter((r) => r.key === "c_1");
  check("under imperial: range in miles, inside in °F", car[0]!.value === "176 miles range · Unplugged" && car[2]!.value === "Off · 89°F inside", car);
}
{
  const plugged = sources({ snapshot: async () => ({ battery: 12, rangeMiles: 30, charging: "Stopped", locked: false, climateOn: true }) });
  const [view] = await viewPanels([panel], plugged.src);
  const car = view!.rows.filter((r) => r.key === "c_1");
  check("plugged in and stopped: a charging tile offering Start charging",
    car.map((r) => `${r.label}=${r.actions.map((a) => a.label).join("+")}`).join("|") === "Comet=|Locks=Lock|Climate=Climate off|Charging=Start charging", car);
  check("…unlocked and the climate on drawn in colour, the lock open", car[1]!.icon === "unlock" && car[1]!.active && car[2]!.active && !car[3]!.active);
}
{
  const [view] = await viewPanels([{ ...panel, items: [{ kind: "car", ref: "c_see", label: "Mum's" }, { kind: "car", ref: "c_gone", label: "Old" }] }], sources().src);
  const seen = view!.rows.filter((r) => r.key === "c_see");
  check("a car shared to see shows its state, with no buttons", seen.length === 3 && seen.every((r) => r.actions.length === 0), seen);
  check("a car no longer theirs says so", view!.rows.find((r) => r.key === "c_gone")?.note?.includes("no longer") === true);
}
{
  const [view] = await viewPanels([panel], sources({ house: null }).src);
  check("no house connected: said, not guessed", view!.rows[0]!.note === "The house is not connected to Jarvis.");
  check("…and still drawn by its name", view!.rows[0]!.icon === "gate");
  const [down] = await viewPanels([panel], sources({ read: async () => { throw new Error("timeout"); } }).src);
  check("the house not answering: said, with no buttons", down!.rows[0]!.note?.includes("Could not reach") === true && down!.rows[0]!.actions.length === 0);
}

{
  const { src } = sources({ read: async () => ({ state: "on", attributes: { entity_id: ["light.a", "light.b"] } }) });
  const [view] = await viewPanels([{ ...panel, items: [{ kind: "home", ref: "group.master_bedroom_light", label: "Master bedroom lights" }] }], src);
  check("a group's button reads All off", view!.rows[0]!.actions.map((a) => a.label).join() === "All off" && view!.rows[0]!.value === "On, 2 lights", view!.rows[0]);
}

console.log("pressing a button");
const signal = new AbortController().signal;
{
  const { src, asked } = sources({ read: async () => ({ state: "on", attributes: {} }) });
  const group = await actOn({ ...panel, items: [{ kind: "home", ref: "group.master_bedroom_light", label: "Master bedroom lights" }] }, "group.master_bedroom_light", "off", src, signal);
  check("All off on a group switches it off as a whole, with Home Assistant's own service",
    group.status === 200 && group.text === "Master bedroom lights: All off." && asked.calls.join() === "homeassistant.turn_off group.master_bedroom_light", { group, calls: asked.calls });
}
{
  const { src, asked } = sources();
  const r = await actOn(panel, "cover.main_gate", "open", src, signal);
  check("Open on a closed gate opens it, through the pass's fixed service", r.status === 200 && asked.calls.join() === "cover.open_cover cover.main_gate", { r, asked });

  const stale = await actOn(panel, "cover.main_gate", "close", src, signal);
  check("a button its state no longer offers sends nothing", stale.status === 409 && asked.calls.length === 1, stale);
  check("a thing not on the panel is refused", (await actOn(panel, "lock.front_door", "unlock", src, signal)).status === 404 && asked.calls.length === 1);
  check("a note or the usage has no buttons", (await actOn(panel, "usage", "on", src, signal)).status === 404);
  check("no panel, no press", (await actOn(undefined, "cover.main_gate", "open", src, signal)).status === 404);
}
{
  const { src, asked } = sources({ grants: ["screen", "car.read", "car.control"] });
  check("without home, the house is not worked", (await actOn(panel, "cover.main_gate", "open", src, signal)).status === 403 && asked.calls.length === 0);
  const ok = await actOn(panel, "c_1", "unlock", src, signal);
  check("Unlock on a locked car wakes it and unlocks", ok.status === 200 && asked.woke === 1 && asked.commands.join() === "unlock", { ok, asked });
  check("Lock on a car that is locked already sends nothing", (await actOn(panel, "c_1", "lock", src, signal)).status === 409 && asked.commands.length === 1);
}
{
  const { src, asked } = sources();
  const seen = await actOn({ ...panel, items: [{ kind: "car", ref: "c_see", label: "Mum's" }] }, "c_see", "unlock", src, signal);
  check("a car shared to see is never worked", seen.status === 403 && asked.commands.length === 0, seen);
  const { src: noControl } = sources({ grants: ["screen", "car.read"] });
  check("without car.control, nor is any car", (await actOn(panel, "c_1", "unlock", noControl, signal)).status === 403);
}

console.log("the tool");
{
  const kept: { person: string; title: string; items: unknown[]; mode: string }[] = [];
  const stub = {
    panelSet: async (person: string, title: string, items: unknown[], mode: string) => (kept.push({ person, title, items, mode }), { id: "p_1", title, items, at: 0 }),
    panelsOf: async () => [{ id: "p_1", title: "Home Controls", items: [], at: 0 }],
    panelRemove: async (_p: string, title: string) => (title === "Home Controls" ? [] : `There is no panel called "${title}".`),
  };
  const STATE = { idFromName: () => "j", get: () => stub };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => {
    const url = String(u);
    if (url.endsWith("/api/states/cover.main_gate")) return new Response(JSON.stringify({ state: "closed", attributes: { friendly_name: "Main gate" } }));
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  try {
    const env = { STATE, JARVIS_PERSON: "u_sara", HA_BASE_URL: "https://ha.example", HA_TOKEN: "h", TESSIE_TOKEN: "t", TESSIE_VIN: "VIN1" };
    const ctx = (grants: string[], e: Record<string, unknown> = env) => ({ env: e, grants, signal, progress: () => {}, memory: null, display: () => {} }) as never;
    const run = (args: Record<string, unknown>, c: never) => panelSet.run(args as never, c) as Promise<string>;
    const items = [
      { kind: "home", ref: "cover.main_gate", label: null },
      { kind: "car", ref: null, label: "Comet" },
      { kind: "usage", ref: null, label: null },
      { kind: "note", ref: null, label: "Renew the road tax" },
    ];
    const said = await run({ title: "Home Controls", mode: "add", items }, ctx(["*"]));
    check("the house's own name, the car, the usage and a note go on the asker's panel",
      said.startsWith("Done") && kept[0]?.person === "u_sara" && JSON.stringify(kept[0]?.items) === JSON.stringify([
        { kind: "home", ref: "cover.main_gate", label: "Main gate" },
        { kind: "car", ref: "family", label: "Comet" },
        { kind: "usage", ref: "usage", label: "What you have used" },
        { kind: "note", ref: "", label: "Renew the road tax" },
      ]), { said, kept });
    check("a thing the house does not have is refused, and nothing is kept",
      (await run({ title: "X", mode: "add", items: [{ kind: "home", ref: "light.nowhere", label: null }] }, ctx(["*"]))).includes("there is no light.nowhere") && kept.length === 1);
    check("a made-up entity id is refused before the house is asked",
      (await run({ title: "X", mode: "add", items: [{ kind: "home", ref: "the gate", label: null }] }, ctx(["*"]))).includes("not an entity id"));
    check("without home, nothing from the house", (await run({ title: "X", mode: "add", items: [items[0]] }, ctx(["screen", "car.read"]))).includes("not this person's"));
    check("with no house connected, it says so", (await run({ title: "X", mode: "add", items: [items[0]] }, ctx(["*"], { ...env, HA_BASE_URL: undefined }))).includes("not connected"));
    check("without car.read, no car", (await run({ title: "X", mode: "add", items: [items[1]] }, ctx(["screen"]))).includes("not this person's to check"));
    check("a note needs its text", (await run({ title: "X", mode: "add", items: [{ kind: "note", ref: null, label: "" }] }, ctx(["screen"]))).includes("needs its text"));
    check("taking a panel away", String(await panelRemove.run({ title: "Home Controls", item: null } as never, ctx(["screen"]))).startsWith("Done"));
    check("…or saying there is none by that name", String(await panelRemove.run({ title: "Nope", item: null } as never, ctx(["screen"]))).includes("no panel called"));
    check("offered only to someone with screen, which a guest does not have", panelSet.scope === "screen" && panelRemove.scope === "screen");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
