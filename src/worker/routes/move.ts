import type { Env } from "../types.ts";
import { err, json, readObject } from "../lib/http.ts";
import { stateStub } from "../lib/state-client.ts";
import { _resetSettingsCache } from "../lib/settings-store.ts";
import { asMovePage, deployed, moveKeyOk, movePage, moveStep, type MoveKv } from "../lib/move.ts";
import { JARVIS_VERSION } from "./version.ts";

/** A move's request is an address, a key and a place in it: nothing large. */
const BODY_MAX = 8_192;

/** The settings store as a move uses it (lib/move.ts). */
function kvOf(env: Env): MoveKv {
  return {
    list: (options) => env.CONFIG.list(options),
    get: (key) => env.CONFIG.get(key),
    put: (key, value, options) => env.CONFIG.put(key, value, options),
    delete: (key) => env.CONFIG.delete(key),
  };
}

/**
 *   GET /api/v1/move/export?after=…   one page of everything this Jarvis keeps
 *
 * For the Jarvis that is taking this one's place, and it alone: the caller
 * presents MOVE_KEY, not the owner key or a device's, so index.ts answers this
 * before its gate. Without a move key set there is nothing here: the same 404
 * a wrong key gets, so the path says nothing about whether a move is open.
 * Under /api/v1/ with the rest of what machines call, so a deployment that
 * keeps a sign-in wall in front of the app and lets /api/v1/ through needs
 * nothing opened for a move.
 */
export async function handleMoveExport(req: Request, env: Env): Promise<Response> {
  const presented = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;
  if (!(await moveKeyOk(env, presented))) return err(404, "not found");
  if (req.method !== "GET") return err(405, "GET only");
  const state = stateStub(env);
  if (!state) return err(503, "a move needs the STATE Durable Object");
  try {
    const page = await movePage(
      {
        version: JARVIS_VERSION,
        statePage: (after) => state.moveOut(after),
        kv: kvOf(env),
        // `env` here is the deployment's own: nothing saved has been laid over it (index.ts, before the gate).
        deployed: async () => deployed({ ...env }, await state.getSettings()),
      },
      new URL(req.url).searchParams.get("after"),
    );
    return json(page, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return err(500, e instanceof Error ? e.message : String(e));
  }
}

/**
 *   POST /api/move/import   { from, key, after?, replace? }   one step of moving another Jarvis here
 *
 * The owner's alone (lib/scopes.ts). `from` is the old Jarvis's address and
 * `key` its MOVE_KEY; the page that asks sends each answer's `next` back as
 * `after` until it is null (lib/move.ts).
 */
export async function handleMoveImport(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return err(405, "POST only");
  const state = stateStub(env);
  if (!state) return err(503, "a move needs the STATE Durable Object");
  const body = await readObject(req, BODY_MAX);
  if (!body) return err(400, "send { from, key }");
  const key = typeof body.key === "string" ? body.key.trim() : "";
  let from: URL;
  try {
    from = new URL(typeof body.from === "string" ? body.from.trim() : "");
  } catch {
    return err(400, "from must be the other Jarvis's address, like https://jarvis.example.com");
  }
  if (from.protocol !== "https:" && from.protocol !== "http:") return err(400, "from must be an http or https address");
  if (!key) return err(400, "key must be the other Jarvis's MOVE_KEY");
  const after = typeof body.after === "string" && body.after ? body.after : null;

  try {
    const step = await moveStep(
      {
        page: async (at) => {
          const url = new URL("/api/v1/move/export", from.origin);
          if (at !== null) url.searchParams.set("after", at);
          // Never followed elsewhere: the key goes to the address given and no other.
          const r = await fetch(url, { headers: { authorization: `Bearer ${key}` }, redirect: "manual" });
          if (r.status >= 300 && r.status < 400) throw new Error("that address sends callers elsewhere: give the other Jarvis's own address");
          if (r.status === 404) throw new Error("the other Jarvis has no move open under that key: set MOVE_KEY there, and check the address");
          const data: unknown = await r.json().catch(() => null);
          if (!r.ok) throw new Error(`the other Jarvis said ${r.status}${data && typeof data === "object" && "error" in data ? `: ${String(data.error)}` : ""}`);
          const page = asMovePage(data);
          if (!page) throw new Error("the other Jarvis did not answer with a page of a move");
          return page;
        },
        holdsAnything: () => state.moveHolds(),
        clear: () => state.moveClear(),
        put: (entries) => state.moveIn(entries),
        keep: async (settings) => void (await state.putSettings(settings, 0)),
        settle: () => state.moveSettle(),
        kv: kvOf(env),
        now: Date.now(),
      },
      after,
      body.replace === true,
    );
    if (typeof step === "string") return err(409, step);
    // What this isolate remembers of the settings is from before the move.
    if (step.next === null) _resetSettingsCache();
    return json(step);
  } catch (e) {
    return err(502, e instanceof Error ? e.message : String(e));
  }
}
