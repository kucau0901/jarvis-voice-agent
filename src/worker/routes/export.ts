import type { Env } from "../types.ts";
import { err, json } from "../lib/http.ts";
import { personOf, type Principal } from "../lib/auth.ts";
import { stateStub } from "../lib/state-client.ts";
import { bookOf, isTheirs } from "../lib/context.ts";
import { SETTINGS } from "../lib/settings.ts";
import { localeOf } from "../lib/locale.ts";
import { dayOf } from "../lib/usage.ts";
import { jobView } from "./jobs.ts";
import { JARVIS_VERSION } from "./version.ts";

/**
 *   GET /api/export   everything Jarvis keeps of the asker, as one JSON file
 *
 * Their memory (and the family's shared book, for one in a family), their
 * specialties, past attempts, routines, panels, conversation and jobs, and the household's settings with
 * no secret among them: a secret is never sent to the browser, here as in
 * Settings. Admins only (lib/scopes.ts), and only their own: nobody else's
 * words are in it.
 *
 * The state is read directly, not through MemoryStore, which reads a failure
 * as an empty memory: an export that came back empty without saying so would
 * mislead.
 */
export async function handleExport(req: Request, env: Env, principal: Principal): Promise<Response> {
  if (req.method !== "GET") return err(405, "GET only");
  const state = stateStub(env);
  if (!state) return err(503, "the export needs the STATE Durable Object");
  const me = personOf(principal);
  const book = bookOf(env.JARVIS_PERSON);
  const now = Date.now();
  const [memory, reference, familyMemory, familyReference, routines, panels, conversation, jobs, saved, specialties, past] = await Promise.all([
    state.loadMemory(book),
    state.loadReference(book),
    env.JARVIS_FAMILY ? state.loadMemory(env.JARVIS_FAMILY) : null,
    env.JARVIS_FAMILY ? state.loadReference(env.JARVIS_FAMILY) : null,
    state.listRoutines(),
    state.panelsOf(me),
    state.conversationOf(me, now),
    state.listJobs(),
    state.getSettings(),
    state.specialtiesOf(me),
    state.episodesOf(me, now),
  ]);
  // Only what Settings would show as a value: a secret's never, nor a name no setting has.
  const plain = new Set(SETTINGS.filter((s) => s.kind !== "secret").map((s) => s.name));
  const settings = Object.fromEntries(Object.entries(saved).filter(([name]) => plain.has(name)).map(([name, s]) => [name, s.v]));
  const bundle = {
    version: JARVIS_VERSION,
    exportedAt: new Date(now).toISOString(),
    person: me,
    memory: { facts: memory.facts, trash: memory.trash, reference: reference.facts },
    family: familyMemory && familyReference ? { facts: familyMemory.facts, trash: familyMemory.trash, reference: familyReference.facts } : null,
    routines: routines.filter((r) => isTheirs(r.createdBy, me)),
    panels,
    specialties,
    past,
    conversation,
    jobs: jobs.filter((j) => isTheirs(j.createdBy, me)).map((j) => jobView(j, true)),
    settings,
  };
  const day = dayOf(now, localeOf(env).timeZone);
  return json(bundle, { headers: { "content-disposition": `attachment; filename="jarvis-export-${day}.json"` } });
}
