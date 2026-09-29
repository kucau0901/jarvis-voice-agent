/**
 * Which MCP servers are in force, decided in exactly one place.
 *
 * There used to be two answers. The router's loader treated an empty saved
 * list as "use the repo seed"; the settings panel's reader showed the empty
 * list as it was. KV held `{"servers":[]}`, so Jarvis used the seed's Home
 * Assistant server and its 11 tools while the panel showed no servers at all —
 * the one screen meant to answer "what is Jarvis connected to" answered it
 * wrongly. Both now call `resolveConfigured()`, so they cannot drift again.
 *
 * Kept apart from config-store.ts, which imports the seed JSON: Node's test
 * runner will not load a bare JSON import, and this is the part worth testing.
 */

import { NOT_SETTINGS, SETTINGS, settingDef } from "./settings.ts";

export interface McpServerConfig {
  label: string;
  url: string;
  headers?: Record<string, string>;
  allowedTools?: string[];
  enabled?: boolean;
  hint?: string;
  /**
   * What to call this out loud. `label` is the tool-name prefix and belongs to
   * the plumbing — "asking home-assistant" is not a sentence anyone says. When
   * absent the label is used, which is only ever right by accident.
   */
  spokenAs?: string;
}

/**
 * Header values as text. A number or true/false typed without quotes is what
 * was meant; anything else is dropped. Left as it was, one of them broke
 * filling in placeholders, and with it every load of the list.
 */
function headerValues(h: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (typeof v === "string") out[k] = v;
    else if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

/** "saved" came from the settings panel; "default" is config/mcp-servers.json. */
export type ConfigSource = "saved" | "default";

export function sane(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: McpServerConfig[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const { label, url, headers, allowedTools, enabled, hint, spokenAs } =
      s as Record<string, unknown>;
    if (typeof label !== "string" || !label.trim()) continue;
    // A URL may be a ${NAME} placeholder resolved from Worker secrets at call
    // time, so it cannot be required to look like a URL until after expansion.
    if (typeof url !== "string") continue;
    if (!/^https:\/\//i.test(url) && !/^\$\{[A-Z0-9_]+\}$/.test(url.trim())) continue;
    out.push({
      label: label.trim().slice(0, 60),
      url: url.trim(),
      headers: headers && typeof headers === "object" && !Array.isArray(headers) ? headerValues(headers) : undefined,
      allowedTools: Array.isArray(allowedTools)
        ? allowedTools.filter((t): t is string => typeof t === "string")
        : undefined,
      enabled: enabled !== false,
      hint: typeof hint === "string" ? hint.slice(0, 300) : undefined,
      spokenAs: typeof spokenAs === "string" ? spokenAs.trim().slice(0, 60) : undefined,
    });
  }
  return out;
}

/**
 * A saved list wins if it has anything usable in it; otherwise the seed.
 *
 * An empty saved list falls back rather than meaning "none", so removing every
 * server and saving cannot strand the deployment with no tools and no way back
 * from the car. Turning a server off is what `enabled: false` is for: a saved
 * list holding one disabled server is not empty, so it is honoured.
 */
export function resolveConfigured(
  stored: unknown,
  seedServers: unknown,
): { servers: McpServerConfig[]; source: ConfigSource } {
  const fromKv = stored ? sane((stored as { servers?: unknown }).servers) : [];
  return fromKv.length
    ? { servers: fromKv, source: "saved" }
    : { servers: sane(seedServers), source: "default" };
}

/* ---------- ${NAME} placeholders ------------------------------------------ */

const PLACEHOLDER = /\$\{([A-Z0-9_]+)\}/g;

/** Fill every `${NAME}` from `lookup`; an unset name becomes empty, never literal. */
export function expandTemplate(template: string, lookup: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER, (_m, name: string) => {
    const v = lookup[name];
    return typeof v === "string" ? v : "";
  });
}

/**
 * What `${NAME}` may be filled with, for a server at `url`.
 *
 * Placeholders are for secrets set for MCP servers. Jarvis's own keys are
 * another matter: each is only ever sent where its own address points (the
 * rule settings.ts guarded() keeps), and anyone who can edit this list can
 * point a server anywhere. So one of them is filled only for a server at or
 * under an address it is already sent to (the Home Assistant token for Home
 * Assistant's own MCP server, under its Base URL), and never in a URL, where
 * it would be sent to whatever host the rest of the URL names. Under the
 * address, not merely on its host: a host can be shared by path, as a gateway
 * serving many accounts is. The owner key and the per-request values are
 * never filled.
 */
export function fillable(env: Record<string, unknown>, url: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(env)) {
    if (name in NOT_SETTINGS) continue;
    if (settingDef(name)?.kind === "secret") {
      const sentThere = SETTINGS.some((d) => d.bindsTo?.includes(name) && under(url, env[d.name]));
      if (!sentThere) continue;
    }
    out[name] = v;
  }
  return out;
}

