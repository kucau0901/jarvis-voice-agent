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
      headers:
        headers && typeof headers === "object"
          ? (headers as Record<string, string>)
          : undefined,
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
 * Matched by label, then by URL, so renaming a server or moving it keeps its
 * token; changing both at once is a new server as far as this can tell, and
 * the mask is dropped rather than stored as a literal "***".
 */
export function restoreMasked(
  incoming: McpServerConfig[],
  current: McpServerConfig[],
): McpServerConfig[] {
  return incoming.map((s) => {
    const was = current.find((c) => c.label === s.label) ?? current.find((c) => c.url === s.url);
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
