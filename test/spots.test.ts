// A person's places (lib/spots.ts): what is kept of one, whose it is, what
// its events are named, the device API for a phone to keep them
// (routes/spots.ts), and a routine set off at one (tools/routines.ts).
import { findSpot, placeEvent, RADIUS_DEFAULT, RADIUS_MAX, RADIUS_MIN, slugOf, Spots, SPOTS_MAX } from "../src/worker/lib/spots.ts";
import { handleSpots } from "../src/worker/routes/spots.ts";
import { requiredScope } from "../src/worker/lib/scopes.ts";
import { EVENT_NAME } from "../src/worker/lib/routines.ts";
import { routineTools } from "../src/worker/tools/routines.ts";

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
    get: async <T>(k: string) => (m.has(k) ? (structuredClone(m.get(k)) as T) : undefined),
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string) => m.delete(k),
    list: async <T>() => new Map<string, T>(),
    _m: m,
  };
}

// Invented places: a shop and an office in a made-up town.
const SHOP = { name: "Corner Grocer", lat: 3.123456789, lng: 101.654321987 };
const OFFICE = { name: "The Office", lat: 3.2, lng: 101.7 };

console.log("what a place's events are named");
{
  check("lower case, the rest as one underscore", slugOf("Corner Grocer") === "corner_grocer" && slugOf("  Mum's   house! ") === "mum_s_house");
  check("accents fold to their letters", slugOf("Café Olé") === "cafe_ole");
  check("no letters at all: none, for the store to name", slugOf("超市") === "" && slugOf("!!!") === "");
  check("arrived and left, by its slug", placeEvent("corner_grocer", true) === "arrived:corner_grocer" && placeEvent("corner_grocer", false) === "left:corner_grocer");
  check("anywhere: the bare event", placeEvent(null, true) === "arrived" && placeEvent(null, false) === "left");
  const longest = slugOf("a".repeat(80));
  check("the longest still makes an event a routine takes", EVENT_NAME.test(placeEvent(longest, true)) && EVENT_NAME.test(placeEvent(longest, false)), longest.length);
}

console.log("\nkept, each person's own");
{
  const st = fakeStorage();
  const spots = new Spots(st as never);
  const kept = await spots.save("u_sara", SHOP, 1000);
  check("kept with its slug and the usual radius", typeof kept !== "string" && kept.slug === "corner_grocer" && kept.radius === RADIUS_DEFAULT && kept.at === 1000, kept);
  check("a position no finer than a phone gives", typeof kept !== "string" && kept.lat === 3.123457 && kept.lng === 101.654322, kept);
  check("it is hers", (await spots.list("u_sara")).length === 1 && (await spots.list("u_adam")).length === 0 && (await spots.list("owner")).length === 0);

  const moved = await spots.save("u_sara", { name: "corner grocer", lat: 3.5, lng: 101.5, radius: 400 }, 2000);
  check("the same name again moves it, and its events keep their name", typeof moved !== "string" && moved.slug === "corner_grocer" && moved.lat === 3.5 && moved.radius === 400 && (await spots.list("u_sara")).length === 1, moved);

  const twin = await spots.save("u_sara", { name: "Corner-Grocer", lat: 1, lng: 2 });
  check("another whose name spells the same gets a number", typeof twin !== "string" && twin.slug === "corner_grocer_2", twin);
  const nameless = await spots.save("u_sara", { name: "超市", lat: 1, lng: 2 });
  check("a name with no letters is still kept, and can be set off", typeof nameless !== "string" && nameless.slug === "place" && nameless.name === "超市", nameless);

  const near = await spots.save("u_adam", { ...OFFICE, radius: 5 });
  const far = await spots.save("u_adam", { name: "Town", lat: 1, lng: 1, radius: 50_000 });
  check("a radius is kept between what a phone can tell apart and a neighbourhood", typeof near !== "string" && near.radius === RADIUS_MIN && typeof far !== "string" && far.radius === RADIUS_MAX);

  check("no name: refused", typeof (await spots.save("u_adam", { name: "  ", lat: 1, lng: 1 })) === "string");
  check("no position, or one off the earth: refused", typeof (await spots.save("u_adam", { name: "X" })) === "string" && typeof (await spots.save("u_adam", { name: "X", lat: 91, lng: 0 })) === "string" && typeof (await spots.save("u_adam", { name: "X", lat: "3.1", lng: 101 })) === "string");

  check("removed by its slug; one that is not there says so", (await spots.remove("u_sara", "corner_grocer")) === true && (await spots.remove("u_sara", "corner_grocer")) === false && (await spots.list("u_sara")).length === 2);
  check("one person cannot remove another's", (await spots.remove("u_sara", "the_office")) === false && (await spots.list("u_adam")).some((s) => s.slug === "the_office"));

  const full = new Spots(fakeStorage() as never);
  for (let i = 0; i < SPOTS_MAX; i++) await full.save("owner", { name: `Place ${i}`, lat: 1, lng: i });
  const over = await full.save("owner", { name: "One more", lat: 1, lng: 1 });
  check(`at most ${SPOTS_MAX}: the next is refused, and says why`, typeof over === "string" && over.includes(String(SPOTS_MAX)), over);
  check("but one of them can still be moved", typeof (await full.save("owner", { name: "Place 3", lat: 2, lng: 2 })) !== "string");

  await spots.forget("u_sara");
  check("someone who leaves the family: theirs go, nobody else's", (await spots.list("u_sara")).length === 0 && (await spots.list("u_adam")).length === 2 && !st._m.has("spot:u_sara"));
}

