import type { Env } from "../types.ts";
import type { Tool, ToolContext } from "./registry.ts";
import { stateStub } from "../lib/state-client.ts";
import { allows } from "../lib/scopes.ts";
import { entityState, haConfig } from "../lib/ha.ts";
import { pickCar } from "./tessie.ts";
import type { PanelItem } from "../lib/panels.ts";

/**
 * Panels on this person's Home tab (lib/panels.ts), made and changed by
 * asking: "put the gate, the front door and the porch light on a panel",
 * "add my car to Home Controls", "a to-do panel with renew the road tax".
 *
 * What a panel can hold follows what Jarvis reaches for this person: the
 * house needs Home Assistant and `home`, a car Tessie and `car.read`; their
 * usage and notes need nothing more. Under `screen`, which a guest does not
 * have, so a guest is never offered them.
 */

const person = (env: Env) => env.JARVIS_PERSON || "owner";
const ENTITY = /^[a-z_]+\.[a-z0-9_]+$/;
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One thing for a panel, checked against what this person reaches; a string says why not. */
async function itemFor(raw: unknown, ctx: ToolContext): Promise<PanelItem | string> {
  const { kind, ref, label } = (raw ?? {}) as { kind?: unknown; ref?: unknown; label?: unknown };
  const given = typeof label === "string" ? label.trim() : "";
  if (kind === "note") return given ? { kind, ref: "", label: given } : "a note needs its text, in label.";
  if (kind === "usage") return { kind, ref: "usage", label: given || "What you have used" };
  if (kind === "home") {
    if (!allows(ctx.grants, "home")) return "the house is not this person's to reach.";
    const ha = haConfig(ctx.env);
    if (!ha) return "the house is not connected to Jarvis.";
    const id = typeof ref === "string" ? ref.trim().toLowerCase() : "";
    if (!ENTITY.test(id)) return `"${String(ref)}" is not an entity id: find it with the house tools first.`;
    let now;
    try {
      now = await entityState(ha, id);
    } catch (e) {
      return `the house could not be asked (${why(e)}).`;
    }
    if (!now) return `there is no ${id} in the house.`;
    const name = typeof now.attributes.friendly_name === "string" ? now.attributes.friendly_name : id;
    return { kind, ref: id, label: given || name };
  }
  if (kind === "car") {
    if (!allows(ctx.grants, "car.read")) return "cars are not this person's to check.";
    const picked = pickCar(ctx.env, ref);
    if (typeof picked === "string") return picked;
    return { kind, ref: picked.car?.id ?? "family", label: given || picked.car?.name || "The car" };
  }
  return `a panel cannot hold "${String(kind)}".`;
}

export const panelSet: Tool = {
  name: "panel_set",
  scope: "screen",
  pace: "fast",
  description:
    "Make or change a panel on the user's Home tab in this app, when they ask to put something on a " +
    "panel, add to one or make one. A panel shows each thing live, with buttons that follow its state " +
    "(a closed gate shows Open). It can hold: home — something in Home Assistant, by its entity id " +
    "(find it with the house tools first; never guess one); car — one of their cars, by name, or null " +
    "for their usual one; usage — what they have used and spent; note — a line of text such as a " +
    "to-do, the text itself in label. Panels are the asker's own: nobody else sees them.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "The panel's name, e.g. 'Home Controls'. A panel of that name is changed; otherwise one is made.",
      },
      mode: {
        type: "string",
        enum: ["add", "replace"],
        description: "add: put these after what the panel has. replace: these become all it holds.",
      },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["home", "car", "usage", "note"] },
            ref: {
              type: ["string", "null"],
              description: "home: the entity id, e.g. cover.main_gate. car: the car's name, or null for their usual car. usage and note: null.",
            },
            label: {
              type: ["string", "null"],
              description: "Its name on the panel, or null for the house's or the car's own name. For a note, the note itself.",
            },
          },
          required: ["kind", "ref", "label"],
          additionalProperties: false,
        },
      },
    },
    required: ["title", "mode", "items"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "Panels need this deployment's state object.";
    const items: PanelItem[] = [];
    for (const raw of Array.isArray(args.items) ? args.items : []) {
      const it = await itemFor(raw, ctx);
      if (typeof it === "string") return `Nothing was changed: ${it}`;
      items.push(it);
    }
    const me = person(ctx.env);
    const out = await state.panelSet(me, String(args.title ?? ""), items, args.mode === "replace" ? "replace" : "add");
    if (typeof out === "string") return `Nothing was changed: ${out}`;
    const all = await state.panelsOf(me);
    return (
      `Done: "${out.title}" on their Home tab shows ${out.items.map((i) => i.label).join(", ") || "nothing yet"}. ` +
      `Their panels: ${all.map((p) => p.title).join(", ")}.`
    );
  },
};

export const panelRemove: Tool = {
  name: "panel_remove",
  scope: "screen",
  pace: "fast",
  description:
    "Take a panel off the user's Home tab, or one thing off a panel: 'remove my usage panel', " +
    "'take the porch light off Home Controls', 'done with renew the road tax'.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "The panel's name." },
      item: {
        type: ["string", "null"],
        description: "The thing to take off it, by its name or entity id. Null removes the whole panel.",
      },
    },
    required: ["title", "item"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "Panels need this deployment's state object.";
    const item = typeof args.item === "string" && args.item.trim() ? args.item.trim() : null;
    const left = await state.panelRemove(person(ctx.env), String(args.title ?? ""), item);
    if (typeof left === "string") return `Nothing was removed: ${left}`;
    return `Done. Their panels: ${left.map((p) => p.title).join(", ") || "none"}.`;
  },
};

export const panelTools: Tool[] = [panelSet, panelRemove];
