import type { Tool } from "./registry";
import { stateStub } from "../lib/state-client.ts";
import { localeOf } from "../lib/locale.ts";
import { whenSaid, zonedToUtc } from "../lib/routines.ts";
import type { Relay } from "../lib/relays.ts";

/**
 * Jarvis as the family's go-between (lib/relays.ts): passing something on
 * to someone, answering what was passed on to you, and seeing what became of
 * what you sent. Only with a family, for people with `chat`.
 */

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;
const person = (env: { JARVIS_PERSON?: string }) => env.JARVIS_PERSON || "owner";

const STATUS: Record<Relay["status"], string> = {
  waiting: "not passed on yet",
  sent: "passed on, no answer yet",
  done: "done",
  declined: "can't",
  answered: "answered",
  expired: "never answered",
  cancelled: "taken back",
};

export const passOn: Tool = {
  name: "pass_on",
  scope: "chat",
  pace: "fast",
  available: (env) => !!env.JARVIS_FAMILY,
  description:
    "Pass something on to someone in the family, through you: tell them, remind them, or ask them. " +
    "It reaches them on their own screens and phone (said aloud if a screen is open) and appears in " +
    "the user's conversation with them. A reminder waits for them to say done; a question waits for " +
    "their answer; either comes back to the user by itself — say so. Use it for 'tell / remind / ask " +
    "<name> …', or 'everyone'. Names are in THE FAMILY. For later, give local_time or in_minutes; " +
    "for 'when she gets home', when_home true, with local_time too if a time was said (it then goes " +
    "at that time or once they are home, whichever is later). Write text as said TO them, in the " +
    "user's language, complete on its own: 'Please buy ice cream on your way home'.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "A name from THE FAMILY, or everyone." },
      kind: {
        type: "string",
        enum: ["tell", "remind", "ask"],
        description: "tell: just let them know. remind: something to do, which they say done to. ask: a question, whose answer comes back.",
      },
      text: { type: "string", description: "What to say to them, as said to them." },
      local_time: {
        type: ["string", "null"],
        description: "When, as the user's local date and time, YYYY-MM-DDTHH:MM, from RIGHT NOW. Null for now.",
      },
      in_minutes: { type: ["integer", "null"], description: "Or this many minutes from now." },
      when_home: { type: ["boolean", "null"], description: "Not until they are home (their Home Assistant person)." },
      answer_within_minutes: {
        type: ["integer", "null"],
        description: "For remind or ask: how long they have before the user hears it went unanswered (nudged halfway). Null for the family's usual.",
      },
    },
    required: ["to", "kind", "text", "local_time", "in_minutes", "when_home", "answer_within_minutes"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "Messages cannot be passed on here: this deployment has no state object.";
    const tz = localeOf(ctx.env).timeZone;
    const now = Date.now();
    let after: number | undefined;
    const local = LOCAL.exec(String(args.local_time ?? ""));
    const mins = Number(args.in_minutes);
    if (local) after = zonedToUtc(+local[1]!, +local[2]!, +local[3]!, +local[4]!, +local[5]!, tz);
    else if (args.in_minutes !== null && Number.isFinite(mins) && mins > 0) after = now + Math.round(mins) * 60_000;
    if (after !== undefined && after < now - 60_000) return "Not passed on: that time has already gone. Ask when.";

    const kind = args.kind === "remind" || args.kind === "ask" ? args.kind : "tell";
    const r = await state.relayCreate({
      kind,
      from: person(ctx.env),
      fromName: ctx.env.JARVIS_PERSON_NAME || "Someone at home",
      to: String(args.to ?? ""),
      text: String(args.text ?? ""),
      ...(after ? { after } : {}),
      whenHome: args.when_home === true,
      ...(Number.isInteger(args.answer_within_minutes) ? { answerMin: Number(args.answer_within_minutes) } : {}),
    });
    if (typeof r === "string") return `Not passed on: ${r}.`;
    const names = r.relays.map((x) => x.toName).join(", ");
    const waiting = r.relays.filter((x) => x.status === "waiting");
    const home = r.relays.some((x) => x.home);
    // Scheduled is not sent: the model must not say "I've reminded him" of something still to come.
    let out = waiting.length
      ? `Scheduled, not sent yet: it will reach ${names}${after ? ` at ${whenSaid(after, tz)}` : ""}${home ? `${after ? ", or" : ""} once they are home${after ? ", whichever is later" : ""}` : ""}. ` +
        `It is in the user's conversation with ${names} already${kind === "remind" ? `, and ${names} ${r.relays.length === 1 ? "has" : "have"} been told it is coming` : ""}.`
      : `Passed on to ${names}: it has reached them.`;
    if (r.noHome.length) out += ` ${r.noHome.join(" and ")} ha${r.noHome.length === 1 ? "s" : "ve"} no Home Assistant person set, so it goes by the time alone.`;
    if (kind !== "tell") out += " Their answer will come back to the user by itself.";
    return out;
  },
};

