import { readFileSync } from "node:fs";
import {
  GROUPS,
  NOT_SETTINGS,
  SETTINGS,
  applyChanges,
  describe,
  effectiveEnv,
  guarded,
  maskSecret,
  ownerFingerprint,
  settingDef,
  validateChanges,
  RENAMED,
  type SavedSettings,
} from "../src/worker/lib/settings.ts";
import { localeOf, utcOffset, countryName } from "../src/worker/lib/locale.ts";
import { StateHost } from "../src/worker/lib/state-host.ts";
import { withSettings, saveSettings, _resetSettingsCache } from "../src/worker/lib/settings-store.ts";
import { requiredScope } from "../src/worker/lib/scopes.ts";
import { publicOrigin } from "../src/worker/lib/http.ts";
import { googleConfig } from "../src/worker/lib/google.ts";
import { carState, distanceIn, imperialState } from "../src/worker/tools/tessie.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 260) : "");
  }
}

const HA_TOKEN = "eyJhbGciOiJIUzI1NiJ9.deployment-token-abcdefghijklmnop";
const env = (extra: Record<string, unknown> = {}) =>
  ({
    CONFIG: { marker: "kv" },
    JARVIS_SHARED_SECRET: "NOTAREALKEY12345",
    HA_BASE_URL: "https://home.example",
    HA_TOKEN,
    HERMES_BASE_URL: "https://hermes.example",
    HERMES_API_KEY: "hermes-deployment-key-1234567890",
    ...extra,
  }) as never;

console.log("the catalogue is complete");
{
  // Every Env field is either a setting or deliberately not one, so a field
  // added later cannot silently escape the panel.
  const src = readFileSync(new URL("../src/worker/types.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export interface Env {"));
  const fields = [...body.matchAll(/^\s+([A-Z][A-Z0-9_]+)\??:/gm)].map((m) => m[1]!);
  const covered = new Set([...SETTINGS.map((s) => s.name), ...Object.keys(NOT_SETTINGS)]);
  const missing = fields.filter((f) => !covered.has(f));
  check(`every Env field (${fields.length}) is a setting or listed as not one`, missing.length === 0, missing);
  check("no setting is declared twice", new Set(SETTINGS.map((s) => s.name)).size === SETTINGS.length);
  check("every setting belongs to a real group", SETTINGS.every((s) => GROUPS.some((g) => g.id === s.group)));
  check("every binding names a real secret", SETTINGS.every((s) => (s.bindsTo ?? []).every((b) => settingDef(b)?.kind === "secret")));
  check("every group's needs are real settings", GROUPS.every((g) => g.needs.every((n) => !!settingDef(n))));
  check("the owner key is never a setting", !settingDef("JARVIS_SHARED_SECRET"));
  check("all 18 deployment secrets are editable",
    ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_MAPS_API_KEY",
      "GOOGLE_MAPS_EMBED_KEY", "HA_BASE_URL", "HA_MCP_URL", "HA_TOKEN", "HERMES_API_KEY", "HERMES_BASE_URL",
      "HERMES_MODEL", "OPENAI_API_KEY", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "TESSIE_TOKEN", "TESSIE_VIN"]
      .every((n) => !!settingDef(n)));
}

console.log("\na secret never leaves in plaintext");
{
  let leaked = 0;
  for (let len = 8; len <= 90; len += 7) {
    const v = Array.from({ length: len }, (_, i) => "abcdefghijkmnpqrstuvwxyz0123456789"[(i * 7 + len) % 34]).join("");
    const m = await maskSecret(v);
    if (m.includes(v) || m.includes(v.slice(0, 8)) || (v.length < 24 && m.includes(v.slice(-4)))) leaked++;
  }
  check("masking never contains the value, its start, or (when short) its end", leaked === 0, leaked);
  check("the mask carries a fingerprint", /sha256 [0-9a-f]{8}$/.test(await maskSecret("sk-live-abcdefghijklmnopqrstuv")));

  const saved: SavedSettings = { OPENAI_API_KEY: { v: "sk-saved-0123456789abcdefghijkl", at: 1 } };
  const view = JSON.stringify(await describe(env(), saved));
  check("GET never contains a saved secret", !view.includes("sk-saved-0123456789abcdefghijkl"));
  check("GET never contains a deployment secret", !view.includes(HA_TOKEN) && !view.includes("hermes-deployment-key"));
  check("a URL is shown as written", view.includes("https://home.example"));
  check("the owner fingerprint is not the key", (await ownerFingerprint(env())).length === 8 && !(await ownerFingerprint(env())).includes("NOTA"));
}

