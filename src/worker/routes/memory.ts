import type { Env } from "../types";
import { json, err } from "../lib/http.ts";
import { MemoryStore, sane, sanitise, search, PROFILE_BUDGET, type Kind } from "../lib/memory.ts";

const KINDS: readonly Kind[] = ["place", "person", "preference", "vehicle", "routine", "note", "reference"];

async function body(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Read, edit and probe what Jarvis has saved.
 *
 * The search route earns its place: a lexical retriever is only debuggable by
 * trying queries against it, and "does 'how long to the office' actually find my
 * office fact?" is otherwise unanswerable. It is the same idea as the per-server
 * Test button in the MCP settings.
 */
export async function handleMemory(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const store = new MemoryStore(env);
  await store.load();

  if (url.pathname === "/api/memory/search") {
    if (req.method !== "POST") return err(405, "method not allowed");
    let body: { query?: unknown };
    try {
      body = await req.json();
    } catch {
      return err(400, "body is not valid JSON");
    }
    const query = typeof body.query === "string" ? body.query : "";
    if (!query.trim()) return err(400, "query is required");

    // Deliberately not store.search(): probing from the UI must not inflate
    // useCount and quietly change what the profile block prioritises.
    const hits = search(await store.allFacts(), query, 10);
    return json({
      query,
      total: (await store.allFacts()).length,
      hits: hits.map((h) => ({
        id: h.fact.id,
        text: h.fact.text,
        kind: h.fact.kind,
        address: h.fact.address,
        score: +h.score.toFixed(2),
      })),
    });
  }

  if (req.method === "GET") {
    const profile = store.buildProfile();
    const lines = store.profileLines();
    return json({
      facts: await store.allFacts(),
      trash: store.trash,
      count: (await store.allFacts()).length,
      cap: 300,
      // What actually rides on every delegation, so its size is visible. The
      // budget bounds the fact lines; the block's fixed header sits on top.
      profile: {
        chars: profile.length,
        used: lines.reduce((n, l) => n + l.length, 0),
        budget: PROFILE_BUDGET,
        listed: lines.length,
        text: profile,
      },
    });
  }

  /*
   * One fact at a time, for the memory panel.
   *
   * The panel could have used PUT, but replace-all from a page that has been
   * open a while writes back what it loaded: a fact saved by voice in the
   * meantime would be silently deleted. These go through the same changeset
   * path the voice tools use, so they touch only the fact they name.
   */
  if (req.method === "POST") {
    const b = await body(req);
    if (!b) return err(400, "body is not valid JSON");
    // Same validator as the voice path: the panel is no more trusted than speech.
    const clean = sanitise(b.text);
    if (!clean.ok) return err(400, clean.why);
    const kind = KINDS.includes(b.kind as Kind) ? (b.kind as Kind) : "note";
    const named = kind === "place" || kind === "person";
    const name = named && typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 60) : undefined;
    const address =
      kind === "place" && typeof b.address === "string" && b.address.trim()
        ? b.address.trim().slice(0, 300)
        : undefined;

    const { fact, replaced } = store.add({
      text: clean.text,
      kind,
      slug: name,
      address,
      pinned: kind !== "reference" && b.pinned === true ? true : undefined,
      source: "ui",
    });
    await store.save();
    return json({ ok: true, fact, replaced: replaced ?? null });
  }

  if (req.method === "DELETE") {
    const b = await body(req);
    const id = typeof b?.id === "string" ? b.id : "";
    if (!id) return err(400, "id is required");
    // Hot facts go to the trash, exactly as `forget` does; reference has none.
    const gone = store.remove(id) ?? (await store.removeReference(id));
    if (!gone) return err(404, "no saved fact with that id");
    await store.save();
    return json({ ok: true, removed: gone });
  }

  if (req.method === "PUT") {
    let body: { facts?: unknown; confirm?: unknown };
    try {
      body = await req.json();
    } catch {
      return err(400, "body is not valid JSON");
    }
    // Same validator as the write path: edits from the UI are no more trusted
    // than speech from the car.
    const facts = sane(body.facts);

    /*
     * Replace-all is a loaded gun, and it went off: a one-line diagnostic
     * `PUT {"facts":[]}` deleted every fact in the store and returned 200, as
     * designed. Nothing about the request said "delete everything", because
     * from the endpoint's point of view nothing had to.
     *
     * So a PUT that removes most of what is there now needs to say so. The
     * editor saving an ordinary edit never trips this; a stray or truncated
     * body always does.
     */
    const before = (await store.allFacts()).length;
    const losing = before - facts.length;
    if (before > 0 && losing > 0 && facts.length < before / 2 && body.confirm !== true) {
      return err(
        409,
        `That would delete ${losing} of ${before} saved facts. Send "confirm": true if you mean it.`,
        { before, after: facts.length, deleting: losing },
      );
    }

    await store.replaceAll(facts);
    await store.save();
    return json({ ok: true, count: facts.length });
  }

  return err(405, "method not allowed");
}
