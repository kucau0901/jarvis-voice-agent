// Panels on a person's Home tab: what is kept (lib/panels.ts), how each thing
// is read and which buttons its state offers (lib/panel-view.ts), what a press
// is checked against, and what the tool will put on one (tools/panels.ts).
import { MAX_HOUSE, MAX_ITEMS, MAX_PANELS, MAX_REFRESHED, noteKey, Panels, tileKey, type Panel, type PanelRefreshDeps } from "../src/worker/lib/panels.ts";
import { actOn, carActions, houseActions, houseActive, houseIcon, houseValue, viewPanels, type PanelSources } from "../src/worker/lib/panel-view.ts";
import { panelList, panelRemove, panelSet, panelsText } from "../src/worker/tools/panels.ts";
import { areasOf, arrange } from "../src/worker/lib/panel-arrange.ts";
import { controlCall, controlsOf } from "../src/worker/lib/panel-controls.ts";
import { parseTile, pressTile, readingOf, readTile, tileIcon, tileSpec } from "../src/worker/lib/panel-tiles.ts";
import { historyOf, readTileOf } from "../src/worker/lib/panel-view.ts";
import { entityHistory } from "../src/worker/lib/ha.ts";
import { alertChoice, alertsOn, setAlert, watchFor, type AlertDeps } from "../src/worker/lib/panel-alerts.ts";
import type { Routine, RoutineInput } from "../src/worker/lib/routines.ts";
import { everyWords } from "../src/shared/panels.ts";

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
  const room = Array.from({ length: 8 }, (_, i) => `light.master_bedroom_lamp_${i}`).join(",");
  const together = await lots.set("u_room", "Home Controls", [{ kind: "home", ref: room, label: "Master bedroom lights" }], "add");
  check("a room's lights together are kept whole, however long their ids", typeof together !== "string" && together.items[0]!.ref === room && room.length > 120, together);
  const more = await lots.set("u_room", "More", [{ kind: "home", ref: things(0, MAX_HOUSE - 7).map((i) => i.ref).join(","), label: "Lots" }], "add");
  check("…and each of them counts towards MAX_HOUSE", typeof more === "string" && more.includes(String(MAX_HOUSE)), more);
  await panels.forget("u_sara");
  check("someone who leaves takes their panels with them", (await panels.list("u_sara")).length === 0 && (await panels.list("owner")).length === 1);
}

console.log("moved by dragging: the order is the person's");
{
  const store = new Panels(fakeStorage());
  for (const t of ["Gate", "Car", "Music", "To do"]) await store.set("u", t, [], "add");
  const ids = Object.fromEntries((await store.list("u")).map((p) => [p.title, p.id]));
  const moved = await store.order("u", [ids.Music!, ids.Gate!, ids.Car!, ids["To do"]!]);
  check("kept in the order given", moved.map((p) => p.title).join() === "Music,Gate,Car,To do" && (await store.list("u")).map((p) => p.title).join() === "Music,Gate,Car,To do");
  await store.set("u", "Air", [], "add");
  const stale = await store.order("u", [ids.Car!, ids.Music!, ids.Car!, "p_someone_elses"]);
  check("one made meanwhile is not lost, an id twice or not theirs is passed over",
    stale.map((p) => p.title).join() === "Car,Music,Gate,To do,Air", stale.map((p) => p.title));
  check("each person's own", (await store.order("v", [ids.Car!])).length === 0 && (await store.list("u")).length === 5);
  const made = await store.set("u", "Gate", [{ kind: "note", ref: "", label: "Oil the hinges" }], "add");
  check("a panel changed keeps its place", typeof made !== "string" && (await store.list("u")).map((p) => p.title).join() === "Car,Music,Gate,To do,Air");
  const things = await store.set("u", "Car", [
    { kind: "home", ref: "cover.main_gate", label: "Main gate" }, { kind: "note", ref: "", label: "Wash it" }, { kind: "tile", ref: '{"read":null,"buttons":[]}', label: "Music" },
  ], "add");
  const id = (things as Panel).id;
  const tile = tileKey('{"read":null,"buttons":[]}');
  const sorted = await store.orderThings("u", id, [tile, noteKey("wash it"), "light.nowhere"]);
  check("a panel's things in the order dragged, by their keys; one not named stays after them",
    typeof sorted !== "string" && sorted.items.map((i) => i.label).join() === "Music,Wash it,Main gate", sorted);
  check("…on a panel that is there", typeof (await store.orderThings("u", "p_none", [tile])) === "string");
}

console.log("a checklist: typed onto a panel, ticked off, cleared");
{
  const lists = new Panels(fakeStorage());
  const made = await lists.set("u", "To do", [{ kind: "note", ref: "", label: "Renew the road tax" }, { kind: "note", ref: "", label: "Book the service" }], "add");
  const id = (made as Panel).id;
  const added = await lists.addNote("u", id, "  Buy milk ");
  check("a to-do typed onto the panel goes after the others", typeof added !== "string" && added.items.map((i) => i.label).join() === "Renew the road tax,Book the service,Buy milk", added);
  check("…not twice", typeof (await lists.addNote("u", id, "buy MILK")) === "string" && typeof (await lists.addNote("u", id, "   ")) === "string");
  const one = await lists.tick("u", id, noteKey("Renew the road tax"));
  check("ticked, it goes to the bottom, marked done",
    typeof one !== "string" && one.items.map((i) => `${i.label}${i.ref === "done" ? "✓" : ""}`).join() === "Book the service,Buy milk,Renew the road tax✓", one);
  const next = await lists.addNote("u", id, "Water the plants");
  check("a new one goes above the ticked ones", typeof next !== "string" && next.items.map((i) => i.label).at(-1) === "Renew the road tax" && next.items[2]!.label === "Water the plants");
  const back = await lists.tick("u", id, noteKey("renew the road tax"));
  check("ticked again, it is open again, above any still ticked", typeof back !== "string" && back.items.every((i) => i.ref === "") && back.items.at(-1)!.label === "Renew the road tax");
  await lists.tick("u", id, noteKey("Book the service"));
  await lists.tick("u", id, noteKey("Buy milk"));
  const cleared = await lists.clearTicked("u", id);
  check("Clear ticked takes off only the ticked ones", typeof cleared !== "string" && cleared.items.map((i) => i.label).join() === "Water the plants,Renew the road tax", cleared);
  check("a to-do or a panel that is not there is said so", typeof (await lists.tick("u", id, "n_nothing")) === "string" && typeof (await lists.addNote("u", "p_none", "x")) === "string");
  await lists.tick("u", id, noteKey("Water the plants"));
  const [view] = await viewPanels(await lists.list("u"), sources().src);
  check("drawn with each its own key, the ticked one marked done",
    view!.rows.map((r) => `${r.key === noteKey(r.label) ? "k" : "?"}:${r.label}${r.done ? "✓" : ""}`).join() === "k:Renew the road tax,k:Water the plants✓", view!.rows);
  check("Jarvis's own layout keeps ticked ones below the open",
    arrange([{ kind: "note", ref: "done", label: "a" }, { kind: "note", ref: "", label: "b" }], new Map()).map((i) => i.label).join() === "b,a");
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
  houseIcon("switch.master_bath", "off", { friendly_name: "Master bathroom light" }) === "light" &&
  houseIcon("switch.kettle", "off", { device_class: "outlet" }) === "plug" && houseIcon("switch.pump", "off", {}) === "power");
check("a sensor by what it senses",
  houseIcon("sensor.outside", "31", { device_class: "temperature" }) === "temp" && houseIcon("sensor.bath", "60", { device_class: "humidity" }) === "drop" &&
  houseIcon("binary_sensor.hall", "on", { device_class: "motion" }) === "motion" && houseIcon("sensor.odd", "3", {}) === "sensor");
check("an alarm is a shield, and a bell once it has gone off",
  houseIcon("alarm_control_panel.house", "armed_night", {}) === "alarm" && houseIcon("alarm_control_panel.house", "disarmed", {}) === "alarm" &&
  houseIcon("alarm_control_panel.house", "triggered", {}) === "alert");
