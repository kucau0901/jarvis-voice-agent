import type { Env } from "../types";
import { DEFAULT_ORDER, validateOrder } from "./alerts.ts";
import { validateCameraList } from "./cameras.ts";
import { DEFAULT_STYLE, DEFAULT_VOICE, STT_PROVIDERS, TTS_PROVIDERS, TTS_VOICES } from "./speech.ts";
import { EFFORTS } from "./router-model.ts";

/**
 * Every setting Jarvis reads, in one list.
 *
 * Until September 2026 every credential went in with `wrangler secret put`,
 * because Jarvis was built for a Tesla screen where typing a token is
 * miserable. It is now used from desktops and phones, and is meant to become a
 * public repo someone else can deploy — so everything is shown and edited in
 * the settings panel, and a fresh deployment needs exactly one deploy-time
 * secret: the owner key.
 *
 * Saved values live in the Durable Object (lib/state-host.ts) and are layered
 * over the Worker's own environment by `effectiveEnv()`, once per request, so
 * the forty-odd places that read `env.X` did not change. Precedence: saved in
 * the panel, then the deployment (Worker secret or var), then the default here.
 *
 * Kept free of Cloudflare imports so Node can test it directly.
 */

export type Group =
  | "openai"
  | "car"
  | "home"
  | "hermes"
  | "google"
  | "spotify"
  | "maps"
  | "locale"
  | "alerts"
  | "cameras"
  | "voice"
  | "devices"
  | "advanced";

export type Kind = "secret" | "url" | "text" | "number" | "bool" | "enum";

export interface SettingDef {
  name: string;
  group: Group;
  kind: Kind;
  label: string;
  help: string;
  /** An error message, or null. Receives the trimmed value. */
  validate?: (v: string) => string | null;
  default?: string;
  options?: readonly string[];
  /**
   * Secrets that are only ever sent to where THIS points. If this is changed in
   * the panel, they are withheld until they are saved again — see `guarded()`.
   */
  bindsTo?: readonly string[];
  /** Jarvis cannot work at all without it. */
  required?: boolean;
}

export interface GroupDef {
  id: Group;
  title: string;
  /** Where the values come from, for someone setting this up for the first time. */
  intro: string;
  /** Set when every one of these has a value; empty means always "configured". */
  needs: readonly string[];
  testable: boolean;
}

/* ---------- validators ----------------------------------------------------- */

const httpsUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? null : "must start with https://";
  } catch {
    return "is not a URL";
  }
};
const noSpaces = (v: string) => (/\s/.test(v) ? "must not contain spaces" : null);
const minLen = (n: number) => (v: string) => (v.length < n ? `looks too short to be real (${v.length} characters)` : null);
const all =
  (...checks: ((v: string) => string | null)[]) =>
  (v: string) => {
    for (const c of checks) {
      const e = c(v);
      if (e) return e;
    }
    return null;
  };
const intIn = (lo: number, hi: number) => (v: string) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? null : `must be a whole number from ${lo} to ${hi}`;
};
const timeZone = (v: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: v });
    return null;
  } catch {
    return "is not a time zone name like Asia/Kuala_Lumpur or Europe/London";
  }
};
const locale = (v: string) => {
  try {
    return Intl.getCanonicalLocales(v).length === 1 ? null : "is not a language tag like en or en-GB";
  } catch {
    return "is not a language tag like en or en-GB";
  }
};
const origins = (v: string) => {
  for (const o of v.split(",").map((s) => s.trim()).filter(Boolean)) {
    try {
      const u = new URL(o);
      if (u.origin !== o) return `"${o}" should be an origin only, like https://example.com`;
    } catch {
      return `"${o}" is not an origin`;
    }
  }
  return null;
};

/* ---------- the catalogue -------------------------------------------------- */

