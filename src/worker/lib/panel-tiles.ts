import type { PanelIcon } from "../../shared/panels.ts";

/**
 * A tile for anything else Jarvis can read or do — the music, the car, the
 * calendar, cameras, routines, Hermes, an MCP server's tools — beside the
 * house's own things, which lib/panel-view.ts reads directly.
 *
 * Its reading is one of the person's own tools run with fixed arguments
 * (music_state, calendar_check); its buttons are tool calls too
 * (music_control {"action": "pause"}), or, where no tool call can do it, a
 * sentence asked of Jarvis as if typed in Chat — one model call a press. The
 * model wires a tile up once, when asked for it (tools/panels.ts); after
 * that a press runs the tool itself, with no model. A tool runs only if the
 * person pressing may use it now: the same tools, filtered by the same
 * grants, as when they ask, so a tile can do nothing its person could not
 * ask for (and Hermes stays unreachable without `hermes`).
 */

export interface TileCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface TileButton {
  label: string;
  tool?: TileCall;
  ask?: string;
}

export interface TileSpec {
  read?: TileCall;
  buttons: TileButton[];
}

export const MAX_BUTTONS = 6;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LABEL = 40;
const MAX_ASK = 300;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const callOf = (v: unknown): TileCall | null =>
  isObject(v) && typeof v.tool === "string" && TOOL_NAME.test(v.tool) && isObject(v.args) ? { tool: v.tool, args: v.args } : null;

/** A tile as stored (its item's ref), checked; null if it is not one, or a string saying what is wrong. */
export function tileSpec(v: unknown): TileSpec | string {
  if (!isObject(v)) return "a tile needs a reading or buttons.";
  const read = v.read === undefined || v.read === null ? undefined : callOf(v.read);
  if (read === null) return "its reading must be one of your tools, with its arguments.";
  const raw = Array.isArray(v.buttons) ? v.buttons : [];
  if (raw.length > MAX_BUTTONS) return `a tile has at most ${MAX_BUTTONS} buttons.`;
  const buttons: TileButton[] = [];
  for (const b of raw) {
    if (!isObject(b) || typeof b.label !== "string" || !b.label.trim()) return "each button needs its words, in label.";
    const label = b.label.trim().slice(0, MAX_LABEL);
    const tool = b.tool === undefined || b.tool === null ? undefined : callOf(b.tool);
    const ask = typeof b.ask === "string" && b.ask.trim() ? b.ask.trim().slice(0, MAX_ASK) : undefined;
    if (tool === null || !!tool === !!ask) return `"${label}" must either run one of your tools or ask Jarvis a sentence.`;
    buttons.push({ label, ...(tool ? { tool } : { ask }) });
  }
  if (!read && !buttons.length) return "a tile needs a reading or buttons.";
  return { ...(read ? { read } : {}), buttons };
}

/** A stored tile read back; null when it no longer reads as one. */
export function parseTile(ref: string): TileSpec | null {
  try {
    const spec = tileSpec(JSON.parse(ref));
    return typeof spec === "string" ? null : spec;
  } catch {
    return null;
  }
}

/** A tile's key on its panel, short and stable: its ref is too long to send with every press. */
export function tileKey(ref: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < ref.length; i++) h = Math.imul(h ^ ref.charCodeAt(i), 0x01000193);
  return `t_${(h >>> 0).toString(36)}`;
}

/** What a tile is drawn with, by the tools it uses. */
const BY_TOOL: [RegExp, PanelIcon][] = [
  [/^music_/, "music"],
  [/^car_/, "car"],
  [/^calendar_/, "calendar"],
  [/^(mail_|contacts_)/, "mail"],
  [/camera/, "camera"],
  [/^routine_/, "clock"],
  [/^(ask_hermes|control_home)$/, "terminal"],
  [/^(directions|place_info|show_place)$/, "route"],
];

export function tileIcon(spec: TileSpec): PanelIcon {
  const names = [spec.read?.tool, ...spec.buttons.map((b) => b.tool?.tool)].filter((n): n is string => !!n);
  for (const n of names) for (const [re, icon] of BY_TOOL) if (re.test(n)) return icon;
  return names.length ? "dot" : "chat";
}

/** Where a tile's tools run and its sentences are asked; the route gives the real ones, the tests fakes. */
export interface TileSources {
  /** One of this person's tools, run as asked; null when they may not use it here. */
  tool: (name: string, args: Record<string, unknown>) => Promise<{ text: string; image?: string } | null>;
  /** A sentence asked of Jarvis, as typed in Chat: its answer. */
  ask: (text: string) => Promise<string>;
}

/** A tool's or Jarvis's words, for a tile: one paragraph, not too long. */
const clip = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A tile's reading, now. */
export async function readTile(spec: TileSpec, src: TileSources): Promise<{ status: number; text: string; image?: string }> {
  if (!spec.read) return { status: 404, text: "This tile has no reading." };
  try {
    const out = await src.tool(spec.read.tool, spec.read.args);
    if (!out) return { status: 403, text: `${spec.read.tool} is not yours to use here.` };
    return { status: 200, text: clip(out.text, 600), ...(out.image ? { image: out.image } : {}) };
  } catch (e) {
    return { status: 502, text: `Could not read it just now: ${why(e)}` };
  }
}

/** A tile's button pressed ("b0", "b1"…): its tool, or its sentence asked of Jarvis. */
export async function pressTile(label: string, spec: TileSpec, action: string, src: TileSources): Promise<{ status: number; text: string }> {
  const n = /^b(\d)$/.exec(action);
  const b = n ? spec.buttons[Number(n[1])] : undefined;
  if (!b) return { status: 404, text: "That is not on this tile." };
  try {
    if (b.ask) return { status: 200, text: clip(await src.ask(b.ask), 600) };
    const out = await src.tool(b.tool!.tool, b.tool!.args);
    if (!out) return { status: 403, text: `${b.tool!.tool} is not yours to use here.` };
    return { status: 200, text: clip(out.text, 600) || `${label}: ${b.label}.` };
  } catch (e) {
    return { status: 502, text: `${b.label} did not work: ${why(e)}` };
  }
}