/** Whether `url` is `base` or below it: the same origin, and `base`'s path whole segments of `url`'s. */
function under(url: string | null, base: unknown): boolean {
  if (!url || typeof base !== "string" || !base) return false;
  try {
    const u = new URL(url);
    const b = new URL(base);
    const prefix = b.pathname.endsWith("/") ? b.pathname : `${b.pathname}/`;
    return u.origin === b.origin && `${u.pathname}/`.startsWith(prefix);
  } catch {
    return false;
  }
}

/** An address's origin as fetch reaches it (a look-alike name in its xn-- form, no user part), or null. */
export function originOf(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** A Worker secret set for MCP servers: neither a setting nor one of Jarvis's own values. */
const isMcpSecret = (name: string): boolean => !(name in NOT_SETTINGS) && !settingDef(name);

/**
 * Whether a server's address stays put until the owner redeploys: written out
 * in full, or naming only Worker secrets. One that names a setting, such as
 * the seeded `${HA_MCP_URL}`, points wherever whoever changes settings (any
 * family admin) points it, the list untouched.
 */
function fixedAddress(template: string): boolean {
  return [...template.matchAll(PLACEHOLDER)].every((m) => isMcpSecret(m[1]!));
}

/** `lookup` without the Worker secrets set for MCP servers. */
function settingsOnly(lookup: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(lookup).filter(([name]) => !isMcpSecret(name)));
}

/**
 * A server's URL with its placeholders filled.
 *
 * A URL that is one placeholder and nothing else, such as the seeded Home
 * Assistant server's `${HA_MCP_URL}`, is filled from anything: a request to
 * an address tells that address nothing it does not know. Anything else only
 * from what `fillable` allows, and a Worker secret only into an address that
 * stays put (`fixedAddress`).
 */
export function expandUrlTemplate(template: string, env: Record<string, unknown>): string {
  const whole = /^\$\{[A-Z0-9_]+\}$/.test(template.trim());
  if (whole) return expandTemplate(template, env);
  const lookup = fillable(env, null);
  return expandTemplate(template, fixedAddress(template) ? lookup : settingsOnly(lookup));
}

/**
 * Header values with their placeholders filled, for a server whose URL is
 * written as `template`.
 *
 * A server whose address a setting decides gets no secret of its own: not a
 * header typed in as-is, not a Worker secret. Checking where it pointed when
 * the list was saved is not enough, since a setting can be changed later, so
 * this is decided here, on every call, as settings.ts guarded() is. What such
 * a server still gets is Jarvis's own keys that `fillable` allows, which keep
 * to their own addresses.
 */
export function expandHeaderTemplates(headers: Record<string, string> | undefined, env: Record<string, unknown>, template: string): Record<string, string> {
  const fixed = fixedAddress(template);
  const lookup = fillable(env, expandUrlTemplate(template, env));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (!fixed && !/\$\{/.test(v)) continue;
    out[k] = expandTemplate(v, fixed ? lookup : settingsOnly(lookup));
  }
  return out;
}