console.log("\nprecedence: saved, then the deployment, then the default");
{
  const d = await describe(env(), { HERMES_MODEL: { v: "hermes-2", at: 5 } });
  const by = (n: string) => d.find((x) => x.name === n)!;
  check("saved", by("HERMES_MODEL").source === "saved" && by("HERMES_MODEL").display === "hermes-2");
  check("deployment", by("HA_BASE_URL").source === "deployment");
  check("default", by("UNITS").source === "default" && by("UNITS").display === "metric");
  check("unset", by("TESSIE_TOKEN").source === "unset" && by("TESSIE_TOKEN").display === "");

  const eff = effectiveEnv(env(), { HA_BASE_URL: { v: "https://home.example", at: 5 } }) as unknown as Record<string, unknown>;
  check("effective env keeps bindings by identity", eff.CONFIG === (env() as unknown as { CONFIG: unknown }).CONFIG || (eff.CONFIG as { marker: string }).marker === "kv");
  const cleared = applyChanges({ HERMES_MODEL: { v: "x", at: 1 } }, { HERMES_MODEL: null });
  check("null clears a saved value", !("HERMES_MODEL" in cleared));
}

console.log("\nvalidation");
{
  const bad = validateChanges({ OPENAI_API_KEY: "sk-good-0123456789abcdef", TESSIE_VIN: "short" });
  check("one bad field rejects the whole batch", !bad.ok && "TESSIE_VIN" in bad.errors && !("OPENAI_API_KEY" in (bad as { errors: object }).errors));
  const nope = validateChanges({ JARVIS_SHARED_SECRET: "X" });
  check("the owner key is refused, with the reason", !nope.ok && /deploy-time/.test(nope.errors.JARVIS_SHARED_SECRET!));
  check("an unknown name is refused", !validateChanges({ NOT_A_THING: "x" }).ok);
  check("empty is refused — Clear is the way to remove", !validateChanges({ HERMES_MODEL: "  " }).ok);
  const b = validateChanges({ DISABLE_WEB_SEARCH: "on", HA_ASSIST: "off" });
  check("booleans are normalised to 1/0", b.ok && b.changes.DISABLE_WEB_SEARCH === "1" && b.changes.HA_ASSIST === "0");
  check("an enum must be one of its options", !validateChanges({ UNITS: "furlongs" }).ok);
  check("a swapped Access pair is caught", !validateChanges({ CF_ACCESS_CLIENT_SECRET: "abc123.access" }).ok);
  check("a bad time zone is caught", !validateChanges({ TIMEZONE: "Mars/Olympus" }).ok);
  check("a real time zone passes", validateChanges({ TIMEZONE: "Asia/Kuala_Lumpur" }).ok);
  check("http is refused for a URL", !validateChanges({ HA_BASE_URL: "http://home.example" }).ok);
  check("values are trimmed", (validateChanges({ HERMES_MODEL: "  hermes-3  " }) as { changes: Record<string, string> }).changes.HERMES_MODEL === "hermes-3");
}

