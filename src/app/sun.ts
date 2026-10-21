/**
 * Where the sun is, for the sky behind the app (sky.ts): pure, with no
 * imports, so Node tests it.
 */

/** The sun's height, -1 (straight down) to 1 (overhead), at a place and time: the sine of its elevation. */
export function sunHeight(lat: number, lng: number, at: Date): number {
  const rad = Math.PI / 180;
  const start = Date.UTC(at.getUTCFullYear(), 0, 0);
  const day = (at.getTime() - start) / 86_400_000;
  const decl = 23.44 * rad * Math.sin((2 * Math.PI * (284 + day)) / 365);
  const solarHours = at.getUTCHours() + at.getUTCMinutes() / 60 + lng / 15;
  const hourAngle = 15 * rad * (solarHours - 12);
  return Math.sin(lat * rad) * Math.sin(decl) + Math.cos(lat * rad) * Math.cos(decl) * Math.cos(hourAngle);
}

/** The sun by the clock alone, with nowhere known: up at six, highest at noon, down at six. */
export const clockSun = (hours: number): number => Math.sin((Math.PI * (hours - 6)) / 12);
