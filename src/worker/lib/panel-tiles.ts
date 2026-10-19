import type { ButtonInput, PanelIcon } from "../../shared/panels.ts";
import type { Reading } from "./panels.ts";

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

/**
 * A button that takes a value first: a slider's number or typed words, put
 * into the tool's argument `arg` (the music's volume, a note's text) or, for
 * a button that asks, into its sentence where it says {} (else after it).
 */
export type TileInput = ButtonInput & { arg: string };

export interface TileButton {
  label: string;
  tool?: TileCall;
  ask?: string;
  input?: TileInput;
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
const ARG = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
/** Words typed into a tile, at most. */
const MAX_TYPED = 500;
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

/** A button's input, checked; null when it has none, a string when it is not one. */
function inputOf(v: unknown): TileInput | null | string {
  if (v === undefined || v === null) return null;
  if (!isObject(v) || typeof v.arg !== "string" || !ARG.test(v.arg)) return "a button's input needs the argument it fills, in arg.";
  if (v.kind === "text") return { kind: "text", arg: v.arg, hint: typeof v.hint === "string" ? v.hint.slice(0, 40) : "" };
  const min = Number(v.min ?? 0);
  const max = Number(v.max ?? 100);
  const step = Number(v.step ?? 1);
  if (v.kind !== "slider" || !Number.isFinite(min) || !Number.isFinite(max) || max <= min || !(step > 0)) return "a slider needs its range, min below max.";
  return { kind: "slider", arg: v.arg, min, max, step };
}

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
    const input = inputOf(b.input);
    if (typeof input === "string") return input;
    buttons.push({ label, ...(tool ? { tool } : { ask }), ...(input ? { input } : {}) });
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
  /** A sentence asked of Jarvis, as typed in Chat: its answer. For a button pressed. */
  ask: (text: string) => Promise<string>;
  /**
   * A reading looked up by Jarvis, with its reading tools only (lib/jobs.ts
   * jobTool): it is asked with nobody pressing anything, whenever Home is
   * open, so it may read but never act, nor hand anything to Hermes.
   */
  look: (text: string) => Promise<string>;
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
  'figures, each on its own line as "Label: value" (e.g. "API: 175", "As of: 3:00 PM"). Where they help, ' +
  'add: up to eight lines starting with "- " (a forecast\'s days, the headlines); one line ' +
  '"Chart: <title>: <x>=<number>; <x>=<number>; …" with up to 24 points (a trend, e.g. ' +
  '"Chart: API today: 08:00=120; 12:00=160; 15:00=175"); one line "Map: <latitude>, <longitude>" for a ' +
  "place that matters. Last, one line \"Source: <url>\" with the https address of the page the reading " +
  "came from. Nothing else, no markdown.";

/** "Chart: API today: 08:00=120; 12:00=160" as its title and points; null if it is not one. */
function chartOf(line: string): Reading["chart"] | null {
  const m = /^chart\s*:\s*(.*?)\s*:\s*(.+)$/i.exec(line);
  if (!m) return null;
  const points = m[2]!
    .split(/;|,(?=\s*[^=;]+=)/)
    .map((p) => /^\s*(.{1,16}?)\s*=\s*(-?[\d.]+)/.exec(p))
    .filter((p): p is RegExpExecArray => !!p)
    .map((p) => ({ x: p[1]!, y: Number(p[2]) }))
    .filter((p) => Number.isFinite(p.y))
    .slice(0, 24);
  return points.length >= 2 ? { title: clip(m[1]!, 40), points } : null;
}

/** "Map: 2.19, 102.25" as a point on the map; null if it is not one. */
function mapOf(line: string): Reading["map"] | null {
  const m = /^map\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i.exec(line);
  const lat = Number(m?.[1]);
  const lng = Number(m?.[2]);
  return m && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

/**
 * An answer as a tile shows it: its first line; then "Label: value" lines
 * as figures (three at most), a "Chart:" line as a trend, a "Map:" line as
 * a place, and the rest — lines that start "- ", as it is asked to give
 * them — as a short list, even where one reads "Thu: 160".
 */
export function readingOf(answer: string, at: number): Reading {
  const raw = answer.split("\n").map((l) => l.replace(/\*\*/g, "").trim()).filter(Boolean);
  const bullet = new Set(raw.map((l, i) => (/^[-*•]\s/.test(l) ? i : -1)).filter((i) => i > 0));
  const lines = raw.map((l) => l.replace(/^[\s>*\-•]+/, "").trim());
  const figures: Reading["figures"] = [];
  const list: string[] = [];
  let chart: Reading["chart"] | null = null;
  let map: Reading["map"] | null = null;
  let source: string | undefined;
  for (const [i, l] of lines.entries()) {
    if (i === 0 || !l) continue;
    if (bullet.has(i)) {
      if (list.length < 8) list.push(clip(l, 140));
      continue;
    }
    const c: Reading["chart"] | null = chart ? null : chartOf(l);
    if (c) {
      chart = c;
      continue;
    }
    const from = /^source\s*:\s*(https:\/\/[^\s)>\]"']+)/i.exec(l);
    if (from) {
      source ??= from[1]!.replace(/[.,;:!?]+$/, "");
      continue;
    }
    const where: Reading["map"] | null = map ? null : mapOf(l);
    if (where) {
      map = where;
      continue;
    }
    const m = /^([^:]{1,24}):\s*(.{1,40})$/.exec(l);
    if (m && figures.length < 3) figures.push({ label: m[1]!.trim(), value: m[2]!.trim() });
    else if (list.length < 8) list.push(clip(l, 140));
  }
  return {
    text: clip(lines[0] ?? "", 200), figures, at,
    ...(list.length ? { list } : {}), ...(chart ? { chart } : {}), ...(map ? { map } : {}), ...(source ? { source } : {}),
  };
}

type Shown = Partial<Omit<Reading, "text">> & { status: number; text: string; image?: string; stale?: boolean; pending?: boolean };
const shownOf = (r: Reading | null): Omit<Shown, "status"> => r ?? { text: "" };

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
    answer = await src.look(`${read.ask}\n\n${FOR_A_TILE}`);
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
    // A tool that answers in lines (today's events) keeps them, as a list under its first.
    const lines = out.text.split("\n").map((l) => l.replace(/^[\s>*\-•]+/, "").trim()).filter(Boolean);
    const list = lines.slice(1, 9).map((l) => clip(l, 140));
    return { status: 200, text: clip(lines[0] ?? "", 300), ...(list.length ? { list } : {}), ...(out.image ? { image: out.image } : {}) };
  } catch (e) {
    return { status: 502, text: `Could not read it just now: ${why(e)}` };
  }
}