/** Whether `expandHeaderTemplates` withholds any of these headers from a server whose URL is written as `template`. */
export function withheldFrom(template: string, headers: Record<string, string>): boolean {
  return !fixedAddress(template) &&
    Object.values(headers).some((v) => !/\$\{/.test(v) || [...v.matchAll(PLACEHOLDER)].some((m) => isMcpSecret(m[1]!)));
}

/**
 * Put the placeholders back into text that may contain what they expanded to.
 *
 * For a server whose URL IS the credential — a Nabu Casa webhook URL is — an
 * error message that quotes the address would hand the secret to the settings
 * panel. So anything derived from an expanded template is passed through here
 * before it leaves the Worker. Longest values first, so a secret that contains
 * another is not half-replaced.
 */
export function unexpand(text: string, template: string, lookup: Record<string, unknown>): string {
  const pairs = [...template.matchAll(PLACEHOLDER)]
    .map((m) => [m[0], lookup[m[1]!]] as const)
    .filter((p): p is readonly [string, string] => typeof p[1] === "string" && p[1].length >= 8)
    .sort((a, b) => b[1].length - a[1].length);
  let out = text;
  for (const [placeholder, value] of pairs) out = out.split(value).join(placeholder);
  return out;
}

/* ---------- secrets in the settings panel -------------------------------- */

/**
 * What the panel is shown in place of a header value typed in as-is, and what
 * it sends back to mean "unchanged".
 */
export const MASK = "***";

/**
 * What the panel may see: a `${NAME}` placeholder is shown as written, because
 * it names a secret rather than containing one; anything else is masked.
 */
export function maskForUi(list: McpServerConfig[]): McpServerConfig[] {
  return list.map((s) => ({
    ...s,
    headers: Object.fromEntries(
      Object.entries(s.headers ?? {}).map(([k, v]) => [k, /\$\{/.test(v) ? v : MASK]),
    ),
  }));
}

/**
 * Put stored secrets back wherever the panel sent the mask.
 *
 * The panel never holds a typed-in header value — only MASK — so it cannot
 * send the real one back. It used to drop the header instead, and the Worker
 * saved what arrived: editing anything about a server with a pasted token, or
 * about any OTHER server in the list, silently erased that token and the
 * server started answering 401. Now MASK travels back and means "unchanged",
 * and this restores it from what is in force. A header the user cleared is
 * absent rather than masked, so removing one still works.
 *
 * Matched by label, then by URL, so renaming a server keeps its token. But a
 * token is put back only for the URL it was saved with, exactly as written:
 * every family admin can edit this list, and a server kept under its label
 * with a new URL must not carry the owner's token there, the rule settings.ts
 * guarded() keeps for Jarvis's own keys. Not only the host, which can be
 * shared (Nabu Casa's webhook host is all its customers'), and not where a
 * new URL points today: a `${SETTING}` pointing at the old address now can be
 * pointed elsewhere later. So a server given any new URL needs its token typed
 * again (the panel is told which, by `leftBehind`). Where nothing matches,
 * the mask is dropped rather than stored as a literal "***".
 */
export function restoreMasked(incoming: McpServerConfig[], current: McpServerConfig[]): McpServerConfig[] {
  return incoming.map((s) => {
    const match = current.find((c) => c.label === s.label) ?? current.find((c) => c.url === s.url);
    const was = match?.url === s.url ? match : undefined;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.headers ?? {})) {
      if (v !== MASK) {
        headers[k] = v;
        continue;
      }
      const kept = was?.headers?.[k];
      if (typeof kept === "string" && kept !== MASK) headers[k] = kept;
    }
    return { ...s, headers };
  });
}

/* ---------- Worker secrets set for MCP servers ---------------------------- */

/**
 * Where a server sends each Worker secret set for MCP servers (settings keep
 * to their own addresses, by `fillable`): "NAME URL", for each one in its
 * headers or inside its URL, the URL as written, for the reasons
 * `restoreMasked` gives. A URL that is one placeholder and nothing else is
 * sent only to the address it holds, so it is not counted.
 */
function aimed(s: McpServerConfig): string[] {
  const whole = /^\$\{[A-Z0-9_]+\}$/.test(s.url.trim());
  const text = [...Object.values(s.headers ?? {}), whole ? "" : s.url].join(" ");
  return [...text.matchAll(PLACEHOLDER)]
    .map((m) => m[1]!)
    .filter(isMcpSecret)
    .map((name) => `${name} ${s.url}`);
}

/**
 * The labels of servers in `incoming` that would send a Worker secret to an
 * address the list in force does not already send it to.
 *
 * Such a secret was set with `wrangler secret put` by whoever deploys Jarvis,
 * and has no address of its own to keep to, while every family admin can edit
 * this list. So only the owner key may aim one somewhere new (routes/mcp.ts),
 * anywhere else on the same host included; any admin may keep, rename, turn
 * off or remove a server already using one. Removing it first does not help:
 * then nothing uses it.
 */
export function aimedAnew(incoming: McpServerConfig[], current: McpServerConfig[]): string[] {
  const known = new Set(current.flatMap(aimed));
  return incoming.filter((s) => aimed(s).some((a) => !known.has(a))).map((s) => s.label);
}

/** The labels of servers sent with a mask that `restoreMasked` did not fill. */
export function leftBehind(incoming: McpServerConfig[], restored: McpServerConfig[]): string[] {
  return incoming
    .filter((s, i) => Object.entries(s.headers ?? {}).some(([k, v]) => v === MASK && !(k in (restored[i]?.headers ?? {}))))
    .map((s) => s.label);
}
