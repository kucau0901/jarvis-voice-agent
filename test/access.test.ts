import { allowedNow, hoursSaid, nextAllowed, passActions, passService, saneAccess } from "../src/worker/lib/access.ts";
import { deliver as deliverAlert, makeAlert as alertOf, type AlertState } from "../src/worker/lib/alerts.ts";
import { zonedToUtc } from "../src/worker/lib/routines.ts";
import { HubHost } from "../src/worker/lib/hub.ts";
import { sha256Hex } from "../src/worker/lib/devices.ts";
import { withPerson } from "../src/worker/lib/context.ts";
import { passOf, usePass } from "../src/worker/tools/pass.ts";
import { buildRoutine, describeAction } from "../src/worker/lib/routines.ts";
import { outcome } from "../src/worker/lib/scheduler.ts";
import { Relays, type RelayDeps } from "../src/worker/lib/relays.ts";
import type { Alert } from "../src/worker/lib/alerts.ts";

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
    list: async <T,>({ prefix }: { prefix: string }) =>
      new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T])),
  };
}

const TZ = "Asia/Kuala_Lumpur";
const at = (y: number, mo: number, d: number, h: number, mi = 0) => zonedToUtc(y, mo, d, h, mi, TZ);
// 2026-09-28 is a Monday.
const MON_10 = at(2026, 9, 28, 10);
const MON_19 = at(2026, 9, 28, 19);
const SAT_10 = at(2026, 10, 3, 10);

console.log("limits, checked");
{
  check("an end in the past is refused", typeof saneAccess({ until: MON_10 - 1 }, MON_10) === "string");
  check("hours need from and to", typeof saneAccess({ hours: { from: "8:00", to: "17:00" } }) === "string");
  check("days are 0 to 6", typeof saneAccess({ hours: { from: "08:00", to: "17:00", days: [7] } }) === "string");
  check("a pass works only things that can be worked", typeof saneAccess({ allow: [{ entity: "sensor.temperature", label: "x" }] }) === "string");
  const a = saneAccess({ until: MON_10 + 7 * 86_400_000, hours: { from: "08:00", to: "17:00", days: [5, 1, 2, 3, 4] }, allow: [{ entity: "cover.main_gate", label: "Main gate" }] }, MON_10);
  check("a good pass is kept, days in order", typeof a === "object" && a !== null && a.hours?.days?.join() === "1,2,3,4,5" && a.allow?.[0]?.label === "Main gate");
  check("said the way people say it", hoursSaid({ from: "08:00", to: "17:00", days: [1, 2, 3, 4, 5] }) === "08:00 to 17:00, Mondays to Fridays");
  check("null clears them", saneAccess(null) === null && saneAccess({}) === null);
}

console.log("\nhours");
{
  const helper = { hours: { from: "08:00", to: "17:00", days: [1, 2, 3, 4, 5] } };
  check("a helper on Monday at ten: yes", allowedNow(helper, MON_10, TZ).ok);
  check("on Monday at seven in the evening: no, and why", !allowedNow(helper, MON_19, TZ).ok && /Mondays to Fridays/.test((allowedNow(helper, MON_19, TZ) as { why: string }).why));
  check("on Saturday: no", !allowedNow(helper, SAT_10, TZ).ok);
  const child = { hours: { from: "07:00", to: "21:00" } };
  check("a child at seven in the evening: yes", allowedNow(child, MON_19, TZ).ok);
  check("at eleven at night: quiet time", !allowedNow(child, at(2026, 9, 28, 23), TZ).ok);
  const night = { hours: { from: "22:00", to: "06:00", days: [1] } };
  check("a night shift past midnight belongs to the day it began", allowedNow(night, at(2026, 9, 29, 2), TZ).ok && !allowedNow(night, at(2026, 9, 28, 2), TZ).ok);
  check("after the end, never", !allowedNow({ until: MON_10 }, MON_10 + 1, TZ).ok);
}

