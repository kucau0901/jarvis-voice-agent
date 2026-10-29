import type { Tool } from "./registry.ts";
import { stateStub } from "../lib/state-client.ts";
import { OWNER } from "../lib/context.ts";

/**
 * "Open Jarvis", said to Even AI on G2 glasses (routes/v1.ts): the glasses app
 * on the person's phone takes the glasses from the Even app and shows Jarvis's
 * own screen there, a menu to talk or read the latest alerts. It is told on
 * the alert socket (docs/api.md), as `{"type":"glasses.open"}`; only the
 * person's own screens and devices are.
 */
export const openOnGlasses: Tool = {
  name: "open_on_glasses",
  pace: "fast",
  description:
    "Open Jarvis on the user's display glasses (Even Realities G2), through the Jarvis app on their " +
    "phone: a menu there to talk to Jarvis or read their latest alerts. Use it when they ask to open, " +
    "start or show Jarvis on their glasses ('open Jarvis', 'buka Jarvis' said on the glasses). Say in a " +
    "few words whether it was sent.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  async run(_args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "Not opened: this deployment has no state object.";
    const told = await state.glassesOpen(ctx.env.JARVIS_PERSON ?? OWNER);
    return told
      ? "Sent to the Jarvis app on their phone, which opens Jarvis on the glasses now if it is with them."
      : "Not opened: no Jarvis app of theirs is connected. Opening the Jarvis app on the phone connects it.";
  },
};