check("…drawn in colour while armed, arming or going off, not disarmed",
  houseActive("alarm_control_panel.house", "armed_night") && houseActive("alarm_control_panel.house", "arming") &&
  houseActive("alarm_control_panel.house", "triggered") && !houseActive("alarm_control_panel.house", "disarmed"));
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
    pick: () => ({ cfg, car: { id: "c_1", name: "Comet", level: "own", mine: true, vin: "VIN1", token: "t" } }),
    car: (id) => (id === "c_1" ? { cfg, car: { id: "c_1", name: "Comet", level: "own", mine: true, vin: "VIN1", token: "t" } } : id === "c_see" ? { cfg, car: { id: "c_see", name: "Mum's", level: "see", mine: false, vin: "VIN1", token: "t" } } : null),
    snapshot: async () => (asked.snapshots++, { battery: 69, rangeMiles: 176, charging: "Disconnected", locked: true, climateOn: false, insideTemp: 31.4 }),
    wake: async () => void asked.woke++,
    command: async (_c, name) => (asked.commands.push(name), true),
    tool: async () => null,
    ask: async () => "",
    look: async () => "",
    history: async () => [],
    maps: false,
    routines: async () => [],
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
  check("…with no budget, nothing said of one", row("usage").value === "", row("usage"));
  const budgeted = sources({ budget: async () => ({ limit: 20, spent: 10 }) });
  const [withBudget] = await viewPanels([panel], budgeted.src);
  const usage = withBudget!.rows.find((r) => r.key === "usage")!;
  check("with a budget: how much of it is gone first, then the money, and when it resets",
    usage.tiles.map((t) => `${t.label}: ${t.value}`).join("|") === "Budget used: 50% of $20.00|Today: $0.00|Spent this month: $1.75|Live this month: 10 min" && usage.value === "Resets 1 November", usage);
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

console.log("a room's lights together");
{
  const room: Record<string, { state: string; attributes: Record<string, unknown> }> = {
    "light.bed_a": { state: "on", attributes: {} },
    "light.bed_b": { state: "off", attributes: {} },
    "switch.bed_c": { state: "off", attributes: { friendly_name: "Bedside lamp" } },
    "light.reading": { state: "unavailable", attributes: { friendly_name: "Reading lamp" } },
  };
  const ref = "light.bed_a,light.bed_b,switch.bed_c,light.reading";
  const roomPanel: Panel = { ...panel, items: [{ kind: "home", ref, label: "Master bedroom lights" }] };
  const calls: string[] = [];
  const { src } = sources({ read: async (_c, id) => room[id] ?? null, call: async (_c, d, sv, id) => void calls.push(`${d}.${sv} ${id}`) });
  const [view] = await viewPanels([roomPanel], src);
  const row = view!.rows[0]!;
  check("one row: how many are on, and the one that cannot be reached", view!.rows.length === 1 && row.value === "1 of 4 on · Reading lamp unavailable", row);
  check("…All off while one is on, drawn lit, as a light", row.actions.map((a) => a.label).join() === "All off" && row.active && row.icon === "light", row);
  const off = await actOn(roomPanel, ref, "off", src, signal);
  check("All off is one call, Home Assistant's own turn_off, for the one that is on",
    off.status === 200 && off.text === "Master bedroom lights: All off." && calls.join() === "homeassistant.turn_off light.bed_a", { off, calls });
  check("All on while one is on is not what it offers: nothing is sent", (await actOn(roomPanel, ref, "on", src, signal)).status === 409 && calls.length === 1);
  room["light.bed_a"]!.state = "off";
  const [dark] = await viewPanels([roomPanel], src);
  check("all off: All on, not lit", dark!.rows[0]!.actions.map((a) => a.label).join() === "All on" && !dark!.rows[0]!.active && dark!.rows[0]!.value === "0 of 4 on · Reading lamp unavailable", dark!.rows[0]);
  const on = await actOn(roomPanel, ref, "on", src, signal);
  check("All on turns on those that are off, not the one that cannot be reached", on.status === 200 && calls[1] === "homeassistant.turn_on light.bed_a,light.bed_b,switch.bed_c", calls);
  const { src: noHome } = sources({ grants: ["screen"] });
  check("without home, a room is neither read nor worked",
    (await viewPanels([roomPanel], noHome))[0]!.rows[0]!.note?.includes("not yours") === true && (await actOn(roomPanel, ref, "off", noHome, signal)).status === 403);
}

{
  const mixed: Record<string, { state: string; attributes: Record<string, unknown> }> = {
    "light.x": { state: "off", attributes: {} },
    "switch.y": { state: "off", attributes: { friendly_name: "Master bathroom switch" } },
  };
  const { src } = sources({ read: async (_c, id) => mixed[id] ?? null });
  const [v] = await viewPanels([{ ...panel, items: [{ kind: "home", ref: "light.x,switch.y", label: "Master Bedroom lights" }] }], src);
  check("a room's row with a plain switch in it is still drawn as a light", v!.rows[0]!.icon === "light", v!.rows[0]);
}

console.log("Jarvis lays a panel out");
{
  const h = (ref: string, label: string) => ({ kind: "home" as const, ref, label });
  const rooms = new Map([
    ["light.led", "Master Bedroom"], ["light.spot", "Master Bedroom"], ["light.reading", "Master Bedroom"],
    ["switch.bath_light", "Master Bedroom"], ["light.kitchen", "Kitchen"], ["light.study", "Study"],
  ]);
  const out = arrange([
    { kind: "note", ref: "", label: "Renew the road tax" },
    h("light.led", "Master ceiling light"), h("climate.master", "Master bedroom aircond"), h("light.kitchen", "Kitchen"),
    h("cover.main_gate", "Main gate"), h("light.spot", "Master spot light"), h("sensor.outside", "Outside"),
    h("light.reading", "Reading lamp"), h("switch.bath_light", "Master bathroom light"), h("lock.front_door", "Front door"),
    { kind: "car", ref: "family", label: "Comet" }, h("light.study", "Study"),
  ], rooms);
  check("a room's lights (by its area in the house; a switch named for a light too) become one row, named for the room",
    out.some((i) => i.ref === "light.led,light.spot,light.reading,switch.bath_light" && i.label === "Master Bedroom lights"), out);
  check("the way in first, then lights, the climate, readings, the car and notes, each kind in the order given",
    out.map((i) => i.label).join(" | ") === "Main gate | Front door | Master Bedroom lights | Kitchen | Study | Master bedroom aircond | Outside | Comet | Renew the road tax",
    out.map((i) => i.label));
  check("two lights of a room stay two tiles", arrange([h("light.a", "Hall lamp"), h("light.b", "Hall light")], new Map([["light.a", "Hall"], ["light.b", "Hall"]])).length === 2);
  check("where the house names no rooms, lights named alike are one",
    arrange([h("light.m1", "Master ceiling light"), h("light.m2", "Master spot light"), h("light.m3", "Master down light"), h("light.porch", "Porch light")], new Map())
      .map((i) => i.label).join() === "Master lights,Porch light");
  const later = arrange([h("light.led,light.spot,light.reading", "Master Bedroom lights"), h("light.down", "Master down light")],
    new Map([["light.led", "Master Bedroom"], ["light.down", "Master Bedroom"]]));
  check("a light added later joins its room's row, which keeps its name",
    later.length === 1 && later[0]!.ref === "light.led,light.spot,light.reading,light.down" && later[0]!.label === "Master Bedroom lights", later);
  const withSwitches = arrange([h("light.led", "Master ceiling light"), h("switch.bath", "Master bathroom switch"), h("switch.wardrobe", "Master wardrobe switch"), h("switch.kettle", "Master kettle")],
    new Map([["light.led", "Master Bedroom"], ["switch.bath", "Master Bedroom"], ["switch.wardrobe", "Master Bedroom"], ["switch.kettle", "Master Bedroom"]]));
  check("a room's plain switches join its lights' row, as Hark's eight were six lights and two switches",
    withSwitches.length === 1 && withSwitches[0]!.ref === "light.led,switch.bath,switch.wardrobe,switch.kettle", withSwitches);
  check("…but a room of switches with no light stays apart, and a plug or a fan never joins",
    arrange([h("switch.pump", "Garden pump"), h("switch.fountain", "Garden fountain"), h("switch.sprinkler", "Garden sprinkler")], new Map()).length === 3 &&
    arrange([h("light.a", "Den lamp"), h("light.b", "Den spot"), h("switch.p", "Den plug"), h("fan.c", "Den fan")], new Map()).length === 4);
  check("a group from the house is left as it is", arrange([h("group.bedroom", "Bedroom lights"), h("light.x", "Bedroom lamp"), h("light.y", "Bedroom spot")], new Map()).length === 3);
  // Moved by hand (the porch light first, the gate last), then added to by chat.
  const moved = [h("light.porch", "Porch light"), { kind: "note" as const, ref: "", label: "Call the plumber" }, h("cover.main_gate", "Main gate")];
  const added = arrange([...moved, h("lock.front_door", "Front door lock"), h("light.garden", "Garden light"), { kind: "car" as const, ref: "c_1", label: "Comet" }], new Map(), moved.length);
  check("what a panel had keeps its order; each thing added goes after its kind, or else after what Jarvis puts before it",
    added.map((i) => i.label).join() === "Porch light,Garden light,Call the plumber,Main gate,Front door lock,Comet", added.map((i) => i.label));
  const joined = arrange([h("light.m1", "Master ceiling light"), { kind: "note" as const, ref: "", label: "x" }, h("light.m2", "Master spot light"), h("light.m3", "Master down light")], new Map(), 3);
  check("…a room's row made with a light added stands where its first light was", joined.map((i) => i.label).join() === "Master lights,x", joined);
  const before = arrange([h("lock.front_door", "Front door"), h("light.porch", "Porch light"), { kind: "usage" as const, ref: "usage", label: "Usage" }], new Map());
  const more = [h("cover.main_gate", "Main gate"), h("climate.living", "Aircond"), { kind: "note" as const, ref: "", label: "Note" }];
  check("…and a panel nobody moved comes out as if laid out afresh",
    arrange([...before, ...more], new Map(), before.length).map((i) => i.label).join() === arrange([...before, ...more], new Map()).map((i) => i.label).join());
  const asked: string[] = [];
  const got = await areasOf({ base: "https://ha.example", token: "h" }, ["light.led", "light.porch"], async (_c, t) => (asked.push(t), "light.led\tMaster Bedroom\nlight.porch\t\n"));
  check("rooms come from one template: an area for each light that has one", got.get("light.led") === "Master Bedroom" && !got.has("light.porch") && asked.length === 1 && asked[0]!.includes('["light.led","light.porch"]'), [...got]);
  check("…and none when the house will not render it", (await areasOf({ base: "https://ha.example", token: "h" }, ["light.led"], async () => { throw new Error("Home Assistant said 401"); })).size === 0);
}

