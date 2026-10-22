// Errands for later (lib/later.ts, Proposals): a call staged now and put to
// its person when its time comes (at a time, before an event, on getting
// home or leaving), checked again as it is put to them, and never seen,
// approved or allowed without asking before then.
import { AT_GRACE_MS, HOME_MS, MAX_HOME, MAX_STAGED, parseLater, presenceRead, presenceTemplate, untilOf, whenSaid, type Release } from "../src/worker/lib/later.ts";
import { held, Proposals, weigh, type LaterDeps, type Proposal, type ProposalInput } from "../src/worker/lib/proposals.ts";
import { WATCH_ERRORS_SLOW, WATCH_EVERY_MS, WATCH_SLOW_MS } from "../src/worker/lib/scheduler.ts";
import { carCommand } from "../src/worker/tools/tessie.ts";
import type { Tool } from "../src/worker/tools/registry.ts";

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
    _m: m,
  };
}

const TZ = "Asia/Kuala_Lumpur";
/** 21 October 2026 at hh:mm in Kuala Lumpur (UTC+8). */
const at = (h: number, m = 0, day = 21) => Date.UTC(2026, 9, day, h - 8, m);
const T = at(7);
const MIN = 60_000;
const NO_CARS = {} as never;
const lock = { tool: "car_command", args: { command: "lock", value: null, temperature: null, percent: null, car: null } };
const climate = { tool: "car_command", args: { command: "start_climate", value: null, temperature: null, percent: null, car: null } };
const input = (over: Partial<ProposalInput> = {}): ProposalInput => ({
  who: "u_sara",
  person: "u_sara",
  from: { kind: "job", id: "j1", title: "Get the car ready" },
  action: lock,
  weighed: weigh(carCommand, lock.args, NO_CARS)!,
  grants: ["*"],
  ...over,
});