console.log("\nquiet time holds alerts");
{
  const child = { hours: { from: "07:00", to: "21:00" } };
  check("at eleven at night, her hours next begin at seven", nextAllowed(child, at(2026, 9, 28, 23), TZ) === at(2026, 9, 29, 7));
  check("in her hours, nothing waits", nextAllowed(child, MON_19, TZ) === null);
  const helper = { hours: { from: "08:00", to: "17:00", days: [1, 2, 3, 4, 5] } };
  check("a helper's Saturday waits for Monday morning", nextAllowed(helper, SAT_10, TZ) === at(2026, 10, 5, 8));
  check("an ended pass waits for nothing", nextAllowed({ until: MON_10, hours: child.hours }, at(2026, 9, 28, 23), TZ) === null);

  const held: { id: string; until: number }[] = [];
  const pushed: string[] = [];
  const state: AlertState = {
    async quietUntil(person) {
      return person === "u_child" ? at(2026, 9, 29, 7) : null;
    },
    async hold(a, until) {
      held.push({ id: a.id, until });
    },
    async broadcast() {
      return { open: 0, visible: 0, acked: null };
    },
    async pushTargets(person) {
      pushed.push(person ?? "");
      return { vapid: { publicKey: "", privateJwk: {} }, subs: [] };
    },
    async pushResults() {},
    async logDelivery() {},
  };
  const env = { ALERT_ORDER: "live,push" } as never;
  const quiet = await deliverAlert(env, state, alertOf({ text: "Tidy your room" }, "relay", MON_10, "u_child")!);
  check("an alert for a child in quiet time waits for the morning", quiet.heldUntil === at(2026, 9, 29, 7) && held.length === 1 && pushed.length === 0);
  const urgent = alertOf({ text: "No answer from Nenek", urgent: true }, "relay", MON_10, "u_child")!;
  await deliverAlert(env, state, urgent);
  check("an urgent one never waits", held.length === 1 && pushed.includes("u_child"));
  await deliverAlert(env, state, alertOf({ text: "hi" }, "relay", MON_10, "u_adult")!);
  check("someone in their hours gets theirs at once", held.length === 1 && pushed.includes("u_adult"));
  const stale = await deliverAlert(env, state, alertOf({ text: "Leave now for swimming", expiresAt: at(2026, 9, 28, 23, 30) }, "routine", MON_10, "u_child")!);
  check("one that is no use by the morning is not kept", held.length === 1 && stale.deliveredBy === null && !stale.heldUntil);

  // What the routine's history then says: not "nothing is set up to receive it".
  const heldRun = outcome(quiet, MON_10);
  check("a routine's alert held for quiet time is recorded as held, not failed", heldRun.ok && /held for their quiet time/.test(heldRun.detail), heldRun);
  const staleRun = outcome(stale, MON_10);
  check("one dropped as out of date says so", !staleRun.ok && /out of date/.test(staleRun.detail), staleRun);
  const nowhere = outcome({ alert: quiet.alert, attempts: [], deliveredBy: null }, MON_10);
  check("with nowhere to send it, it still says to turn notifications on", !nowhere.ok && /nothing is set up/.test(nowhere.detail), nowhere);
}