/** A slider's number or typed words, as the button takes them; a string says why not. */
function valueFor(input: TileInput, value: string | undefined): number | string | { why: string } {
  const v = (value ?? "").trim();
  if (input.kind === "text") return v ? v.slice(0, MAX_TYPED) : { why: "Type something first." };
  const n = Number(v);
  if (!v || !Number.isFinite(n) || n < input.min || n > input.max) return { why: `Pick a number from ${input.min} to ${input.max}.` };
  return Math.round(n / input.step) * input.step;
}

/** A tile's button pressed ("b0", "b1"…): its tool, or its sentence asked of Jarvis, with the value it takes. */
export async function pressTile(label: string, spec: TileSpec, action: string, src: TileSources, value?: string): Promise<{ status: number; text: string }> {
  const n = /^b(\d)$/.exec(action);
  const b = n ? spec.buttons[Number(n[1])] : undefined;
  if (!b) return { status: 404, text: "That is not on this tile." };
  const given = b.input ? valueFor(b.input, value) : undefined;
  if (typeof given === "object") return { status: 400, text: given.why };
  try {
    if (b.ask) {
      const words = given === undefined ? b.ask : b.ask.includes("{}") ? b.ask.replace("{}", String(given)) : `${b.ask} ${given}`;
      return { status: 200, text: clip(await src.ask(words), 600) };
    }
    const args = given === undefined ? b.tool!.args : { ...b.tool!.args, [b.input!.arg]: given };
    const out = await src.tool(b.tool!.tool, args);
    if (!out) return { status: 403, text: `${b.tool!.tool} is not yours to use here.` };
    return { status: 200, text: clip(out.text, 600) || `${label}: ${b.label}.` };
  } catch (e) {
    return { status: 502, text: `${b.label} did not work: ${why(e)}` };
  }
}
