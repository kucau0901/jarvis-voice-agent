import type { Env } from "../types.ts";
import type { Tool, ToolContext } from "./registry.ts";
import { stateStub } from "../lib/state-client.ts";
import { allows } from "../lib/scopes.ts";
import { entityState, haConfig } from "../lib/ha.ts";
import { pickCar } from "./tessie.ts";
import { TOGETHER } from "../lib/panel-view.ts";
import { areasOf, arrange, lightIds } from "../lib/panel-arrange.ts";
import { tileSpec } from "../lib/panel-tiles.ts";
import { idsOf, type PanelItem } from "../lib/panels.ts";

/**
 * Panels on this person's Home tab (lib/panels.ts), made and changed by
 * asking: "put the gate, the front door and the porch light on a panel",
 * "add my car to Home Controls", "a to-do panel with renew the road tax".
 *
 * What a panel can hold follows what Jarvis reaches for this person: the
 * house needs Home Assistant and `home`, a car Tessie and `car.read`; their
 * usage and notes need nothing more. Under `screen`, which a guest does not
 * have, so a guest is never offered them.
 *
 * Whatever the words, the panel is laid out as Hark lays one out — a room's
 * lights as one row, the way in first — by lib/panel-arrange.ts, here, on
 * every change: so the model names the things and Jarvis arranges them.
 */

