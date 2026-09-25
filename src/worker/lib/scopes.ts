/**
 * What a credential is allowed to reach.
 *
 * Two layers, deliberately separate. Tools carry a scope so the router is only
 * ever *shown* what the caller may use — a tool that is absent cannot be talked
 * into existence, which is why this is a filter and not a prompt instruction.
 * Routes carry a scope so the HTTP surface is gated before any handler runs.
 *
 * The owner — whoever holds JARVIS_SHARED_SECRET — bypasses all of it.
 */

export const SCOPES = [
  "ask",
  "memory.read",
  "memory.write",
  "car.read",
  "car.control",
  "home",
  "media",
  "mail",
  "calendar",
  "screen",
  "voice",
  "alerts",
  "routines",
] as const;

export type Scope = (typeof SCOPES)[number];

/** Everything, including capabilities that do not exist yet. */
export const WILDCARD = "*";

export type Grant = Scope | typeof WILDCARD;

const KNOWN = new Set<string>(SCOPES);

export function isScope(v: unknown): v is Grant {
  return typeof v === "string" && (v === WILDCARD || KNOWN.has(v));
}

/** Drop anything unrecognised rather than failing — a stored grant may predate a rename. */
export function saneGrants(raw: unknown): Grant[] {
  if (!Array.isArray(raw)) return [];
  const out: Grant[] = [];
  for (const g of raw) if (isScope(g) && !out.includes(g)) out.push(g);
  return out;
}

/**
 * Does this set of grants cover that scope?
 *
 * The wildcard is the whole reason this is a function rather than a `Set.has`:
 * a device granted `*` picks up new capabilities the moment they are added,
 * with no token re-issue. That is the intent for a personally-owned device, and
 * it is also the sharpest edge in the design — see docs/api.md.
 */
export function allows(grants: readonly Grant[], needed: Scope): boolean {
  return grants.includes(WILDCARD) || grants.includes(needed);
}

/* ---------- the HTTP surface --------------------------------------------- */

/**
 * `"owner"` means no device token may reach it, whatever it holds.
 * `"any"` means an authenticated caller of any kind may.
 */
export type RouteRequirement = Scope | "owner" | "any";

/**
 * What a path requires.
 *
 * This MUST mirror the order in index.ts, which matches some paths by prefix
 * *before* the exact switch — so `/api/mcpanything` lands in `handleMcp`. If the
 * table below only matched exact paths, a device would slip through that gap
 * into the broadest-reach handler in the codebase.
 *
 * Unmatched paths resolve to `"owner"`. Every route added in future is therefore
 * closed to devices until someone deliberately opens it, which is the correct
 * direction for that mistake to fail in.
 */
export function requiredScope(pathname: string, method: string): RouteRequirement {
  const m = method.toUpperCase();

  // Prefix matches first, exactly as the router does them.
  if (pathname.startsWith("/api/mcp")) return "owner";
  if (pathname.startsWith("/api/spotify")) return "owner";
  // Linking, unlinking and inspecting the Google grant are administrative: they
  // affect the credential itself, not the mail a device is allowed to read. A
  // device with `mail` gets the tools and nothing else.
  if (pathname.startsWith("/api/google")) return "owner";
  if (pathname.startsWith("/api/memory")) {
    if (pathname === "/api/memory/search") return "memory.read";
    if (pathname === "/api/memory") return m === "GET" ? "memory.read" : "owner";
    return "owner";
  }
  if (pathname.startsWith("/api/v1/devices")) return "owner";
  // Which model reads the house and the mailbox. Covered by the default below
  // anyway; stated so nobody later mistakes it for something a device may set.
  if (pathname.startsWith("/api/router")) return "owner";
  // Every credential Jarvis holds. Covered by the default too; stated so it is
  // never mistaken for something a device may read or change.
  if (pathname.startsWith("/api/settings")) return "owner";
  // Which devices get notifications, and every recent alert's text.
  if (pathname.startsWith("/api/alerts")) return "owner";

  switch (pathname) {
    // How any client checks a credential, so it cannot itself need a scope.
    case "/api/health":
      return "any";

    case "/api/delegate":
    case "/api/v1/ask":
    case "/api/v1/stream":
    // Even Realities G2 glasses: the same delegation in the shape their app reads.
    case "/api/v1/chat/completions":
      return "ask";

    case "/api/session":
    case "/api/tts":
    case "/api/voices":
    // Push-to-talk. It also needs `ask`, checked in the route: it asks things.
    case "/api/v1/voice":
      return "voice";

    case "/api/map":
      return "screen";

    // Receiving alerts, and raising one. The same scope for both: a device
    // that may be told things may also ask to be told something.
    case "/api/v1/events":
    case "/api/v1/events/ticket":
    case "/api/v1/push":
    case "/api/v1/notify":
    case "/api/v1/alerts":
      return "alerts";

    // Routines: listing, making and changing them, and sending the events
    // that set them off. A routine's question runs with its creator's grants,
    // so this does not widen what a device can reach.
    case "/api/v1/routines":
    case "/api/v1/routines/run":
    case "/api/v1/trigger":
      return "routines";

    // Background jobs. A job asks things, so `ask`; one for Hermes also needs
    // `home`, checked in the route. Each runs with its creator's grants.
    case "/api/v1/jobs":
    case "/api/v1/jobs/cancel":
      return "ask";
    case "/api/camera":
      return "home";

    // Diagnostics and the stored probe runs are the owner's business.
    case "/api/diag":
    case "/api/probe":
      return "owner";

    default:
      return "owner";
  }
}
