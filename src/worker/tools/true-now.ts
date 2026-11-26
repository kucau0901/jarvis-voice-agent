import type { Tool } from "./registry.ts";
import { bookOf } from "../lib/context.ts";
import { factHash } from "../lib/embeddings.ts";
import type { Fact } from "../lib/memory.ts";
import { asQuotedData, ownPart } from "../lib/quote.ts";
import { doubtsOf, settle } from "../lib/true-now.ts";

/**
 * Memory → Which is true now? by chat or voice (lib/true-now.ts): facts that
 * may say one thing twice or disagree, and ones whose day has passed, found by
 * code; settled as the user says, in their own words. Each fact is named by its
 * id and the start of its hash, so one changed since it was listed is not
 * settled on what it used to say.
 */

/** How many of each are said at once: the rest wait in Memory. */
const SAID = 5;

const token = (f: Fact): string => `${f.id}:${factHash(f).split("/").pop()!.slice(0, 6)}`;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export const trueNow: Tool = {
  name: "true_now",
  scope: "memory.write",
  pace: "fast",
  description:
    "Saved facts that may say one thing twice or disagree, or whose day has passed: 'list'; 'settle' one as the user says, keeping " +
    "those still true (the rest go to Trash). Only in their own words.",
  parameters: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["list", "settle"] },
      book: { type: "string", enum: ["mine", "family"], description: "Theirs, or what the family shares." },
      facts: { type: ["array", "null"], items: { type: "string" }, description: "settle: a pair's two, or the one whose day passed, as listed." },
      keep: { type: ["array", "null"], items: { type: "string" }, description: "settle: those still true, as listed; empty for none." },
    },
    required: ["op", "book", "facts", "keep"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const family = args.book === "family";
    const store = family ? ctx.memory.family : ctx.memory;
    if (!store) return "There is no family memory here.";
    const book = family ? (ctx.env.JARVIS_FAMILY ?? "") : bookOf(ctx.env.JARVIS_PERSON);
    if (args.op !== "settle") {
      const d = await doubtsOf(ctx.env, store.facts, book);
      if (!d) return "This deployment has no state object, so this cannot be looked at.";
      if (!d.pairs.length && !d.passed.length) return "Nothing to ask about: no two saved facts look alike, and none speaks of a day that has passed.";
      const lines = [
        ...d.pairs.slice(0, SAID).map((p, i) => `Pair ${i + 1}, may say one thing twice or disagree:\n  [${token(p.older)}] ${p.older.text}\n  [${token(p.newer)}] ${p.newer.text}`),
        ...d.passed.slice(0, SAID).map((p) => `Spoke of ${p.day}, now past: [${token(p.fact)}] ${p.fact.text}`),
      ];
      const more = Math.max(0, d.pairs.length - SAID) + Math.max(0, d.passed.length - SAID);
      return (
        asQuotedData("saved facts to check", lines.join("\n"), "THEIR SAVED MEMORY") +
        `${more ? `\n${more} more wait in Memory → Which is true now?.` : ""}\nAsk which are still true, one at a time; settle with the tokens in brackets.`
      );
    }
    if (ctx.env.JARVIS_DEVICE) return "Not done: a device changes memory by asking, through remember and forget.";
    if (!ownPart(ctx.asked ?? "")) return "Not done: only the user can say what is true, in their own words.";
    if (family && !ctx.memory.familyWrite) return "That is the whole family's, and this person may not change what the family shares.";
    const named = strings(args.facts);
    const all = named.map((t) => store.facts.find((f) => token(f) === t));
    if (!all.length || all.length > 2 || all.some((f) => !f) || (all.length === 2 && all[0] === all[1])) {
      return "Not settled: one of them is not kept any more, or was changed since it was listed. List them again.";
    }
    const keep = strings(args.keep).flatMap((t) => all.filter((f) => token(f!) === t).map((f) => f!.id));
    const gone = await settle(ctx.env, store, book, all as Fact[], keep);
    const whose = family ? ", for the whole family" : "";
    if (all.length === 1) return gone.length ? `Forgotten, to Trash${whose}.` : "Kept as still true; not asked about again until it changes.";
    if (!gone.length) return "Both kept as true; not asked about again until one of them changes.";
    return gone.length === 2 ? `Both forgotten, to Trash${whose}.` : `One forgotten, to Trash${whose}; the other is kept.`;
  },
};
