/** How many results a tool is asked for: a whole number from 1 to `max`, else `fallback`. */
export const clampLimit = (v: unknown, fallback: number, max: number): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, n);
};