console.log("an aircond and an alarm, opened");
{
  const ac = { hvac_modes: ["off", "cool", "dry", "fan_only"], fan_modes: ["low", "high"], fan_mode: "low", temperature: 25, current_temperature: 27, min_temp: 16, max_temp: 30 };
  const on = controlsOf("climate.bedroom", "cool", ac)!;
  check("an aircond that is cooling offers Turn off, and opened, its temperature, modes and fan",
    on.actions.map((a) => a.label).join() === "Turn off" && on.more?.climate?.target === 25 && on.more.climate.now === 27 &&
    on.more.climate.modes.join() === "off,cool,dry,fan_only" && on.more.climate.fans.join() === "low,high" && on.more.climate.mode === "cool", on);
  check("…one that is off offers Turn on", controlsOf("climate.bedroom", "off", ac)!.actions.map((a) => a.action).join() === "on");
  const temp = controlCall("climate.bedroom", "cool", ac, "temp:23");
  check("a temperature within its range is set with Home Assistant's set_temperature",
    typeof temp === "object" && temp?.service === "set_temperature" && JSON.stringify(temp.data) === '{"temperature":23}', temp);
  check("…one outside it is refused", typeof controlCall("climate.bedroom", "cool", ac, "temp:40") === "string");
  check("a mode or a fan speed it has is set; one it has not is refused",
    (controlCall("climate.bedroom", "cool", ac, "mode:dry") as { data: unknown }).data !== undefined &&
    JSON.stringify((controlCall("climate.bedroom", "cool", ac, "fan:high") as { data: unknown }).data) === '{"fan_mode":"high"}' &&
    typeof controlCall("climate.bedroom", "cool", ac, "mode:heat") === "string");
  check("Turn on while it is cooling is not what it offers", typeof controlCall("climate.bedroom", "cool", ac, "on") === "string");

  const alarm = { code_format: "number", code_arm_required: false, supported_features: 1 | 2 | 4 };
  const armed = controlsOf("alarm_control_panel.house", "armed_night", alarm)!;
  check("an armed alarm, opened, offers Disarm, which wants its code; folded it offers nothing",
    armed.actions.length === 0 && armed.more?.actions?.map((a) => a.label).join() === "Disarm" && armed.more.code?.digits === true && armed.more.code.for.join() === "disarm", armed);
  const off = controlsOf("alarm_control_panel.house", "disarmed", alarm)!;
  check("disarmed, it offers each way it can be armed, with no code when arming needs none",
    off.more?.actions?.map((a) => a.action).join() === "arm_away,arm_home,arm_night" && !off.more.code, off);
  check("Disarm without the code is not sent", controlCall("alarm_control_panel.house", "armed_night", alarm, "disarm") === "it wants its code");
  const dis = controlCall("alarm_control_panel.house", "armed_night", alarm, "disarm", "1234");
  check("…with it, Home Assistant's alarm_disarm, the code passed on",
    typeof dis === "object" && dis?.domain === "alarm_control_panel" && dis.service === "alarm_disarm" && JSON.stringify(dis.data) === '{"code":"1234"}', dis);
  check("arming a way it does not support is refused", typeof controlCall("alarm_control_panel.house", "disarmed", { supported_features: 2 }, "arm_night") === "string");
  check("anything else is not theirs", controlsOf("light.porch", "on", {}) === null && controlCall("light.porch", "on", {}, "off") === null);

  const calls: { svc: string; data: unknown }[] = [];
  const house: Record<string, { state: string; attributes: Record<string, unknown> }> = {
    "climate.bedroom": { state: "cool", attributes: ac },
    "alarm_control_panel.house": { state: "armed_night", attributes: alarm },
  };
  const { src } = sources({ read: async (_c, id) => house[id] ?? null, call: async (_c, d, sv, id, data) => void calls.push({ svc: `${d}.${sv} ${id}`, data }) });
  const p: Panel = { ...panel, items: [{ kind: "home", ref: "climate.bedroom", label: "Bedroom aircond" }, { kind: "home", ref: "alarm_control_panel.house", label: "Alarm" }] };
  const [view] = await viewPanels([p], src);
  check("on a panel: the aircond with Turn off and its controls, the alarm with its own",
    view!.rows[0]!.actions[0]?.label === "Turn off" && !!view!.rows[0]!.more?.climate && view!.rows[1]!.more?.actions?.[0]?.label === "Disarm", view!.rows);
  const set = await actOn(p, "climate.bedroom", "temp:24", src, signal);
  check("the temperature pressed on a panel reaches the house with its value",
    set.status === 200 && calls[0]?.svc === "climate.set_temperature climate.bedroom" && JSON.stringify(calls[0]?.data) === '{"temperature":24}', { set, calls });
  const noCode = await actOn(p, "alarm_control_panel.house", "disarm", src, signal);
  const withCode = await actOn(p, "alarm_control_panel.house", "disarm", src, signal, { code: "1234" });
  check("the alarm is not disarmed without its code, and is with it, the code going no further than the house",
    noCode.status === 409 && withCode.status === 200 && !withCode.text.includes("1234") && JSON.stringify(calls[1]?.data) === '{"code":"1234"}', { noCode, withCode, calls });
}
{
  const room: Record<string, { state: string; attributes: Record<string, unknown> }> = {
    "light.bed_a": { state: "on", attributes: { friendly_name: "Ceiling" } },
    "switch.bed_b": { state: "off", attributes: { friendly_name: "Bedside lamp" } },
  };
  const calls: string[] = [];
  const { src } = sources({ read: async (_c, id) => room[id] ?? null, call: async (_c, d, sv, id) => void calls.push(`${d}.${sv} ${id}`) });
  const ref = "light.bed_a,switch.bed_b,light.gone";
  const p: Panel = { ...panel, items: [{ kind: "home", ref, label: "Bedroom lights" }] };
  const [view] = await viewPanels([p], src);
  const members = view!.rows[0]!.more?.members ?? [];
  check("a room's row, opened, shows each of its lights with its own button, by the house's names",
    members.map((m) => `${m.label}:${m.actions.map((a) => a.label).join()}`).join("|") === "Ceiling:Turn off|Bedside lamp:Turn on|light.gone:" && !!members[2]!.note, members);
  const one = await actOn(p, ref, "on", src, signal, { member: "switch.bed_b" });
  check("one of them pressed switches that one alone", one.status === 200 && calls.join() === "switch.turn_on switch.bed_b", { one, calls });
  check("a light that is not in the room is refused", (await actOn(p, ref, "on", src, signal, { member: "light.porch" })).status === 404 && calls.length === 1);
}

