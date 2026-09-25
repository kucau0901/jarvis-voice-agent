import type { Env } from "../types";
import type { Fact, Hit } from "./memory.ts";

/**
 * Recall by meaning, beside recall by words.
 *
 * The keyword search (memory.ts `search`) finds a fact only when the question
 * uses its words. "Who handles my car insurance?" shares none with "Aisyah at
 * Etiqa renews the Tesla policy", and "siapa doktor gigi saya?" none with "Dr
 * Lim is my dentist". An embedding — a list of numbers standing for what a
 * text means — puts those close together whatever the words or the language.
 *
 * Only on a search, never on an ordinary question: the handful of facts that
 * travel with every question are unaffected, so there is no new call on the
 * everyday path. Each fact is embedded once (again if its text changes) and
 * the vectors live beside memory in the Durable Object, which does the
 * comparing, so they never travel.
 *
 * Cost, with OpenAI's text-embedding-3-large at $0.13 per million tokens: a
 * hundredth of a cent to embed a memory of a few dozen facts, about a
 * hundred-thousandth of a cent per search.
 *
 * Kept free of Cloudflare imports so Node tests it.
 */

/**
 * The large model, not the small one: measured on real memory in September
 * 2026, the small one missed short Malay questions about English facts —
 * "isteri saya siapa?" did not find "The user's wife is called Sara" — and
 * the large one found every one. The price difference is a rounding error.
 */
export const EMBED_MODEL = "text-embedding-3-large";
/** Shortened from 3072: a third of the storage, no loss measured at this scale. */
export const EMBED_DIMS = 1024;
/** Embedded per search at most; a bigger backlog is finished over the next few. */
export const MAX_BACKFILL = 256;
/**
 * The closeness below which a fact is not offered at all. Calibrated on real
 * memory with the large model: true matches 0.39–0.50 (English and Malay
 * questions alike), loosely related facts 0.29–0.36, unrelated questions
 * ("what's the weather tomorrow?") 0.17 at most.
 */
export const SEM_MIN = 0.35;
/**
 * So close in meaning that "remember" is probably restating a fact already
 * kept. Measured: "My wife's name is Sara" against "The user's wife is called
 * Sara." 0.82; different facts that sound alike ("My sister is called Sara",
 * "Sara's birthday is 3 May") 0.59–0.63. Looser restatements overlap with
 * those and are let through: this only ever adds a note, it never merges.
 */
export const DUPLICATE_MIN = 0.75;

/** What is embedded for a fact: its words, and what it is called and where. */
export function embedText(f: Pick<Fact, "text" | "slug" | "address">): string {
  return [f.text, f.slug ? `(${f.slug})` : "", f.address ? `— ${f.address}` : ""].filter(Boolean).join(" ");
}

/** FNV-1a: enough to notice a fact's text changed, with no async digest. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Changes when the fact's text does, or the model: either way it must be embedded again. */
export const factHash = (f: Pick<Fact, "text" | "slug" | "address">): string =>
  `${EMBED_MODEL}/${EMBED_DIMS}/${fnv(embedText(f))}`;

export function toB64(v: Float32Array): string {
  const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string): Float32Array {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return new Float32Array(b.buffer);
}

/** Cosine similarity. OpenAI's vectors are unit length, but a stored one need not be trusted to be. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Embed several texts in one call; null if it cannot be done (no key, OpenAI down). */
export async function embed(env: Env, texts: string[]): Promise<Float32Array[] | null> {
  if (!env.OPENAI_API_KEY || !texts.length) return null;
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, dimensions: EMBED_DIMS, encoding_format: "base64" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    console.warn("embeddings failed:", r.status, (await r.text().catch(() => "")).slice(0, 200));
    return null;
  }
  const j = (await r.json()) as { data?: { index: number; embedding: string | number[] }[] };
  const out: Float32Array[] = new Array(texts.length);
  for (const d of j.data ?? []) {
    out[d.index] = typeof d.embedding === "string" ? fromB64(d.embedding) : Float32Array.from(d.embedding);
  }
  return out.every(Boolean) ? out : null;
}

export interface Near {
  id: string;
  score: number;
}

/**
 * One ranking from two: words and meaning, by reciprocal rank fusion — each
 * list contributes 1/(K + rank), so a fact near the top of both beats one at
 * the top of either, and neither score's scale has to be trusted against the
 * other's. K is small because the lists are short.
 */
const K = 10;

export type Found = Hit & { via: "words" | "meaning" | "both" };

export function fuse(words: Hit[], meaning: Near[], facts: Map<string, Fact>, limit: number): Found[] {
  const score = new Map<string, number>();
  const via = new Map<string, Found["via"]>();
  words.forEach((h, i) => {
    score.set(h.fact.id, (score.get(h.fact.id) ?? 0) + 1 / (K + i + 1));
    via.set(h.fact.id, "words");
  });
  meaning
    .filter((m) => m.score >= SEM_MIN && facts.has(m.id))
    .forEach((m, i) => {
      score.set(m.id, (score.get(m.id) ?? 0) + 1 / (K + i + 1));
      via.set(m.id, via.get(m.id) === "words" ? "both" : "meaning");
    });
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, s]) => ({ fact: facts.get(id)!, score: Math.round(s * 1000) / 1000, via: via.get(id)! }));
}
