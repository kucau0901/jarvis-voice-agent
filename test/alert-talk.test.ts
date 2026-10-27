// "Talk to me about alerts", by voice (tools/alerts.ts): only the person
// signed in, only asked in their own latest message, and offered wherever they
// speak to Jarvis (push-to-talk and Live's delegations) but never to a job.
// Then the family room's choices: whether its messages are said
// (lib/chat.ts talksAbout), and where answering one by voice sends it
// (tools/family.ts reply_family_room).
import { alertTalk } from "../src/worker/tools/alerts.ts";
import { baseTools } from "../src/worker/tools/registry.ts";
import { DRAWS_ON_SCREEN } from "../src/worker/tools/place.ts";
import { jobTool } from "../src/worker/lib/jobs.ts";
import { ROLE_SCOPES, type Prefs } from "../src/worker/lib/hub.ts";
import { FAMILY_ROOM, talksAbout, type ChatMessage } from "../src/worker/lib/chat.ts";
import { familyTools } from "../src/worker/tools/family.ts";
import type { Alert } from "../src/worker/lib/alerts.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 300) : ""); }
}

// The hub as the tool reaches it (lib/hub-client.ts hubStub): one RPC method, by name.
const prefs = new Map<string, Prefs>();
const hub = {
  async prefsOf(id: string) {
    return prefs.get(id) ?? {};
  },
  async setPrefs(id: string, patch: Prefs) {
    const next = { ...prefs.get(id), ...patch };
    prefs.set(id, next);
    return next;
  },
};
const stub = { hubCall: (m: string, a: unknown[]) => (hub as unknown as Record<string, (...x: unknown[]) => unknown>)[m]!(...a) };
const STATE = { idFromName: () => "j", get: () => stub };
// The first person signed in: their data is "owner", their own id is theirs.
const sara = { JARVIS_PERSON: "owner", JARVIS_USER: "u_sara", STATE };
const ctx = (env: object, asked?: string) => ({ env, asked, signal: new AbortController().signal, progress() {}, display() {}, grants: ["*"] }) as never;
const run = async (on: boolean | null, env: object, asked?: string) => String(await alertTalk.run({ on }, ctx(env, asked)));

console.log("asking what it is");
{
  check("on when never chosen", /^On:/.test(await run(null, sara, "do you talk to me about alerts?")));
  check("asking changes nothing", !prefs.has("u_sara"));
}

console.log("\nchanging it");
{
  check("asked in their own words: off, by their own id", /^Done\. Off:/.test(await run(false, sara, "Stop talking to me about alerts")) && prefs.get("u_sara")?.alertTalk === "off");
  check("…and said so when asked", /^Off:/.test(await run(null, sara, "are alerts read to me?")));
  check("in Malay too", /^Done\. On:/.test(await run(true, sara, "tolong baca amaran saya")) && prefs.get("u_sara")?.alertTalk === "on");
  check("their latest message not about it (a mail read to them asks): refused", /only the user can change this/.test(await run(false, sara, "yes")) && prefs.get("u_sara")?.alertTalk === "on");
  check("no latest message of theirs (a routine's run): refused", /only the user can change this/.test(await run(false, sara)) && prefs.get("u_sara")?.alertTalk === "on");
}

console.log("\nonly a person has it");
{
  const owner = { JARVIS_PERSON: "owner", STATE };
  check("the owner key, or a device: told so, nothing changed", /device or the owner key/.test(await run(false, owner, "stop talking about alerts")) && prefs.size === 1);
  check("…asking what it is too", /device or the owner key/.test(await run(null, owner, "do you read alerts?")));
  check("without the state object: said so", /no state object/.test(await run(false, { JARVIS_USER: "u_sara" }, "stop talking about alerts")));
}

console.log("\nwhere it is offered");
{
  const names = (g: readonly string[]) => baseTools({} as never, g as never).map((t) => t.name);
  check("to an adult and a child, by the alerts scope", names(ROLE_SCOPES.adult).includes("alert_talk") && names(ROLE_SCOPES.child).includes("alert_talk"));
  check("to an admin", names(["*"]).includes("alert_talk"));
  check("on a screen or none: push-to-talk and Live's delegations are screenless", !DRAWS_ON_SCREEN.includes("alert_talk"));
  check("never to a background job", !jobTool(alertTalk));
}

