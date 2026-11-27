import type { Env } from "../types.ts";
import { whoOf, type Principal } from "../lib/auth.ts";
import { archive, GitHubError } from "../lib/github.ts";
import { err, json, readBytes, readObject } from "../lib/http.ts";
import type { MacReport } from "../lib/jobs.ts";
import { FROM_MAC, MAX_FILE, MAX_SAID, isRoundEnd } from "../lib/mac-build.ts";
import { stateStub } from "../lib/state-client.ts";
import { WorkshopError, workshopBring, workshopConfig } from "../lib/workshop.ts";

/**
 * A Claude Code build on a Mac, which its person's tap began (lib/mac-build.ts),
 * as that Mac takes part in it by its own device token, never on its socket:
 * - POST /api/v1/computer/build: what it says of it (it still works, waits for
 *   its person's Claude plan, ended a round, brought its files, was stopped);
 * - POST /api/v1/computer/build/file?id=&name=: one file of what it made, to
 *   the job's workshop folder, while the job waits for them;
 * - GET /api/v1/computer/build/source?id=: on a repository, its files at the
 *   commit the job was given them at, for Claude Code to start from.
 * Each only for a build its job still waits on, and only from the Mac it was
 * sent to. Nothing of what it made is published, or shown, here.
 */

const BUILD = "/api/v1/computer/build";
const MAX_REPORT = 16_000 + MAX_SAID * 4;
/** What may come back: its site, its source, and what its person installs (its out folder), each by a plain name. */
const NAME = /^(?:site\.zip|source\.zip|out\/[A-Za-z0-9][A-Za-z0-9._ -]{0,79})$/;
const MAX_NAMES = 20;

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** What the Mac says, as the job takes it; null for anything else. */
function reportOf(body: Record<string, unknown>): MacReport | null {
  const round = typeof body.round === "number" && Number.isInteger(body.round) ? body.round : 0;
  switch (body.state) {
    case "working":
      return { state: "working" };
    case "paused":
      return typeof body.until === "number" && Number.isFinite(body.until) ? { state: "paused", until: body.until } : null;
    case "said":
      return round > 0 && isRoundEnd(body.how) ? { state: "said", round, said: str(body.said, MAX_SAID), how: body.how } : null;
    case "done": {
      const files = Array.isArray(body.files) ? body.files.filter((f): f is string => typeof f === "string" && NAME.test(f)).slice(0, MAX_NAMES) : [];
      const left = Array.isArray(body.left)
        ? body.left.flatMap((l: unknown) => (l && typeof l === "object" && typeof (l as { name?: unknown }).name === "string" ? [{ name: str((l as { name: string }).name, 120), why: str((l as { why?: unknown }).why, 200) }] : [])).slice(0, MAX_NAMES)
        : [];
      return { state: "done", files, left, path: str(body.path, 300) };
    }
    case "stopped":
      return { state: "stopped" };
    default:
      return null;
  }
}

export async function handleComputer(req: Request, env: Env, url: URL, principal: Principal): Promise<Response | null> {
  const path = url.pathname;
  if (path !== BUILD && path !== `${BUILD}/file` && path !== `${BUILD}/source`) return null;
  // Only a Mac: the device that holds `computer` (lib/scopes.ts), never a person's own session.
  if (principal.kind !== "device") return err(403, "only a Mac takes part in its build");
  const state = stateStub(env);
  if (!state) return err(503, "builds need the STATE Durable Object");
  const who = whoOf(principal);

  if (path === `${BUILD}/source`) {
    if (req.method !== "GET") return err(405, "GET a repository's files");
    const build = url.searchParams.get("id") ?? "";
    const p = build ? await state.macBuildPending(who, build) : null;
    if (!p || p.phase !== "round" || p.round !== 1 || !p.repo || !p.base) return err(404, "no job of a repository's waits on that build from this Mac to begin");
    try {
      const { bytes } = await archive(env, p.repo, AbortSignal.timeout(60_000), p.base);
      return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": "application/gzip", "cache-control": "no-store" } });
    } catch (e) {
      if (e instanceof GitHubError) return err(502, e.message);
      throw e;
    }
  }

  if (path === `${BUILD}/file`) {
    if (req.method !== "POST") return err(405, "POST one file of what it made");
    const build = url.searchParams.get("id") ?? "";
    const name = url.searchParams.get("name") ?? "";
    if (!NAME.test(name) || name.includes("..")) return err(400, "name is site.zip, source.zip or out/<a plain name>");
    const p = build ? await state.macBuildPending(who, build) : null;
    if (!p || p.phase !== "finish") return err(404, "no job waits on files from that build from this Mac");
    const bytes = await readBytes(req, MAX_FILE);
    if (!bytes) return err(413, `a file of a build's is ${MAX_FILE.toLocaleString("en-US")} bytes at most`);
    const cfg = workshopConfig(env);
    if (!cfg) return err(503, "the workshop is not set up here");
    try {
      await workshopBring(cfg, p.job, `${FROM_MAC}/${name}`, bytes, AbortSignal.timeout(60_000));
    } catch (e) {
      if (e instanceof WorkshopError) return err(502, e.message);
      throw e;
    }
    return json({ ok: true });
  }

  if (req.method !== "POST") return err(405, "POST what came of a build");
  const body = await readObject(req, MAX_REPORT);
  if (!body) return err(400, `a JSON object of ${MAX_REPORT.toLocaleString("en-US")} bytes at most`);
  const build = typeof body.id === "string" ? body.id : "";
  const report = reportOf(body);
  if (!report) return err(400, "state is working, paused, said, done or stopped, with what goes with it");
  const taken = build ? await state.macBuildHeard(who, build, report) : false;
  return taken ? json({ ok: true }) : err(404, "no job waits on that from this build from this Mac");
}
