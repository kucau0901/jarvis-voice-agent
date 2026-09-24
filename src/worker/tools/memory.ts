import type { Tool } from "./registry";
import { sanitise, type Kind } from "../lib/memory.ts";

/** One spoken answer's worth. Beyond this it is a database, not a memory. */
const MAX_BATCH = 12;

/**
 * Durable facts about the user, replacing the one thing only Hermes could do.
 *
 * The descriptions are deliberately reluctant. A voice agent that hears
 * "remember X" will cheerfully accumulate trivia, and a few hundred junk facts
 * make the injected profile block useless long before any cap bites — so the
 * guidance about what NOT to save matters more than the storage does.
 */

const KINDS: Kind[] = ["place", "person", "preference", "vehicle", "routine", "note"];

export const remember: Tool = {
  name: "remember",
  scope: "memory.write",
  pace: "fast",
  description:
    "Save something durable about the user so it survives to future drives. Use this " +
    "only for facts that will still matter next week: an address, someone's name or " +
    "preference, a standing routine, how they like something done. Do NOT save " +
    "transient state (where they are now, what they just asked), anything you could " +
    "look up instead, or anything the user did not actually tell you. " +
    "When something you already knew turns out to be wrong, pass `replaces` with its " +
    "id rather than saving a second, contradicting copy. " +
    "For a place, always fill `place` with a name and a full street address — that is " +
    "what lets 'how long to get home' work later. " +
    "To save a LIST that arrived together — a staff roster, a set of rooms — put the " +
    "first entry in `text` and the rest in `more`, one short sentence each, rather " +
    "than calling this once per entry. " +
    "Use kind=reference for anything LOOKED UP rather than lived with: rosters, " +
    "supplier lists, phone directories, reference tables. Those are kept apart and " +
    "found by recall when asked for, so they cost nothing the rest of the time. " +
    "Reserve the other kinds for the handful of things worth carrying into every " +
    "conversation — home, family, the car, standing preferences.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The fact, as one short sentence." },
      kind: { type: "string", enum: KINDS, description: "What sort of fact this is." },
      place: {
        type: ["object", "null"],
        description: "For kind=place: the name it is called by, and a full street address.",
        properties: {
          name: { type: "string", description: "What the user calls it, e.g. 'home'." },
          address: { type: "string", description: "Full street address." },
        },
        required: ["name", "address"],
        additionalProperties: false,
      },
      replaces: {
        type: ["string", "null"],
        description: "Id of a fact this supersedes, from the profile block or recall.",
      },
      more: {
        type: ["array", "null"],
        items: { type: "string" },
        description:
          "Further facts of the SAME kind, saved in one go — one short sentence each. " +
          "Use this for a list that arrived together: a roster of staff and their " +
          "extensions, several rooms and their lights. Without it a seven-person list " +
          "costs seven calls and runs out of steps before it is saved. Null for a " +
          "single fact.",
      },
      pin: {
        type: ["boolean", "null"],
        description: "Keep this permanently, never evicted.",
      },
    },
    required: ["text", "kind", "place", "replaces", "pin", "more"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const clean = sanitise(args.text);
    if (!clean.ok) return `Not saved: ${clean.why}.`;

    const kind = (KINDS as string[]).includes(String(args.kind)) ? (args.kind as Kind) : "note";
    const place = args.place as { name?: string; address?: string } | null | undefined;

    const { fact, replaced } = ctx.memory.add({
      text: clean.text,
      kind,
      slug: place?.name,
      address: place?.address,
      replaces: typeof args.replaces === "string" ? args.replaces : undefined,
      pinned: args.pin === true ? true : undefined,
    });

    /*
     * A list arrives as one call, because it cannot arrive as several: asking
     * Hermes and then saving seven people is eight steps against a budget of
     * six, so the save would be cut off partway and leave half a roster.
     */
    const extra = Array.isArray(args.more) ? args.more : [];
    const saved: string[] = [];
    const skipped: string[] = [];
    for (const raw of extra.slice(0, MAX_BATCH)) {
      const one = sanitise(raw);
      if (!one.ok) {
        skipped.push(`${String(raw).slice(0, 40)} (${one.why})`);
        continue;
      }
      saved.push(ctx.memory.add({ text: one.text, kind }).fact.text);
    }

    const head = replaced
      ? `Updated what I had. It now reads: ${fact.text} [${fact.id}]`
      : `Saved: ${fact.text} [${fact.id}]`;
    if (!extra.length) return head;

    // Say how many landed, so a partial save cannot be reported as a whole one.
    return (
      `${head}\nAlso saved ${saved.length} more: ${saved.join("; ")}` +
      (skipped.length ? `\nNot saved: ${skipped.join("; ")}` : "")
    );
  },
};

export const recall: Tool = {
  name: "recall",
  scope: "memory.read",
  pace: "fast",
  description:
    "Search everything saved about the user, including the reference material that is " +
    "deliberately kept out of the profile block — rosters, directories, lists. The " +
    "profile already carries the handful of facts worth having everywhere, so reach " +
    "for this when what you need is not there: a name from a roster, an older note, " +
    "something specific, or a fact's id in order to change it.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for, in plain words." },
      limit: { type: ["integer", "null"], description: "How many to return. Default 6." },
    },
    required: ["query", "limit"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const query = String(args.query ?? "").trim();
    if (!query) return "No search text was supplied.";
    const limit = Number.isFinite(args.limit) ? Math.min(20, Math.max(1, Number(args.limit))) : 6;

    const hits = await ctx.memory.search(query, limit);
    if (!hits.length) {
      // Report the corpus size, so the model cannot read an empty result as
      // "nothing is known" and confabulate from it.
      const total = ctx.memory.facts.length;
      return total
        ? `Nothing saved matches that. I have ${total} thing${total === 1 ? "" : "s"} noted in total.`
        : "Nothing is saved about the user yet.";
    }
    return hits
      .map((h) => `[${h.fact.id}] ${h.fact.text}${h.fact.address ? ` — ${h.fact.address}` : ""}`)
      .join("\n");
  },
};

export const forget: Tool = {
  name: "forget",
  scope: "memory.write",
  pace: "fast",
  description:
    "Delete one saved fact, by its id. Ids come from the profile block or from recall. " +
    "If you do not have the id, call recall first — never guess.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "The fact id, e.g. m_1a2b3c4d." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    // Id only, never a fuzzy query: a misheard "forget about the office" must
    // not be able to delete the user's address.
    const id = String(args.id ?? "").trim();
    if (!/^m_[0-9a-f]{6,}$/i.test(id)) {
      return "That is not a fact id. Use recall to find the right one first.";
    }
    const gone = ctx.memory.remove(id);
    return gone ? `Forgotten: ${gone.text}` : "No saved fact has that id.";
  },
};

export const memoryTools: Tool[] = [remember, recall, forget];