export const GROUPS: readonly GroupDef[] = [
  {
    id: "openai",
    title: "OpenAI",
    intro: "The only required setting. Create a key at platform.openai.com → API keys.",
    needs: ["OPENAI_API_KEY"],
    testable: true,
  },
  {
    id: "car",
    title: "Car (Tessie)",
    intro: "A Tessie access token from dash.tessie.com → Settings → API, and the car's VIN.",
    needs: ["TESSIE_TOKEN", "TESSIE_VIN"],
    testable: true,
  },
  {
    id: "home",
    title: "Home (Home Assistant)",
    intro:
      "The house. The MCP URL gives Jarvis its tools; the base URL and a long-lived token (your HA profile → Security) are for cameras and the glasses' fast path.",
    needs: ["HA_MCP_URL"],
    testable: true,
  },
  {
    id: "hermes",
    title: "Hermes",
    intro: "Optional: a Hermes agent reachable over HTTPS, and the Cloudflare Access service token in front of it if there is one.",
    needs: ["HERMES_BASE_URL", "HERMES_API_KEY"],
    testable: true,
  },
  {
    id: "google",
    title: "Google (Gmail, Calendar, Contacts)",
    intro:
      "A Web application OAuth client from console.cloud.google.com → Credentials. Publish the consent screen to In production, or Google expires the link every 7 days.",
    needs: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    testable: true,
  },
  {
    id: "spotify",
    title: "Spotify",
    intro: "An app from developer.spotify.com/dashboard, then link your account below.",
    needs: ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"],
    testable: true,
  },
  {
    id: "maps",
    title: "Google Maps",
    intro:
      "Two keys: a server key (not referrer-restricted) for directions and places, and a browser key restricted to this site for the map on screen.",
    needs: ["GOOGLE_MAPS_API_KEY"],
    testable: true,
  },
  {
    id: "locale",
    title: "Where you are",
    intro: "Time zone, country, language and units — used for times, directions, addresses and distances.",
    needs: [],
    testable: true,
  },
  {
    id: "alerts",
    title: "Alerts",
    intro:
      "How Jarvis reaches you when it speaks first. An open Jarvis screen gets it first, then notifications on any device where you turned them on below — neither needs setting up. The rest are optional extra ways through; Test sends one message down every channel that is set up.",
    needs: [],
    testable: true,
  },
  {
    id: "cameras",
    title: "Cameras",
    intro:
      "Cameras Jarvis can look at to answer \"is there a car in the driveway?\" or \"did the parcel arrive?\" — and show you. Home Assistant's cameras appear on their own once the Home section is set up. Add any other camera by the address of its snapshot picture. Test fetches a frame from each.",
    needs: [],
    testable: true,
  },
  {
    id: "voice",
    title: "Push-to-talk voice",
    intro:
      "The cheap way to talk to Jarvis: one question at a time, transcribed, answered and spoken back, for a fraction of a cent — no live session. GPT-Live stays for proper conversations. Choose it per screen under the orb. Test speaks a sentence and hears it back.",
    needs: [],
    testable: true,
  },
  {
    id: "devices",
    title: "Devices and glasses",
    intro: "Limits for device tokens, and tuning for Even Realities G2 glasses.",
    needs: [],
    testable: false,
  },
  {
    id: "advanced",
    title: "Advanced",
    intro: "Rarely needed.",
    needs: [],
    testable: false,
  },
];