console.log("\nthe one a person means");
{
  const at = (name: string, slug: string) => ({ slug, name, lat: 1, lng: 1, radius: 150, at: 0 });
  const mine = [at("Corner Grocer", "corner_grocer"), at("The Office", "the_office"), at("Office Gym", "office_gym")];
  check("by its name, however it is cased", findSpot(mine, "corner grocer")?.slug === "corner_grocer" && findSpot(mine, "THE OFFICE")?.slug === "the_office");
  check("by part of it, when only one has it", findSpot(mine, "grocer")?.slug === "corner_grocer" && findSpot(mine, "the corner grocer near home")?.slug === "corner_grocer");
  check("two that could be meant: neither is guessed", findSpot(mine, "office") === null);
  check("one they have not saved: none", findSpot(mine, "airport") === null && findSpot(mine, "  ") === null && findSpot([], "home") === null);
}

console.log("\nthe phone's API");
{
  const st = fakeStorage();
  const spots = new Spots(st as never);
  const state = {
    spotsList: (p: string) => spots.list(p),
    spotSave: (p: string, i: Record<string, unknown>) => spots.save(p, i),
    spotRemove: (p: string, s: string) => spots.remove(p, s),
  };
  const env = { STATE: { idFromName: () => "j", get: () => state } } as never;
  const sara = { kind: "member", id: "u_sara", role: "adult", scopes: ["ask", "routines"], session: "s" };
  const adam = { kind: "device", id: "d1", name: "Adam's phone", scopes: ["routines"], owner: "u_adam" };
  const go = (principal: unknown, method: string, body?: unknown, query = "") =>
    handleSpots(new Request(`https://j.test/api/v1/places${query}`, { method, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), env, new URL(`https://j.test/api/v1/places${query}`), principal as never);

  check("the routines scope, as the event that sets one off", (["GET", "POST", "DELETE"] as const).every((m) => requiredScope("/api/v1/places", m) === "routines"));
  const made = await go(sara, "POST", SHOP);
  const place = ((await made!.json()) as { place: { slug: string; name: string } }).place;
  check("POST keeps one and gives it back with its slug", made!.status === 200 && place.slug === "corner_grocer" && place.name === "Corner Grocer", place);
  await go(adam, "POST", OFFICE);
  const hers = (await (await go(sara, "GET"))!.json()) as { places: { slug: string }[] };
  const his = (await (await go(adam, "GET"))!.json()) as { places: { slug: string }[] };
  check("GET: each caller's own, a member's and a member's device's alike", hers.places.map((p) => p.slug).join() === "corner_grocer" && his.places.map((p) => p.slug).join() === "the_office", [hers, his]);
  check("a body that is not JSON, or has no position: 400 and why", (await go(sara, "POST", "{"))!.status === 400 && (await go(sara, "POST", { name: "X" }))!.status === 400);
  check("DELETE someone else's: not there", (await go(sara, "DELETE", undefined, "?slug=the_office"))!.status === 404 && (await spots.list("u_adam")).length === 1);
  check("DELETE her own", (await go(sara, "DELETE", undefined, "?slug=corner_grocer"))!.status === 200 && (await spots.list("u_sara")).length === 0);
  check("another method: refused", (await go(sara, "PUT", {}))!.status === 405);
  check("another path: not this route's", (await handleSpots(new Request("https://j.test/api/v1/placesx"), env, new URL("https://j.test/api/v1/placesx"), sara as never)) === null);
  check("no state object: said", (await handleSpots(new Request("https://j.test/api/v1/places"), {} as never, new URL("https://j.test/api/v1/places"), sara as never))!.status === 503);
}

console.log("\na routine at a place, by voice");
{
  const add = routineTools.find((t) => t.name === "routine_add")!;
  const required = (add.parameters as { required: string[] }).required;
  const sent: Record<string, unknown>[] = [];
  const saved = [
    { slug: "corner_grocer", name: "Corner Grocer", lat: 1, lng: 1, radius: 150, at: 0 },
    { slug: "the_office", name: "The Office", lat: 2, lng: 2, radius: 150, at: 0 },
  ];
  const asked: string[] = [];
  const stub = {
    spotsList: async (person: string) => (asked.push(person), person === "u_sara" ? saved : []),
    addRoutine: async (input: Record<string, unknown>) => (sent.push(input), { id: "r1", name: "x", enabled: true, trigger: { kind: "event", event: input.event }, action: { kind: "say", text: "x" }, grants: ["*"], createdBy: "u_sara", createdAt: 0 }),
  };
  const ctx = (person?: string) => ({ env: { STATE: { idFromName: () => "j", get: () => stub }, TIMEZONE: "Asia/Kuala_Lumpur", ...(person ? { JARVIS_PERSON: person } : {}) }, signal: new AbortController().signal, progress() {}, display() {}, memory: {}, grants: ["*"] }) as never;
  const args = (over: Record<string, unknown>) => ({ ...Object.fromEntries(required.map((k) => [k, null])), ...over });

  check("the tool's schema names the place, and stays strict", required.includes("place") && Object.keys((add.parameters as { properties: object }).properties).join() === required.join());
  await add.run(args({ when: "arrive_place", place: "the corner grocer", ask: "Tell me my shopping list." }), ctx("u_sara"));
  check("arriving at a saved place: an event routine named for it", sent[0]?.when === "event" && sent[0]?.event === "arrived:corner_grocer" && sent[0]?.ask === "Tell me my shopping list.", sent[0]);
  await add.run(args({ when: "leave_place", place: "The Office", ask: "Tell me the best way home." }), ctx("u_sara"));
  check("leaving one: the other event", sent[1]?.event === "left:the_office", sent[1]);
  await add.run(args({ when: "arrive_place", place: null, ask: "One useful thing about where I am, or stay quiet.", notify: "if-important" }), ctx("u_sara"));
  check("anywhere: the bare event, and no places read for it", sent[2]?.event === "arrived" && sent[2]?.notify === "if-important" && asked.length === 2, [sent[2], asked]);

  const unknown = String(await add.run(args({ when: "arrive_place", place: "the airport", say: "x" }), ctx("u_sara")));
  check("a place they have not saved: nothing made, told where to save it and which they have", sent.length === 3 && /^Not set up/.test(unknown) && /Save where I am now/.test(unknown) && unknown.includes("Corner Grocer") && unknown.includes("The Office"), unknown);
  const none = String(await add.run(args({ when: "arrive_place", place: "Corner Grocer", say: "x" }), ctx("u_adam")));
  check("another person's places are not theirs to use", sent.length === 3 && /saved no places yet/.test(none) && asked.at(-1) === "u_adam", none);
  await add.run(args({ when: "event", event: "doorbell", say: "Someone is at the door." }), ctx("u_sara"));
  check("any other event is as it was", sent[3]?.when === "event" && sent[3]?.event === "doorbell");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
