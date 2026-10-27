import type { Tool } from "./registry.ts";
import { hubStub, forgetPerson } from "../lib/hub-client.ts";
import { OWNER } from "../lib/context.ts";

/**
 * "Stop talking to me about alerts." Whether Jarvis says each of the person's
 * alerts aloud and listens for a reply (lib/alerts.ts talk), or only puts it
 * in Chat: their own choice, as in Family → You (hub.ts prefs alertTalk).
 *
 * Alerts carry other people's words (mail, pages, the house), so changing it
 * takes the user's own latest message asking about it, as specialty_save does
 * (tools/specialties.ts): a routine has none (lib/router.ts ownWords), and a
 * mail read aloud cannot switch it. Jobs are never offered it (lib/jobs.ts
 * READ_TOOLS). Only a person signed in has the choice; a device or the owner
 * key is told where it is.
 */

/** Asking about it, in their words: alerts, being told or spoken to, quiet; or in Malay. */
const ABOUT = /\b(alerts?|notif\w*|talk\w*|tell\w*|speak\w*|say\w*|read\w*|announc\w*|quiet\w*|silen\w*|mute\w*|amaran|makluman|notifikasi|beritahu\w*|cakap\w*|baca\w*|senyap|diam)\b/i;

const SAYS = {
  on: "On: their alerts are said aloud in their glasses or by a screen that can speak, and Jarvis listens for a reply. They are in Chat too.",
  off: "Off: their alerts are not said aloud; they are still in Chat and still a notification.",
};

export const alertTalk: Tool = {
  name: "alert_talk",
  scope: "alerts",
  pace: "fast",
  description:
    "Whether you say the user's alerts aloud (reminders, routines, finished jobs, the house) in their " +
    "glasses or on a screen that can speak, and listen for their reply, or only put them in Chat. " +
    "Turn it on or off only when the user asks in their own words ('stop talking to me about alerts', " +
    "'read my alerts to me again'); if they only agree to your offer, ask them to say it. Null to say " +
    "what it is now.",
  parameters: {
    type: "object",
    properties: {
      on: { type: ["boolean", "null"], description: "True to turn it on, false to turn it off, null to say what it is now." },
    },
    required: ["on"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const user = ctx.env.JARVIS_USER;
    if (!user) return "This is a device or the owner key, not a person signed in, so it has no such choice. A person changes it in Family → You → Alerts.";
    const hub = hubStub(ctx.env);
    if (!hub) return "Alerts cannot be talked about on this deployment: it has no state object.";
    if (args.on === null) return (await hub.prefsOf(user)).alertTalk === "off" ? SAYS.off : SAYS.on;
    if (typeof args.on !== "boolean") return "Not changed: say on or off.";
    if (!ctx.asked || !ABOUT.test(ctx.asked)) {
      return "Not changed: only the user can change this, asking in their own latest message. Ask them whether to.";
    }
    const r = await hub.setPrefs(user, { alertTalk: args.on ? "on" : "off" });
    if ("error" in r) return `Not changed: ${r.error}.`;
    // Read afresh by this isolate's next request, as Family → You does (routes/hub.ts).
    forgetPerson(ctx.env.JARVIS_PERSON ?? OWNER);
    return `Done. ${args.on ? SAYS.on : SAYS.off}`;
  },
};
