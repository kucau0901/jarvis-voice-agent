import type { Env } from "../types.ts";
import { err, json, readObject } from "../lib/http.ts";
import { personOf, type Principal } from "../lib/auth.ts";
import { stateStub } from "../lib/state-client.ts";
import { MAX_FILE, bytesOf, jobFileOf } from "../lib/projects.ts";
import { fileHeaders } from "../lib/workshop.ts";

/**
 * A person's projects (lib/projects.ts), in Jobs. Reading them needs
 * `memory.read` and changing them `memory.write`; a device changes none.
 *
 *   GET    /api/v1/projects              {projects}
 *   POST   /api/v1/projects              {id?, name, rules}: new, or changed
 *   DELETE /api/v1/projects?id=          gone, its files with it; its jobs stay
 *   POST   /api/v1/projects/file         {id, name, data} a file, as base64url; or {id, job, n} one a job of theirs gave
 *   GET    /api/v1/projects/file?id=&n=  one, to save
 *   DELETE /api/v1/projects/file?id=&n=
 */
export async function handleProjects(req: Request, env: Env, url: URL, principal: Principal): Promise<Response | null> {
  const p = url.pathname;
  if (p !== "/api/v1/projects" && p !== "/api/v1/projects/file") return null;
  const state = stateStub(env);
  if (!state) return err(503, "projects need the STATE Durable Object");
  const person = personOf(principal);
  const now = Date.now();
  const id = url.searchParams.get("id") ?? "";
  if (req.method !== "GET" && principal.kind === "device") return err(403, "a project is changed by its person, not a device");

  if (p === "/api/v1/projects") {
    if (req.method === "GET") return json({ projects: await state.projectsOf(person) });
    if (req.method === "DELETE") return (await state.projectForget(person, id)) ? json({ ok: true }) : err(404, "no such project");
    if (req.method !== "POST") return err(405, "method not allowed");
    const b = await readObject(req, 16 * 1024);
    if (!b) return err(400, "body must be a small JSON object");
    const r = await state.projectSave(person, { id: b.id, name: b.name, rules: b.rules }, now);
    return typeof r === "string" ? err(400, r) : json({ ok: true, project: r }, { status: b.id ? 200 : 201 });
  }

  if (req.method === "GET") {
    const f = await state.projectFile(person, id, Number(url.searchParams.get("n")));
    return f ? new Response(f.bytes as Uint8Array<ArrayBuffer>, { headers: fileHeaders(f.name.split("/").pop()!, f.bytes.byteLength) }) : err(404, "no such file");
  }
  if (req.method === "DELETE") {
    const r = await state.projectDrop(person, id, Number(url.searchParams.get("n")), now);
    return typeof r === "string" ? err(404, r) : json({ ok: true, project: r });
  }
  if (req.method !== "POST") return err(405, "method not allowed");
  const b = await readObject(req, Math.ceil(MAX_FILE * 1.4) + 10_000);
  if (!b || typeof b.id !== "string") return err(400, `no file came, or it is over ${MAX_FILE / 1_000_000} MB`);
  let name = b.name;
  let bytes = bytesOf(b.data);
  if (b.job !== undefined) {
    const got = await jobFileOf(env, (j) => state.getJob(j), person, typeof b.job === "string" ? b.job : "", typeof b.n === "number" ? b.n : NaN);
    if ("why" in got) return err(got.status, got.why);
    name = got.name;
    bytes = got.bytes;
  }
  if (!bytes) return err(400, "that file could not be read");
  const r = await state.projectPut(person, b.id, name, bytes, now, b.job !== undefined);
  return typeof r === "string" ? err(400, r) : json({ ok: true, project: r }, { status: 201 });
}
