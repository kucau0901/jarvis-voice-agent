// Watching the house (lib/house.ts): what matters, read in one template call
// with no model, compared with the read before, and seen at a glance.
import { active, changes, FRESH_MS, HEARD_MS, House, houseSection, houseTemplate, KINDS, MAX_BATCH, MAX_THINGS, parseBatch, parseThings, watchList, type Thing } from "../src/worker/lib/house.ts";
import { handleHouse } from "../src/worker/routes/house.ts";
import { requiredScope } from "../src/worker/lib/scopes.ts";

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
    get: async <T,>(k: string) => (m.has(k) ? (structuredClone(m.get(k)) as T) : undefined),
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string) => m.delete(k),
    list: async <T,>({ prefix }: { prefix: string }) => new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T])),
    _m: m,
  };
}

const TZ = "Asia/Kuala_Lumpur";
const thing = (id: string, state: string, over: Partial<Thing> = {}): Thing => ({ id, name: id.split(".")[1]!.replace(/_/g, " "), area: "", kind: "", state, unit: "", t: 0, ...over });
const raw = (things: Thing[]) => JSON.stringify(things.map((t) => ({ i: t.id, n: t.name, a: t.area, c: t.kind, s: t.state, u: t.unit, t: t.t })));

console.log("the template");
{
  const t = houseTemplate({ add: ["sensor.freezer_temperature"], ignore: ["light.garden'); {{ evil }}"] });
  check("reads every kind that matters", Object.keys(KINDS).every((d) => t.includes(`'${d}'`)), t.slice(0, 300));
  check("with what the person added and left out", t.includes("'sensor.freezer_temperature'") && t.includes("'light.garden"));
  check("an id cannot break out of its quotes", !t.includes("evil }}") && !t.includes("'light.garden')"), t);
  check(`and stops at ${MAX_THINGS}`, t.includes(`< ${MAX_THINGS}`));
  check("as JSON", t.endsWith("{{ ns.out | tojson }}"));
}

console.log("\nwhat Home Assistant gave");
{
  const got = parseThings(JSON.stringify([
    { i: "light.study", n: "Study light", a: "Study", c: "", s: "on", u: "", t: 1793600000 },
    { i: "not an id", n: "x", s: "on" },
    { i: "lock.front_door", s: "locked" },
    7,
  ]));
  check("each thing kept, malformed ones left out", got.length === 2 && got[0]!.area === "Study" && got[1]!.name === "lock.front_door", got);
  let threw = false;
  try {
    parseThings('{"error": "no"}');
  } catch {
    threw = true;
  }
  check("not a list: said, not taken as an empty house", threw);
}

console.log("\nwhat changed");
{
  const before = [thing("light.study", "off"), thing("lock.front_door", "locked"), thing("sensor.outside_temperature", "29.1"), thing("binary_sensor.back_door", "unavailable")];
  const now = [thing("light.study", "on"), thing("lock.front_door", "locked"), thing("sensor.outside_temperature", "30.4"), thing("binary_sensor.back_door", "off"), thing("cover.garage", "open")];
  const c = changes(before, now);
  check("a light turned on", c.some((x) => x.id === "light.study" && x.from === "off" && x.to === "on"), c);
  check("not what stayed, a number drifting, Home Assistant starting, or a thing first seen", c.length === 1, c);
  check("nor something dropping off", changes([thing("light.study", "on")], [thing("light.study", "unavailable")]).length === 0);
}

console.log("\nat a glance");
{
  check("on, open, unlocked: active", active(thing("light.a", "on")) && active(thing("cover.g", "open")) && active(thing("lock.f", "unlocked")) && active(thing("binary_sensor.m", "on")));
  check("off, closed, locked, disarmed: not", !active(thing("light.a", "off")) && !active(thing("cover.g", "closed")) && !active(thing("lock.f", "locked")) && !active(thing("alarm_control_panel.h", "disarmed")));
  const s = houseSection([
    thing("person.adam", "not_home", { name: "Adam" }),
    thing("person.sara", "home", { name: "Sara" }),
    thing("light.study", "on", { name: "Study light", area: "Study", t: Math.floor(Date.UTC(2026, 9, 21, 6, 0) / 1000) }),
    thing("lock.front_door", "locked", { name: "Front door" }),
    thing("sensor.hall_motion_battery", "9", { name: "Hall motion battery", kind: "battery", area: "Hall" }),
    thing("sensor.outside_temperature", "30.4", { kind: "temperature" }),
  ], TZ);
  check("who is home, what is on and since when, by room, and a battery running low", JSON.stringify(s?.lines) === JSON.stringify(["People: Adam away, Sara home", "- Study light (Study): on since 14:00", "- Hall motion battery (Hall): battery 9%"]), s?.lines);
  check("all quiet is said so", houseSection([thing("light.study", "off")], TZ)?.lines[0] === "Everything watched is shut, off and quiet.");
  check("nothing read: no section", houseSection([], TZ) === null);
}