console.log("\nwhat a pass may do");
{
  check("a gate opens and closes", JSON.stringify(passService("cover.main_gate", "open")) === '{"domain":"cover","service":"open_cover"}' && passActions("cover.main_gate").join() === "open,close");
  check("a lock unlocks", (passService("lock.front_door", "unlock") as { service: string }).service === "unlock");
  check("a light cannot be told to open", typeof passService("light.porch", "open") === "string");
  const env = withPerson({} as never, { person: "u_helper", access: { allow: [{ entity: "cover.main_gate", label: "Main gate" }] } });
  check("a guest's requests carry their pass", passOf(env).length === 1);
  check("nothing else in the house is on it", (await usePass(env, "garage door", "open")).startsWith("That is not on this pass"));
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${url} ${init?.body}`);
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  const withHa = { ...env, HA_BASE_URL: "https://ha.example", HA_TOKEN: "t" } as never;
  const done = await usePass(withHa, "main gate", "open");
  globalThis.fetch = realFetch;
  check("the gate is opened, by name", done === "Done: Main gate, open." && calls[0] === 'https://ha.example/api/services/cover/open_cover {"entity_id":"cover.main_gate"}', { done, calls });
}

console.log("\na guest pass, from invite to end");
{
  const hub = new HubHost(fakeStorage());
  const T0 = MON_10;
  const claim = await hub.claim({ name: "Adam", spaceName: "The Testers", agentName: "Jarvis" }, T0);
  if ("error" in claim) throw new Error(claim.error);
  await hub.redeemInvite(claim.token, { name: "Adam", key: { id: "k1", publicKey: "p", alg: -7, counter: 0 }, label: "x" }, T0);
  const space = claim.space.id;
  const inv = await hub.createInvite(space, { role: "guest", name: "Siti", access: { until: T0 + 7 * 86_400_000, allow: [{ entity: "cover.main_gate", label: "Main gate" }] } }, "owner", T0);
  if ("error" in inv) throw new Error(inv.error);
  const joined = await hub.redeemInvite(inv.token, { name: "Siti", key: { id: "k2", publicKey: "p", alg: -7, counter: 0 }, label: "x" }, T0 + 1000);
  if ("error" in joined) throw new Error(joined.error);
  const who = await hub.lookupSession(await sha256Hex(joined.token), T0 + 2000);
  check("the guest joins with the pass the invite carried", who?.place.access?.allow?.[0]?.entity === "cover.main_gate");
  check("a week on, she is signed out", (await hub.lookupSession(await sha256Hex(joined.token), T0 + 8 * 86_400_000)) === null);
  const bad = await hub.createInvite(space, { role: "guest", name: "x", access: { until: T0 - 1 } }, "owner", T0);
  check("a pass that has already ended is refused", "error" in bad);
  const u = await hub.updateMember(space, joined.user.id, { access: { hours: { from: "08:00", to: "17:00" } } });
  check("an admin changes a member's limits", !("error" in u) && u.access?.hours?.from === "08:00" && !u.access.allow);
  check("the first person has none", "error" in (await hub.updateMember(space, (await hub.firstPerson())!, { access: { hours: { from: "08:00", to: "17:00" } } })));
}

console.log("\nchores, check-ins and medicine, as routines");
{
  const built = buildRoutine({ when: "daily", time: "10:00", days: ["sat"], say: "Wash the car", passTo: [{ person: "u_a", name: "Aisyah" }, { person: "owner", name: "Adam" }], points: 5 }, TZ, MON_10);
  check("a rota: to each in turn, for points", built.ok && built.action.kind === "relay" && built.action.to.length === 2 && built.action.points === 5 && built.action.relay === "remind");
  check("said as it is", built.ok && describeAction(built.action) === 'remind Aisyah, then Adam, in turn: "Wash the car", 5 points for doing it');
  const checkin = buildRoutine({ when: "daily", time: "10:00", ask: "Are you well today?", passTo: [{ person: "u_nenek", name: "Nenek" }], escalate: true }, TZ, MON_10);
  check("a check-in asks, and tells the family if unanswered", checkin.ok && checkin.action.kind === "relay" && checkin.action.relay === "ask" && checkin.action.escalate === true);
  check("points are 0 to 100", !buildRoutine({ when: "daily", time: "10:00", say: "x", passTo: [{ person: "u_a", name: "A" }], points: 500 }, TZ, MON_10).ok);

  const sent: Alert[] = [];
  let awarded: [string, number] | null = null;
  const deps: RelayDeps = {
    async deliver(a) {
      sent.push(a);
      return { alert: a, attempts: [], deliveredBy: "push" };
    },
    async isHome() {
      return null;
    },
    async post() {},
    async markPosted() {},
    async award(person, points) {
      awarded = [person, points];
    },
    async family() {
      return ["owner", "u_sara", "u_nenek"];
    },
  };
  const relays = new Relays(fakeStorage(), async () => deps);
  const [chore] = (await relays.create({ kind: "remind", from: "owner", fromName: "Adam", to: [{ person: "u_a", name: "Aisyah" }], text: "Wash the car", points: 5 }, MON_10)) as { id: string }[];
  await relays.answer(chore!.id, "u_a", { status: "done" }, MON_10 + 60_000);
  check("done earns the chore's points", JSON.stringify(awarded) === '["u_a",5]');
  const [ci] = (await relays.create({ kind: "ask", from: "owner", fromName: "Adam", to: [{ person: "u_nenek", name: "Nenek" }], text: "Are you well today?", escalate: true }, MON_10)) as { id: string }[];
  sent.length = 0;
  await relays.tick(MON_10 + 30 * 60_000);
  await relays.tick(MON_10 + 60 * 60_000);
  const told = sent.filter((a) => a.title === "No answer from Nenek");
  check("an unanswered check-in tells the whole family, urgently", told.length === 2 && told.every((a) => a.urgent) && told.some((a) => a.for === "u_sara") && told.some((a) => a.for === undefined));
  check("but not the one who did not answer", !told.some((a) => a.for === "u_nenek"));

  // Medicine with twenty minutes to answer: nudged at ten, the family told at twenty.
  sent.length = 0;
  await relays.create({ kind: "remind", from: "owner", fromName: "Adam", to: [{ person: "u_atuk", name: "Atuk" }], text: "Take your tablets", escalate: true, answerMin: 20 }, MON_10);
  await relays.tick(MON_10 + 10 * 60_000);
  check("the time to answer can be shorter: nudged halfway", sent.some((a) => a.for === "u_atuk" && a.text.startsWith("Still waiting")));
  await relays.tick(MON_10 + 20 * 60_000);
  check("and the family told at its end", sent.some((a) => a.title === "No answer from Atuk" && a.text.includes("20 minutes")));
  check("too short a time is refused", typeof (await relays.create({ kind: "ask", from: "owner", fromName: "Adam", to: [{ person: "u_x", name: "X" }], text: "?", answerMin: 1 }, MON_10)) === "string");
  void ci;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