console.log("\nthe rebinding guard: a secret never follows a changed address");
{
  const token = (saved: SavedSettings) => (effectiveEnv(env(), saved) as unknown as { HA_TOKEN: string }).HA_TOKEN;
  check("untouched, the deployment token is used", token({}) === HA_TOKEN);
  check("URL changed alone: the deployment token is withheld",
    token({ HA_BASE_URL: { v: "https://evil.example", at: 10 } }) === "");
  check("URL and token saved together: used",
    token({ HA_BASE_URL: { v: "https://new.example", at: 10 }, HA_TOKEN: { v: "new-token-0123456789abcdef", at: 10 } }) === "new-token-0123456789abcdef");
  check("a token saved BEFORE the URL changed is withheld",
    token({ HA_TOKEN: { v: "old-saved-0123456789abcdef", at: 5 }, HA_BASE_URL: { v: "https://evil.example", at: 10 } }) === "");
  check("a token saved AFTER the URL changed is used",
    token({ HA_BASE_URL: { v: "https://new.example", at: 10 }, HA_TOKEN: { v: "later-0123456789abcdefgh", at: 11 } }) === "later-0123456789abcdefgh");
  check("re-saving the SAME URL withholds nothing",
    token({ HA_BASE_URL: { v: "https://home.example", at: 10 } }) === HA_TOKEN);

  // The two-step dodge: change the URL, then clear the saved token so the
  // deployment's copy would come back. It must not.
  let s: SavedSettings = { HA_TOKEN: { v: "saved-0123456789abcdefgh", at: 1 } };
  s = applyChanges(s, { HA_BASE_URL: "https://evil.example" }, 10);
  s = applyChanges(s, { HA_TOKEN: null }, 11);
  check("clearing the token after moving the URL does not bring the deployment copy back", token(s) === "");

  const hermes = effectiveEnv(env(), { HERMES_BASE_URL: { v: "https://evil.example", at: 10 } }) as unknown as Record<string, string>;
  check("Hermes: key and Access pair all withheld", hermes.HERMES_API_KEY === "" && hermes.CF_ACCESS_CLIENT_SECRET === "");
  check("the MCP URL is guarded too", token({ HA_MCP_URL: { v: "https://evil.example/mcp", at: 10 } }) === "");

  const d = await describe(env(), { HA_BASE_URL: { v: "https://evil.example", at: 10 } });
  check("the panel says why a token is not being used", /changed/.test(d.find((x) => x.name === "HA_TOKEN")!.withheld ?? ""));
  check("guarded() and effectiveEnv agree", guarded(env() as never, { HA_BASE_URL: { v: "https://evil.example", at: 10 } }).has("HA_TOKEN"));
}

console.log("\nstored in the Durable Object");
{
  const m = new Map<string, unknown>();
  const storage = { get: async (k: string) => structuredClone(m.get(k)) as never, put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)) };
  const host = new StateHost(storage, env() as never);
  check("empty to begin with", Object.keys(await host.getSettings()).length === 0);
  await host.putSettings({ TIMEZONE: "Asia/Kuala_Lumpur", UNITS: "metric" }, 100);
  await host.putSettings({ UNITS: null }, 200);
  const got = await host.getSettings();
  check("saved, with the time it was saved", got.TIMEZONE?.v === "Asia/Kuala_Lumpur" && got.TIMEZONE.at === 100);
  check("cleared", !("UNITS" in got));

  _resetSettingsCache();
  const e = { ...(env() as object), STATE: { idFromName: () => "jarvis", get: () => host } } as never;
  await saveSettings(e, { COUNTRY: "MY" });
  const eff = (await withSettings(e)) as unknown as Record<string, string>;
  check("a request sees what was just saved, with no wait", eff.COUNTRY === "MY" && eff.TIMEZONE === "Asia/Kuala_Lumpur");
  _resetSettingsCache();
  const noStore = (await withSettings(env())) as unknown as Record<string, string>;
  check("with no Durable Object, the deployment values stand", noStore.HA_BASE_URL === "https://home.example");
}

console.log("\na setting saved under an old name");
{
  // What an older version stored: the glasses-only names for the Assist settings.
  const m = new Map<string, unknown>([["settings:v1", { G2_FASTPATH: { v: "0", at: 50 }, G2_HA_LANGUAGE: { v: "ms", at: 50 } }]]);
  const storage = { get: async (k: string) => structuredClone(m.get(k)) as never, put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)) };
  const host = new StateHost(storage, env() as never);
  const got = await host.getSettings();
  check("is read under its new name", got.HA_ASSIST?.v === "0" && got.HA_ASSIST_LANGUAGE?.v === "ms", got);
  const eff = effectiveEnv(env() as never, got) as unknown as Record<string, string>;
  check("and takes effect", eff.HA_ASSIST === "0" && eff.HA_ASSIST_LANGUAGE === "ms");
  await host.putSettings({ HA_ASSIST: "1" }, 60);
  const after = await host.getSettings();
  check("until it is saved again under the new one", after.HA_ASSIST?.v === "1" && after.HA_ASSIST_LANGUAGE?.v === "ms", after);
  check("every renamed setting exists under its new name", Object.values(RENAMED).every((n) => settingDef(n)));
}

