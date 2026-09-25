import type { Env } from "../types";
import { err, json, redact } from "../lib/http";
import { stateStub } from "../lib/state-client";
import { saveSettings } from "../lib/settings-store";
import {
  GROUPS,
  SETTINGS,
  applyChanges,
  describe,
  effectiveEnv,
  groupConfigured,
  ownerFingerprint,
  validateChanges,
  type Group,
  type SavedSettings,
} from "../lib/settings";
import { carState } from "../tools/tessie";
import { ping as hermesPing, hermesConfig } from "../tools/hermes";
import * as google from "../lib/google";
import * as spotify from "../lib/spotify";
import { loadServers } from "../lib/config-store";
import { probe as mcpProbe } from "./mcp";
import { deliver, makeAlert, summarise } from "../lib/alerts";
import { recognitionHints, speechConfig, synthesize, transcribe } from "../lib/speech";
import { listCameras, snapshot } from "../lib/cameras";

/**
 * The settings panel's API. Owner-only (lib/scopes.ts).
 *
 *   GET  /api/settings        every setting: where it comes from, masked if secret
 *   PUT  /api/settings        {changes: {NAME: value | null}} — null clears
 *   POST /api/settings/test   {group, values?} — a real check, optionally of
 *                             values not yet saved
 *
 * `env` here is the Worker's OWN environment, not the effective one the other
 * routes get: this route has to tell a saved value from a deployment value.
 */
export async function handleSettings(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/api/settings/test") {
    if (req.method !== "POST") return err(405, "POST a group to test");
    return test(req, env, url.origin);
  }

  if (req.method === "GET") return json(await view(env, await freshSaved(env)));

  if (req.method === "PUT") {
    const body = (await req.json().catch(() => null)) as { changes?: unknown } | null;
    const checked = validateChanges(body?.changes);
    if (!checked.ok) return json({ saved: false, errors: checked.errors }, { status: 422 });

    const before = effectiveEnv(env, await freshSaved(env));
    let saved: SavedSettings;
    try {
      saved = await saveSettings(env, checked.changes);
    } catch (e) {
      return err(503, e instanceof Error ? e.message : String(e));
    }
    const after = effectiveEnv(env, saved);
    await sideEffects(env, before, after);
    return json({ saved: true, ...(await view(env, saved)) });
  }

  return err(405, "GET, PUT, or POST /api/settings/test");
}

/** Straight from the Durable Object: the panel must not show a 15-second-old copy. */
async function freshSaved(env: Env): Promise<SavedSettings> {
  const state = stateStub(env);
  return state ? await state.getSettings() : {};
}

async function view(env: Env, saved: SavedSettings) {
  const eff = effectiveEnv(env, saved);
  const [settings, owner, googleLinked, spotifyLinked] = await Promise.all([
    describe(env, saved),
    ownerFingerprint(env),
    google.isLinked(env).catch(() => false),
    spotify.isLinked(env).catch(() => false),
  ]);
  return {
    owner: {
      fingerprint: owner,
      howToChange: "npx wrangler secret put JARVIS_SHARED_SECRET",
    },
    storage: !!env.STATE,
    groups: GROUPS.map((g) => ({
      id: g.id,
      title: g.title,
      intro: g.intro,
      testable: g.testable,
      configured: groupConfigured(g, eff),
      ...(g.id === "google" ? { linked: googleLinked } : {}),
      ...(g.id === "spotify" ? { linked: spotifyLinked } : {}),
    })),
    settings,
  };
}

/**
 * What else has to happen when a setting changes, beyond storing it.
 *
 * A new OAuth client cannot use a refresh token issued to the old one, so the
 * link is dropped and the panel asks for it again rather than failing later
 * with invalid_grant. A new Home Assistant address or token makes the cached
 * tool list stale, so it is cleared.
 */
async function sideEffects(env: Env, before: Env, after: Env): Promise<void> {
  const changed = (k: keyof Env) => (before[k] ?? "") !== (after[k] ?? "");
  const jobs: Promise<unknown>[] = [];
  if (changed("GOOGLE_CLIENT_ID") || changed("GOOGLE_CLIENT_SECRET")) jobs.push(google.unlink(env));
  if (changed("SPOTIFY_CLIENT_ID") || changed("SPOTIFY_CLIENT_SECRET")) jobs.push(spotify.unlink(env));
  if (changed("HA_MCP_URL") || changed("HA_TOKEN")) {
    const labels = (await loadServers(before).catch(() => [])).map((s) => s.label);
    for (const l of new Set([...labels, "home-assistant"])) {
      jobs.push(env.CONFIG.delete(`mcp:catalog:${l}`).catch(() => {}));
    }
  }
  await Promise.allSettled(jobs);
}

/* ---------- testing a section --------------------------------------------- */

interface TestResult {
  ok: boolean;
  detail: string;
}