const person = (env: Env) => env.JARVIS_PERSON || "owner";
const ENTITY = /^[a-z_]+\.[a-z0-9_]+$/;
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A tile wired to the asker's own tools: the tools must be ones they were
 * offered for this question (so ones they may use, MCP servers' included),
 * never the panel tools themselves; arguments come as JSON text.
 */
function tileFor(label: string, read: unknown, buttons: unknown, ctx: ToolContext): PanelItem | string {
  if (!label) return "a tile needs its name, in label.";
  const offered = new Set((ctx.offered ?? []).filter((n) => !n.startsWith("panel_")));
  const call = (tool: unknown, args: unknown): { tool: string; args: unknown } | string => {
    if (typeof tool !== "string" || !offered.has(tool)) return `"${String(tool)}" is not one of the tools you can use.`;
    if (typeof args !== "string" || !args.trim()) return { tool, args: {} };
    try {
      return { tool, args: JSON.parse(args) };
    } catch {
      return `the arguments for ${tool} are not JSON.`;
    }
  };
  const r = (read ?? null) as { tool?: unknown; args?: unknown } | null;
  const readCall = r ? call(r.tool, r.args) : undefined;
  if (typeof readCall === "string") return readCall;
  const wired = [];
  for (const b of Array.isArray(buttons) ? buttons : []) {
    const { label: words, tool, args, ask } = (b ?? {}) as { label?: unknown; tool?: unknown; args?: unknown; ask?: unknown };
    const c = tool === null || tool === undefined ? undefined : call(tool, args);
    if (typeof c === "string") return c;
    wired.push({ label: words, ...(c ? { tool: c } : {}), ask });
  }
  const spec = tileSpec({ ...(readCall ? { read: readCall } : {}), buttons: wired });
  if (typeof spec === "string") return spec;
  const ref = JSON.stringify(spec);
  return ref.length > 2000 ? "that tile is too big: fewer buttons, or shorter arguments." : { kind: "tile", ref, label };
}

/** One thing for a panel, checked against what this person reaches; a string says why not. */
async function itemFor(raw: unknown, ctx: ToolContext): Promise<PanelItem | string> {
  const { kind, ref, label, read, buttons } = (raw ?? {}) as { kind?: unknown; ref?: unknown; label?: unknown; read?: unknown; buttons?: unknown };
  const given = typeof label === "string" ? label.trim() : "";
  if (kind === "tile") return tileFor(given, read, buttons, ctx);
  if (kind === "note") return given ? { kind, ref: "", label: given } : "a note needs its text, in label.";
  if (kind === "usage") return { kind, ref: "usage", label: given || "What you have used" };
  if (kind === "home") {
    if (!allows(ctx.grants, "home")) return "the house is not this person's to reach.";
    const ha = haConfig(ctx.env);
    if (!ha) return "the house is not connected to Jarvis.";
    const ids = [...new Set((typeof ref === "string" ? ref : "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean))];
    const bad = ids.length ? ids.find((id) => !ENTITY.test(id)) : String(ref);
    if (bad !== undefined) return `"${bad}" is not an entity id: find it with the house tools first.`;
    if (ids.length > 1) {
      const odd = ids.find((id) => !TOGETHER.has(id.split(".")[0]!));
      if (odd) return `${odd} cannot be switched with others: only lights and switches share a row.`;
      if (!given) return "things sharing a row need its name, in label, e.g. 'Master bedroom lights'.";
    }
    let name = "";
    for (const id of ids) {
      let now;
      try {
        now = await entityState(ha, id);
      } catch (e) {
        return `the house could not be asked (${why(e)}).`;
      }
      if (!now) return `there is no ${id} in the house.`;
      name = typeof now.attributes.friendly_name === "string" ? now.attributes.friendly_name : id;
    }
    return { kind, ref: ids.join(","), label: given || name };
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
    "(find them with the house tools first, all in one go; never guess one). Jarvis lays the panel out " +
    "itself, as the user would want: three or more lights of one room become one row (\"Master Bedroom " +
    "lights · 1 of 8 on\", with All off), and the way in comes first, then lights, the climate, readings, " +
    "the car, usage and notes. So list each thing; a room's group (group.… or a light group) is used as " +
    "it is. Up to 20 rows a panel; for more, make a second panel. car — one of their cars, by name, or null " +
    "for their usual one; usage — what they have used and spent; note — a line of text such as a " +
    "to-do, the text itself in label; tile — anything else you can read or do with your other tools (music, " +
    "the car's other controls, calendar, mail, cameras, routines, jobs, Hermes, connected services), named in " +
    "label: read is one of your tools whose answer the tile shows, run each time the panel is shown (e.g. " +
    "music_state with {}), or null; buttons, up to 6, each run one of your tools with fixed arguments (tool, " +
    "and args as a JSON object, e.g. music_control with {\"action\":\"pause\"}) or, only when no tool call " +
    "can do it, ask Jarvis a sentence (ask). Use a tile for whatever is not in Home Assistant. " +
    "Panels are the asker's own: nobody else sees them.",
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
            kind: { type: "string", enum: ["home", "car", "usage", "note", "tile"] },
            ref: {
              type: ["string", "null"],
              description:
                "home: the entity id, e.g. cover.main_gate, or a room's lights and switches as one row: their ids separated by commas. " +
                "car: the car's name, or null for their usual car. usage and note: null.",
            },
            label: {
              type: ["string", "null"],
              description: "Its name on the panel, or null for the house's or the car's own name. A room's lights together need one. For a note, the note itself.",
            },
            read: {
              type: ["object", "null"],
              description: "tile only: the tool whose answer is the tile's reading. Null otherwise.",
              properties: {
                tool: { type: "string", description: "One of your tools, by name." },
                args: { type: "string", description: "Its arguments, a JSON object as text, e.g. {}." },
              },
              required: ["tool", "args"],
              additionalProperties: false,
            },
            buttons: {
              type: ["array", "null"],
              description: "tile only: up to 6 buttons. Null otherwise.",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "The button's words, e.g. 'Pause'." },
                  tool: { type: ["string", "null"], description: "One of your tools, by name; null when the button asks." },
                  args: { type: ["string", "null"], description: "That tool's arguments, a JSON object as text; null when the button asks." },
                  ask: { type: ["string", "null"], description: "A sentence to ask Jarvis, only when no tool call can do it; null otherwise." },
                },
                required: ["label", "tool", "args", "ask"],
                additionalProperties: false,
              },
            },
          },
          required: ["kind", "ref", "label", "read", "buttons"],
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
    const title = String(args.title ?? "");
    // Laid out as a whole, so what is added finds its room among what was there.
    const old =
      args.mode === "replace" ? undefined : (await state.panelsOf(me)).find((p) => p.title.trim().toLowerCase() === title.trim().toLowerCase());
    const given = [...(old?.items ?? []), ...items];
    const ha = haConfig(ctx.env);
    const lights = lightIds(given);
    const areas = ha && lights.length >= 2 ? await areasOf(ha, lights) : new Map<string, string>();
    const out = await state.panelSet(me, old?.title ?? title, arrange(given, areas), "replace");
    if (typeof out === "string") return `Nothing was changed: ${out}`;
    const all = await state.panelsOf(me);
    const shown = out.items.map((i) => (idsOf(i).length > 1 ? `${i.label} (${idsOf(i).length} lights in one row)` : i.label));
    return `Done: "${out.title}" on their Home tab shows ${shown.join(", ") || "nothing yet"}. Their panels: ${all.map((p) => p.title).join(", ")}.`;
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
