import { FOLLOW_MS, GIVE_UP_MS, Relays, type RelayDeps } from "../src/worker/lib/relays.ts";
import { Chat, FAMILY_ROOM, dmId, mayRead, namesAgent } from "../src/worker/lib/chat.ts";
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

const T0 = 1_800_000_000_000;
const MIN = 60_000;

function harness(home: Record<string, boolean | null> = {}) {
  const sent: Alert[] = [];
  const posted: { between: string; from: string; text: string; relay?: unknown }[] = [];
  const marks: string[] = [];
  const state = { home };
  const deps: RelayDeps = {
    async deliver(a) {
      sent.push(a);
      return { alert: a, attempts: [], deliveredBy: "push" };
    },
    async isHome(entity) {
      return state.home[entity] ?? null;
    },
    async post(between, msg) {
      posted.push({ between: between.join("|"), from: msg.from, text: msg.text, relay: msg.relay });
    },
    async markPosted(_b, id, note) {
      marks.push(`${id}:${note}`);
    },
  };
  const relays = new Relays(fakeStorage(), async () => deps);
  return { relays, sent, posted, marks, state };
}

const ADAM = { person: "owner", name: "Adam" };
const AISYAH = { person: "u_aisyah", name: "Aisyah", home: "person.aisyah" };
const SARA = { person: "u_sara", name: "Sara" };

console.log("a reminder, due now");
{
  const h = harness();
  const made = await h.relays.create({ kind: "remind", from: ADAM.person, fromName: ADAM.name, to: [AISYAH], text: "Buy ice cream on the way home" }, T0);
  check("it is made", Array.isArray(made) && made.length === 1);
  const r = (made as { id: string; status: string }[])[0]!;
  check("and sent at once", r.status === "sent" && h.sent.length === 1);
  check("to her, with Done offered", h.sent[0]!.for === "u_aisyah" && h.sent[0]!.relay?.kind === "remind" && h.sent[0]!.title === "Reminder from Adam");
  check("and it is in their conversation", h.posted[0]?.between === "owner|u_aisyah" && h.posted[0]?.text.startsWith("Reminder:"));
  check("only she can answer it", typeof (await h.relays.answer(r.id, "u_sara", { status: "done" }, T0 + MIN)) === "string");
  const done = await h.relays.answer(r.id, "u_aisyah", { status: "done" }, T0 + 2 * MIN);
  check("she says done", typeof done !== "string" && done.status === "done");
  check("and Adam hears it, under her name", h.sent[1]?.for === undefined && h.sent[1]!.title === "Aisyah" && h.sent[1]!.text.startsWith("Done: Buy ice cream"));
  check("the message shows it is done", h.marks.includes(`${r.id}:✓ done`));
  check("it cannot be answered twice", typeof (await h.relays.answer(r.id, "u_aisyah", { status: "declined" }, T0 + 3 * MIN)) === "string");
}

console.log("\nat five, once she is home");
{
  const h = harness({ "person.aisyah": false });
  const five = T0 + 60 * MIN;
  const made = (await h.relays.create({ kind: "remind", from: "owner", fromName: "Adam", to: [AISYAH], text: "Take the bins out", after: five, whenHome: true }, T0)) as { id: string }[];
  check("it waits until five", h.sent.length === 0 && (await h.relays.nextWake(T0)) === five);
  await h.relays.tick(five);
  check("at five she is out: still waiting, looked at again in a minute", h.sent.length === 0 && (await h.relays.get(made[0]!.id))!.status === "waiting" && (await h.relays.nextWake(five)) === five + MIN);
  h.state.home["person.aisyah"] = true;
  await h.relays.tick(five + MIN);
  check("home: it reaches her", h.sent.length === 1 && (await h.relays.get(made[0]!.id))!.status === "sent");
  const noHome = (await h.relays.create({ kind: "remind", from: "owner", fromName: "Adam", to: [SARA], text: "x", whenHome: true }, T0)) as { status: string; home?: string }[];
  check("someone with no Home Assistant person gets it by the time alone", noHome[0]!.status === "sent" && !noHome[0]!.home);
}

console.log("\nnobody answers");
{
  const h = harness();
  const [r] = (await h.relays.create({ kind: "ask", from: "owner", fromName: "Adam", to: [SARA], text: "Do you want anything from the shop?" }, T0)) as { id: string }[];
  check("a question is titled as one", h.sent[0]!.title === "Adam asks" && h.sent[0]!.relay?.kind === "ask");
  await h.relays.tick(T0 + FOLLOW_MS);
  check("half an hour later, she is nudged once", h.sent.length === 2 && h.sent[1]!.for === "u_sara" && h.sent[1]!.text.startsWith("Still waiting"));
  await h.relays.tick(T0 + FOLLOW_MS + MIN);
  check("not twice", h.sent.length === 2);
  await h.relays.tick(T0 + 2 * FOLLOW_MS);
  check("an hour later, Adam is told", h.sent.length === 3 && h.sent[2]!.for === undefined && h.sent[2]!.text.includes("hasn't answered"));
  check("an answer needs words", typeof (await h.relays.answer(r!.id, "u_sara", { status: "answered", answer: "  " }, T0 + 3 * FOLLOW_MS)) === "string");
  const a = await h.relays.answer(r!.id, "u_sara", { status: "answered", answer: "Milk and bread, please" }, T0 + 3 * FOLLOW_MS);
  check("a late answer still reaches him", typeof a !== "string" && h.sent[3]!.title === "Sara" && h.sent[3]!.text.startsWith("Milk and bread, please"));
  const [late] = (await h.relays.create({ kind: "ask", from: "owner", fromName: "Adam", to: [SARA], text: "?" }, T0)) as { id: string }[];
  await h.relays.tick(T0 + GIVE_UP_MS + MIN);
  check("a day on, it is let go", (await h.relays.get(late!.id))!.status === "expired");
}