export const SETTINGS: readonly SettingDef[] = [
  // --- OpenAI
  {
    name: "ROUTER_EFFORT", group: "openai", kind: "enum", default: "auto", options: EFFORTS,
    label: "Thinking before answering",
    help: "How long the AI thinks on a question you are waiting for: spoken, typed or on the glasses. Auto leaves it to the model, which testing found best for GPT-6 Luna; less can help a heavier model. None can make mistakes. Background jobs and routines are not affected.",
  },
  {
    name: "RESEARCH_MODEL", group: "openai", kind: "text", default: "gpt-6-sol",
    label: "Research model",
    help: "What a research job runs on (\"research … in depth and let me know\"): stronger than the router, as it is asked for depth and nobody is waiting. About a dollar a report on GPT-6 Sol.",
    validate: (v: string) => (/^[a-z0-9][a-z0-9._:-]{1,79}$/i.test(v.trim()) ? null : "is not a model id like gpt-6-sol"),
  },
  {
    name: "RESEARCH_MONTHLY_LIMIT", group: "openai", kind: "number", default: "10",
    label: "Research jobs a month",
    help: "A ceiling on what research can spend. 0 switches research jobs off.",
    validate: intIn(0, 200),
  },
  {
    name: "OPENAI_API_KEY", group: "openai", kind: "secret", required: true,
    label: "API key", help: "Starts with sk-.",
    validate: all(noSpaces, (v) => (v.startsWith("sk-") ? null : "should start with sk-"), minLen(20)),
  },

  // --- Car
  {
    name: "TESSIE_TOKEN", group: "car", kind: "secret",
    label: "Tessie token", help: "From dash.tessie.com → Settings → API.",
    validate: all(noSpaces, minLen(16)),
  },
  {
    name: "TESSIE_VIN", group: "car", kind: "text",
    label: "VIN", help: "17 characters, on the car's screen under Software.",
    validate: (v) => (/^[A-HJ-NPR-Z0-9]{17}$/i.test(v) ? null : "must be 17 letters and digits (no I, O or Q)"),
  },

  // --- Home
  {
    name: "HA_MCP_URL", group: "home", kind: "secret",
    label: "MCP URL", help: "The Home Assistant MCP address. Kept secret: a webhook URL IS the credential.",
    validate: httpsUrl, bindsTo: ["HA_TOKEN"],
  },
  {
    name: "HA_BASE_URL", group: "home", kind: "url",
    label: "Base URL", help: "Your Home Assistant address, e.g. https://abc.ui.nabu.casa.",
    validate: httpsUrl, bindsTo: ["HA_TOKEN"],
  },
  {
    name: "HA_TOKEN", group: "home", kind: "secret",
    label: "Long-lived token", help: "Home Assistant → your profile → Security → Long-lived access tokens.",
    validate: all(noSpaces, minLen(20)),
  },
  {
    name: "HA_ASSIST", group: "home", kind: "bool", default: "1",
    label: "Try Assist first",
    help: "House requests from the glasses, Type and push-to-talk go to Home Assistant's Assist before the AI: under a second and no model cost. What it may do is what you expose to Assist in Home Assistant.",
  },
  {
    name: "HA_ASSIST_LANGUAGE", group: "home", kind: "text", default: "en",
    label: "Assist language", help: "The language Assist is asked in.",
    validate: locale,
  },

  // --- Hermes
  {
    name: "HERMES_BASE_URL", group: "hermes", kind: "url",
    label: "Base URL", help: "Where the Hermes api_server answers.",
    validate: httpsUrl, bindsTo: ["HERMES_API_KEY", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"],
  },
  {
    name: "HERMES_API_KEY", group: "hermes", kind: "secret",
    label: "API key", help: "The key Hermes's api_server expects.",
    validate: all(noSpaces, minLen(8)),
  },
  {
    name: "HERMES_MODEL", group: "hermes", kind: "text", default: "hermes",
    label: "Model name", help: "What Hermes's api_server calls its model.",
    validate: noSpaces,
  },
  {
    name: "CF_ACCESS_CLIENT_ID", group: "hermes", kind: "secret",
    label: "Access client ID", help: "Only if Hermes sits behind Cloudflare Access. Ends in .access.",
    validate: (v) => (v.endsWith(".access") ? null : "a Client ID ends in .access — this may be the secret"),
  },
  {
    name: "CF_ACCESS_CLIENT_SECRET", group: "hermes", kind: "secret",
    label: "Access client secret", help: "The other half of the service token.",
    validate: (v) => (v.endsWith(".access") ? "ends in .access, so it is the ID, not the secret" : noSpaces(v)),
  },

  // --- Google
  {
    name: "GOOGLE_CLIENT_ID", group: "google", kind: "text",
    label: "OAuth client ID", help: "Ends in .apps.googleusercontent.com.",
    validate: (v) => (v.endsWith(".apps.googleusercontent.com") ? null : "should end in .apps.googleusercontent.com"),
    bindsTo: ["GOOGLE_CLIENT_SECRET"],
  },
  {
    name: "GOOGLE_CLIENT_SECRET", group: "google", kind: "secret",
    label: "OAuth client secret", help: "Shown next to the client ID in Google Cloud.",
    validate: all(noSpaces, minLen(16)),
  },

  // --- Spotify
  {
    name: "SPOTIFY_CLIENT_ID", group: "spotify", kind: "text",
    label: "Client ID", help: "32 hexadecimal characters.",
    validate: (v) => (/^[0-9a-f]{32}$/i.test(v) ? null : "should be 32 hexadecimal characters"),
    bindsTo: ["SPOTIFY_CLIENT_SECRET"],
  },
  {
    name: "SPOTIFY_CLIENT_SECRET", group: "spotify", kind: "secret",
    label: "Client secret", help: "From the app's settings in the Spotify dashboard.",
    validate: (v) => (/^[0-9a-f]{32}$/i.test(v) ? null : "should be 32 hexadecimal characters"),
  },

  // --- Maps
  {
    name: "GOOGLE_MAPS_API_KEY", group: "maps", kind: "secret",
    label: "Server key", help: "Directions, Places, Geocoding. Must NOT be referrer-restricted.",
    validate: (v) => (v.startsWith("AIza") ? null : "Google API keys start with AIza"),
  },
  {
    name: "GOOGLE_MAPS_EMBED_KEY", group: "maps", kind: "secret",
    label: "Browser key", help: "The map on screen. Restrict it to this site and the Maps Embed API.",
    validate: (v) => (v.startsWith("AIza") ? null : "Google API keys start with AIza"),
  },

  // --- Locale
  {
    name: "TIMEZONE", group: "locale", kind: "text", default: "UTC",
    label: "Time zone", help: "An IANA name: Asia/Kuala_Lumpur, Europe/London, America/New_York.",
    validate: timeZone,
  },
  {
    name: "COUNTRY", group: "locale", kind: "text",
    label: "Country", help: "Two letters: MY, GB, US. Biases directions and address lookups.",
    validate: (v) => (/^[A-Za-z]{2}$/.test(v) ? null : "must be a two-letter country code"),
  },
  {
    name: "LOCALE", group: "locale", kind: "text", default: "en",
    label: "Language", help: "A language tag: en, en-GB, ms.",
    validate: locale,
  },
  {
    name: "UNITS", group: "locale", kind: "enum", default: "metric", options: ["metric", "imperial"],
    label: "Units", help: "Kilometres and Celsius, or miles.",
  },

  // --- Alerts
  {
    name: "ALERT_ORDER", group: "alerts", kind: "text", default: DEFAULT_ORDER,
    label: "Order to try",
    help: "Stops at the first that gets through; an urgent alert goes to all. Leave one out to never use it.",
    validate: validateOrder,
  },
  {
    name: "TELEGRAM_BOT_TOKEN", group: "alerts", kind: "secret",
    label: "Telegram bot token", help: "Message @BotFather, /newbot. Looks like 123456:ABC-DEF…",
    validate: (v) => (/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(v) ? null : "should look like 123456789:AA… (digits, a colon, then letters)"),
  },
  {
    name: "TELEGRAM_CHAT_ID", group: "alerts", kind: "text",
    label: "Telegram chat ID", help: "Send your bot a message, then open api.telegram.org/bot<token>/getUpdates and copy chat.id.",
    validate: (v) => (/^-?\d{3,20}$/.test(v) ? null : "is a number, negative for a group"),
  },
  {
    name: "NTFY_URL", group: "alerts", kind: "secret",
    label: "ntfy topic address", help: "e.g. https://ntfy.sh/a-long-random-name. On ntfy.sh anyone who knows the name can read it, so make it long.",
    validate: all(httpsUrl, (v) => (/^https:\/\/[^/]+\/[^/?#]+\/?$/.test(v) ? null : "must be a server and one topic name, nothing more")),
    bindsTo: ["NTFY_TOKEN"],
  },
  {
    name: "NTFY_TOKEN", group: "alerts", kind: "secret",
    label: "ntfy access token", help: "Only for a protected topic. Starts with tk_.",
    validate: all(noSpaces, minLen(8)),
  },
  {
    name: "ALERT_WEBHOOK_URL", group: "alerts", kind: "secret",
    label: "Webhook URL", help: "Receives each alert as JSON: Node-RED, n8n, IFTTT, a Home Assistant webhook, your own code.",
    validate: httpsUrl, bindsTo: ["ALERT_WEBHOOK_SECRET"],
  },
  {
    name: "ALERT_WEBHOOK_SECRET", group: "alerts", kind: "secret",
    label: "Webhook signing secret", help: "Optional. Each POST then carries X-Jarvis-Signature: sha256=HMAC of the body.",
    validate: minLen(16),
  },
  {
    name: "HA_NOTIFY_SERVICE", group: "alerts", kind: "text",
    label: "Home Assistant notify service",
    help: "Without \"notify.\" — e.g. mobile_app_pixel_9. Uses the Home section's base URL and token.",
    validate: (v) => (/^[a-z0-9_]+$/.test(v) ? null : "is lower-case letters, digits and underscores, without notify."),
  },
  {
    name: "HA_NOTIFY_SPEAK", group: "alerts", kind: "bool", default: "0",
    label: "Home Assistant: read aloud", help: "Android Companion app only: speaks the alert instead of showing it.",
  },

  // --- Cameras
  {
    name: "CAMERAS", group: "cameras", kind: "secret",
    label: "Snapshot addresses",
    help: "Name = address, separated by ; — e.g. Front gate = https://cam.example.com/snap.jpg; Driveway = http://user:pass@192.168.1.20/snap.jpg. A home (LAN) address only works when Jarvis runs at home in Docker.",
    validate: validateCameraList,
  },

  // --- Push-to-talk
  {
    name: "VOICE_STT", group: "voice", kind: "enum", default: "openai", options: STT_PROVIDERS,
    label: "Hearing",
    help: "openai: any language, mixed ones too, ~$0.003/min. workers-ai: Whisper, ~$0.0005/min, needs the AI binding (Cloudflare only). browser: the device's own, free, where it has one.",
  },
  {
    name: "VOICE_TTS", group: "voice", kind: "enum", default: "openai", options: TTS_PROVIDERS,
    label: "Speaking",
    help: "openai: the same voices as GPT-Live, ~$0.015 per minute of speech. workers-ai: Deepgram Aura for English, MeloTTS for a few others; anything else falls back to OpenAI. browser: the device's own voice, free.",
  },
  {
    name: "VOICE_TTS_VOICE", group: "voice", kind: "enum", default: DEFAULT_VOICE, options: TTS_VOICES,
    label: "Voice", help: "For OpenAI speaking. cedar and marin are GPT-Live's own.",
  },
  {
    name: "VOICE_STYLE", group: "voice", kind: "text", default: DEFAULT_STYLE,
    label: "How it sounds", help: "A line of direction for the OpenAI voice: tone, pace, accent.",
    validate: (v) => (v.length > 300 ? "keep it under 300 characters" : null),
  },

  // --- Devices and glasses
  {
    name: "DEVICE_DAILY_LIMIT", group: "devices", kind: "number", default: "500",
    label: "Requests per device per day", help: "A cost ceiling for device tokens. The owner is never limited.",
    validate: intIn(1, 100_000),
  },
  {
    name: "JARVIS_ALLOWED_ORIGINS", group: "devices", kind: "text",
    label: "Allowed browser origins", help: "Comma-separated. Only for a browser client on another site.",
    validate: origins,
  },
  {
    name: "G2_CHAR_BUDGET", group: "devices", kind: "number", default: "350",
    label: "Glasses: characters shown", help: "Before the G2 renderer gives up.",
    validate: intIn(50, 2000),
  },
  {
    name: "G2_WAIT_S", group: "devices", kind: "number", default: "240",
    label: "Glasses: seconds to wait", help: "The Even app hangs up at 300.",
    validate: intIn(10, 290),
  },

  // --- Advanced
  {
    name: "PUBLIC_URL", group: "advanced", kind: "url",
    label: "Public address",
    help: "Only behind a reverse proxy (e.g. Docker): the https address people use. Google and Spotify sign-in return here.",
    validate: httpsUrl,
  },
  {
    name: "UPDATE_REPO", group: "advanced", kind: "text",
    label: "Check for new versions at",
    help: "A GitHub repository, owner/name, whose releases the settings panel checks. Empty: the project this copy came from. \"off\": never check.",
    validate: (v: string) => (/^(off|[\w.-]+\/[\w.-]+)$/i.test(v.trim()) ? null : "should be owner/name, or off"),
  },
  {
    name: "DISABLE_WEB_SEARCH", group: "advanced", kind: "bool", default: "0",
    label: "Withhold web search", help: "Stop the router searching the web.",
  },
];

/**
 * Env fields that are deliberately NOT settings, and why. The tests check that
 * every Env field is either here or in SETTINGS, so a new one cannot be
 * forgotten.
 */
export const NOT_SETTINGS: Readonly<Record<string, string>> = {
  ASSETS: "a binding",
  CONFIG: "a binding",
  STATE: "a binding",
  DEVICE_LIMIT: "a binding",
  AI: "a binding (Workers AI), added in wrangler.jsonc",
  JARVIS_SHARED_SECRET: "the owner key: deploy-time only, so login never depends on storage",
  ROUTER_MODEL: "has its own section, with a live probe before saving",
  G2_FASTPATH: "renamed HA_ASSIST; the old name is still read",
  G2_HA_LANGUAGE: "renamed HA_ASSIST_LANGUAGE; the old name is still read",
};

const BY_NAME = new Map(SETTINGS.map((s) => [s.name, s]));
export const settingDef = (name: string): SettingDef | undefined => BY_NAME.get(name);

/* ---------- stored shape --------------------------------------------------- */

export interface Saved {
  v: string;
  /** When it was saved. The rebinding guard compares these. */
  at: number;
}
export type SavedSettings = Record<string, Saved>;

/**
 * Settings saved under a name they no longer have, and the name they have now.
 * A value saved under the old name is read under the new one until it is saved
 * again, so an update never quietly undoes a choice made in the panel.
 */
export const RENAMED: Readonly<Record<string, string>> = {
  G2_FASTPATH: "HA_ASSIST",
  G2_HA_LANGUAGE: "HA_ASSIST_LANGUAGE",
};

export function withRenames(saved: SavedSettings): SavedSettings {
  let out = saved;
  for (const [old, now] of Object.entries(RENAMED)) {
    if (saved[old] && !saved[now]) {
      if (out === saved) out = { ...saved };
      out[now] = saved[old]!;
    }
  }
  return out;
}

/* ---------- validation ----------------------------------------------------- */

export type Changes = Record<string, string | null>;

/**
 * Check a batch of changes. `null` clears a saved value; anything else is
 * trimmed and validated. One bad field rejects the whole batch, so a half-saved
 * pair (a new URL without its token) cannot happen by accident.
 */
export function validateChanges(
  raw: unknown,
): { ok: true; changes: Changes } | { ok: false; errors: Record<string, string> } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: { _: "changes must be an object of NAME: value" } };
  }
  const changes: Changes = {};
  const errors: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const def = BY_NAME.get(name);
    if (!def) {
      errors[name] = NOT_SETTINGS[name] ? `cannot be set here: ${NOT_SETTINGS[name]}` : "is not a setting";
      continue;
    }
    if (value === null) {
      changes[name] = null;
      continue;
    }
    if (typeof value !== "string") {
      errors[name] = "must be text";
      continue;
    }
    let v = value.trim();
    if (!v) {
      errors[name] = "is empty — use Clear to remove a saved value";
      continue;
    }
    if (v.length > 4096) {
      errors[name] = "is too long";
      continue;
    }
    if (def.kind === "bool") {
      if (!/^(1|0|true|false|on|off)$/i.test(v)) {
        errors[name] = "must be on or off";
        continue;
      }
      v = /^(1|true|on)$/i.test(v) ? "1" : "0";
    }
    if (def.kind === "enum" && !def.options?.includes(v)) {
      errors[name] = `must be one of ${def.options?.join(", ")}`;
      continue;
    }
    const e = def.validate?.(v);
    if (e) {
      errors[name] = `${def.label} ${e}`;
      continue;
    }
    changes[name] = v;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, changes };
}

