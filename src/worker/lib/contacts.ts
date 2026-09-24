import type { Env } from "../types";
import { call, PEOPLE, type GoogleConfig } from "./google.ts";

/**
 * Turning a spoken name into an address.
 *
 * This exists for one sentence: "email Sam and tell them I am running late."
 * Without it `mail_send` can only refuse, because the alternative — letting a
 * model invent an address that looks plausible — is how private mail reaches a
 * stranger with a similar name.
 *
 * The rule throughout is that AMBIGUITY IS A REFUSAL, never a guess. Two
 * matching contacts means asking which, not picking the first. The cost of
 * asking is a second of conversation; the cost of guessing is unrecoverable.
 */

/** A resolution either lands on exactly one address, or it does not resolve. */
export type Resolution =
  | { ok: true; email: string; name: string }
  | { ok: false; why: "none" }
  | { ok: false; why: "ambiguous"; candidates: { name: string; email: string }[] };

interface Person {
  names?: { displayName?: string }[];
  emailAddresses?: { value?: string }[];
}

const MAX_CANDIDATES = 4;

async function searchOnce(
  env: Env,
  cfg: GoogleConfig,
  query: string,
  signal: AbortSignal,
): Promise<Person[]> {
  const p = new URLSearchParams({
    query,
    readMask: "names,emailAddresses",
    pageSize: "10",
  });
  const res = await call(env, cfg, `/people:searchContacts?${p}`, {
    base: PEOPLE,
    signal,
  }).catch(() => null);

  if (!res || res.status !== 200) return [];
  const results = (res.body as { results?: { person?: Person }[] } | null)?.results ?? [];
  return results.map((r) => r.person).filter((p): p is Person => !!p);
}

/**
 * Find the one contact a name refers to.
 *
 * The People API keeps a per-session search cache and documents that clients
 * should send a warmup request with an empty query before searching — a cold
 * cache answers an honest query with nothing. Rather than pay that warmup on
 * every lookup, it is only sent when a search comes back empty, which is the
 * one case where the cache might be the reason.
 */
export async function resolveContact(
  env: Env,
  cfg: GoogleConfig,
  name: string,
  signal: AbortSignal,
): Promise<Resolution> {
  const query = name.trim();
  if (!query) return { ok: false, why: "none" };

  let people = await searchOnce(env, cfg, query, signal);
  if (!people.length) {
    await searchOnce(env, cfg, "", signal); // warm the cache
    people = await searchOnce(env, cfg, query, signal);
  }

  // One person can hold several addresses, and two people can share one. Key
  // on the address so "which Sam" is asked only when it is genuinely two.
  const byEmail = new Map<string, string>();
  for (const p of people) {
    const display = p.names?.[0]?.displayName?.trim() || query;
    for (const e of p.emailAddresses ?? []) {
      const email = e.value?.trim().toLowerCase();
      if (email && !byEmail.has(email)) byEmail.set(email, display);
    }
  }

  const candidates = [...byEmail].map(([email, n]) => ({ email, name: n }));
  if (!candidates.length) return { ok: false, why: "none" };
  if (candidates.length === 1) {
    return { ok: true, email: candidates[0]!.email, name: candidates[0]!.name };
  }
  return { ok: false, why: "ambiguous", candidates: candidates.slice(0, MAX_CANDIDATES) };
}