console.log("\nreading and keeping the house");
{
  const h = new House(fakeStorage() as never);
  let reads = 0;
  let house = [thing("light.study", "off")];
  const render = async (_t: string) => (reads++, raw(house));
  const first = await h.glance(render, 1000);
  check("the first read: things, and nothing changed yet", first.things.length === 1 && first.changed.length === 0);
  house = [thing("light.study", "on")];
  const second = await h.glance(render, 61_000);
  check("the next: what changed since", second.changed.length === 1 && second.changed[0]!.to === "on", second.changed);
  check("a look takes a fresh read as it is, with no call", (await h.now(render, 61_000 + FRESH_MS - 1)).length === 1 && reads === 2);
  house = [thing("light.study", "off")];
  const stale = await h.now(render, 61_000 + FRESH_MS + 1);
  check("a stale one is read again for the look, not kept: what changed stays the watch's to find", reads === 3 && stale[0]!.state === "off" && (await h.last())!.things[0]!.state === "on");
  check("an id that is not one is refused", typeof (await h.setPref("not an id", "watch")) === "string");
  await h.setPref("sensor.freezer_temperature", "watch");
  await h.setPref("light.garden", "ignore");
  check("added and left out", JSON.stringify(await h.prefs()) === '{"add":["sensor.freezer_temperature"],"ignore":["light.garden"]}', await h.prefs());
  await h.setPref("light.garden", "default");
  check("put back to its kind", (await h.prefs()).ignore.length === 0);
  let asked = "";
  await h.glance(async (t) => ((asked = t), raw(house)), 200_000);
  check("what was added is read", asked.includes("'sensor.freezer_temperature'"));
}

console.log("\nthe component in Home Assistant");
{
  const b = parseBatch({ changes: [{ id: "light.study", from: "off", to: "on" }, { id: "not an id", to: "on" }, { id: "lock.front_door", to: 3 }, "x"] });
  check("a batch: each change, malformed ones left out", JSON.stringify(b) === '[{"id":"light.study","from":"off","to":"on"}]', b);
  check("not a batch: null", parseBatch({ change: [] }) === null && parseBatch(null) === null);
  check(`at most ${MAX_BATCH} at a time`, parseBatch({ changes: Array.from({ length: MAX_BATCH + 5 }, () => ({ id: "light.a", to: "on" })) })!.length === MAX_BATCH);
  const w1 = await watchList([thing("lock.front_door", "locked"), thing("light.study", "off")]);
  const w2 = await watchList([thing("light.study", "on"), thing("lock.front_door", "unlocked")]);
  const w3 = await watchList([thing("light.study", "on")]);
  check("the watch list, sorted, with a version that moves only with what is watched", w1.entities.join() === "light.study,lock.front_door" && w1.version === w2.version && w1.version !== w3.version && w1.version.length === 12, [w1, w3]);

  const h = new House(fakeStorage() as never);
  check("before anything was read, a batch changes nothing", (await h.apply([{ id: "light.study", from: "off", to: "on" }], 1000)).length === 0);
  let reads = 0;
  const render = async () => (reads++, raw([thing("light.study", "off"), thing("lock.front_door", "locked"), thing("sensor.freezer", "-18", { kind: "temperature" })]));
  const first = await h.watching(render, 10_000);
  check("asked what to watch: the house read once, and kept", reads === 1 && first.things.length === 3);
  await h.watching(render, 20_000);
  check("asked again soon: no read", reads === 1);
  const c = await h.apply([
    { id: "light.study", from: "off", to: "on" },
    { id: "lock.front_door", from: "locked", to: "unavailable" },
    { id: "sensor.freezer", from: "-18", to: "-12" },
    { id: "light.not_watched", from: "off", to: "on" },
    { id: "light.study", from: "on", to: "on" },
  ], 30_000);
  check("what changed, as from what Jarvis knew: not Home Assistant starting, a number, or a thing not watched", JSON.stringify(c) === '[{"id":"light.study","from":"off","to":"on"}]', c);
  const kept = (await h.last())!;
  check("all of it kept as the house now, the number too, and when it was heard", kept.things.find((t) => t.id === "light.study")!.state === "on" && kept.things.find((t) => t.id === "sensor.freezer")!.state === "-12" && kept.heardAt === 30_000, kept);
  check("while it is heard from, a look takes the house as kept, with no read", (await h.now(render, 30_000 + HEARD_MS - 1)).find((t) => t.id === "light.study")!.state === "on" && reads === 1);
  await h.setPref("binary_sensor.shed_door", "watch");
  await h.watching(render, 40_000);
  check("what is watched changed: the next ask reads the house again, for a new list", reads === 2);
}

console.log("\nwho may send");
{
  const env = { HA_BASE_URL: "https://ha.example.com", HA_TOKEN: "t" } as never;
  const go = (principal: unknown, path = "/api/v1/house/watch", method = "GET", e = env) => handleHouse(new Request(`https://j.test${path}`, { method }), e, new URL(`https://j.test${path}`), principal as never);
  check("a member's device: no, it could make up the house", (await go({ kind: "device", id: "d1", name: "Phone", scopes: ["home"], owner: "u_sara" }))?.status === 403);
  check("a member who is not an admin: no", (await go({ kind: "member", id: "u_sara", role: "adult", scopes: ["*"], session: "s" }))?.status === 403);
  check("the first person's device, with no Home Assistant: said so", (await go({ kind: "device", id: "d_ha", name: "Home Assistant", scopes: ["home"] }, "/api/v1/house/watch", "GET", {} as never))?.status === 404);
  check("another path: not this route's", (await go({ kind: "owner" }, "/api/v1/house/other")) === null);
  check("both need the house's scope", requiredScope("/api/v1/house/watch", "GET") === "home" && requiredScope("/api/v1/house/events", "POST") === "home");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