async function test(req: Request, env: Env, origin: string): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { group?: unknown; values?: unknown } | null;
  const group = GROUPS.find((g) => g.id === body?.group);
  if (!group) return err(400, "group must be one of " + GROUPS.map((g) => g.id).join(", "));
  if (!group.testable) return err(400, `${group.title} has nothing to test`);

  // Unsaved values from the form are tested exactly as they would run once
  // saved — including the rebinding guard, so a test cannot be used to send a
  // stored secret to a new address either.
  let saved = await freshSaved(env);
  if (body?.values !== undefined) {
    const checked = validateChanges(body.values);
    if (!checked.ok) return json({ ok: false, detail: Object.values(checked.errors).join("; "), errors: checked.errors });
    saved = applyChanges(saved, checked.changes);
  }
  const eff = effectiveEnv(env, saved);

  let result: TestResult;
  try {
    result = await TESTS[group.id as Group]!(eff, origin);
  } catch (e) {
    result = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  return json({ ok: result.ok, detail: scrub(result.detail, eff) });
}

/** No secret leaves in an error message, whatever the service chose to echo. */
function scrub(text: string, eff: Env): string {
  let out = redact(text);
  const raw = eff as unknown as Record<string, unknown>;
  for (const def of SETTINGS) {
    const v = raw[def.name];
    if (def.kind === "secret" && typeof v === "string" && v.length >= 8) out = out.split(v).join("***");
  }
  return out.slice(0, 800);
}

const timeout = () => AbortSignal.timeout(15_000);