console.log("\nfamily-room messages, said or not");
{
  const room = { convo: FAMILY_ROOM };
  const direct = { convo: "dm:owner|u_sara" };
  check("by default, the room's are said, as anything is", talksAbout({}, room) && talksAbout({}, direct) && talksAbout({}, {}));
  check("the room's turned off: the room's are not, a direct message and any other alert still are",
    !talksAbout({ roomTalk: "off" }, room) && talksAbout({ roomTalk: "off" }, direct) && talksAbout({ roomTalk: "off" }, {}));
  check("alerts turned off: none is, the room's turned on or not", !talksAbout({ alertTalk: "off", roomTalk: "on" }, room) && !talksAbout({ alertTalk: "off" }, direct));
}

console.log("\nanswering a family-room message by voice");
{
  // The object as the tool reaches it: the room, the family, messages passed on, and alerts to the others.
  const posted: { convo: string; msg: Omit<ChatMessage, "id" | "at"> }[] = [];
  const relays: { kind: string; from: string; to: string; text: string }[] = [];
  const told: Alert[] = [];
  const family = {
    ...stub,
    async chatPost(convo: string, msg: Omit<ChatMessage, "id" | "at">) {
      posted.push({ convo, msg });
      return { ...msg, id: `m${posted.length}`, at: 1 };
    },
    async chatSeen() {},
    async familyPeople() {
      return [
        { person: "u_ana", name: "Ana", role: "adult", chat: true },
        { person: "u_ben", name: "Ben", role: "adult", chat: true },
        { person: "u_kid", name: "Kid", role: "guest", chat: false },
      ];
    },
    async relayCreate(input: { kind: string; from: string; to: string; text: string }) {
      relays.push(input);
      return { relays: [{ toName: input.to, status: "sent" }], noHome: [] };
    },
    async broadcast(a: Alert) {
      told.push(a);
      return { open: 1, visible: 1, acked: "phone" };
    },
    async pushTargets() {
      return { vapid: {}, subs: [] };
    },
    async pushResults() {},
    async logDelivery() {},
  };
  const env = { JARVIS_PERSON: "u_ana", JARVIS_USER: "u_ana", JARVIS_PERSON_NAME: "Ana", JARVIS_FAMILY: "fam:x", ALERT_ORDER: "live", STATE: { idFromName: () => "j", get: () => family } };
  const reply = familyTools.find((t) => t.name === "reply_family_room")!;
  const answer = async (e: object) => String(await reply.run({ sender: "Ben", text: "Yes, eight is fine" }, ctx(e, "tell them yes")));

  const toSender = await answer(env);
  check("by default, to whoever wrote it, passed on: not the room", /Told Ben, directly, not the room/.test(toSender) && relays.length === 1 && relays[0]!.kind === "tell" && relays[0]!.to === "Ben" && relays[0]!.from === "u_ana" && !posted.length, toSender);

  prefs.set("u_ana", { roomReply: "room" });
  const toRoom = await answer(env);
  check("chosen: into the family room, as them", /Said in the family room/.test(toRoom) && posted.length === 1 && posted[0]!.convo === FAMILY_ROOM && posted[0]!.msg.from === "u_ana" && posted[0]!.msg.name === "Ana" && relays.length === 1, toRoom);
  check("…and the others in it told, not them, nor a guest with no chat",
    told.map((a) => a.for).sort().join() === "u_ben" && told[0]!.convo === FAMILY_ROOM && told[0]!.title === "Ana, to the family" && told[0]!.source === "chat", told);

  const device = await answer({ ...env, JARVIS_USER: undefined });
  check("from a device or the owner key: nothing sent", /only a person signed in/.test(device) && posted.length === 1 && relays.length === 1);
  check("offered with the chat scope, as pass_on is", reply.scope === "chat" && !jobTool(reply));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
