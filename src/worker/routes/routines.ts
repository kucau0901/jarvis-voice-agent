import type { Env } from "../types";
import type { Principal } from "../lib/auth";
import { err, json } from "../lib/http";
import { stateStub } from "../lib/state-client";
import { localeOf } from "../lib/locale";
import { Collector } from "../lib/collector";
import { MemoryStore } from "../lib/memory";
import { carWaypoint, drive } from "../lib/travel";
import { EVENT_NAME, describeAction, describeTrigger, type Routine } from "../lib/routines";
import type { Travel } from "../lib/scheduler";
import { SCOPES, WILDCARD, type Grant } from "../lib/scopes";
import { run } from "./delegate";

/**
 * Routines over HTTP (lib/routines.ts). All need the `routines` scope.
 *
 *   GET    /api/v1/routines          every routine, described
 *   POST   /api/v1/routines          make one (see docs/api.md for the shape)
 *   PATCH  /api/v1/routines          {id, enabled?, name?}
 *   DELETE /api/v1/routines?id=      remove one
 *   POST   /api/v1/routines/run      {id} — run it now
 *   POST   /api/v1/trigger           {event, text?} — sets off event routines
 *
 * The routines live in, and run from, the Durable Object; these only relay.
 */

const MAX_BODY = 8 * 1024;

async function body(req: Request): Promise<Record<string, unknown> | null> {
  const raw = await req.text();
  if (raw.length > MAX_BODY) return null;
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const creator = (p: Principal) =>
  p.kind === "owner" ? { who: "owner", grants: [WILDCARD] as Grant[] } : { who: p.id, grants: p.scopes };

/** A routine as the panel and the API show it. */
export function view(r: Routine, timeZone: string) {
  return { ...r, when: describeTrigger(r.trigger, timeZone), does: describeAction(r.action) };
}

export async function handleRoutines(req: Request, env: Env, url: URL, principal: Principal): Promise<Response | null> {
  const p = url.pathname;
  if (p !== "/api/v1/routines" && p !== "/api/v1/routines/run" && p !== "/api/v1/trigger") return null;
  const state = stateStub(env);
  if (!state) return err(503, "routines need the STATE Durable Object");
  const tz = localeOf(env).timeZone;

  if (p === "/api/v1/trigger") {
    if (req.method !== "POST") return err(405, "method not allowed");
    const b = await body(req);
    const event = typeof b?.event === "string" ? b.event.trim().toLowerCase() : "";
    if (!EVENT_NAME.test(event)) return err(400, "event is required: letters, digits and _ . : - , like arrived_home");
    const text = typeof b?.text === "string" ? b.text.trim().slice(0, 500) : undefined;
    const started = await state.fireEvent(event, text || undefined);
    return json({ event, started });
  }

  if (p === "/api/v1/routines/run") {
    if (req.method !== "POST") return err(405, "method not allowed");
    const b = await body(req);
    const r = await state.runRoutine(typeof b?.id === "string" ? b.id : "");
    return typeof r === "string" ? err(404, r) : json({ ok: true, routine: view(r, tz) });
  }

  // /api/v1/routines
  if (req.method === "GET") {
    const all = await state.listRoutines();
    return json({ timeZone: tz, routines: all.map((r) => view(r, tz)) });
  }
  if (req.method === "DELETE") {
    const b = req.headers.get("content-type")?.includes("json") ? await body(req) : null;
    const id = typeof b?.id === "string" ? b.id : url.searchParams.get("id") ?? "";
    return (await state.removeRoutine(id)) ? json({ ok: true, id }) : err(404, "no such routine");
  }
  const b = await body(req);
  if (!b) return err(400, "body must be a small JSON object");
  if (req.method === "POST") {
    const r = await state.addRoutine(b, creator(principal));
    return typeof r === "string" ? err(400, r) : json({ ok: true, routine: view(r, tz) }, { status: 201 });
  }
  if (req.method === "PATCH") {
    const patch: { enabled?: boolean; name?: string } = {};
    if (typeof b.enabled === "boolean") patch.enabled = b.enabled;
    if (typeof b.name === "string") patch.name = b.name;
    const r = await state.updateRoutine(typeof b.id === "string" ? b.id : "", patch);
    return typeof r === "string" ? err(r === "no such routine" ? 404 : 400, r) : json({ ok: true, routine: view(r, tz) });
  }
  return err(405, "method not allowed");
}

/* ---------- what the Durable Object runs a routine with ----------------------- */

/**
 * A routine's question, answered by the router with the creator's grants and
 * no screen. Two minutes at most: nobody is waiting, but nothing should run
 * away with an alarm either.
 */
export async function askForRoutine(
  env: Env,
  prompt: string,
  grants: readonly Grant[],
  routine: Routine,
): Promise<{ ok: boolean; text: string }> {
  if (!env.OPENAI_API_KEY) return { ok: false, text: "no OpenAI key is set" };
  const sink = new Collector();
  // Nothing to show a map on: screen tools are left out rather than offered and lost.
  const screenless = grants.includes(WILDCARD)
    ? SCOPES.filter((s) => s !== "screen")
    : grants.filter((g) => g !== "screen");
  await run(env, [{ role: "user", text: prompt }], sink, AbortSignal.timeout(120_000), screenless, {
    surface: "routine",
    routineName: routine.name,
  });
  const c = sink.finish();
  return { ok: c.ok, text: c.text };
}

/**
 * How long the drive is to `destination` right now: from the car if Tessie
 * knows where it is, else from the place saved as "home". Null when there is
 * no Maps key or nowhere to start from — the warning then comes a fixed time
 * ahead instead.
 */
export async function travelFor(env: Env, destination: string): Promise<Travel | null> {
  if (!env.GOOGLE_MAPS_API_KEY) return null;
  let from: Travel["from"] = "car";
  let origin = await carWaypoint(env);
  if (!origin) {
    const memory = new MemoryStore(env);
    await memory.load().catch(() => {});
    const home = memory.resolvePlace("home");
    if (!home?.address) return null;
    origin = { address: home.address };
    from = "home";
  }
  const d = await drive(env, origin, { address: destination });
  return typeof d === "string" ? null : { min: d.withTraffic, from };
}
