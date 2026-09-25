import type { Tool } from "./registry";
import { deliver, makeAlert } from "../lib/alerts.ts";
import { stateStub } from "../lib/state-client.ts";

/**
 * "Send that to my phone."
 *
 * The one alert the user raises themselves, and the one that works before any
 * routine exists. It skips open screens on purpose: the screen in front of
 * them is where they asked, and "send it to my phone" means somewhere else.
 */
export const sendNote: Tool = {
  name: "send_note",
  scope: "alerts",
  pace: "fast",
  description:
    "Send the user a written note to read later on their phone or other devices — an " +
    "address, a list, a phone number, a link, something just worked out. It goes as a " +
    "notification (or through whichever alert channel is set up), not to this screen. " +
    "Use it when asked to send, text, message or put something on their phone. Answer " +
    "aloud as usual too; this is in addition, and say whether it was sent.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: ["string", "null"],
        description: "A few words, e.g. 'Dentist's address'. Null for a plain note.",
      },
      text: {
        type: "string",
        description: "The note, complete on its own: it is read later, away from this conversation.",
      },
    },
    required: ["title", "text"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "Notes cannot be sent on this deployment: it has no state object.";
    const alert = makeAlert({ title: args.title ?? undefined, text: args.text, speak: false }, "note");
    if (!alert) return "Nothing was sent: the note was empty.";
    const d = await deliver(ctx.env, state, alert, { skipLive: true });
    if (d.deliveredBy) return `Sent, by ${d.deliveredBy}.`;
    if (!d.attempts.length) {
      return (
        "Not sent: nothing is set up to receive notes yet. To get them on a phone, open " +
        "Jarvis on that phone, then Jarvis's own settings, and turn notifications on under Alerts."
      );
    }
    return `Not sent. ${d.attempts.map((a) => `${a.channel}: ${a.detail}`).join("; ")}.`;
  },
};
