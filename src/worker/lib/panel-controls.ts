import type { PanelMore } from "../../shared/panels.ts";

/**
 * An aircond's and an alarm's controls on a panel (lib/panel-view.ts), shown
 * when their tile is opened (src/app/ui/Home.ts): what each offers now, from
 * its state and what Home Assistant says it supports, and the service a
 * press sends. As for every press on a panel, the state is read again first,
 * the person must hold `home`, and what the house then does — a code it
 * wants, a mode it refuses — is Home Assistant's to decide.
 *
 * Actions carry their value: "mode:cool", "fan:high", "temp:24", "level:60",
 * "color:220,100", "kelvin:3000". A light's brightness, a fan's speed, a
 * blind's position, a speaker's volume and a number in the house open to a
 * slider, from the range Home Assistant gives each; a light with a colour or a
 * white temperature to its colours and its warm-to-cool range too.
 */

type Attrs = Record<string, unknown>;
type Call = { domain: string; service: string; data: Record<string, unknown>; said: string };

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const words = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
const gone = (state: string) => state === "unavailable" || state === "unknown";

/* ---------- an aircond --------------------------------------------------------- */

/** Folded, as Hark's: Turn off while it runs, Turn on while it is off. */
function climateActions(state: string): string[] {
  return gone(state) ? [] : state === "off" ? ["on"] : ["off"];
}

function climateMore(state: string, a: Attrs): PanelMore["climate"] {
  return {
    now: num(a.current_temperature),
    target: num(a.temperature),
    // Home Assistant's own defaults, for an integration that gives none.
    min: num(a.min_temp) ?? 7,
    max: num(a.max_temp) ?? 35,
    step: num(a.target_temp_step) ?? 1,
    modes: words(a.hvac_modes),
    mode: state,
    fans: words(a.fan_modes),
    ...(typeof a.fan_mode === "string" ? { fan: a.fan_mode } : {}),
  };
}

function climateCall(state: string, a: Attrs, action: string): Call | string {
  if (gone(state)) return `it is ${state}`;
  if (action === "off" && state !== "off") return { domain: "climate", service: "turn_off", data: {}, said: "Turn off" };
  if (action === "on" && state === "off") return { domain: "climate", service: "turn_on", data: {}, said: "Turn on" };
  const [kind, value = ""] = action.split(/:(.*)/s);
  if (kind === "mode" && words(a.hvac_modes).includes(value)) return { domain: "climate", service: "set_hvac_mode", data: { hvac_mode: value }, said: cap(value) };
  if (kind === "fan" && words(a.fan_modes).includes(value)) return { domain: "climate", service: "set_fan_mode", data: { fan_mode: value }, said: `fan ${value}` };
  if (kind === "temp") {
    const t = Number(value);
    const m = climateMore(state, a)!;
    if (value && Number.isFinite(t) && t >= m.min && t <= m.max) return { domain: "climate", service: "set_temperature", data: { temperature: t }, said: `set to ${t}°` };
    return `${value}° is outside ${m.min}–${m.max}°`;
  }
  return `it is ${state.replace(/_/g, " ")} now, so that was not sent`;
}

/* ---------- an alarm ------------------------------------------------------------- */

/** Home Assistant's alarm features, as bits of supported_features, and what each arms. */
const ARM: [bit: number, action: string, label: string][] = [
  [2, "arm_away", "Arm away"],
  [1, "arm_home", "Arm home"],
  [4, "arm_night", "Arm night"],
  [32, "arm_vacation", "Arm vacation"],
];
const ALARM_LABEL: Record<string, string> = { disarm: "Disarm", ...Object.fromEntries(ARM.map(([, a, l]) => [a, l])) };

/** Disarm while armed, arming or sounding; each way it can be armed while disarmed. */
function alarmActions(state: string, a: Attrs): string[] {
  if (gone(state) || state === "disarming") return [];
  if (state !== "disarmed") return ["disarm"];
  const f = num(a.supported_features);
  // An integration that does not say: home and away, which every alarm has.
  return ARM.filter(([bit]) => (f === undefined ? bit <= 2 : (f & bit) !== 0)).map(([, action]) => action);
}

/** The actions that want the alarm's code: disarming whenever it has one, arming unless it says not. */
function codeFor(a: Attrs, actions: string[]): string[] {
  if (a.code_format !== "number" && a.code_format !== "text") return [];
  return actions.filter((x) => x === "disarm" || a.code_arm_required !== false);
}

