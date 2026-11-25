import type { Job } from "./jobs.ts";
import type { Episode } from "./episodes.ts";
import type { Specialty } from "./specialties.ts";
import { seen } from "./skill-md.ts";
import { secretShaped } from "./memory-guard.ts";
import { wellFormed } from "./quote.ts";
import { MAX_STEP, MAX_STEPS } from "./specialty-more.ts";

/**
 * What a finished job could be done the same way by, next time: drafted by
 * code, as a card its person may keep, change or leave (tools/specialties.ts
 * specialty_keep). Offered only when they corrected it as it worked, when one
 * like it failed before, or when they ask; never kept without a tap.
 *
 * It holds what they said to it, word for word, and how it was run. Never what
 * it read, found or wrote: a page or a mail that talked a job round would
 * otherwise be followed every time after. The one thing of the job's own is
 * its title, which its person reads before they keep it.
 */
export interface Learned {
  /** The specialty it changes, where the job used one, as it stood (`at`, its updatedAt), and what it would add; absent, a new one. */
  id?: string;
  at?: number;
  add?: string[];
  name: string;
  when: string[];
  steps: string[];
  why?: string;
}

/** One like it failed within this long. */
export const FAILED_MS = 30 * 86_400_000;
/** "Learn this" is of a job that ended within this long. */
export const ASKED_MS = 24 * 3_600_000;

const line = (s: string) => seen(s).text.replace(/\s+/g, " ").trim();

/** What its person told it, as they said it: not an answer to what it asked, nor its card, which were to the job's own words. */
const saidOf = (j: Job): string[] => (j.told ?? []).filter((t) => !t.by && !t.to && !t.card).map((t) => line(t.text)).filter((t) => t && t.length <= MAX_STEP && !secretShaped(t));

/** How it was run, where that is worth saying of one that worked after another failed. */
const howOf = (j: Job): string[] => [...(j.mode === "thorough" ? ["As a thorough job."] : []), ...(j.help?.chains.length ? ["With helpers."] : [])];

/**
 * The draft, from a job that is done; null when there is nothing to keep.
 * `failed`: one like it that failed before. `used`: the specialty it used,
 * which the draft then changes. `asked`: they asked for it.
 */
export function learned(j: Job, opts: { failed?: Episode | null; used?: Specialty | null; asked?: boolean } = {}): Learned | null {
  if (j.engine !== "jarvis" || j.status !== "done") return null;
  const had = opts.used?.steps ?? [];
  const fresh: string[] = [];
  for (const s of [...saidOf(j), ...(opts.failed || opts.asked ? howOf(j) : [])]) {
    if (had.length + fresh.length < MAX_STEPS && ![...had, ...fresh].some((h) => h.toLowerCase() === s.toLowerCase())) fresh.push(s);
  }
  if (!fresh.length) return null;
  const name = opts.used?.name ?? wellFormed(line(j.title).slice(0, 60)).trim();
  if (!name) return null;
  return {
    ...(opts.used ? { id: opts.used.id, at: opts.used.updatedAt, add: fresh } : {}),
    name,
    when: opts.used?.when ?? [],
    steps: [...had, ...fresh],
    ...(opts.used?.why ? { why: opts.used.why } : opts.failed ? { why: "An earlier try at this did not work." } : {}),
  };
}

const numbered = (steps: readonly string[]) => steps.map((s, i) => `${i + 1}. ${s}`).join("\n");

/** The draft as its card shows it: whole, and for a change what it was beside what it would be. */
export const learnedBody = (d: Learned, used?: Specialty | null): string =>
  used ? `Now:\n${numbered(used.steps)}\n\nIt would be:\n${numbered(d.steps)}` : `When you ask for: ${d.name}\n\n${numbered(d.steps)}${d.why ? `\n\nWhy: ${d.why}` : ""}`;

/** The scripts a job ran that worked, by their names in its folder: what could be kept with it, shown whole first (routes/memory.ts). */
export function scriptsOf(j: Pick<Job, "ran">): string[] {
  const out = new Set<string>();
  for (const r of j.ran ?? []) {
    // The job's own, not a helper's, whose folder is gone; and ended well.
    if (r.by || r.code !== 0) continue;
    for (const m of r.cmd.matchAll(/(?:^|[\s;&|])((?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.(?:py|js|mjs|sh))(?=$|[\s;&|<>])/g)) out.add(m[1]!);
  }
  return [...out].slice(0, 5);
}
