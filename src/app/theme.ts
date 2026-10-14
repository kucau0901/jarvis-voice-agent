/**
 * Light or dark, per screen.
 *
 * Auto is the default: light by day and dark at night, by this screen's own
 * clock. Not the system setting, because Chromium 148 in the car can report
 * prefers-color-scheme: light at night, and a white screen is the last thing
 * a driver wants after dark. System is there for a phone or a laptop that
 * reports it properly; Dark and Light hold whatever the hour.
 *
 * Kept per screen, in localStorage, like the voice's loudness (loud.ts): the
 * car and a phone in the same family can differ. The colours themselves are
 * the custom properties in index.html, dark in :root and light under
 * [data-theme="light"].
 */

export type ThemeChoice = "auto" | "system" | "dark" | "light";
export type Theme = "light" | "dark";
export const THEMES: readonly ThemeChoice[] = ["auto", "system", "dark", "light"];

/** Auto's day, on this screen's clock: light from 07:00 until 19:00. */
export const DAY_STARTS = 7;
export const NIGHT_STARTS = 19;

const KEY = "jarvis.theme";
/** Until when light stays right, for the one line in index.html that paints it before anything loads. */
const LIGHT_UNTIL = "jarvis.lightUntil";

export function asThemeChoice(v: string | null | undefined): ThemeChoice {
  return v === "system" || v === "dark" || v === "light" ? v : "auto";
}

export function resolveTheme(choice: ThemeChoice, hour: number, systemDark: boolean): Theme {
  if (choice === "dark" || choice === "light") return choice;
  if (choice === "system") return systemDark ? "dark" : "light";
  return hour >= DAY_STARTS && hour < NIGHT_STARTS ? "light" : "dark";
}

/**
 * Until when the theme just shown stays right, as a time: never for dark,
 * 19:00 today for Auto's light, for good for a chosen or the system's light.
 */
export function lightUntil(choice: ThemeChoice, shown: Theme, now: Date): number {
  if (shown === "dark") return 0;
  if (choice !== "auto") return 8.64e15;
  return new Date(now).setHours(NIGHT_STARTS, 0, 0, 0);
}

/** Without storage (private mode) a choice lasts until the page closes. */
let unsaved: ThemeChoice | null = null;

export function themeChoice(): ThemeChoice {
  try {
    return asThemeChoice(localStorage.getItem(KEY));
  } catch {
    return unsaved ?? "auto";
  }
}

const listeners = new Set<(t: Theme) => void>();
let shown: Theme | null = null;

function apply(): void {
  const choice = themeChoice();
  const now = new Date();
  const t = resolveTheme(choice, now.getHours(), matchMedia("(prefers-color-scheme: dark)").matches);
  // Every time, not only on a change: a new choice can keep the theme and still end it at another hour.
  try {
    localStorage.setItem(LIGHT_UNTIL, String(lightUntil(choice, t, now)));
  } catch {
    // the next load paints dark first, then this
  }
  if (t === shown) return;
  shown = t;
  const root = document.documentElement;
  root.dataset.theme = t;
  // The browser's own bar takes the page's colour: read it from the CSS, which stays the one source.
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(root).getPropertyValue("--bg").trim());
  for (const f of listeners) f(t);
}

export function setThemeChoice(c: ThemeChoice): void {
  unsaved = c;
  try {
    localStorage.setItem(KEY, c);
  } catch {
    // kept in `unsaved` instead
  }
  apply();
}

/**
 * Calls `f` with the theme now and whenever it changes: a new choice, Auto
 * crossing 07:00 or 19:00, or the system's setting. Checked once a minute
 * rather than timed to the boundary, which also survives the screen sleeping
 * through it.
 */
export function watchTheme(f: (t: Theme) => void): void {
  if (!listeners.size) {
    setInterval(apply, 60_000);
    document.addEventListener("visibilitychange", apply);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", apply);
  }
  listeners.add(f);
  apply();
  f(shown!);
}
