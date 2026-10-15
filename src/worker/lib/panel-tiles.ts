import type { PanelIcon } from "../../shared/panels.ts";
import { shortKey, type Reading } from "./panels.ts";

/**
 * A tile for anything else Jarvis can read or do — the music, the car, the
 * calendar, cameras, routines, Hermes, an MCP server's tools — beside the
 * house's own things, which lib/panel-view.ts reads directly.
 *
 * Its reading is one of the person's own tools run with fixed arguments
 * (music_state, calendar_check) or, for what no tool of theirs can read —
 * the air quality in a town, a price, the news — a question Jarvis answers
 * with the model and web search, as Hark does. That answer is kept and asked
 * again only while someone has Home open and it is older than the tile's
 * interval, never more than hourly (the owner's choice: nothing is spent
 * while nobody looks). Its buttons are tool calls too
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

/** A reading looked up by asking Jarvis, at most every `every` minutes. */
export interface TileAsk {
  ask: string;
  every: number;
}

export interface TileSpec {
  read?: TileCall | TileAsk;
  buttons: TileButton[];
}

export const MAX_BUTTONS = 6;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LABEL = 40;
const MAX_ASK = 300;
/** An asked reading is looked up at most hourly, and at least daily when looked at. */
const EVERY_MIN = 60;
const EVERY_MAX = 24 * 60;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const callOf = (v: unknown): TileCall | null =>
  isObject(v) && typeof v.tool === "string" && TOOL_NAME.test(v.tool) && isObject(v.args) ? { tool: v.tool, args: v.args } : null;
const askOf = (v: unknown): TileAsk | null =>
  isObject(v) && typeof v.ask === "string" && v.ask.trim()
    ? { ask: v.ask.trim().slice(0, MAX_ASK), every: Math.min(EVERY_MAX, Math.max(EVERY_MIN, Math.round(Number(v.every) || EVERY_MIN))) }
    : null;
export const isAsk = (r: TileCall | TileAsk): r is TileAsk => "ask" in r;

/** A tile as stored (its item's ref), checked; null if it is not one, or a string saying what is wrong. */
export function tileSpec(v: unknown): TileSpec | string {
  if (!isObject(v)) return "a tile needs a reading or buttons.";
  const read = v.read === undefined || v.read === null ? undefined : (callOf(v.read) ?? askOf(v.read));
  if (read === null) return "its reading must be one of your tools with its arguments, or a question to ask.";
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
export const tileKey = (ref: string): string => shortKey("t_", ref);

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
  const read = spec.read && !isAsk(spec.read) ? spec.read.tool : undefined;
  const names = [read, ...spec.buttons.map((b) => b.tool?.tool)].filter((n): n is string => !!n);
  for (const n of names) for (const [re, icon] of BY_TOOL) if (re.test(n)) return icon;
  return spec.read && isAsk(spec.read) ? "web" : names.length ? "dot" : "chat";
}

/** Where a tile's tools run and its sentences are asked; the route gives the real ones, the tests fakes. */
export interface TileSources {
  /** One of this person's tools, run as asked; null when they may not use it here. */
  tool: (name: string, args: Record<string, unknown>) => Promise<{ text: string; image?: string } | null>;
  /** A sentence asked of Jarvis, as typed in Chat: its answer. */
  ask: (text: string) => Promise<string>;
  /** An asked reading as kept (lib/panels.ts), by the tile's key. */
  kept: (tile: string) => Promise<Reading | null>;
  /** It again, and whether this caller should ask now: stale, and nobody else asking. */
  claim: (tile: string, everyMs: number) => Promise<{ reading: Reading | null; go: boolean }>;
  /** What was looked up, or null when the asking failed. */
  keep: (tile: string, reading: Reading | null) => Promise<void>;
}

/** How an asked reading is to be answered, so it fits a tile and can be read back. */
const FOR_A_TILE =
  "This is for a tile on the user's Home screen, refreshed now and then. Answer with one short line first " +
  '(the verdict, e.g. "Unhealthy: sensitive groups should limit outdoor activity"), then at most three ' +
  'figures, each on its own line as "Label: value" (e.g. "API: 175", "As of: 3:00 PM"). Nothing else, no markdown.';

/** An answer as a tile shows it: its first line, and the "Label: value" lines after it. */
export function readingOf(answer: string, at: number): Reading {
  const lines = answer
    .split("\n")
    .map((l) => l.replace(/^[\s>*\-•]+/, "").replace(/\*\*/g, "").trim())
    .filter(Boolean);
  const figures: Reading["figures"] = [];
  for (const l of lines.slice(1)) {
    const m = /^([^:]{1,24}):\s*(.{1,40})$/.exec(l);
    if (m && figures.length < 3) figures.push({ label: m[1]!.trim(), value: m[2]!.trim() });
  }
  return { text: clip(lines[0] ?? "", 200), figures, at };
}

type Shown = { status: number; text: string; image?: string; figures?: Reading["figures"]; at?: number; stale?: boolean; pending?: boolean };
const shownOf = (r: Reading | null): Omit<Shown, "status"> => (r ? { text: r.text, figures: r.figures, at: r.at } : { text: "" });

/**
 * An asked reading: `cached` answers at once with what was kept, saying
 * whether it is stale; otherwise it is looked up if it is stale and nobody
 * else is already asking (`pending` when they are).
 */
async function readAsked(read: TileAsk, key: string, cached: boolean, src: TileSources): Promise<Shown> {
  const every = read.every * 60_000;
  if (cached) {
    const r = await src.kept(key);
    return { status: 200, ...shownOf(r), stale: !r || Date.now() - r.at >= every };
  }
  const { reading, go } = await src.claim(key, every);
  if (!go) return { status: 200, ...shownOf(reading), pending: !reading || Date.now() - reading.at >= every };
  let answer: string;
  try {
    answer = await src.ask(`${read.ask}\n\n${FOR_A_TILE}`);
  } catch (e) {
    await src.keep(key, null);
    return reading ? { status: 200, ...shownOf(reading) } : { status: 502, text: `Could not look it up just now: ${why(e)}` };
  }
  const fresh = readingOf(answer, Date.now());
  if (!fresh.text) {
    await src.keep(key, null);
    return reading ? { status: 200, ...shownOf(reading) } : { status: 502, text: "Jarvis found nothing to show." };
  }
  await src.keep(key, fresh);
  return { status: 200, ...shownOf(fresh) };
}

/** A tool's or Jarvis's words, for a tile: one paragraph, not too long. */
const clip = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A tile's reading: its tool run now, or its question's kept answer, looked up again when stale. */
export async function readTile(spec: TileSpec, src: TileSources, key: string, cached = false): Promise<Shown> {
  if (!spec.read) return { status: 404, text: "This tile has no reading." };
  if (isAsk(spec.read)) return readAsked(spec.read, key, cached, src);
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
