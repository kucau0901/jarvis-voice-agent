import type { Env } from "../types.ts";
import { whoOf, type Principal } from "../lib/auth.ts";
import { err, json, readObject } from "../lib/http.ts";
import { FROM_MAC, MAX_ZIP } from "../lib/mac-build.ts";
import { stateStub } from "../lib/state-client.ts";
import { fromB64u } from "../lib/webauthn.ts";
import { WorkshopError, workshopBring, workshopConfig } from "../lib/workshop.ts";

/**
 * What a Mac says came of a build its person's tap started (lib/mac-build.ts):
 * POST /api/v1/computer/build, by the Mac's own device token, never on its
 * socket (a site is more than a socket's answer may be). Taken only for a
 * build its job still waits on, and only from the Mac it was sent to. Its
 * files go to the job's workshop folder, where the job checks them; nothing
 * of them is published, or shown, here.
 */

/** As much as a request may be: the zip as base64url, and its words. */
const MAX_BODY = Math.ceil((MAX_ZIP * 4) / 3) + 16_000;
const MAX_SAID = 2_000;

export async function handleComputer(req: Request, env: Env, url: URL, principal: Principal): Promise<Response | null> {
  if (url.pathname !== "/api/v1/computer/build") return null;
  if (req.method !== "POST") return err(405, "POST what came of a build");
  // Only a Mac: the device that holds `computer` (lib/scopes.ts), never a person's own session.
  if (principal.kind !== "device") return err(403, "only a Mac sends what came of its build");
  const state = stateStub(env);
  if (!state) return err(503, "builds need the STATE Durable Object");
  const body = await readObject(req, MAX_BODY);
  if (!body) return err(400, `a JSON object of ${MAX_BODY.toLocaleString("en-US")} bytes at most`);
  const who = whoOf(principal);
  const build = typeof body.id === "string" ? body.id : "";
  const job = build ? await state.macBuildPending(who, build) : null;
  if (!job) return err(404, "no job waits on that build from this Mac");
  const claude = typeof body.said === "string" ? body.said.slice(0, MAX_SAID) : "";
  let files = false;
  let said = body.ok === true ? "it came back with no files" : "";
  if (body.ok === true && typeof body.zip === "string" && body.zip) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = fromB64u(body.zip);
    } catch {
      return err(400, "zip is not base64url");
    }
    if (bytes.length > MAX_ZIP) return err(413, `a build's files are ${MAX_ZIP.toLocaleString("en-US")} bytes at most`);
    const cfg = workshopConfig(env);
    said = "its files could not be put in the job's folder";
    if (cfg) {
      try {
        await workshopBring(cfg, job, FROM_MAC, bytes, AbortSignal.timeout(60_000));
        files = true;
      } catch (e) {
        if (!(e instanceof WorkshopError)) throw e;
      }
    }
  }
  const taken = await state.macBuildDone(who, build, { ok: body.ok === true, files, ...(files || !said ? {} : { said }), ...(claude ? { claude } : {}) });
  return taken ? json({ ok: true, files }) : err(404, "no job waits on that build from this Mac");
}