console.log("\nlocale instead of Malaysia");
{
  const l0 = localeOf(env());
  check("neutral defaults: UTC, English, metric, no country",
    l0.timeZone === "UTC" && l0.language === "en" && l0.units === "metric" && !l0.country);
  const my = localeOf(env({ TIMEZONE: "Asia/Kuala_Lumpur", COUNTRY: "my", LOCALE: "en", UNITS: "metric" }));
  check("Malaysia, from settings", my.timeZone === "Asia/Kuala_Lumpur" && my.country === "MY" && my.tag === "en-MY");
  check("a bad time zone falls back to UTC rather than throwing", localeOf(env({ TIMEZONE: "Nowhere/Nope" })).timeZone === "UTC");
  check("Kuala Lumpur is +08:00", utcOffset("Asia/Kuala_Lumpur") === "+08:00");
  check("UTC is +00:00", utcOffset("UTC") === "+00:00");
  check("a country code has a name", countryName(my) === "Malaysia");
  check("imperial is honoured", localeOf(env({ UNITS: "imperial" })).units === "imperial");
}

console.log("\nthe car in the user's units");
{
  check("metric: 176 mi is 283 km", JSON.stringify(distanceIn(176, "metric")) === '{"n":283,"unit":"km"}');
  check("imperial: 176 mi stays 176 miles", JSON.stringify(distanceIn(176, "imperial")) === '{"n":176,"unit":"miles"}');
  const dump = imperialState({ vehicle_state: { odometer: 14096.5 }, drive_state: { speed: 60 } }) as Record<string, Record<string, unknown>>;
  check("imperial dump names its units", dump.vehicle_state!.odometer_mi === 14096.5 && dump.drive_state!.speed_mph === 60, dump);

  globalThis.fetch = (async (u: string | URL | Request) => {
    const url = String(u instanceof Request ? u.url : u);
    return new Response(JSON.stringify(url.includes("/battery") ? { battery_level: 69, battery_range: 176 } : {}), { status: 200 });
  }) as typeof fetch;
  const read = (UNITS: string) =>
    carState.run({ what: "battery" }, { env: env({ TESSIE_TOKEN: "t", TESSIE_VIN: "LRWTEST0000000000", UNITS }), signal: new AbortController().signal } as never) as Promise<string>;
  check("metric battery line", (await read("metric")) === "Battery 69%, range 283 km.", await read("metric"));
  check("imperial battery line", (await read("imperial")) === "Battery 69%, range 176 miles.", await read("imperial"));
}

console.log("\nbehind a proxy: PUBLIC_URL fixes the sign-in return address");
{
  // Behind Caddy in Docker the Worker sees the proxy's plain-http hop, and
  // Google refuses "http://…/callback" — measured before this setting existed.
  check("no PUBLIC_URL: the request's own origin", publicOrigin({}, "https://jarvis.example.com") === "https://jarvis.example.com");
  check("PUBLIC_URL wins over the proxy's http origin",
    publicOrigin({ PUBLIC_URL: "https://jarvis.example.com" }, "http://jarvis.example.com") === "https://jarvis.example.com");
  check("only its origin is used, never a path", publicOrigin({ PUBLIC_URL: "https://jarvis.example.com/app/" }, "x") === "https://jarvis.example.com");
  check("a malformed value falls back rather than throwing", publicOrigin({ PUBLIC_URL: "not a url" }, "https://a.example") === "https://a.example");
  const cfg = googleConfig({ GOOGLE_CLIENT_ID: "1.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "s", PUBLIC_URL: "https://jarvis.example.com" } as never, "http://jarvis.example.com");
  check("Google's redirect URI uses it", cfg?.redirectUri === "https://jarvis.example.com/api/google/callback", cfg?.redirectUri);
  check("http is refused for it in the panel", !validateChanges({ PUBLIC_URL: "http://jarvis.example.com" }).ok);
}

console.log("\nonly the owner reaches it");
{
  for (const [p, m] of [["/api/settings", "GET"], ["/api/settings", "PUT"], ["/api/settings/test", "POST"]] as const) {
    check(`${m} ${p} is owner-only`, requiredScope(p, m) === "owner");
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
