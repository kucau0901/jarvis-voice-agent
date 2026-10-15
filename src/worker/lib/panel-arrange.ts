import { renderTemplate, type HaConfig } from "./ha.ts";
import { houseIcon } from "./panel-view.ts";
import { idsOf, ticked, type PanelItem } from "./panels.ts";

/**
 * How Jarvis lays out a panel, as Hark does, whatever the words it was asked
 * in: a room's lights become one row ("Master Bedroom lights · 1 of 8 on",
 * lib/panel-view.ts), and the things are put in order — the way in first
 * (gates, doors, locks, the alarm), then lights and switches, the climate,
 * readings, the car and other tiles, the usage, notes. Done by the tool on every change
 * (tools/panels.ts), with no model call.
 *
 * A room's row holds its lights and its plain switches, which in a house are
 * mostly lights too ("Master bathroom switch"): the row Hark made for a room
 * was eight, six lights and two switches. Never a plug, a fan or a helper
 * toggle, and never a room of switches with no light among them. A thing's
 * room is its area in Home Assistant; where the house will not say (no area
 * set, or a token that may not render templates), things whose names begin
 * with the same word ("Master …") are taken to be one room.
 */

/** Things of one room from which they share a row; two stay two tiles. */
export const ROOM_ROW = 3;

const WAY_IN = new Set(["gate", "garage", "door", "lock", "unlock", "alarm", "alert"]);
const READING = new Set(["temp", "drop", "bolt", "motion", "sensor", "weather"]);
const LAST: Record<"car" | "usage" | "note" | "tile", number> = { car: 4, tile: 4, usage: 5, note: 6 };

const iconOf = (i: PanelItem) => houseIcon(idsOf(i)[0]!, "", { friendly_name: i.label });

/** A light (a switch named for one counts), or a room's row already: what makes a room worth a row. */
const lit = (i: PanelItem): boolean => i.kind === "home" && (idsOf(i).length > 1 || (!i.ref.startsWith("group.") && iconOf(i) === "light"));

/** What may join a room's row: a light, or a plain switch (not a plug or a fan, never a helper). */
const roomish = (i: PanelItem): boolean => lit(i) || (i.kind === "home" && i.ref.startsWith("switch.") && iconOf(i) === "power");

/** Where a thing goes: the way in, lights and switches, the climate, readings, then the car, the usage and notes. */
function rank(i: PanelItem): number {
  // A to-do ticked off stays below the open ones until it is cleared.
  if (i.kind !== "home") return ticked(i) ? LAST.note + 1 : LAST[i.kind];
  const icon = iconOf(i);
  return WAY_IN.has(icon) ? 0 : icon === "climate" ? 2 : READING.has(icon) ? 3 : 1;
}

/** The lights and switches on a panel, whose rooms are worth asking the house for. */
export const lightIds = (items: PanelItem[]): string[] => [...new Set(items.filter(roomish).flatMap(idsOf))];

/** Each light's area, by one template; empty when the house will not say. */
export async function areasOf(cfg: HaConfig, ids: string[], render: typeof renderTemplate = renderTemplate): Promise<Map<string, string>> {
  // Entity ids are checked (tools/panels.ts), so they sit safely in the template.
  const template = `{% for e in ${JSON.stringify(ids)} %}{{ e }}\t{{ area_name(e) or '' }}\n{% endfor %}`;
  let text: string;
  try {
    text = await render(cfg, template);
  } catch {
    return new Map();
  }
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const [id, area] = line.split("\t").map((s) => s.trim());
    if (id && area) out.set(id, area);
  }
  return out;
}

/** The panel as Jarvis lays it out: a room's lights as one row, then everything in order. */
export function arrange(items: PanelItem[], areas: Map<string, string>): PanelItem[] {
  const rooms = new Map<string, { name: string; ids: string[]; label: string | null; lit: boolean; items: PanelItem[] }>();
  // Each thing in the order given, a room standing where its first light was.
  const placed: (PanelItem | string)[] = [];
  for (const i of items) {
    if (!roomish(i)) {
      placed.push(i);
      continue;
    }
    const ids = idsOf(i);
    const area = areas.get(ids[0]!);
    const word = /^[^\s,]+/.exec(i.label.trim())?.[0] ?? "";
    const key = area ? `area:${area.toLowerCase()}` : `word:${word.toLowerCase()}`;
    let room = rooms.get(key);
    if (!room) {
      rooms.set(key, (room = { name: area ?? word, ids: [], label: null, lit: false, items: [] }));
      placed.push(key);
    }
    room.ids.push(...ids);
    room.items.push(i);
    room.lit ||= lit(i);
    if (ids.length > 1) room.label ??= i.label;
  }
  const out = placed.flatMap((p): PanelItem[] => {
    if (typeof p !== "string") return [p];
    const room = rooms.get(p)!;
    const ids = [...new Set(room.ids)];
    return ids.length >= ROOM_ROW && room.lit ? [{ kind: "home", ref: ids.join(","), label: room.label ?? `${room.name} lights` }] : room.items;
  });
  return out
    .map((i, n) => ({ i, n, r: rank(i) }))
    .sort((a, b) => a.r - b.r || a.n - b.n)
    .map(({ i }) => i);
}
