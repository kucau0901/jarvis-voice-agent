/**
 * What a brief for the web says of its person that it need not (tools/jobs.ts
 * start_job). A job on the web is handed nothing of theirs (lib/jobs.ts Reach),
 * but its brief is written by a model that knows who they are, and what is
 * looked up leaves by the words of the search. The tool's description asks for
 * only the facts the work needs; asked to plan a trip, the model still wrote
 * their full name and the part of town they live in (24 Nov 2026). So code
 * looks, where it can be sure: their names and the family's, an address saved
 * in memory as far as the house or the street, an email address, a phone
 * number. Not the town, which prices and what is near depend on. Their own
 * words are theirs: what their message says may be in it.
 */

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A whole word: a name as one is written, with its capital, so that a rose is not Rose; in what they said, however they wrote it. */
const named = (word: string, text: string, flags = "u") => new RegExp(`(?<![\\p{L}\\p{N}])${escaped(word)}(?![\\p{L}\\p{N}])`, flags).test(text);
const capital = (w: string) => w[0]!.toUpperCase() + w.slice(1);

export interface Known {
  /** Their name, what they like to be called, and the family's names. */
  names: readonly string[];
  /** The addresses saved in memory. */
  addresses: readonly string[];
}

/** What is in `brief` that says who or exactly where they are, as it is written there; not what `asked`, their own message, says. */
export function tells(brief: string, known: Known, asked: string): string[] {
  const out = new Set<string>();
  const theirs = asked.toLowerCase();
  const words = new Set(known.names.flatMap((n) => n.match(/\p{L}{3,}/gu) ?? []).map(capital));
  for (const w of words) if (named(w, brief) && !named(w, asked, "iu")) out.add(w);
  // A part of an address with a number in it, and a street's words or a number as long as a postcode, is the house or
  // the street: not "No 12" or "Level 3", which a brief may mean otherwise, and not the rest, which may be a town.
  const parts = known.addresses.flatMap((a) => a.split(",")).map((p) => p.trim())
    .filter((p) => /\d/.test(p) && /\p{L}/u.test(p) && ((p.match(/\p{L}{2,}/gu) ?? []).length >= 2 || /\d{4}/.test(p)));
  const said = brief.toLowerCase();
  for (const p of parts) if (said.includes(p.toLowerCase()) && !theirs.includes(p.toLowerCase())) out.add(p);
  for (const m of brief.matchAll(/(?<![\w.+-])[\w.+-]{1,64}@[\w-]{1,63}\.[\w.]{2,}|\+?\d[\d ()-]{7,40}\d/g)) {
    const found = m[0].trim();
    // A phone number has nine digits or more; fewer may be a price, a year or a model.
    if (!found.includes("@") && found.replace(/\D/g, "").length < 9) continue;
    if (!theirs.includes(found.toLowerCase())) out.add(found);
  }
  return [...out];
}
