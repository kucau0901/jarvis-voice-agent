import type { Tool } from "./registry.ts";
import { stateStub } from "../lib/state-client.ts";
import { callService, haConfig } from "../lib/ha.ts";
import { ALONE, checkTemplate, parseThings, weighAct } from "../lib/house.ts";
import { renderTemplate } from "../lib/ha.ts";
import { refuseIfForbidden } from "./mcp.ts";

/**
 * What Jarvis watches in the house (lib/house.ts). Code chooses by kind:
 * doors, locks, lights, presence, leaks and the rest. This changes that for
 * one thing: watch it as well, leave it out, or let its kind decide again.
 */
export const houseWatch: Tool = {
  name: "house_watch",
  scope: "home",
  pace: "fast",
  available: (env) => !!haConfig(env),
  description:
    "Change what Jarvis watches in the house: 'don't watch the garden lights', 'also keep an eye on the freezer " +
    "temperature', 'watch the study light again'. Jarvis watches locks, the alarm, people, doors, windows, leaks, " +
    "smoke, covers, lights, climate, outlets, motion and batteries running low by itself, but no temperature unless " +
    "added; this adds one thing, leaves one out, or puts one back to that. Find the entity id with the house tools first, never guess it.",
  parameters: {
    type: "object",
    properties: {
      entity: { type: "string", description: "The entity id, e.g. light.garden or sensor.freezer_temperature." },
      choice: { type: "string", enum: ["watch", "ignore", "default"], description: "watch: as well; ignore: leave it out; default: as its kind decides." },
    },
    required: ["entity", "choice"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "The house cannot be watched on this deployment: it has no state object.";
    const entity = String(args.entity ?? "").trim().toLowerCase();
    const choice = args.choice === "watch" || args.choice === "ignore" ? args.choice : "default";
    const p = await state.houseWatchSet(entity, choice);
    if (typeof p === "string") return `Not changed: ${p}.`;
    return choice === "watch" ? `Watching ${entity} as well.` : choice === "ignore" ? `No longer watching ${entity}.` : `${entity} is watched as its kind decides.`;
  },
};

/** One thing done in the house, as a card puts it: for an approval only (lib/approval.ts). Null when it is not one. */
function houseArgs(args: Record<string, unknown>): { service: string; entity: string; name: string; when: "away" | "empty" | "ask" } | null {
  const service = typeof args.service === "string" ? args.service : "";
  const entity = typeof args.entity_id === "string" ? args.entity_id : "";
  const name = typeof args.name === "string" ? args.name.slice(0, 60) : "";
  const when = args.when === "away" || args.when === "empty" ? args.when : "ask";
  if (!/^[a-z_]+\.[a-z_]+$/.test(service) || !/^[a-z_]+\.[a-z0-9_]+$/.test(entity) || service.split(".")[0] !== entity.split(".")[0] || !name) return null;
  // What Jarvis never does from anywhere (tools/mcp.ts): never as a card either.
  if (refuseIfForbidden("house__ha_call_service", { domain: service.split(".")[0], service: service.split(".")[1] })) return null;
  return { service, entity, name, when };
}

/**
 * A thing in the house done when its card is approved, or at once when the household allows that kind
 * (lib/proposals.ts standing permissions): put by the house's judgment (lib/house.ts), never offered to the router
 * or a job. Only switching off a light, switch, fan or media player, with evidence ("nobody is home", "its room is
 * empty"), is a kind that can be allowed; anything else (a gate, a door, a lock, a cover) is always a question.
 */
/** How long a switched-off thing is given before it is read again. */
export const AFTER_MS = 1500;

export const houseDo: Tool = {
  name: "house_do",
  scope: "home",
  pace: "fast",
  available: (env) => !!haConfig(env),
  description: "Do one thing in the house: for an approval only.",
  parameters: {
    type: "object",
    properties: { service: { type: "string" }, entity_id: { type: "string" }, name: { type: "string" }, when: { type: "string" } },
    required: ["service", "entity_id", "name", "when"],
    additionalProperties: false,
  },
  propose(args) {
    const h = houseArgs(args);
    if (!h) return null;
    const verb = h.service.split(".")[1]!.replace(/_/g, " ");
    const alone = ALONE.has(h.service) && h.when !== "ask";
    const what = h.when === "away" ? " (nobody home)" : h.when === "empty" ? " (its room is empty)" : "";
    return {
      risk: alone ? "reversible" : "irreversible",
      // Allowed for this one thing, not for every light: one "yes, always" never reaches another room.
      ...(alone ? { category: `house:${h.service}:${h.entity}@${h.when}` } : {}),
      says: `Home: ${verb} ${h.name}${what}`,
      verb: verb.replace(/^(\w)/, (c) => c.toUpperCase()),
    };
  },
  async run(args, ctx) {
    const h = houseArgs(args);
    if (!h) return "That is not something to do in the house, so nothing was done.";
    const cfg = haConfig(ctx.env);
    if (!cfg) return "Home Assistant is not set up, so nothing was done.";
    const [domain, service] = h.service.split(".") as [string, string];
    // Its evidence again, as it is done: the house may have moved on since the card or the permission. And the same
    // evidence as was allowed or shown: "while nobody is home" never runs on "its room is empty".
    let evidence = "";
    if (h.when !== "ask") {
      const w = weighAct({ service: h.service, entity: h.entity, why: "" }, parseThings(await renderTemplate(cfg, checkTemplate(h.entity))), Date.now());
      if (!w.ok) return `Not done: ${w.why}.`;
      if (!w.alone) return "Not done: it is no longer something done without asking.";
      if (w.when !== h.when) return `Not done: it was ${h.when === "away" ? "for while nobody is home" : "for while its room is empty"}, and that no longer holds.`;
      evidence = w.evidence;
    }
    await callService(cfg, domain, service, h.entity);
    // Switched off, it is read again: Home Assistant accepts a call for a device that has stopped answering.
    if (h.when !== "ask") {
      await new Promise((r) => setTimeout(r, AFTER_MS));
      const now = (await renderTemplate(cfg, `{{ states(${JSON.stringify(h.entity).replace(/"/g, "'")}) }}`).catch(() => "")).trim();
      if (now !== "off") return `Not done: Home Assistant was asked, but ${h.name} still reads ${now || "nothing"}.`;
    }
    ctx.done?.();
    return h.when === "ask" ? `Done: ${service.replace(/_/g, " ")} ${h.name}.` : `Done: ${evidence}, read just now`;
  },
};
