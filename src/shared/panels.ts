/**
 * A person's panels as the Home tab draws them (GET /api/hub/panels): each
 * thing read just now, its buttons worked out from what it is doing now — a
 * closed gate offers Open, a lit lamp Turn off — so nothing here is a copy
 * kept from before (src/worker/lib/panel-view.ts, src/app/ui/Home.ts).
 */

/** What a thing is drawn with on its tile; index.html has a mask for each. */
export type PanelIcon =
  | "gate" | "garage" | "door" | "window" | "blind" | "lock" | "unlock"
  | "light" | "power" | "plug" | "fan" | "climate" | "scene" | "play" | "press"
  | "temp" | "drop" | "bolt" | "motion" | "sensor" | "weather" | "music" | "alarm" | "alert"
  | "car" | "usage" | "note" | "calendar" | "mail" | "camera" | "clock" | "terminal" | "route" | "chat" | "web" | "dot";

export interface PanelRow {
  /** Which thing it is on its panel (its entity id, car id, "usage", or the note), for a button press. */
  key: string;
  kind: "home" | "car" | "usage" | "note" | "tile";
  label: string;
  /** What it is doing now, in words: "Closed", "On", "31 °C", "Locked". Empty for a note. */
  value: string;
  icon: PanelIcon;
  /** Lit, open, unlocked, running, charging: drawn in colour. */
  active: boolean;
  /** A car's battery, 0–100, drawn as a bar. */
  level?: number;
  /** Figures side by side: what was used this month. */
  tiles: { label: string; value: string }[];
  /** What can be done to it now, from its state now; a tile's may take a slider's value or typed words. */
  actions: { action: string; label: string; input?: ButtonInput }[];
  /** Why it cannot be read or worked just now. */
  note?: string;
  /** What its tile shows when opened: a room's lights each, or an aircond's or an alarm's controls. */
  more?: PanelMore;
  /** A tile whose reading comes on its own (GET /api/hub/panels/read), since a tool can be slow. */
  read?: boolean;
  /** That reading, for its panel's More info: the tool it runs each time it is read (lib/panel-tiles.ts)… */
  tool?: string;
  /** …or, for one Jarvis looks up, how many minutes old it may get before it is looked up again (TileAsk.every). */
  every?: number;
  /** A to-do ticked off: struck through, at the bottom, until cleared. */
  done?: boolean;
  /** The alerts set on it, a few words each ("above 200", "opens"): routines of theirs that watch it. */
  alerts?: string[];
}

/** What a tile's button takes before it is pressed (lib/panel-tiles.ts): a number on a slider, or words. */
export type ButtonInput = { kind: "slider"; min: number; max: number; step: number } | { kind: "text"; hint: string };

export interface PanelMore {
  /** A room's lights and switches, each with its own buttons, pressed with its key as `member`. */
  members?: PanelRow[];
  /** An aircond's: the room's temperature, what it is set to, and what it may be set to. */
  climate?: { now?: number; target?: number; min: number; max: number; step: number; modes: string[]; mode: string; fans: string[]; fan?: string };
  /** Buttons shown only when it is opened: an alarm's arming and disarming. */
  actions?: { action: string; label: string }[];
  /** Which of those want the alarm's code, and whether it is digits. */
  code?: { digits: boolean; for: string[] };
  /** A number read over the last day: its chart is fetched when the tile opens (GET /api/hub/panels/history). */
  history?: boolean;
  /**
   * "Alert me": its two states in words ("opens" / "closes"), a number to go
   * above or below, or — for a reading Jarvis looks up — words typed for it
   * (POST /api/hub/panels/alert).
   */
  alert?: { kind: "state"; on: string; off: string } | { kind: "number"; unit: string; value: number } | { kind: "words" };
  /** Where it is (the car), drawn as a map when the tile opens. */
  map?: { lat: number; lng: number };
  /** A slider: a light's brightness, a fan's speed, a blind's position, a speaker's volume, a number. Pressed as `level:<n>`. */
  level?: { name: string; value: number; min: number; max: number; step: number; unit: string };
}

export interface PanelView {
  id: string;
  title: string;
  rows: PanelRow[];
}

export interface PanelsReply {
  panels: PanelView[];
  /** What a panel could show for this person, for the empty Home tab to say so. */
  can: { home: boolean; car: boolean };
}

/** "hour", "3 hours", "90 minutes", "day": how often a reading Jarvis looks up is looked up again, from minutes (panel_set's reply, Home's More info). */
export const everyWords = (m: number): string => (m === 60 ? "hour" : m === 1440 ? "day" : m % 60 ? `${m} minutes` : `${m / 60} hours`);