console.log("a tile for anything else Jarvis can do");
{
  const spec = tileSpec({ read: { tool: "music_state", args: {} }, buttons: [{ label: "Pause", tool: { tool: "music_control", args: { action: "pause" } } }, { label: "Play something calm", ask: "play something calm" }] });
  check("a tile: a reading from one tool, a button for another, and one that asks Jarvis",
    typeof spec === "object" && spec.read?.tool === "music_state" && spec.buttons[1]!.ask === "play something calm", spec);
  check("a button must do one thing: run a tool or ask, not both nor neither",
    typeof tileSpec({ buttons: [{ label: "X" }] }) === "string" && typeof tileSpec({ buttons: [{ label: "X", ask: "a", tool: { tool: "t", args: {} } }] }) === "string");
  check("…at most six of them, and a tile needs a reading or a button",
    typeof tileSpec({ buttons: Array.from({ length: 7 }, () => ({ label: "x", ask: "y" })) }) === "string" && typeof tileSpec({ buttons: [] }) === "string");
  const ref = JSON.stringify(spec);
  check("kept as text and read back the same; its key short and the same each time",
    JSON.stringify(parseTile(ref)) === ref && tileKey(ref) === tileKey(ref) && tileKey(ref).length < 12 && parseTile("{not json") === null);
  check("drawn by what it uses", tileIcon(spec as never) === "music" && tileIcon({ buttons: [{ label: "x", ask: "y" }] }) === "chat");

  const ran: string[] = [];
  const asked: string[] = [];
  const tools: Record<string, string> = { music_state: "Playing Blue in Green, by Miles Davis.", music_control: "Paused." };
  const src = {
    tool: async (name: string, args: Record<string, unknown>) => (ran.push(`${name} ${JSON.stringify(args)}`), name in tools ? { text: tools[name]! } : null),
    ask: async (text: string) => (asked.push(text), "Playing some quiet piano."),
  };
  const s = spec as never;
  check("its reading is its tool's answer", (await readTile(s, src, "t_x")).text === "Playing Blue in Green, by Miles Davis.");
  const paused = await pressTile("Music", s, "b0", src);
  check("a button runs its tool with its arguments, no model", paused.status === 200 && paused.text === "Paused." && ran.at(-1) === 'music_control {"action":"pause"}', { paused, ran });
  const calm = await pressTile("Music", s, "b1", src);
  check("an asking button asks Jarvis its sentence", calm.text === "Playing some quiet piano." && asked.join() === "play something calm");
  check("a button that is not there is refused", (await pressTile("Music", s, "b7", src)).status === 404);
  const locked = { ...src, tool: async () => null };
  check("a tool its person may not use here is not run", (await pressTile("Music", s, "b0", locked)).status === 403 && (await readTile(s, locked, "t_x")).status === 403);

  const p: Panel = { ...panel, items: [{ kind: "tile", ref, label: "Music" }] };
  const { src: all } = sources({ tool: src.tool, ask: src.ask });
  const [view] = await viewPanels([p], all);
  const row = view!.rows[0]!;
  check("on a panel: its buttons, and its reading fetched on its own",
    row.kind === "tile" && row.key === tileKey(ref) && row.read === true && row.actions.map((a) => `${a.action}:${a.label}`).join() === "b0:Pause,b1:Play something calm", row);
  check("pressed and read through the panel, by its key", (await actOn(p, tileKey(ref), "b0", all, signal)).text === "Paused." &&
    (await readTileOf(p, tileKey(ref), all)).text.startsWith("Playing") && (await readTileOf(p, "t_other", all)).status === 404);
}

console.log("sliders: brightness, speed, position, volume, a number");
{
  const lvl = (entity: string, state: string, a: Record<string, unknown>) => controlsOf(entity, state, a)?.more?.level;
  check("a dimmable light opens to its brightness, as a share of full; off is 0",
    lvl("light.desk", "on", { brightness: 128, supported_color_modes: ["brightness"] })?.value === 50 && lvl("light.desk", "off", { supported_color_modes: ["color_temp"] })?.value === 0);
  check("…a light that is only on or off has no slider", lvl("light.porch", "on", { supported_color_modes: ["onoff"] }) === undefined);
  check("a fan's speed, a blind's position, a speaker's volume",
    lvl("fan.bed", "on", { percentage: 33, percentage_step: 33 })?.step === 33 && lvl("cover.blind", "open", { current_position: 70 })?.value === 70 &&
    lvl("media_player.kitchen", "playing", { volume_level: 0.4 })?.value === 40);
  check("a number in the house, with its own range and unit",
    JSON.stringify(lvl("input_number.target", "21.5", { min: 16, max: 30, step: 0.5, unit_of_measurement: "°C" })) === '{"name":"Value","value":21.5,"min":16,"max":30,"step":0.5,"unit":"°C"}');
  const call = (entity: string, state: string, a: Record<string, unknown>, action: string) => controlCall(entity, state, a, action);
  const dim = call("light.desk", "on", { brightness: 255, supported_color_modes: ["brightness"] }, "level:60") as { service: string; data: unknown };
  check("set by its slider: a light's brightness_pct, and 0 turns it off",
    dim.service === "turn_on" && JSON.stringify(dim.data) === '{"brightness_pct":60}' &&
    (call("light.desk", "on", { supported_color_modes: ["brightness"] }, "level:0") as { service: string }).service === "turn_off");
  check("a blind's position, a speaker's volume as a fraction, a number's value",
    JSON.stringify((call("cover.blind", "open", { current_position: 10 }, "level:55") as { data: unknown }).data) === '{"position":55}' &&
    JSON.stringify((call("media_player.k", "playing", { volume_level: 0.1 }, "level:40") as { data: unknown }).data) === '{"volume_level":0.4}' &&
    (call("input_number.target", "20", { min: 16, max: 30 }, "level:22") as { domain: string; service: string }).service === "set_value");
  check("out of its range, or with no slider, nothing is sent",
    typeof call("light.desk", "on", { supported_color_modes: ["brightness"] }, "level:150") === "string" && typeof call("light.porch", "on", { supported_color_modes: ["onoff"] }, "level:50") === "string");
  const calls: { svc: string; data: unknown }[] = [];
  const { src } = sources({ read: async () => ({ state: "on", attributes: { brightness: 255, supported_color_modes: ["brightness"], friendly_name: "Desk" } }), call: async (_c, d, sv, id, data) => void calls.push({ svc: `${d}.${sv} ${id}`, data }) });
  const p: Panel = { ...panel, items: [{ kind: "home", ref: "light.desk", label: "Desk lamp" }] };
  const [view] = await viewPanels([p], src);
  check("on a panel, a dimmable light keeps Turn off and opens to its slider", view!.rows[0]!.actions[0]?.label === "Turn off" && view!.rows[0]!.more?.level?.value === 100);
  const pressed = await actOn(p, "light.desk", "level:30", src, signal);
  check("…dimmed from the panel", pressed.status === 200 && calls[0]?.svc === "light.turn_on light.desk" && JSON.stringify(calls[0]?.data) === '{"brightness_pct":30}', { pressed, calls });
}
{
  const spec = tileSpec({ read: null, buttons: [
    { label: "Volume", tool: { tool: "music_control", args: { action: "volume" } }, input: { kind: "slider", arg: "volume", min: 0, max: 100 } },
    { label: "Send", tool: { tool: "send_note", args: { to: "family" } }, input: { kind: "text", arg: "text" } },
    { label: "Ask", ask: "Add {} to the shopping list", input: { kind: "text", arg: "text" } },
  ] }) as never;
  check("a button takes a slider or words, into one argument of its tool", typeof spec === "object");
  check("…and a slider needs its range", typeof tileSpec({ buttons: [{ label: "V", tool: { tool: "t", args: {} }, input: { kind: "slider", arg: "volume", min: 5, max: 5 } }] }) === "string");
  const ran: string[] = [];
  const asked: string[] = [];
  const src = { tool: async (n: string, a: Record<string, unknown>) => (ran.push(`${n} ${JSON.stringify(a)}`), { text: "Done." }), ask: async (t: string) => (asked.push(t), "Added."), kept: async () => null, claim: async () => ({ reading: null, go: false }), keep: async () => {} };
  await pressTile("Music", spec, "b0", src, "60");
  await pressTile("Note", spec, "b1", src, "  Home by 7  ");
  await pressTile("Ask", spec, "b2", src, "eggs");
  check("the number and the words go where the button says",
    ran.join("|") === 'music_control {"action":"volume","volume":60}|send_note {"to":"family","text":"Home by 7"}' && asked.join() === "Add eggs to the shopping list", { ran, asked });
  check("a number outside its range, or nothing typed, is not sent",
    (await pressTile("Music", spec, "b0", src, "250")).status === 400 && (await pressTile("Note", spec, "b1", src, "   ")).status === 400 && ran.length === 2);
  const p: Panel = { ...panel, items: [{ kind: "tile", ref: JSON.stringify(spec), label: "Music" }] };
  const [view] = await viewPanels([p], sources().src);
  check("the panel says what each button takes, but not which argument it fills",
    JSON.stringify(view!.rows[0]!.actions.map((a) => a.input)) === '[{"kind":"slider","min":0,"max":100,"step":1},{"kind":"text","hint":""},{"kind":"text","hint":""}]', view!.rows[0]!.actions);
}

