import type { PanelMore } from "../../shared/panels.ts";

/**
 * An aircond's and an alarm's controls on a panel (lib/panel-view.ts), shown
 * when their tile is opened (src/app/ui/Home.ts): what each offers now, from
 * its state and what Home Assistant says it supports, and the service a
 * press sends. As for every press on a panel, the state is read again first,
 * the person must hold `home`, and what the house then does — a code it
 * wants, a mode it refuses — is Home Assistant's to decide.
 *
 * Actions carry their value: "mode:cool", "fan:high", "temp:24".
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

/* ---------- for lib/panel-view.ts ------------------------------------------------- */

const LABEL: Record<string, string> = { on: "Turn on", off: "Turn off" };

/** An aircond's or an alarm's buttons and opened controls; null for anything else. */
export function controlsOf(entity: string, state: string, a: Attrs): { actions: { action: string; label: string }[]; more?: PanelMore } | null {
  const domain = entity.split(".")[0];
  if (domain === "climate") {
    return { actions: climateActions(state).map((action) => ({ action, label: LABEL[action]! })), ...(gone(state) ? {} : { more: { climate: climateMore(state, a) } }) };
  }
  if (domain === "alarm_control_panel") return { actions: [], ...(gone(state) ? {} : { more: alarmMore(state, a) }) };
  return null;
}

/** What a press on an aircond or an alarm sends, if its state offers it now (a string says why not); null for anything else. */
export function controlCall(entity: string, state: string, a: Attrs, action: string, code?: string): Call | string | null {
  const domain = entity.split(".")[0];
  if (domain === "climate") return climateCall(state, a, action);
  if (domain === "alarm_control_panel") return alarmCall(state, a, action, code);
  return null;
}