/** Apply validated changes to the stored record. Pure. */
export function applyChanges(saved: SavedSettings, changes: Changes, now = Date.now()): SavedSettings {
  const next: SavedSettings = { ...saved };
  for (const [name, v] of Object.entries(changes)) {
    if (v === null) delete next[name];
    else next[name] = { v, at: now };
  }
  return next;
}

/* ---------- the rebinding guard ------------------------------------------- */

/**
 * Secrets withheld because the place they go was changed after they were set.
 *
 * Anyone holding the owner key can edit settings. Without this, they could
 * point HERMES_BASE_URL at their own server and Jarvis would hand it the stored
 * Hermes key — the settings panel never SHOWS a secret, but sending it
 * somewhere is as good as showing it. So a secret is only ever sent to a
 * destination changed in the panel if it was saved at the same time as that
 * change or later: that is, by someone who already knew it.
 *
 * Enforced when settings are READ, not written, so no sequence of saves and
 * clears gets around it — including falling back to the deployment's copy.
 */
export function guarded(env: Record<string, unknown>, saved: SavedSettings): Map<string, string> {
  const withheld = new Map<string, string>();
  for (const def of SETTINGS) {
    if (!def.bindsTo) continue;
    const dest = saved[def.name];
    if (!dest) continue; // the deployment's own destination
    if (dest.v === env[def.name]) continue; // saved, but the same place
    for (const b of def.bindsTo) {
      const sec = saved[b];
      if (!sec || sec.at < dest.at) withheld.set(b, `${def.label} changed — enter this again to use it there`);
    }
  }
  return withheld;
}