console.log("lists, charts and maps");
{
  const r = readingOf([
    "Hazy, unhealthy for sensitive groups",
    "API: 175",
    "- Thu: 160, moderate",
    "- Fri: 120",
    "Chart: API today: 08:00=120; 12:00=160; 15:00=175",
    "Map: 2.19, 102.25",
  ].join("\n"), 9);
  check("a looked-up answer keeps its list, its trend and its place",
    r.figures.length === 1 && r.list?.join("|") === "Thu: 160, moderate|Fri: 120" && r.chart?.title === "API today" &&
    r.chart.points.map((p) => `${p.x}=${p.y}`).join() === "08:00=120,12:00=160,15:00=175" && r.map?.lat === 2.19 && r.map.lng === 102.25, r);
  check("a chart of one point, or a place off the globe, is not drawn",
    !readingOf("x\nChart: t: a=1", 0).chart && !readingOf("x\nMap: 95, 10", 0).map);
  const lines = await readTile(tileSpec({ read: { tool: "calendar_check", args: {} }, buttons: [] }) as never,
    { tool: async () => ({ text: "Today, three things:\n- 10:00 Dentist\n- 13:00 Lunch with Sam\n- 18:30 School pickup" }), ask: async () => "", kept: async () => null, claim: async () => ({ reading: null, go: false }), keep: async () => {} }, "t_c");
  check("a tool that answers in lines keeps them as a list", lines.text === "Today, three things:" && lines.list?.length === 3 && lines.list[0] === "10:00 Dentist", lines);

  const asked: string[] = [];
  const day = await entityHistory({ base: "https://ha.example", token: "h" }, "sensor.outside", 24, Date.parse("2026-10-15T12:00:00Z"),
    (async (u: unknown) => (asked.push(String(u)), new Response(JSON.stringify([[
      { state: "30.5", last_changed: "2026-10-14T13:00:00Z" }, { state: "unavailable", last_changed: "2026-10-14T14:00:00Z" }, { state: "31", last_changed: "2026-10-14T15:00:00Z" },
    ]])))) as typeof fetch);
  check("a sensor's last day from Home Assistant's history, its numbers only, in one request",
    day.map((p) => p.v).join() === "30.5,31" && asked.length === 1 && asked[0]!.includes("/api/history/period/2026-10-14T12:00:00.000Z") && asked[0]!.includes("filter_entity_id=sensor.outside"), { day, asked });

  const many = Array.from({ length: 300 }, (_, i) => ({ t: i * 60_000, v: i % 2 }));
  const house: Record<string, { state: string; attributes: Record<string, unknown> }> = { "sensor.outside": { state: "31", attributes: { unit_of_measurement: "°C" } } };
  const { src } = sources({ read: async (_c, id) => house[id] ?? null, history: async () => many });
  const p: Panel = { ...panel, items: [{ kind: "home", ref: "sensor.outside", label: "Outside" }] };
  const h = await historyOf(p, "sensor.outside", src);
  check("thinned to at most 96 points by averaging, with its unit", h.status === 200 && h.points!.length <= 96 && h.points![0]!.v === 0.5 && h.unit === "°C", { n: h.points?.length, first: h.points?.[0], unit: h.unit });
  check("…only for what is on the panel, and only with home",
    (await historyOf(p, "sensor.other", src)).status === 404 && (await historyOf(p, "sensor.outside", sources({ grants: ["screen"] }).src)).status === 403);
  const [view] = await viewPanels([{ ...p, items: [...p.items, { kind: "home", ref: "cover.main_gate", label: "Main gate" }] }], sources({ read: async (_c, id) => house[id] ?? { state: "closed", attributes: {} } }).src);
  check("a number opens to its chart; a gate does not", view!.rows[0]!.more?.history === true && !view!.rows[1]!.more?.history);

  const at = { battery: 70, rangeMiles: 200, charging: "Disconnected", locked: true, climateOn: false, lat: 3.1, lng: 101.6 };
  const withMaps = (await viewPanels([{ ...panel, items: [{ kind: "car", ref: "c_1", label: "Comet" }] }], sources({ snapshot: async () => at, maps: true }).src))[0]!.rows[0]!;
  const without = (await viewPanels([{ ...panel, items: [{ kind: "car", ref: "c_1", label: "Comet" }] }], sources({ snapshot: async () => at }).src))[0]!.rows[0]!;
  check("the car opens to where it is, only where a map can be drawn", JSON.stringify(withMaps.more?.map) === '{"lat":3.1,"lng":101.6}' && !without.more, withMaps);
}

console.log("a tile's car buttons follow the car");
{
  const cmd = (command: string) => ({ tool: "car_command", args: { command, value: null, temperature: null, percent: null, car: null } });
  const spec = tileSpec({ read: { tool: "car_state", args: {} }, buttons: [
    { label: "Lock", tool: cmd("lock") }, { label: "Unlock", tool: cmd("unlock") },
    { label: "Start climate", tool: cmd("start_climate") }, { label: "Stop climate", tool: cmd("stop_climate") },
    { label: "Stop charging", tool: cmd("stop_charging") }, { label: "Open frunk", tool: cmd("open_frunk") },
  ] });
  const ref = JSON.stringify(spec);
  const p: Panel = { ...panel, items: [{ kind: "tile", ref, label: "Tesla" }] };
  const ran: string[] = [];
  const tool = async (name: string, args: Record<string, unknown>) => (ran.push(`${name} ${String(args.command)}`), { text: "Done." });
  const shown = async (over: Partial<PanelSources>) => (await viewPanels([p], sources({ tool, ...over }).src))[0]!.rows[0]!.actions.map((a) => `${a.action}:${a.label}`).join();
  check("locked, climate off and unplugged: Unlock and Start climate, and Open frunk, which has no state to follow",
    (await shown({})) === "b1:Unlock,b2:Start climate,b5:Open frunk", await shown({}));
  check("unlocked, climate on and charging: Lock, Stop climate and Stop charging",
    (await shown({ snapshot: async () => ({ locked: false, climateOn: true, charging: "Charging" }) })) === "b0:Lock,b3:Stop climate,b4:Stop charging,b5:Open frunk");
  check("when the car cannot be read, or is not theirs to check, every button stays",
    (await shown({ snapshot: async () => { throw new Error("Tessie down"); } })).split(",").length === 6 && (await shown({ grants: ["screen", "car.control"] })).split(",").length === 6);
  const { src } = sources({ tool });
  const stale = await actOn(p, tileKey(ref), "b0", src, signal);
  const fine = await actOn(p, tileKey(ref), "b1", src, signal);
  check("Lock pressed after the car was locked sends nothing; Unlock goes through",
    stale.status === 409 && fine.status === 200 && ran.join() === "car_command unlock", { stale, fine, ran });
}

console.log("a reading kept fresh with Home closed");
{
  const hourly = tileSpec({ read: { ask: "Latest air quality for Springfield", every: 300, refresh: "hourly" }, buttons: [] });
  check("hourly or daily, its pace the refresh's", typeof hourly === "object" && "ask" in hourly.read! && hourly.read.refresh === "hourly" && hourly.read.every === 60 &&
    (tileSpec({ read: { ask: "x", refresh: "daily" }, buttons: [] }) as { read: { every: number } }).read.every === 1440 && !("refresh" in (tileSpec({ read: { ask: "x", refresh: "weekly" }, buttons: [] }) as { read: object }).read), hourly);
  // A reading is stamped with the clock as it is looked up, so the test runs on it.
  const T = Date.now();
  const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 5_000;
  const ref = (n: number, refresh?: string) => JSON.stringify({ read: { ask: `Reading ${n}`, every: 60, ...(refresh ? { refresh } : {}) }, buttons: [] });
  const p = new Panels(fakeStorage());
  check("nothing to wake for without one", (await p.nextWake(T)) === null);
  await p.set("u_sara", "Outside", [{ kind: "tile", ref: ref(1, "hourly"), label: "Air" }, { kind: "tile", ref: ref(2), label: "Weather" }], "replace", T);
  check("one kept fresh: due at once", (await p.nextWake(T)) === T);
  const many = await p.set("u_sara", "More", [1, 2, 3].map((n) => ({ kind: "tile" as const, ref: ref(10 + n, "daily"), label: `T${n}` })), "replace", T);
  check(`at most ${MAX_REFRESHED} a person`, typeof many === "string" && /At most 3/.test(many), many);
  await p.set("u_sara", "More", [1, 2].map((n) => ({ kind: "tile" as const, ref: ref(10 + n, "daily"), label: `T${n}` })), "replace", T);
  const asked: string[] = [];
  let answer = "Good: API 40\nAPI: 40";
  const deps = (over: Partial<PanelRefreshDeps> = {}): PanelRefreshDeps => ({
    paused: async () => false,
    may: async () => true,
    look: async (person, text) => (asked.push(`${person}:${text.split("\n")[0]}`), answer),
    ...over,
  });
  await p.refresh(deps(), T);
  check("a couple a run, the rest after", asked.length === 2, asked);
  await p.refresh(deps(), T + 1000);
  check("…the third next run; the one only shown on Home never", asked.length === 3 && !asked.some((a) => a.endsWith("Reading 2")), asked);
  const air = tileKey(ref(1, "hourly"));
  check("kept where Home reads it", (await p.reading("u_sara", air))?.figures[0]?.value === "40");
  check("next due at its pace from the reading", near(await p.nextWake(T + 2000), T + 60 * 60_000), (await p.nextWake(T + 2000))! - T);
  await p.refresh(deps(), T + 30 * 60_000);
  check("not before then", asked.length === 3);
  answer = "";
  const late = T + 61 * 60_000;
  await p.refresh(deps(), late);
  const failed = asked.length;
  await p.refresh(deps(), late + 1000);
  check("a look that found nothing: not again at once", asked.length === failed, asked.length - failed);
  check("…but again in a quarter of an hour", near(await p.nextWake(late + 2000), late + 15 * 60_000), (await p.nextWake(late + 2000))! - late);
  const quiet = new Panels(fakeStorage());
  await quiet.set("u_sara", "Outside", [{ kind: "tile", ref: ref(1, "hourly"), label: "Air" }], "replace", T);
  const before = asked.length;
  await quiet.refresh(deps({ paused: async () => true }), T);
  await quiet.refresh(deps({ may: async () => false }), T + 16 * 60_000);
  check("no plan or key, or someone who left: nothing asked", asked.length === before);
}