export const answerMessage: Tool = {
  name: "answer_message",
  scope: "chat",
  pace: "fast",
  available: (env) => !!env.JARVIS_FAMILY,
  description:
    "Answer something someone in the family passed on to the user (WAITING FOR THEIR ANSWER): " +
    "done, can't, or their answer in words. Use it when they say 'done', 'I bought it', 'tell Dad " +
    "yes', 'I can't today'. The answer goes back to whoever asked.",
  parameters: {
    type: "object",
    properties: {
      id: { type: ["string", "null"], description: "Its id from WAITING FOR THEIR ANSWER. Null for the most recent." },
      status: { type: "string", enum: ["done", "declined", "answered"], description: "done or declined for a reminder; answered for a question, with answer." },
      answer: { type: ["string", "null"], description: "Their answer in words, for a question (or a reason for declining)." },
    },
    required: ["id", "status", "answer"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "There is nothing to answer here.";
    const me = person(ctx.env);
    let id = typeof args.id === "string" ? args.id : "";
    if (!id) {
      const waiting = await state.relaysAwaiting(me);
      if (!waiting.length) return "Nothing passed on to the user is waiting for an answer.";
      id = waiting[0]!.id;
    }
    const status = args.status === "declined" || args.status === "answered" ? args.status : "done";
    const r = await state.relayAnswer(id, me, { status, ...(typeof args.answer === "string" ? { answer: args.answer } : {}) });
    if (typeof r === "string") return `Not answered: ${r}.`;
    return `Answered; ${r.fromName} will hear it.`;
  },
};

export const familyMessages: Tool = {
  name: "family_messages",
  scope: "chat",
  pace: "fast",
  available: (env) => !!env.JARVIS_FAMILY,
  description:
    "What the user has passed on to the family, and been sent, over the last week, and what became " +
    "of each: for 'did Aisyah get my message?', 'what's still open?', 'what did Mum ask me?'.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  async run(_args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "There are no family messages here.";
    const tz = localeOf(ctx.env).timeZone;
    const { sent, received } = await state.relaysFor(person(ctx.env));
    const line = (r: Relay, other: string) =>
      `- [${r.id}] ${whenSaid(r.createdAt, tz)}, ${r.kind} ${other}: ${r.text} — ${STATUS[r.status]}${r.answer ? `: “${r.answer}”` : ""}`;
    const parts: string[] = [];
    if (sent.length) parts.push("SENT BY THE USER\n" + sent.slice(0, 15).map((r) => line(r, `to ${r.toName}`)).join("\n"));
    if (received.length) parts.push("SENT TO THE USER\n" + received.slice(0, 15).map((r) => line(r, `from ${r.fromName}`)).join("\n"));
    return parts.join("\n\n") || "Nothing has been passed on this week.";
  },
};

export const chorePoints: Tool = {
  name: "chore_points",
  scope: "chat",
  pace: "fast",
  available: (env) => !!env.JARVIS_FAMILY,
  description: "The family's chore points, earned by saying done to chores passed on by a rota: 'how many points has Aisyah got?', 'who's winning?'.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  async run(_args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "There are no chore points here.";
    const tally = (await state.choresPoints()).filter((p) => p.points > 0);
    return tally.length ? tally.map((p) => `${p.name}: ${p.points}`).join("\n") : "Nobody has chore points yet.";
  },
};

export const familyTools: Tool[] = [passOn, answerMessage, familyMessages, chorePoints];