/* ---------- the environment the rest of the Worker sees ------------------- */

/**
 * The Worker's environment with saved settings layered on top. Bindings are
 * kept as they are; a withheld secret becomes empty, which every reader already
 * treats as "not configured".
 */
export function effectiveEnv(env: Env, saved: SavedSettings): Env {
  const raw = env as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...raw };
  for (const def of SETTINGS) {
    const s = saved[def.name];
    if (s) out[def.name] = s.v;
  }
  for (const name of guarded(raw, saved).keys()) out[name] = "";
  return out as unknown as Env;
}

/* ---------- what the panel is shown --------------------------------------- */

const enc = new TextEncoder();
async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  let out = "";
  for (const b of d) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * How a secret is shown: never the value. A fingerprint tells you WHICH key is
 * set — compare it with the one in your password manager — without revealing
 * it. The last four characters are added only when the value is long enough
 * that four reveal little.
 */
export async function maskSecret(v: string): Promise<string> {
  const fp = (await sha256Hex(v)).slice(0, 8);
  return v.length >= 24 ? `••••${v.slice(-4)} · sha256 ${fp}` : `•••• · sha256 ${fp}`;
}

export type Source = "saved" | "deployment" | "default" | "unset";

export interface SettingView {
  name: string;
  group: Group;
  kind: Kind;
  label: string;
  help: string;
  required: boolean;
  options?: readonly string[];
  source: Source;
  /** Masked for secrets, as written otherwise, empty when unset. */
  display: string;
  setAt?: number;
  /** Why a set value is not being used right now, if it is not. */
  withheld?: string;
}

