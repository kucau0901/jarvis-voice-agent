import type { Env } from "../types";
import { json, err } from "../lib/http";
import { MemoryStore, sane, PROFILE_BUDGET } from "../lib/memory";

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
    const { search } = await import("../lib/memory");
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
    return json({
      facts: await store.allFacts(),
      trash: store.trash,
      count: (await store.allFacts()).length,
      cap: 300,
      // What actually rides on every delegation, so its size is visible.
      profile: { chars: profile.length, budget: PROFILE_BUDGET, text: profile },
    });
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
