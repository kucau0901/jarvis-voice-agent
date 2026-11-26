import { wordsOf } from "../lib/jobs.ts";

/**
 * Those most of `want` names, by the start of their words: the model calls a
 * thing by what it was about ("the power bank comparison"), not by its title.
 * With no words, all of them; with none that fit, all, or where `named` (a
 * change or a stop is not given to whatever is there) none, as where a third
 * of the words or fewer fit.
 */
export function nearest<T>(all: readonly T[], want: readonly string[], words: (x: T) => string, named = false): T[] {
  const fit = all.map((x) => {
    const has = wordsOf(words(x));
    return want.filter((w) => has.some((h) => h.startsWith(w))).length;
  });
  const best = Math.max(0, ...fit);
  if (named && want.length && best * 3 <= want.length) return [];
  return all.filter((_, i) => fit[i] === best);
}

/** How many results a tool is asked for: a whole number from 1 to `max`, else `fallback`. */
export const clampLimit = (v: unknown, fallback: number, max: number): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, n);
};
