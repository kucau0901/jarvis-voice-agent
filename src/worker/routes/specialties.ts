import type { Env } from "../types.ts";
import { err, json, readObject } from "../lib/http.ts";
import { OWNER } from "../lib/context.ts";
import { WILDCARD, allows, type Grant } from "../lib/scopes.ts";
import { stateStub } from "../lib/state-client.ts";
import { MAX_FILE, MAX_OF_ONE, MAX_ZIP, importedDraft, type Draft } from "../lib/specialty-more.ts";
import { b64u, fromB64u } from "../lib/webauthn.ts";
import { wellFormed } from "../lib/quote.ts";
import { WorkshopError, fileHeaders, workshopAsk, workshopConfig, workshopGiven } from "../lib/workshop.ts";

/**
 * Each person's own specialties, as Memory → Specialties keeps them
 * (lib/specialty-more.ts). A device only reads here (routes/memory.ts).
 *
 *   GET    /api/memory/specialties              {specialties}: yours
 *   GET    /api/memory/specialties?id=          {specialty, source, text?, files, before}: one, whole
 *   POST   /api/memory/specialties              {id?, name, when, steps, why?, text?, files?, source?}: written, or changed
 *   DELETE /api/memory/specialties?id=          one forgotten
 *   POST   /api/memory/specialties/back         {id, at}: as it was before a change of it
 *   POST   /api/memory/specialties/import       {name, data}: a SKILL.md or a zip with one, as a draft to read over; keeps nothing. Admins
 *   GET    /api/memory/specialties/export?id=   one as a zip other agents take
 *   GET    /api/memory/specialties/file?id=&n=  a file of one, to save
 *   GET    /api/memory/specialties/draft?job=   {draft, title}: how a finished job of yours was done, to read over; keeps nothing
 */

/** A save with its files, as base64url. */
const MAX_BODY = Math.ceil(MAX_OF_ONE * 1.4) + 100_000;

const bytesOf = (v: unknown): Uint8Array | null => {
  if (typeof v !== "string" || !v) return null;
  try {
    return fromB64u(v);
  } catch {
    return null;
  }
};

export async function handleSpecialties(req: Request, env: Env, url: URL, grants: readonly Grant[], device: boolean): Promise<Response> {
  const state = stateStub(env);
  if (!state) return err(503, "specialties need the STATE Durable Object");
  const person = env.JARVIS_PERSON || OWNER;
  const p = url.pathname.slice("/api/memory/specialties".length);
  const id = url.searchParams.get("id") ?? "";
  const now = Date.now();

  if (p === "" && req.method === "GET") {
    if (!id) return json({ specialties: await state.specialtiesAll(person) });
    const w = await state.specialtyWhole(person, id);
    return w ? json({ specialty: w.specialty, source: w.more.source, ...(w.more.text ? { text: w.more.text } : {}), files: w.more.files, before: w.more.before }) : err(404, "no such specialty");
  }
  if (p === "" && req.method === "DELETE") return (await state.specialtyForget(person, id)) ? json({ ok: true }) : err(404, "no such specialty");
  if (p === "" && req.method === "POST") {
    const b = await readObject(req, MAX_BODY);
    if (!b) return err(400, "body must be a JSON object, with no more files than one may have");
    // Where a new one came from is only said of it; from a file is for whoever may import one.
    const source = b.source === "learned" ? "learned" : b.source === "imported" && grants.includes(WILDCARD) ? "imported" : "written";
    const s = await state.specialtyKeep(person, b, source, allows(grants, "workshop"), now);
    return typeof s === "string" ? err(400, s) : json({ ok: true, specialty: s }, { status: b.id ? 200 : 201 });
  }

  if (p === "/back" && req.method === "POST") {
    const b = await readObject(req, 4_000);
    const s = await state.specialtyPutBack(person, typeof b?.id === "string" ? b.id : "", Number(b?.at), now);
    return typeof s === "string" ? err(404, s) : json({ ok: true, specialty: s });
  }

  if (p === "/import" && req.method === "POST") {
    // Someone else's skill: its steps are followed, and its scripts run, once it is kept.
    if (!grants.includes(WILDCARD)) return err(403, "only an admin can import one");
    const b = await readObject(req, Math.ceil(MAX_ZIP * 1.4) + 10_000);
    const bytes = bytesOf(b?.data);
    if (!bytes) return err(400, `no file came, or it is over ${MAX_ZIP / 1_000_000} MB`);
    const draft = await importedDraft(typeof b?.name === "string" ? b.name : "", bytes);
    return typeof draft === "string" ? err(400, draft) : json({ draft });
  }

  if (p === "/export" && req.method === "GET") {
    const z = await state.specialtyExport(person, id);
    return z ? new Response(z.bytes as Uint8Array<ArrayBuffer>, { headers: fileHeaders(z.name, z.bytes.byteLength) }) : err(404, "no such specialty");
  }

  if (p === "/file" && req.method === "GET") {
    const f = await state.specialtyFile(person, id, Number(url.searchParams.get("n")));
    return f ? new Response(f.bytes as Uint8Array<ArrayBuffer>, { headers: fileHeaders(f.name.split("/").pop()!, f.bytes.byteLength) }) : err(404, "no such file");
  }

  if (p === "/draft" && req.method === "GET") {
    if (device) return err(403, "a job is kept by its person, not a device");
    const job = url.searchParams.get("job") ?? "";
    const d = await state.specialtyDraft(person, job, now);
    if (!d) return err(404, "no finished job of yours by that id");
    const draft: Draft & { id?: string } = { ...(d.draft?.id ? { id: d.draft.id } : {}), name: d.draft?.name ?? wellFormed(d.title.slice(0, 60)), when: d.draft?.when ?? [], steps: d.draft?.steps ?? [], ...(d.draft?.why ? { why: d.draft.why } : {}), text: "", files: [], notes: [] };
    // The scripts of it that ran and worked, as they are in its folder: shown whole before they are kept.
    const shop = allows(grants, "workshop") ? workshopConfig(env) : null;
    if (shop) {
      for (const path of d.scripts) {
        try {
          const { sha256, size } = await workshopAsk<{ sha256: string; size: number }>(shop, "give", { job, path }, AbortSignal.timeout(20_000));
          if (size <= MAX_FILE) draft.files.push({ name: path, data: b64u(await workshopGiven(shop, job, sha256, AbortSignal.timeout(20_000))) });
        } catch (e) {
          if (!(e instanceof WorkshopError)) throw e;
          draft.notes.push(`${path} could not be brought: ${e.message}.`);
        }
      }
    }
    return json({ draft });
  }
  return err(404, "no such thing here");
}