console.log("a reading Jarvis looks up, as Hark's air quality");
{
  const aqi = tileSpec({ read: { ask: "Latest air-quality reading (AQI) for Springfield", every: 30 }, buttons: [] });
  check("a question as its reading, looked up at most hourly however often it was asked for",
    typeof aqi === "object" && "ask" in aqi.read! && aqi.read.every === 60 && (tileSpec({ read: { ask: "x", every: 99999 }, buttons: [] }) as { read: { every: number } }).read.every === 1440, aqi);
  check("drawn as the web", tileIcon(aqi as never) === "web");
  // Figures as the answer is asked to give them ("Label: value"), the verdict in bold as models are given to.
  const answer = "**Unhealthy**: sensitive groups should limit outdoor activity.\nAPI: 175\nAs of: 3:00 PM\nSource: City monitor, Springfield station";
  const r = readingOf(answer, 5);
  check("an answer read back as its verdict and up to three figures",
    r.text === "Unhealthy: sensitive groups should limit outdoor activity." && r.figures.map((f) => `${f.label}=${f.value}`).join("|") === "API=175|As of=3:00 PM|Source=City monitor, Springfield station" && r.at === 5, r);

  const kept = new Panels(fakeStorage());
  check("a reading never looked up is asked for, and then held for its asker",
    (await kept.claimReading("u", "t_a", 3_600_000, 1_000)).go && !(await kept.claimReading("u", "t_a", 3_600_000, 2_000)).go);
  await kept.keepReading("u", "t_a", { text: "Moderate", figures: [], at: 10_000 });
  check("kept, it is not asked for again until it is older than its interval",
    !(await kept.claimReading("u", "t_a", 3_600_000, 10_000 + 3_599_000)).go && (await kept.claimReading("u", "t_a", 3_600_000, 10_000 + 3_600_000)).go);
  await kept.keepReading("u", "t_a", null);
  check("a failed look-up keeps the last answer and lets the next screen try",
    (await kept.reading("u", "t_a"))?.text === "Moderate" && (await kept.claimReading("u", "t_a", 3_600_000, 10_000 + 3_700_000)).go);
  await kept.forget("u");
  check("someone who leaves takes their readings with them", (await kept.reading("u", "t_a")) === null);

  const store = new Panels(fakeStorage());
  const asked: string[] = [];
  const pressed: string[] = [];
  const src = {
    tool: async () => null,
    // A reading is looked up with reading tools only (routes/panels.ts look), never asked as a button is.
    ask: async (q: string) => (pressed.push(q), answer),
    look: async (q: string) => (asked.push(q), answer),
    kept: (t: string) => store.reading("u", t),
    claim: (t: string, every: number) => store.claimReading("u", t, every, Date.now()),
    keep: (t: string, reading: Parameters<Panels["keepReading"]>[2]) => store.keepReading("u", t, reading),
  };
  const spec = aqi as never;
  const first = await readTile(spec, src, "t_aqi", true);
  check("opened for the first time: nothing kept yet, so it says it is stale, without asking", first.text === "" && first.stale === true && asked.length === 0, first);
  const looked = await readTile(spec, src, "t_aqi");
  check("then looked up once, with how to answer for a tile, and kept",
    looked.text.startsWith("Unhealthy") && looked.figures?.length === 3 && asked.length === 1 && asked[0]!.startsWith("Latest air-quality reading") && asked[0]!.includes("Label: value"), looked);
  const again = await readTile(spec, src, "t_aqi");
  const quick = await readTile(spec, src, "t_aqi", true);
  check("opened again within the hour: the kept answer, no new model call", again.text === looked.text && quick.stale === false && asked.length === 1);
  await store.claimReading("u", "t_other", 3_600_000, Date.now());
  const busy = await readTile(spec, src, "t_other");
  check("while another screen is looking it up, this one waits for it rather than asking too", busy.pending === true && asked.length === 1, busy);
  check("a reading is never asked the way a pressed button is, which may act", pressed.length === 0);
  const failing = { ...src, look: async () => { throw new Error("rate limited"); } };
  const failed = await readTile(spec, failing, "t_new");
  check("a look-up that fails with nothing kept says so, and lets the next try",
    failed.status === 502 && failed.text.includes("rate limited") && (await store.claimReading("u", "t_new", 3_600_000, Date.now())).go, failed);
}