function alarmMore(state: string, a: Attrs): PanelMore {
  const actions = alarmActions(state, a);
  const wants = codeFor(a, actions);
  return {
    actions: actions.map((action) => ({ action, label: ALARM_LABEL[action]! })),
    ...(wants.length ? { code: { digits: a.code_format === "number", for: wants } } : {}),
  };
}

function alarmCall(state: string, a: Attrs, action: string, code: string | undefined): Call | string {
  if (!alarmActions(state, a).includes(action)) return `it is ${state.replace(/_/g, " ")} now, so that was not sent`;
  if (codeFor(a, [action]).length && !code) return "it wants its code";
  return { domain: "alarm_control_panel", service: `alarm_${action}`, data: code ? { code } : {}, said: ALARM_LABEL[action]! };
}

/* ---------- a slider: brightness, speed, position, volume, a number ---------------- */

type Level = NonNullable<PanelMore["level"]>;

/** Where a thing that can be set to a level is now, and its range; null when it cannot be. */
function levelOf(entity: string, state: string, a: Attrs): Level | null {
  if (gone(state)) return null;
  const pct = (name: string, value: number | undefined): Level => ({ name, value: Math.round(value ?? 0), min: 0, max: 100, step: 1, unit: "%" });
  switch (entity.split(".")[0]) {
    case "light": {
      // A light that is only on or off has no brightness to set.
      const modes = words(a.supported_color_modes);
      if (modes.length ? modes.every((m) => m === "onoff") : num(a.brightness) === undefined) return null;
      return pct("Brightness", state === "on" ? ((num(a.brightness) ?? 255) / 255) * 100 : 0);
    }
    case "fan":
      return num(a.percentage) === undefined ? null : { ...pct("Speed", num(a.percentage)), step: num(a.percentage_step) ?? 1 };
    case "cover":
      return num(a.current_position) === undefined ? null : pct("Position", num(a.current_position));
    case "media_player":
      return num(a.volume_level) === undefined ? null : pct("Volume", (num(a.volume_level) ?? 0) * 100);
    case "number":
    case "input_number": {
      const v = Number(state);
      const min = num(a.min) ?? 0;
      const max = num(a.max) ?? 100;
      if (!Number.isFinite(v) || max <= min) return null;
      return { name: "Value", value: v, min, max, step: num(a.step) ?? 1, unit: typeof a.unit_of_measurement === "string" ? a.unit_of_measurement : "" };
    }
    default:
      return null;
  }
}

/** A level pressed: within the thing's range, sent as the service its domain has for it. */
function levelCall(entity: string, state: string, a: Attrs, value: string): Call | string {
  const level = levelOf(entity, state, a);
  if (!level) return `it cannot be set to a level now`;
  const n = Number(value);
  if (!value || !Number.isFinite(n) || n < level.min || n > level.max) return `${value} is outside ${level.min}–${level.max}`;
  const said = `${level.name.toLowerCase()} ${n}${level.unit}`;
  const domain = entity.split(".")[0]!;
  switch (domain) {
    case "light":
      return n === 0 ? { domain, service: "turn_off", data: {}, said: "Turn off" } : { domain, service: "turn_on", data: { brightness_pct: n }, said };
    case "fan":
      return { domain, service: "set_percentage", data: { percentage: n }, said };
    case "cover":
      return { domain, service: "set_cover_position", data: { position: n }, said };
    case "media_player":
      return { domain, service: "volume_set", data: { volume_level: n / 100 }, said };
    default:
      return { domain, service: "set_value", data: { value: n }, said };
  }
}

/* ---------- a light's colour and white ------------------------------------------- */

type Color = NonNullable<PanelMore["color"]>;

/** Home Assistant's colour modes that take any colour; color_temp is a white's warmth alone. */
const WHEEL = ["hs", "rgb", "rgbw", "rgbww", "xy"];

/**
 * A light's colour now and the whites it can be, from the colour modes Home
 * Assistant says it supports; null for anything that is not a light, or a
 * light with neither (only on and off, or only dimmed). An older Home
 * Assistant gives its whites in mireds, the inverse of kelvin.
 */
