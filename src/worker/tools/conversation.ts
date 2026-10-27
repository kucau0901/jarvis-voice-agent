import type { Tool } from "./registry.ts";
import { stateStub } from "../lib/state-client.ts";
import { lookBack } from "../lib/conversation.ts";
import { asQuotedData } from "../lib/quote.ts";
import { localeOf } from "../lib/locale.ts";
import { dayOf } from "../lib/usage.ts";
import { OWNER } from "../lib/context.ts";

/**
 * "What did you say last week about the insurance?"
 *
 * A question carries only the last twenty turns of the past three hours
 * (src/app/history.ts), while the chat keeps a month (lib/conversation.ts).
 * This reads back into it, only when the person refers to something said
 * before: nothing is added to every question, and it costs nothing until it
 * is asked for. With memory.read, as the conversation shared between devices
 * (lib/shared.ts): it says as much about the person as memory does.
 *
 * Quoted as data: Jarvis's answers carry what others wrote (a mail it read
 * out, what a routine found).
 */
export const lookBackTool: Tool = {
  name: "look_back",
  scope: "memory.read",
  pace: "fast",
  description:
    "Search the user's earlier conversation with you, kept for 30 days (the last 200 " +
    "messages). Use it when they refer to something said before that is not in the " +
    "conversation you have: \"what did you say last week about the insurance\", \"what " +
    "did we talk about yesterday\". Not for facts saved with remember: recall has those.",
  parameters: {
    type: "object",
    properties: {
      words: {
        type: ["string", "null"],
        description: "Words likely to have been said, e.g. 'insurance renewal'. Null to read a day's latest.",
      },
      day: {
        type: ["string", "null"],
        description: "Only that day, as YYYY-MM-DD in the user's time zone. Null for any day.",
      },
    },
    required: ["words", "day"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "No conversation is kept on this deployment: it has no state object.";
    const words = typeof args.words === "string" ? args.words : "";
    const day = typeof args.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.day) ? args.day : null;
    if (!words.trim() && !day) return "Say what to look for, or which day.";
    const { timeZone } = localeOf(ctx.env);
    const log = await state.conversationOf(ctx.env.JARVIS_PERSON || OWNER, Date.now());
    const found = lookBack(log, words, day, (at) => dayOf(at, timeZone));
    if (!found.length) return `Nothing like that in the conversation kept${day ? ` on ${day}` : ""}.`;
    const when = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const lines = found.map((s) => `[${when.format(s.at)}] ${s.routine ? `Routine "${s.routine.name}"` : s.alert ? `Alert "${s.alert.title}"` : s.role === "user" ? "User" : "Jarvis"}: ${s.text}`);
    return asQuotedData("earlier conversation", lines.join("\n"), "THE USER AND YOU, EARLIER");
  },
};