console.log("what the model is told is on them (panel_list)");
{
  const tile = (spec: unknown) => JSON.stringify(spec);
  const panels: Panel[] = [
    { id: "p_1", title: "Home & Car", at: 0, items: [
      { kind: "home", ref: "cover.main_gate", label: "Main gate" },
      { kind: "home", ref: "light.bed_a,light.bed_b,light.bed_c", label: "Master Bedroom lights" },
      { kind: "car", ref: "c_1", label: "Comet" },
    ] },
    { id: "p_2", title: "Daily", at: 0, items: [
      { kind: "note", ref: "", label: "Renew the road tax" },
      { kind: "note", ref: "done", label: "Book the dentist" },
      { kind: "usage", ref: "usage", label: "What you have used" },
      { kind: "tile", ref: tile({ read: { tool: "music_state", args: {} }, buttons: [{ label: "Pause", tool: { tool: "music_control", args: { action: "pause" } } }] }), label: "Music" },
      { kind: "tile", ref: tile({ read: { ask: "How is the air in Springfield?", every: 60 }, buttons: [] }), label: "Air" },
    ] },
    { id: "p_3", title: "Empty", at: 0, items: [] },
  ];
  const told = panelsText(panels);
  check("each panel by its exact name, in order, with what is on it and what each thing is",
    told.split("\n").length === 4 &&
      told.includes('"Home & Car": Main gate (house: cover.main_gate); Master Bedroom lights (house: light.bed_a, light.bed_b, light.bed_c); Comet (car).') &&
      told.includes('to-do "Renew the road tax"; to-do "Book the dentist" (ticked off); What you have used (usage); Music (tile: shows music_state; buttons Pause); Air (tile: asks "How is the air in Springfield?").') &&
      told.includes('"Empty": nothing yet.'), told);
  check("none at all says so", panelsText([]) === "They have no panels yet.");
  const [daily] = await viewPanels([panels[1]!], sources().src);
  const rowOf = (label: string) => daily!.rows.find((r) => r.label === label);
  check("a tile's row says what it reads, for More info: the tool, or how often it is looked up",
    rowOf("Music")?.tool === "music_state" && rowOf("Music")?.every === undefined && rowOf("Air")?.every === 60 && rowOf("Air")?.tool === undefined &&
      !rowOf("What you have used")?.tool && !rowOf("Renew the road tax")?.every, daily!.rows.map((r) => [r.label, r.tool, r.every]));
  check("how often, in words", everyWords(60) === "hour" && everyWords(180) === "3 hours" && everyWords(90) === "90 minutes" && everyWords(1440) === "day",
    [60, 180, 90, 1440].map(everyWords));
  const asked: string[] = [];
  const STATE = { idFromName: () => "j", get: () => ({ panelsOf: async (p: string) => (asked.push(p), panels) }) };
  const out = String(await panelList.run({}, { env: { STATE, JARVIS_PERSON: "u_sam" }, grants: ["*"], signal: new AbortController().signal, progress: () => {}, memory: null, display: () => {} } as never));
  check("the tool reads the asker's own", asked[0] === "u_sam" && out === told);
  check("for those with a Home tab, as the tools that change them", panelList.scope === "screen" && panelSet.scope === "screen");
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
    if (/\/api\/states\/(light\.bed_[abc]|lock\.front_door)$/.test(url)) return new Response(JSON.stringify({ state: "on", attributes: {} }));
    if (url.endsWith("/api/template")) return new Response("light.bed_a\tMaster Bedroom\nlight.bed_b\tMaster Bedroom\nlight.bed_c\tMaster Bedroom\n");
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  try {
    const env = { STATE, JARVIS_PERSON: "u_sara", HA_BASE_URL: "https://ha.example", HA_TOKEN: "h", TESSIE_TOKEN: "t", TESSIE_VIN: "VIN1" };
    const offered = ["music_state", "music_control", "panel_set", "spotify__queue"];
    const ctx = (grants: string[], e: Record<string, unknown> = env) => ({ env: e, grants, signal, progress: () => {}, memory: null, display: () => {}, offered }) as never;
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
    const roomSaid = await run({ title: "Home Controls", mode: "add", items: [{ kind: "home", ref: "light.bed_a, light.bed_b", label: "Master bedroom lights" }] }, ctx(["*"]));
    check("a room's lights together: one item, their ids joined",
      roomSaid.startsWith("Done") && JSON.stringify(kept.at(-1)?.items) === JSON.stringify([{ kind: "home", ref: "light.bed_a,light.bed_b", label: "Master bedroom lights" }]), { roomSaid, last: kept.at(-1) });
    check("…which need the room's name", (await run({ title: "X", mode: "add", items: [{ kind: "home", ref: "light.bed_a,light.bed_b", label: null }] }, ctx(["*"]))).includes("need its name"));
    check("…and are only lights and switches", (await run({ title: "X", mode: "add", items: [{ kind: "home", ref: "light.bed_a,lock.front_door", label: "Odd" }] }, ctx(["*"]))).includes("only lights and switches"));
    const laid = await run({ title: "Bedroom", mode: "add", items: [
      ...["light.bed_a", "light.bed_b", "light.bed_c"].map((ref) => ({ kind: "home", ref, label: null })),
      { kind: "home", ref: "cover.main_gate", label: null },
    ] }, ctx(["*"]));
    check("asked for a room's three lights and the gate, Jarvis lays it out: the gate first, the room as one row",
      JSON.stringify(kept.at(-1)?.items) === JSON.stringify([
        { kind: "home", ref: "cover.main_gate", label: "Main gate" },
        { kind: "home", ref: "light.bed_a,light.bed_b,light.bed_c", label: "Master Bedroom lights" },
      ]) && laid.includes("Master Bedroom lights (3 lights in one row)"), { laid, last: kept.at(-1) });
    const tile = (read: unknown, buttons: unknown) => ({ kind: "tile", ref: null, label: "Music", read, buttons });
    const wired = await run({ title: "Music", mode: "add", items: [tile({ tool: "music_state", args: "{}" }, [
      { label: "Pause", tool: "music_control", args: '{"action":"pause"}', ask: null },
      { label: "Queue jazz", tool: "spotify__queue", args: '{"q":"jazz"}', ask: null },
      { label: "Something calm", tool: null, args: null, ask: "play something calm" },
    ])] }, ctx(["*"]));
    const made = kept.at(-1)?.items[0] as { kind: string; ref: string; label: string } | undefined;
    check("a tile wired to the asker's own tools, an MCP server's among them, and a sentence to ask",
      wired.startsWith("Done") && made?.kind === "tile" && parseTile(made.ref)?.buttons.map((b) => b.tool?.tool ?? `ask:${b.ask}`).join() === "music_control,spotify__queue,ask:play something calm", { wired, made });
    const airSaid = await run({ title: "Air", mode: "add", items: [tile({ tool: null, args: null, ask: "Latest air-quality reading for Springfield", every_minutes: 30 }, null)] }, ctx(["*"]));
    const air = parseTile((kept.at(-1)?.items[0] as { ref: string }).ref);
    check("a reading no tool has is asked for instead, looked up at most hourly",
      !!air?.read && "ask" in air.read && air.read.ask.includes("Springfield") && air.read.every === 60, air);
    check("…and the answer says how often, as Hark's \"updates every hour\" does", airSaid.startsWith("Done") && airSaid.includes("(updates every hour while Home is open)"), airSaid);
    const slower = await run({ title: "Air later", mode: "add", items: [tile({ tool: null, args: null, ask: "Pollen count for Springfield", every_minutes: 180 }, null)] }, ctx(["*"]));
    check("…in its own words for longer", slower.includes("updates every 3 hours"), slower);
    check("a tool's tile says nothing of the kind: it is read while Home is open", !wired.includes("updates every"), wired);
    check("a tool they were not offered is refused", (await run({ title: "X", mode: "add", items: [tile({ tool: "mail_send", args: "{}" }, null)] }, ctx(["*"]))).includes("not one of the tools"));
    check("…and so are the panel tools themselves", (await run({ title: "X", mode: "add", items: [tile(null, [{ label: "Again", tool: "panel_set", args: "{}", ask: null }])] }, ctx(["*"]))).includes("not one of the tools"));
    check("arguments that are not JSON are refused", (await run({ title: "X", mode: "add", items: [tile({ tool: "music_state", args: "{oops" }, null)] }, ctx(["*"]))).includes("not JSON"));
    check("taking a panel away", String(await panelRemove.run({ title: "Home Controls", item: null } as never, ctx(["screen"]))).startsWith("Done"));
    check("…or saying there is none by that name", String(await panelRemove.run({ title: "Nope", item: null } as never, ctx(["screen"]))).includes("no panel called"));
    check("offered only to someone with screen, which a guest does not have", panelSet.scope === "screen" && panelRemove.scope === "screen");
    // Moved by hand: Jarvis keeps that order when it adds to the panel, and lays it out again only when asked to.
    const byHand = [
      { kind: "note", ref: "", label: "Call the plumber" },
      { kind: "home", ref: "light.porch", label: "Porch light" },
      { kind: "home", ref: "cover.main_gate", label: "Main gate" },
    ];
    stub.panelsOf = (async () => [{ id: "p_1", title: "Home Controls", items: byHand, at: 0 }]) as typeof stub.panelsOf;
    const labels = () => (kept.at(-1)?.items as { label: string }[]).map((i) => i.label).join();
    await run({ title: "Home Controls", mode: "add", items: [{ kind: "note", ref: null, label: "Pay the bill" }] }, ctx(["*"]));
    check("added to by chat, what was moved by hand stays put, the new thing beside its kind", labels() === "Call the plumber,Pay the bill,Porch light,Main gate", labels());
    await run({ title: "Home Controls", mode: "arrange", items: [] }, ctx(["*"]));
    check("asked to tidy it, Jarvis lays it out again", labels() === "Main gate,Porch light,Call the plumber", labels());
    check("…a panel that is not there is said so", (await run({ title: "Nope", mode: "arrange", items: [] }, ctx(["*"]))).includes("no panel called"));
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("alerts from a panel: what a thing in the house offers");
{
  check("a reading: above or below a number, in its unit",
    JSON.stringify(alertChoice("sensor.outside", "31.5", { unit_of_measurement: "°C" })) === '{"kind":"number","unit":"°C","value":31.5}');
  check("a gate: when it opens or closes", JSON.stringify(alertChoice("cover.main_gate", "closed", {})) === '{"kind":"state","on":"opens","off":"closes"}');
  const door = alertChoice("binary_sensor.back_door", "off", { device_class: "door" });
  const motion = alertChoice("binary_sensor.hall", "off", { device_class: "motion" });
  check("a sensor in its own words", door?.kind === "state" && door.on === "opens" && motion?.kind === "state" && motion.on === "sees motion", { door, motion });
  check("nothing for what is out of reach, or has no two states",
    alertChoice("cover.main_gate", "unavailable", {}) === null && alertChoice("sensor.weather", "sunny", {}) === null && alertChoice("button.restart", "2026-10-15", {}) === null);

  const hot = watchFor("sensor.outside", "Outside", "31", { unit_of_measurement: "°C" }, "above", 35);
  check("above a number: a watch that is false while the sensor gives none",
    typeof hot === "object" && hot.condition === "{% set v = states('sensor.outside') | float(none) %}{{ v is not none and v > 35 }}" &&
    hot.say === "Outside is above 35 °C." && hot.name === "Outside above 35 °C", hot);
  const open = watchFor("cover.main_gate", "Main gate", "closed", {}, "on");
  const shut = watchFor("cover.main_gate", "Main gate", "open", {}, "off");
  check("when it opens, and when it closes (not when its sensor drops out)",
    typeof open === "object" && open.condition === "{{ states('cover.main_gate') in ['open', 'opening'] }}" && open.say === "Main gate opens." &&
    typeof shut === "object" && shut.condition === "{{ states('cover.main_gate') not in ['open', 'opening', 'unavailable', 'unknown'] }}" && shut.say === "Main gate closes.", { open, shut });
  const odd = watchFor("light.a'}}{{x", "Lamp", "on", {}, "on");
  check("a quote in an entity id cannot leave its template", typeof odd === "object" && odd.condition.startsWith("{{ states('light.ax') in"), odd);
  check("what does not fit the thing is refused",
    typeof watchFor("cover.main_gate", "Main gate", "closed", {}, "above", 5) === "string" &&
    typeof watchFor("sensor.outside", "Outside", "31", {}, "on") === "string" &&
    typeof watchFor("sensor.outside", "Outside", "31", {}, "above", Number.NaN) === "string");
}

console.log("alerts from a panel: made into a routine of theirs");
{
  const air = tileSpec({ read: { ask: "Latest air-quality reading (API) for Springfield", every: 60 }, buttons: [] });
  const music = tileSpec({ read: { tool: "music_state", args: {} }, buttons: [] });
  const p: Panel = {
    id: "p_1",
    title: "Home",
    at: 0,
    items: [
      { kind: "home", ref: "cover.main_gate", label: "Main gate" },
      { kind: "home", ref: "light.bed_a,light.bed_b", label: "Bedroom lights" },
      { kind: "tile", ref: JSON.stringify(air), label: "Air quality" },
      { kind: "tile", ref: JSON.stringify(music), label: "Music" },
    ],
  };
  const airKey = tileKey(JSON.stringify(air));
  const made: RoutineInput[] = [];
  const asked: string[] = [];
  const deps = (over: Partial<AlertDeps> = {}): AlertDeps => ({
    home: true,
    house: { base: "https://ha.example", token: "h" },
    read: async (_c, id) => (id === "cover.main_gate" ? { state: "closed", attributes: {} } : null),
    ask: async (q) => (asked.push(q), ""),
    kept: async () => null,
    addRoutine: async (input) => (made.push(input), { id: "r_1" } as Routine),
    ...over,
  });

  const gate = await setAlert(p, "cover.main_gate", { when: "on" }, deps());
  check("a gate: a watch, at once, saying what happened",
    gate.status === 200 && made[0]?.when === "watch" && made[0].forMinutes === 0 && made[0].say === "Main gate opens." &&
    made[0].condition === "{{ states('cover.main_gate') in ['open', 'opening'] }}" && gate.text.startsWith("You will be told when Main gate opens."), { gate, made });
  check("not a room's lights together, nor what is not on the panel",
    (await setAlert(p, "light.bed_a,light.bed_b", { when: "on" }, deps())).status === 404 && (await setAlert(p, "lock.front", { when: "on" }, deps())).status === 404 &&
    (await setAlert(undefined, "cover.main_gate", { when: "on" }, deps())).status === 404);
  check("not without the house, or someone allowed to reach it",
    (await setAlert(p, "cover.main_gate", { when: "on" }, deps({ home: false }))).status === 403 &&
    (await setAlert(p, "cover.main_gate", { when: "on" }, deps({ house: null }))).status === 409);
  const full = await setAlert(p, "cover.main_gate", { when: "on" }, deps({ addRoutine: async () => "there are already 10 watches; remove one first" }));
  check("the scheduler's no is passed on", full.status === 409 && full.text === "No alert: there are already 10 watches; remove one first.", full);

  made.length = 0;
  const known = await setAlert(p, airKey, { condition: "the API is above 150" }, deps({ kept: async () => ({ text: "Moderate", figures: [], at: 1, source: "https://air.example.gov/springfield" }) }));
  check("a reading looked up: a page watch on the page it came from, with no search",
    known.status === 200 && asked.length === 0 && made[0]?.when === "page" && made[0].url === "https://air.example.gov/springfield" &&
    made[0].condition === "the API is above 150" && made[0].question === "Latest air-quality reading (API) for Springfield" && made[0].everyMinutes === 60 &&
    made[0].say === "Air quality: the API is above 150." && known.text.includes("air.example.gov is read every hour"), { known, made });

  made.length = 0;
  const found = await setAlert(p, airKey, { condition: "the API is above 150" }, deps({
    kept: async () => ({ text: "Moderate", figures: [], at: 1, source: "https://air.example.gov/map" }),
    ask: async (q) => (asked.push(q), "Try https://data.example.org/api/springfield.json."),
    addRoutine: async (input) => (made.push(input), input.url === "https://air.example.gov/map" ? "that page cannot be watched: the page had no words in it" : ({ id: "r_2" } as Routine)),
  }));
  check("a page drawn by scripts: one search for a page that says it plainly",
    found.status === 200 && asked.length === 1 && asked[0]!.includes("Latest air-quality reading (API) for Springfield") &&
    made.map((m) => m.url).join() === "https://air.example.gov/map,https://data.example.org/api/springfield.json", { found, made, asked });

  const none = await setAlert(p, airKey, { condition: "the API is above 150" }, deps({ ask: async () => "I could not find one." }));
  check("none found: said, and nothing made", none.status === 409 && none.text.startsWith("No page could be found"), none);
  check("what to alert on must be said, and only a looked-up reading can",
    (await setAlert(p, airKey, { condition: " " }, deps())).status === 400 &&
    (await setAlert(p, tileKey(JSON.stringify(music)), { condition: "it is playing" }, deps())).status === 409);
  check("a looked-up answer's source page is kept, not shown as a figure",
    readingOf("Moderate\nAPI: 80\nSource: https://air.example.gov/springfield", 1).source === "https://air.example.gov/springfield" &&
    readingOf("Moderate\nAPI: 80\nSource: https://air.example.gov/springfield.", 1).figures.length === 1 &&
    readingOf("Moderate\nSource: https://air.example.gov/springfield.", 1).source === "https://air.example.gov/springfield");

  const { src } = sources({ grants: ["screen", "home"] });
  const [plain] = await viewPanels([p], src);
  const [can] = await viewPanels([p], sources().src);
  check("offered only to someone who may make routines",
    !plain!.rows.some((r) => r.more?.alert) && can!.rows.find((r) => r.key === "cover.main_gate")?.more?.alert?.kind === "state" &&
    can!.rows.find((r) => r.key === airKey)?.more?.alert?.kind === "words" && !can!.rows.find((r) => r.key === "light.bed_a,light.bed_b")?.more?.alert, can!.rows.map((r) => [r.key, r.more?.alert]));

  made.length = 0;
  const bare = await setAlert(p, airKey, { condition: " 200 " }, deps({ kept: async () => ({ text: "Moderate", figures: [], at: 1, source: "https://air.example.gov/springfield" }) }));
  check("a number alone is a level to go above", bare.status === 200 && made[0]?.condition === "above 200" && made[0].say === "Air quality: above 200." && bare.text.startsWith("You will be told when above 200"), { bare, made });
  made.length = 0;
  await setAlert(p, airKey, { condition: "below 50" }, deps({ kept: async () => ({ text: "Moderate", figures: [], at: 1, source: "https://air.example.gov/springfield" }) }));
  check("…and words are kept as typed", made[0]?.condition === "below 50", made);

  // The alerts already set on a row, drawn on its tile.
  const routine = (name: string, trigger: Routine["trigger"], enabled = true) => ({ id: `r_${name}`, name, enabled, trigger, action: { kind: "say", text: "" }, grants: [], createdBy: "owner", createdAt: 0 }) as Routine;
  const ask = "Latest air-quality reading (API) for Springfield";
  const mine = [
    routine("Air quality: above 200", { kind: "page", url: "https://air.example.gov/springfield", question: ask, condition: "above 200", everyMin: 60 }),
    routine("Air quality: above 300", { kind: "page", url: "https://air.example.gov/springfield", question: ask, condition: "above 300", everyMin: 60 }, false),
    routine("Elsewhere: above 100", { kind: "page", url: "https://air.example.gov/other", question: "Air quality in Shelbyville", condition: "above 100", everyMin: 60 }),
    routine("Main gate opens", { kind: "watch", template: "{{ states('cover.main_gate') in ['open', 'opening'] }}", forMin: 0 }),
    routine("Gate left open", { kind: "watch", template: '{{ is_state("cover.main_gate", "open") }}', forMin: 10 }),
    routine("Garage opens", { kind: "watch", template: "{{ states('cover.main_gate_two') in ['open'] }}", forMin: 0 }),
  ];
  const [airItem, gateItem, roomItem, musicItem] = [p.items[2]!, p.items[0]!, p.items[1]!, p.items[3]!];
  check("a tile: the page watches asking its own question, on only", alertsOn(airItem, mine).join() === "above 200", alertsOn(airItem, mine));
  check("a thing: the watches naming it, less its own name", alertsOn(gateItem, mine).join("|") === "opens|Gate left open", alertsOn(gateItem, mine));
  check("nothing for a room's lights together, a tool's tile or no routines",
    !alertsOn(roomItem, mine).length && !alertsOn(musicItem, mine).length && !alertsOn(airItem, []).length);
  const [drawn] = await viewPanels([p], sources({ routines: async () => mine }).src);
  check("drawn on the row, and only where there are some",
    drawn!.rows.find((r) => r.key === airKey)?.alerts?.join() === "above 200" && drawn!.rows.find((r) => r.key === "cover.main_gate")?.alerts?.length === 2 &&
    !drawn!.rows.find((r) => r.key === tileKey(JSON.stringify(music)))?.alerts, drawn!.rows.map((r) => [r.key, r.alerts]));
  const [unread] = await viewPanels([p], sources({ routines: async () => { throw new Error("state unavailable"); } }).src);
  check("routines that cannot be read cost the panel nothing", unread!.rows.length === drawn!.rows.length && !unread!.rows.some((r) => r.alerts));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