const TESTS: Partial<Record<Group, (eff: Env, origin: string) => Promise<TestResult>>> = {
  async openai(eff) {
    if (!eff.OPENAI_API_KEY) return { ok: false, detail: "No key set." };
    const r = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${eff.OPENAI_API_KEY}` },
      signal: timeout(),
    });
    if (r.ok) {
      const n = ((await r.json()) as { data?: unknown[] }).data?.length ?? 0;
      return { ok: true, detail: `Key accepted. ${n} models available.` };
    }
    if (r.status === 401) return { ok: false, detail: "OpenAI refused the key." };
    if (r.status === 429) return { ok: false, detail: "OpenAI answered 429: out of credit or rate-limited." };
    return { ok: false, detail: `OpenAI answered ${r.status}.` };
  },

  async car(eff) {
    // The car's own read tool: exercises the token, the VIN and the units.
    const out = (await carState.run({ what: "battery" }, {
      env: eff,
      signal: timeout(),
    } as never)) as string;
    const ok = /^Battery \d/.test(out);
    return { ok, detail: out };
  },

  async home(eff) {
    const parts: string[] = [];
    let ok = true;
    if (eff.HA_MCP_URL) {
      const r = await mcpProbe(eff.HA_MCP_URL, {});
      ok &&= r.ok;
      parts.push(r.ok ? `MCP reachable: ${r.toolCount} tools offered.` : `MCP failed: ${r.error}`);
    } else {
      ok = false;
      parts.push("No MCP URL set.");
    }
    if (eff.HA_BASE_URL && eff.HA_TOKEN) {
      const r = await fetch(new URL("/api/", eff.HA_BASE_URL), {
        headers: { Authorization: `Bearer ${eff.HA_TOKEN}` },
        signal: timeout(),
      });
      ok &&= r.ok;
      parts.push(r.ok ? "Base URL and token accepted." : `Base URL answered ${r.status}${r.status === 401 ? " — token refused" : ""}.`);
    } else if (eff.HA_BASE_URL || eff.HA_TOKEN) {
      parts.push("Base URL and token go together; one is missing, so cameras and the glasses' fast path are off.");
    }
    return { ok, detail: parts.join(" ") };
  },

  async hermes(eff) {
    if (!hermesConfig(eff)) return { ok: false, detail: "Needs a base URL and an API key." };
    const r = await hermesPing(eff, timeout());
    return r.ok
      ? { ok: true, detail: `Hermes answered in ${r.ms} ms${r.models.length ? `: ${r.models.join(", ")}` : ""}.` }
      : { ok: false, detail: `Hermes answered ${r.status}: ${r.detail}` };
  },

  async google(eff, origin) {
    const cfg = google.googleConfig(eff, origin);
    if (!cfg) return { ok: false, detail: "Needs a client ID and a client secret." };
    if (!(await google.isLinked(eff))) return { ok: false, detail: "Client set, but no account is linked yet — press Link." };
    const r = await google.call(eff, cfg, "/users/me/profile", { signal: timeout() });
    const who = (r.body as { emailAddress?: string } | null)?.emailAddress;
    return r.status === 200
      ? { ok: true, detail: `Linked and working${who ? ` for ${who}` : ""}.` }
      : { ok: false, detail: google.explain(r) ?? `Google answered ${r.status}.` };
  },

  async spotify(eff, origin) {
    const cfg = spotify.spotifyConfig(eff, origin);
    if (!cfg) return { ok: false, detail: "Needs a client ID and a client secret." };
    if (!(await spotify.isLinked(eff))) return { ok: false, detail: "Client set, but no account is linked yet — press Link." };
    const r = await spotify.call(eff, cfg, "/me", { signal: timeout() });
    const who = (r.body as { display_name?: string } | null)?.display_name;
    return r.status === 200
      ? { ok: true, detail: `Linked and working${who ? ` for ${who}` : ""}.` }
      : { ok: false, detail: spotify.explain(r) ?? `Spotify answered ${r.status}.` };
  },

  async maps(eff) {
    if (!eff.GOOGLE_MAPS_API_KEY) return { ok: false, detail: "No server key set." };
    const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    u.searchParams.set("address", "Eiffel Tower, Paris");
    u.searchParams.set("key", eff.GOOGLE_MAPS_API_KEY);
    const r = (await (await fetch(u, { signal: timeout() })).json()) as { status?: string; error_message?: string };
    const embed = eff.GOOGLE_MAPS_EMBED_KEY
      ? " The browser key cannot be tested from here — it only works from this site; ask Jarvis to show a place."
      : " No browser key, so maps cannot be shown on screen.";
    return r.status === "OK"
      ? { ok: true, detail: `Server key works.${embed}` }
      : { ok: false, detail: `Google said ${r.status}${r.error_message ? `: ${r.error_message}` : ""}.` };
  },

  async alerts(eff) {
    const state = stateStub(eff);
    if (!state) return { ok: false, detail: "Alerts need the STATE Durable Object." };
    const alert = makeAlert(
      { title: "Jarvis test", text: "This is a test alert from Jarvis. If you can read this, this channel works." },
      "test",
    )!;
    // Every channel, each reported — not the first that works.
    const d = await deliver(eff, state, alert, { every: true });
    return { ok: !!d.deliveredBy, detail: summarise(d) };
  },

  async cameras(eff) {
    const list = await listCameras(eff);
    if (!list.length) {
      return {
        ok: false,
        detail: eff.HA_BASE_URL || eff.CAMERAS
          ? "No cameras found: Home Assistant listed none, and none are added here."
          : "No cameras yet: set up the Home section for Home Assistant's, or add snapshot addresses here.",
      };
    }
    // A small frame from each: proves the address, the password and that it is a picture.
    const shown = list.slice(0, 8);
    const results = await Promise.all(
      shown.map(async (c) => {
        const s = await snapshot(eff, c.id, 320);
        return s.ok ? `✓ ${c.name} (${Math.max(1, Math.round(s.bytes.byteLength / 1024))} KB)` : `✗ ${c.name}: ${s.error}`;
      }),
    );
    const more = list.length > shown.length ? `; and ${list.length - shown.length} more not tried` : "";
    return { ok: results.every((r) => r.startsWith("✓")), detail: results.join("; ") + more };
  },

  async voice(eff) {
    // A round trip: say a sentence, then hear it back. Both halves in one press.
    const cfg = speechConfig(eff);
    const said = "Jarvis here, testing one, two, three.";
    const s = await synthesize(eff, said, "mp3");
    if (!s.ok) return { ok: false, detail: `Speaking failed: ${s.error}` };
    const h = await transcribe(eff, s.audio, "audio/mpeg", recognitionHints(null));
    if (!h.ok) return { ok: false, detail: `Spoke it (${s.by}), but hearing it back failed: ${h.error}` };
    const notes: string[] = [];
    if ((cfg.stt === "workers-ai" || cfg.tts === "workers-ai") && !cfg.workersAi) {
      notes.push("Workers AI is not bound on this deployment, so OpenAI stood in.");
    }
    if (cfg.stt === "browser" || cfg.tts === "browser") {
      notes.push("\"browser\" happens on each device; this tested the OpenAI fallback it uses where a device has none.");
    }
    const ok = /testing/i.test(h.text) && /three|3/i.test(h.text);
    return {
      ok,
      detail: `Spoke "${said}" with ${s.by}${s.by === "openai" ? ` (${cfg.voice})` : ""}; heard back with ${h.by}: "${h.text}".${notes.length ? " " + notes.join(" ") : ""}`,
    };
  },

  async locale(eff) {
    const tz = eff.TIMEZONE || "UTC";
    const now = new Intl.DateTimeFormat(eff.LOCALE || "en", {
      timeZone: tz, weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "shortOffset",
    }).format(new Date());
    const units = (eff.UNITS || "metric") === "imperial" ? "miles" : "kilometres";
    return {
      ok: true,
      detail: `It is ${now} in ${tz}. Distances in ${units}${eff.COUNTRY ? `, directions biased to ${eff.COUNTRY.toUpperCase()}` : ""}.`,
    };
  },
};