function colorOf(entity: string, state: string, a: Attrs): Color | null {
  if (!entity.startsWith("light.") || gone(state)) return null;
  const modes = words(a.supported_color_modes);
  const wheel = modes.some((m) => WHEEL.includes(m));
  const white = modes.includes("color_temp");
  if (!wheel && !white) return null;
  const kelvin = (k: unknown, mireds: unknown, fallback: number) => Math.round(num(k) ?? (num(mireds) ? 1_000_000 / num(mireds)! : fallback));
  const warm = kelvin(a.min_color_temp_kelvin, a.max_mireds, 2000);
  const cool = kelvin(a.max_color_temp_kelvin, a.min_mireds, 6500);
  // Home Assistant works out an hs_color for a white too (and a color_temp
  // for a colour), so each is the light's own only in its own mode; with no
  // mode given (off, or older) it is the last one known.
  const mode = typeof a.color_mode === "string" ? a.color_mode : null;
  const hs = Array.isArray(a.hs_color) && (mode === null || WHEEL.includes(mode)) ? a.hs_color : [];
  const k = mode === null || mode === "color_temp" ? a.color_temp_kelvin : null;
  return {
    wheel,
    hue: Math.round(num(hs[0]) ?? 0) % 360,
    sat: Math.round(num(hs[1]) ?? 0),
    white,
    kelvin: Math.round(num(k) ?? (warm + cool) / 2),
    warm,
    cool,
    on: state === "on",
  };
}

/** A colour pressed, "220,100": whole numbers, hue 0–360 (360 is 0) and saturation 0–100, for a light that takes any colour. */
function colorCall(entity: string, state: string, a: Attrs, value: string): Call | string {
  if (!colorOf(entity, state, a)?.wheel) return "it cannot be set to a colour now";
  const m = /^(\d{1,3}),(\d{1,3})$/.exec(value);
  if (!m || Number(m[1]) > 360 || Number(m[2]) > 100) return `${value} is not a hue 0–360 and a saturation 0–100`;
  const hue = Number(m[1]) % 360;
  const sat = Number(m[2]);
  return { domain: "light", service: "turn_on", data: { hs_color: [hue, sat] }, said: `Colour ${hue}°/${sat}%` };
}

/** A white pressed: whole kelvin, within the light's warm-to-cool range. */
function kelvinCall(entity: string, state: string, a: Attrs, value: string): Call | string {
  const c = colorOf(entity, state, a);
  if (!c?.white) return "it cannot be set to a white now";
  const k = Number(value);
  if (!/^\d+$/.test(value) || k < c.warm || k > c.cool) return `${value} K is outside ${c.warm}–${c.cool} K`;
  return { domain: "light", service: "turn_on", data: { color_temp_kelvin: k }, said: `White ${k} K` };
}

/* ---------- for lib/panel-view.ts ------------------------------------------------- */

const LABEL: Record<string, string> = { on: "Turn on", off: "Turn off" };

/**
 * An aircond's or an alarm's buttons and opened controls, or a slider for
 * what has a level and a light's colours (its buttons left to houseActions);
 * null for anything else.
 */
export function controlsOf(entity: string, state: string, a: Attrs): { actions?: { action: string; label: string }[]; more?: PanelMore } | null {
  const domain = entity.split(".")[0];
  if (domain === "climate") {
    return { actions: climateActions(state).map((action) => ({ action, label: LABEL[action]! })), ...(gone(state) ? {} : { more: { climate: climateMore(state, a) } }) };
  }
  if (domain === "alarm_control_panel") return { actions: [], ...(gone(state) ? {} : { more: alarmMore(state, a) }) };
  const level = levelOf(entity, state, a);
  const color = colorOf(entity, state, a);
  return level || color ? { more: { ...(level ? { level } : {}), ...(color ? { color } : {}) } } : null;
}

/** What a press on an aircond, an alarm, a slider or a light's colour sends, if its state offers it now (a string says why not); null for anything else. */
export function controlCall(entity: string, state: string, a: Attrs, action: string, code?: string): Call | string | null {
  const domain = entity.split(".")[0];
  if (domain === "climate") return climateCall(state, a, action);
  if (domain === "alarm_control_panel") return alarmCall(state, a, action, code);
  if (action.startsWith("level:")) return levelCall(entity, state, a, action.slice("level:".length));
  if (action.startsWith("color:")) return colorCall(entity, state, a, action.slice("color:".length));
  if (action.startsWith("kelvin:")) return kelvinCall(entity, state, a, action.slice("kelvin:".length));
  return null;
}