/** The world as releasing sees it, every call written down. */
function world(over: Partial<LaterDeps> = {}) {
  const said: Proposal[] = [];
  const rendered: string[] = [];
  const state = { home: new Map<string, boolean>(), event: null as { start: number } | "gone" | null, renderFails: false };
  const deps: LaterDeps = {
    timeZone: TZ,
    eventOf: async () => state.event,
    presenceOf: async (person) => (person === "u_sara" ? "person.sara" : null),
    renderTemplate: async (t) => {
      rendered.push(t);
      if (state.renderFails) throw new Error("Home Assistant is away");
      return JSON.stringify(Object.fromEntries([...t.matchAll(/'(a[0-9a-z]{20})': is_state\('([a-z_.]+)'/g)].map((m) => [m[1], state.home.get(m[2]!) ?? false])));
    },
    reach: async () => ["*"],
    check: async () => null,
    announce: async (p) => void said.push(p),
    ...over,
  };
  return { deps, said, rendered, state };
}

console.log("what a job may ask for");
{
  check("nothing asked: now", parseLater(null, TZ, T) === null && parseLater({ at: null, before_event: null, minutes_before: null, home: null }, TZ, T) === null);
  const a = parseLater({ at: "2026-10-21T17:30", before_event: null, minutes_before: null, home: null }, TZ, T);
  check("at their local time", typeof a === "object" && a !== null && "at" in a && a.at === at(17, 30), a);
  const e = parseLater({ at: null, before_event: "2026-10-22T10:00:00+08:00", minutes_before: 45, home: null }, TZ, T);
  check("before an event, by its start, with a lead", typeof e === "object" && e !== null && "event" in e && e.event.start === at(10, 0, 22) && e.event.leadMin === 45, e);
  const d = parseLater({ at: null, before_event: "2026-10-22T10:00:00+08:00", minutes_before: null, home: null }, TZ, T);
  check("half an hour before, when it does not say", typeof d === "object" && d !== null && "event" in d && d.event.leadMin === 30, d);
  check("on getting home, or leaving", JSON.stringify(parseLater({ home: "arrive" }, TZ, T)) === '{"home":"arrive"}' && JSON.stringify(parseLater({ home: "leave" }, TZ, T)) === '{"home":"leave"}');
  const refused = [
    parseLater({ at: "2026-10-21T17:30", home: "arrive" }, TZ, T),
    parseLater({ at: "tomorrow at five" }, TZ, T),
    parseLater({ at: "2026-10-21T07:01" }, TZ, T),
    parseLater({ at: "2026-11-21T07:00" }, TZ, T),
    parseLater({ before_event: "2026-10-22 10:00" }, TZ, T),
    parseLater({ before_event: "2026-10-22T10:00:00+08:00", minutes_before: 500 }, TZ, T),
    parseLater({ before_event: "2026-10-21T07:20:00+08:00", minutes_before: 30 }, TZ, T),
    parseLater({ home: "nearby" }, TZ, T),
    parseLater("at five", TZ, T),
  ];
  check("refused, each with why: two forms, not a time, too soon, over a week, no offset, too long a lead, a lead already past, no such home, not an object", refused.every((r) => typeof r === "string"), refused);
}

console.log("\nhow long each waits, and how it is said");
{
  const ev: Release = { event: { id: "evt12345", start: at(10, 0, 22), title: "Dentist", leadMin: 30 } };
  check("a time: half an hour's grace; an event: its start; home: three days", untilOf({ at: at(17) }, T) === at(17) + AT_GRACE_MS && untilOf(ev, T) === at(10, 0, 22) && untilOf({ home: "arrive" }, T) === T + HOME_MS);
  check("said in words, in their zone", whenSaid(ev, TZ) === "30 min before “Dentist”, Thu 22 Oct, 10:00" && whenSaid({ home: "arrive" }, TZ) === "When you get home" && whenSaid({ home: "leave" }, TZ) === "When you leave home" && whenSaid({ at: at(17, 30) }, TZ) === "At Wed 21 Oct, 17:30", whenSaid(ev, TZ));
}

console.log("\nHome Assistant's one look");
{
  const t = presenceTemplate([{ id: "a0123456789abcdefghjk", entity: "person.sara" }, { id: "a1123456789abcdefghjk", entity: "device_tracker.adam_phone" }, { id: "bad", entity: "person.x" }, { id: "a2123456789abcdefghjk", entity: "person.x'); evil('" }]);
  check("one template for everyone, from checked ids and entities only", t === "{{ { 'a0123456789abcdefghjk': is_state('person.sara', 'home'), 'a1123456789abcdefghjk': is_state('device_tracker.adam_phone', 'home') } | tojson }}", t);
  check("nothing valid to look at: no template", presenceTemplate([{ id: "a0123456789abcdefghjk", entity: "sensor.x" }]) === null);
  const r = presenceRead('{"a0123456789abcdefghjk": true, "a1123456789abcdefghjk": "maybe"}');
  check("read back: true or false only", r?.get("a0123456789abcdefghjk") === true && !r.has("a1123456789abcdefghjk") && presenceRead("not json") === null);
}

console.log("\nstaged: kept apart until its time");
{
  const st = fakeStorage();
  const props = new Proposals(st as never);
  const s = (await props.add(input({ release: { at: at(17) } }), T)) as Proposal;
  check("kept apart, not among the proposals, not to be got or approved", [...st._m.keys()].every((k) => k.startsWith("propstage:u_sara:")) && (await props.list("u_sara", T)).length === 0 && (await props.get("u_sara", s.id, T)) === null && (await props.claim("u_sara", s.id, ["*"], ["*"], T)) === "No such proposal.");
  check("but listed as for later", (await props.later("u_sara")).map((x) => x.id).join() === s.id);
  check("the same call from the same job again: the one staged", ((await props.add(input({ release: { at: at(17) } }), T + 1000)) as Proposal).id === s.id && (await props.later("u_sara")).length === 1);
  check("the alarm wakes when it is due", (await props.nextWake(T)) === at(17));
  const allowed = new Proposals(fakeStorage() as never);
  await allowed.add(input(), T);
  const p0 = (await allowed.list("u_sara", T))[0]!;
  await allowed.claim("u_sara", p0.id, ["*"], ["*"], T);
  await allowed.finish("u_sara", p0.id, { ok: true, text: "Locked." }, T);
  await allowed.allow("u_sara", p0.id, T);
  const later = (await allowed.add(input({ from: { kind: "job", id: "j2", title: "x" }, release: { at: at(17) } }), T)) as Proposal;
  check("never done without asking, even a kind they allow", later.state === "pending" && !later.by, later);
  const many = new Proposals(fakeStorage() as never);
  for (let i = 0; i < MAX_STAGED; i++) await many.add(input({ from: { kind: "job", id: `jm${i}`, title: "x" }, release: { at: at(17) } }), T);
  check(`at most ${MAX_STAGED} each`, typeof (await many.add(input({ from: { kind: "job", id: "jmx", title: "x" }, release: { at: at(17) } }), T)) === "string");
  const homes = new Proposals(fakeStorage() as never);
  for (let i = 0; i < MAX_HOME; i++) await homes.add(input({ person: `u_p${i}`, who: `u_p${i}`, release: { home: "arrive" } }), T);
  check(`at most ${MAX_HOME} for getting home in the household`, typeof (await homes.add(input({ person: "u_px", who: "u_px", release: { home: "arrive" } }), T)) === "string");
}

console.log("\nput to them when its time comes, once");
{
  const st = fakeStorage();
  const props = new Proposals(st as never);
  const s = (await props.add(input({ release: { at: at(17) } }), T)) as Proposal;
  const w = world();
  await props.tick({ carryOut: async () => ({ ok: true, text: "" }), later: w.deps }, at(16, 59));
  check("not before", w.said.length === 0 && (await props.later("u_sara")).length === 1);
  await props.tick({ carryOut: async () => ({ ok: true, text: "" }), later: w.deps }, at(17));
  const card = await props.get("u_sara", s.id, at(17));
  check("then: a card waiting for their OK, said once, waiting no longer than its grace", card?.state === "pending" && card.expires === at(17) + AT_GRACE_MS && w.said.length === 1 && w.said[0]!.id === s.id && (await props.later("u_sara")).length === 0, card);
  check("it keeps when it was for", JSON.stringify(card?.release) === JSON.stringify({ at: at(17) }));
  const retry = new Proposals(fakeStorage() as never);
  const r = (await retry.add(input({ release: { at: at(17) } }), T)) as Proposal;
  const flaky = world({ announce: async () => { throw new Error("push down"); } });
  await retry.tick({ carryOut: async () => ({ ok: true, text: "" }), later: flaky.deps }, at(17));
  const again = world();
  await retry.tick({ carryOut: async () => ({ ok: true, text: "" }), later: again.deps }, at(17, 1));
  check("an alert that fails: the card still waits, and is not said a second time", (await retry.get("u_sara", r.id, at(17, 1)))?.state === "pending" && again.said.length === 0);
  const late = new Proposals(fakeStorage() as never);
  const l = (await late.add(input({ release: { at: at(17) } }), T)) as Proposal;
  const lw = world();
  await late.tick({ carryOut: async () => ({ ok: true, text: "" }), later: lw.deps }, at(17) + AT_GRACE_MS);
  const gone = await late.get("u_sara", l.id, at(18));
  check("past its time (the alarm was late): not needed, kept so, not said", gone?.state === "expired" && /its time had passed/.test(gone.outcome?.text ?? "") && lw.said.length === 0, gone);
}

console.log("\nchecked again as it is put to them");
{
  const make = async (over: Partial<LaterDeps>) => {
    const props = new Proposals(fakeStorage() as never);
    const s = (await props.add(input({ release: { at: at(17) } }), T)) as Proposal;
    const w = world(over);
    await props.tick({ carryOut: async () => ({ ok: true, text: "" }), later: w.deps }, at(17));
    return { got: await props.get("u_sara", s.id, at(17)), said: w.said.length, props };
  };
  const left = await make({ reach: async () => null });
  check("its person gone: withdrawn, not said", left.got?.state === "withdrawn" && /no longer in the family/.test(left.got.outcome?.text ?? "") && left.said === 0, left.got);
  const changed = await make({ check: async () => "That has changed since it was proposed (it would now be: Car: lock (Ioniq 5, …0001))" });
  check("its call no longer as its card says: withdrawn, with why", changed.got?.state === "withdrawn" && /changed before it was needed/.test(changed.got.outcome?.text ?? "") && changed.said === 0, changed.got);
  // X'd while it was being looked at: it is gone, and nothing is filed.
  const props = new Proposals(fakeStorage() as never);
  const s = (await props.add(input({ release: { at: at(17) } }), T)) as Proposal;
  const w = world({ check: async () => (await props.decline("u_sara", s.id, at(17)), null) });
  await props.tick({ carryOut: async () => ({ ok: true, text: "" }), later: w.deps }, at(17));
  check("declined while it was checked: it stays declined, and is not put to them", (await props.get("u_sara", s.id, at(17)))?.state === "declined" && w.said.length === 0);
}

console.log("\nbefore an event");
{
  const ev = (start = at(10, 0, 22)): Release => ({ event: { id: "evt12345abc", start, title: "Dentist", leadMin: 30 } });
  const run = async (event: { start: number } | "gone" | null, when = at(9, 30, 22)) => {
    const props = new Proposals(fakeStorage() as never);
    const s = (await props.add(input({ release: ev() }), T)) as Proposal;
    const w = world();
    w.state.event = event;
    await props.tick({ carryOut: async () => ({ ok: true, text: "" }), later: w.deps }, when);
    return { props, s, w };
  };
  const ok = await run({ start: at(10, 0, 22) });
  const card = await ok.props.get("u_sara", ok.s.id, at(9, 30, 22));
  check("its lead before the start: put to them, waiting until the start", card?.state === "pending" && card.expires === at(10, 0, 22) && ok.w.said.length === 1, card);
  const unread = await run(null);
  check("the calendar could not be read: put to them all the same", (await unread.props.get("u_sara", unread.s.id, at(9, 30, 22)))?.state === "pending");
  const cancelled = await run("gone");
  check("cancelled, or declined: withdrawn, not said", (await cancelled.props.get("u_sara", cancelled.s.id, at(9, 30, 22)))?.state === "withdrawn" && cancelled.w.said.length === 0);
  const moved = await run({ start: at(14, 0, 22) });
  const kept = (await moved.props.later("u_sara"))[0];
  check("moved: it waits for the new time", kept?.release && "event" in kept.release && kept.release.event.start === at(14, 0, 22) && kept.release.event.moved === true && kept.until === at(14, 0, 22) && moved.w.said.length === 0, kept);
  moved.w.state.event = { start: at(16, 0, 22) };
  await moved.props.tick({ carryOut: async () => ({ ok: true, text: "" }), later: moved.w.deps }, at(13, 30, 22));
  check("moved again: withdrawn", (await moved.props.get("u_sara", moved.s.id, at(13, 30, 22)))?.state === "withdrawn");
}

console.log("\non getting home, or leaving");
{
  const props = new Proposals(fakeStorage() as never);
  const s = (await props.add(input({ release: { home: "arrive" } }), T)) as Proposal;
  const w = world();
  const tick = (t: number) => props.tick({ carryOut: async () => ({ ok: true, text: "" }), later: w.deps }, t);
  await tick(T);
  check("the first look only learns where they are", w.said.length === 0 && (await props.later("u_sara"))[0]?.check?.was === false && w.rendered.length === 1);
  check("and it is looked at again in a minute", (await props.nextWake(T)) === T + WATCH_EVERY_MS);
  w.state.home.set("person.sara", true);
  await tick(T + WATCH_EVERY_MS);
  check("home after away: put to them", (await props.get("u_sara", s.id, T + WATCH_EVERY_MS))?.state === "pending" && w.said.length === 1);
  const there = new Proposals(fakeStorage() as never);
  const already = world();
  already.state.home.set("person.sara", true);
  const s2 = (await there.add(input({ release: { home: "arrive" } }), T)) as Proposal;
  for (let i = 0; i < 3; i++) await there.tick({ carryOut: async () => ({ ok: true, text: "" }), later: already.deps }, T + i * WATCH_EVERY_MS);
  check("home all along: not arriving, so it waits", already.said.length === 0 && (await there.get("u_sara", s2.id, T)) === null);
  const failing = new Proposals(fakeStorage() as never);
  const f = world();
  f.state.renderFails = true;
  await failing.add(input({ release: { home: "leave" } }), T);
  for (let i = 0; i < WATCH_ERRORS_SLOW; i++) await failing.tick({ carryOut: async () => ({ ok: true, text: "" }), later: f.deps }, T + i * WATCH_SLOW_MS);
  const c = (await failing.later("u_sara"))[0]?.check;
  check("Home Assistant not answering: looked at less often", c?.errors === WATCH_ERRORS_SLOW && c.next === T + (WATCH_ERRORS_SLOW - 1) * WATCH_SLOW_MS + WATCH_SLOW_MS, c);
  const nobody = new Proposals(fakeStorage() as never);
  const n = (await nobody.add(input({ person: "u_adam", who: "u_adam", release: { home: "arrive" } }), T)) as Proposal;
  await nobody.tick({ carryOut: async () => ({ ok: true, text: "" }), later: world().deps }, T);
  check("no Home Assistant person for them: withdrawn, with why", (await nobody.get("u_adam", n.id, T))?.state === "withdrawn");
  const away = new Proposals(fakeStorage() as never);
  const a = (await away.add(input({ release: { home: "arrive" } }), T)) as Proposal;
  await away.tick({ carryOut: async () => ({ ok: true, text: "" }), later: world().deps }, T + HOME_MS);
  check("three days and they did not get home: not needed", (await away.get("u_sara", a.id, T + HOME_MS))?.state === "expired");
}

console.log("\nX, a job cancelled, someone gone");
{
  const st = fakeStorage();
  const props = new Proposals(st as never);
  const s = (await props.add(input({ release: { at: at(17) }, weighed: { ...weigh(carCommand, climate.args, NO_CARS)!, about: "car:climate" }, action: climate }), T)) as Proposal;
  const declined = await props.decline("u_sara", s.id, T + MIN);
  check("X before its time: declined, no longer waiting, its subject remembered", typeof declined !== "string" && declined.state === "declined" && (await props.later("u_sara")).length === 0 && ((st._m.get("propgone:u_sara") ?? {}) as Record<string, number>)["car:climate"] !== undefined, declined);
  const job = (await props.add(input({ from: { kind: "job", id: "jc", title: "x" }, release: { at: at(17) } }), T)) as Proposal;
  await props.withdrawJob("u_sara", "jc", T + MIN);
  const w = await props.get("u_sara", job.id, T + MIN);
  check("its job cancelled: withdrawn, and said so", w?.state === "withdrawn" && w.outcome?.text === "Its job was cancelled." && (await props.later("u_sara")).length === 0, w);
  const run = (await props.add(input({ from: { kind: "brief", id: "rb@1", title: "Brief", routine: "rb" }, release: { at: at(17) } }), T)) as Proposal;
  await props.forgetRun("u_sara", "rb@1", T);
  check("a brief's run forgotten: what it staged goes too", (await props.later("u_sara")).every((x) => x.id !== run.id));
  await props.add(input({ release: { at: at(17) } }), T);
  await props.forget("u_sara");
  check("someone who left: nothing of theirs waits for later", ![...st._m.keys()].some((k) => k.startsWith("propstage:u_sara")));
}

console.log("\nthe car's climate before an event: one for each event");
{
  const props = new Proposals(fakeStorage() as never);
  const w0 = weigh(carCommand, climate.args, NO_CARS)!;
  const brief = (run: string, event: string, start: number): ProposalInput =>
    input({ from: { kind: "brief", id: `rb@${run}`, title: "Morning brief", routine: "rb" }, action: climate, weighed: { ...w0, about: "car:climate" }, release: { event: { id: event, start, title: "Dentist", leadMin: 30 } } });
  const first = (await props.add(brief("1", "evt1abcd", at(10, 0, 22)), T)) as Proposal;
  const same = (await props.add(brief("2", "evt1abcd", at(10, 0, 22)), T + 3_600_000)) as Proposal;
  check("staged for that event already: that one", same.id === first.id && (await props.later("u_sara")).length === 1);
  const other = (await props.add(brief("3", "evt2abcd", at(15, 0, 23)), T)) as Proposal;
  check("another event: another", other.id !== first.id && (await props.later("u_sara")).length === 2);
  const w = world();
  w.state.event = { start: at(10, 0, 22) };
  await props.tick({ carryOut: async () => ({ ok: true, text: "" }), later: w.deps }, at(9, 30, 22));
  check("put to them for its event, then not staged for that event again", w.said.length === 1 && (await props.add(brief("4", "evt1abcd", at(10, 0, 22)), at(9, 31, 22))) === "Already put to them for that event.");
  check("a week later, another event: staged, with no week to wait as other subjects have", typeof (await props.add(brief("5", "evt3abcd", at(10, 0, 27)), at(9, 0, 23))) !== "string");
  await props.decline("u_sara", other.id, at(9, 0, 23));
  check("X: no climate is offered at all for a while", (await props.add(brief("6", "evt4abcd", at(11, 0, 27)), at(9, 1, 23))) === "Dismissed: not offered again for now.");
}

console.log("\na job's held tool: later is when, never the call");
{
  const filed: { args: unknown; later: unknown }[] = [];
  const [h] = held([carCommand], async (action, _w, _c, _b, later) => (filed.push({ args: action.args, later }), "filed"), async () => {});
  const env = { TIMEZONE: TZ } as never;
  await h!.run({ ...lock.args, later: { at: null, before_event: null, minutes_before: null, home: "arrive" } }, { env, grants: ["*"] } as never);
  check("asked for later: passed on, and not part of the call it stores", JSON.stringify(filed[0]) === JSON.stringify({ args: lock.args, later: { home: "arrive" } }), filed[0]);
  const bad = await h!.run({ ...lock.args, later: { at: "soon", before_event: null, minutes_before: null, home: null } }, { env, grants: ["*"] } as never);
  check("asked badly: not filed, and told why", /^Not filed: later\.at/.test(String(bad)) && filed.length === 1, bad);
  const own: Tool = { name: "x__later_tool", description: "d", parameters: { type: "object", properties: { later: { type: "string" } }, required: ["later"] }, strict: false, run: async () => "" };
  const [o] = held([own], async () => "filed", async () => {});
  check("a tool with a later of its own keeps it", JSON.stringify(o!.parameters) === JSON.stringify(own.parameters));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