export async function describe(env: Env, saved: SavedSettings): Promise<SettingView[]> {
  const raw = env as unknown as Record<string, unknown>;
  const withheld = guarded(raw, saved);
  return Promise.all(
    SETTINGS.map(async (def) => {
      const s = saved[def.name];
      const fromEnv = typeof raw[def.name] === "string" && raw[def.name] ? (raw[def.name] as string) : undefined;
      const value = s?.v ?? fromEnv ?? def.default;
      const source: Source = s ? "saved" : fromEnv ? "deployment" : def.default !== undefined ? "default" : "unset";
      const display = value === undefined ? "" : def.kind === "secret" ? await maskSecret(value) : value;
      return {
        name: def.name,
        group: def.group,
        kind: def.kind,
        label: def.label,
        help: def.help,
        required: !!def.required,
        ...(def.options ? { options: def.options } : {}),
        source,
        display,
        ...(s ? { setAt: s.at } : {}),
        ...(withheld.has(def.name) ? { withheld: withheld.get(def.name) } : {}),
      };
    }),
  );
}

/** Is every setting a group needs present in the effective environment? */
export function groupConfigured(group: GroupDef, eff: Env): boolean {
  const raw = eff as unknown as Record<string, unknown>;
  return group.needs.every((n) => typeof raw[n] === "string" && (raw[n] as string).length > 0);
}

/** The owner key's fingerprint, so the panel can say which key is in force. */
export async function ownerFingerprint(env: Env): Promise<string> {
  const norm = (env.JARVIS_SHARED_SECRET ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  return norm ? (await sha256Hex(norm)).slice(0, 8) : "";
}