console.log("\nnever home");
{
  const h = harness({ "person.aisyah": false });
  const [r] = (await h.relays.create({ kind: "remind", from: "owner", fromName: "Adam", to: [AISYAH], text: "Water the plants", whenHome: true }, T0)) as { id: string }[];
  await h.relays.tick(T0 + GIVE_UP_MS + MIN);
  check("after a day, the sender is told it never reached her", (await h.relays.get(r!.id))!.status === "expired" && h.sent.at(-1)!.text.includes("never reached them"));
}

console.log("\neveryone, together");
{
  const h = harness();
  const made = (await h.relays.create({ kind: "ask", from: "owner", fromName: "Adam", to: [SARA, { person: "u_aisyah", name: "Aisyah" }], text: "Where shall we eat on Saturday?" }, T0)) as { id: string; group?: string }[];
  check("one each, asked together", made.length === 2 && made[0]!.group && made[0]!.group === made[1]!.group);
  await h.relays.answer(made[0]!.id, "u_sara", { status: "answered", answer: "Nasi kandar" }, T0 + MIN);
  check("each answer reaches him as it comes", h.sent.at(-1)!.title === "Sara" && h.sent.at(-1)!.text.startsWith("Nasi kandar"));
  await h.relays.answer(made[1]!.id, "u_aisyah", { status: "answered", answer: "Pizza" }, T0 + 2 * MIN);
  const all = h.sent.at(-1)!;
  check("and when all have, together", all.title === "Everyone has answered" && all.text.includes("Sara: Nasi kandar") && all.text.includes("Aisyah: Pizza"));
}

console.log("\ntaking one back, and what is whose");
{
  const h = harness({ "person.aisyah": false });
  const [r] = (await h.relays.create({ kind: "remind", from: "owner", fromName: "Adam", to: [AISYAH], text: "x", whenHome: true }, T0)) as { id: string }[];
  check("only its sender can take it back", typeof (await h.relays.cancel(r!.id, "u_sara")) === "string");
  const c = await h.relays.cancel(r!.id, "owner");
  check("its sender can", typeof c !== "string" && c.status === "cancelled" && (await h.relays.nextWake(T0)) === null);
  const [t] = (await h.relays.create({ kind: "tell", from: "u_sara", fromName: "Sara", to: [ADAM], text: "Dinner at eight" }, T0)) as { id: string; status: string }[];
  check("a tell needs no answer", t!.status === "sent" && typeof (await h.relays.answer(t!.id, "owner", { status: "done" }, T0)) === "string");
  const mine = await h.relays.forPerson("owner", T0 + MIN);
  check("each person sees what they sent and were sent", mine.sent.length === 1 && mine.received.length === 1 && mine.received[0]!.text === "Dinner at eight");
  check("empty text is refused", typeof (await h.relays.create({ kind: "tell", from: "owner", fromName: "Adam", to: [SARA], text: "  " }, T0)) === "string");
}

console.log("\nchat");
{
  const chat = new Chat(fakeStorage());
  check("a direct conversation is the same from either side", dmId("owner", "u_sara") === dmId("u_sara", "owner"));
  check("only its two may read it; everyone the room", mayRead(dmId("owner", "u_sara"), "u_sara") && !mayRead(dmId("owner", "u_sara"), "u_aisyah") && mayRead(FAMILY_ROOM, "u_aisyah"));
  check("a made-up conversation is nobody's", !mayRead("dm:nonsense", "owner"));
  await chat.post(FAMILY_ROOM, { from: "owner", name: "Adam", text: "Dinner at eight" }, T0);
  await chat.post(FAMILY_ROOM, { from: "u_sara", name: "Sara", text: "Jarvis, add rice to the list" }, T0 + 1000);
  const c = await chat.convos("owner", [{ id: "owner", name: "Adam" }, { id: "u_sara", name: "Sara" }]);
  check("Adam's conversations: the room and one with Sara", c.map((x) => x.title).join() === "Family,Sara");
  check("with one he has not read (his own does not count)", c[0]!.unread === 1);
  await chat.seen("owner", FAMILY_ROOM, T0 + 1000);
  check("until he reads it", (await chat.convos("owner", []))[0]!.unread === 0);
  check("newer than a moment", (await chat.messages(FAMILY_ROOM, T0)).length === 1);
  await chat.post(dmId("owner", "u_sara"), { from: "owner", name: "Adam", text: "Reminder: bins", relay: { id: "r_1", kind: "remind", to: "u_sara" } }, T0 + 2000);
  await chat.markRelay(dmId("owner", "u_sara"), "r_1", "✓ done");
  check("a passed-on message shows its answer", (await chat.messages(dmId("owner", "u_sara")))[0]!.text.endsWith("✓ done"));
  check("the assistant is named: at the start, with @, in the middle", namesAgent("Jarvis, add rice") && namesAgent("ok @jarvis what time") && namesAgent("can Jarvis check the car?"));
  check("but not inside another word", !namesAgent("jarvisfan says hi") && !namesAgent("dinner at eight"));
  check("by whatever the family calls it", namesAgent("Friday, lights off", "Friday") && !namesAgent("Jarvis, lights off", "Friday"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
