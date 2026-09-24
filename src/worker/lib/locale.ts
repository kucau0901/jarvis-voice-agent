import type { Env } from "../types";

/**
 * Where the user is, from the settings panel.
 *
 * Until September 2026 this was Malaysia, hard-coded in nine places: the
 * router's clock and its "the user is in Malaysia" line, the calendar and
 * Gmail's time zone, the directions and geocoding region, the car's navigation
 * locale, and kilometres. A public repo cannot ship that, so each site now asks
 * here. Defaults are neutral — UTC, no country bias, English, metric — and a
 * deployment sets its own in the panel.
 *
 * Every value is validated again here rather than trusted: a bad time zone
 * would throw inside Intl on every request, which is a worse failure than
 * quietly using UTC.
 */
export interface Locale {
  timeZone: string;
  /** Upper-case ISO 3166 alpha-2, or undefined when no bias is wanted. */
  country?: string;
  /** The language alone: "en", "ms". */
  language: string;
  /** Language with a region when one is known: "en-MY". */
  tag: string;
  units: "metric" | "imperial";
}

const validZone = (tz: string | undefined): string | undefined => {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
};

const validTag = (t: string | undefined): string | undefined => {
  if (!t) return undefined;
  try {
    return Intl.getCanonicalLocales(t)[0];
  } catch {
    return undefined;
  }
};

export function localeOf(env: Env): Locale {
  const timeZone = validZone(env.TIMEZONE?.trim()) ?? "UTC";
  const country = /^[A-Za-z]{2}$/.test(env.COUNTRY?.trim() ?? "") ? env.COUNTRY!.trim().toUpperCase() : undefined;
  const given = validTag(env.LOCALE?.trim()) ?? "en";
  const language = given.split("-")[0]!;
  const tag = given.includes("-") ? given : country ? `${language}-${country}` : language;
  const units = env.UNITS?.trim().toLowerCase() === "imperial" ? "imperial" : "metric";
  return { timeZone, country, language, tag, units };
}

/** "+08:00", "-05:00", "+00:00" — the offset in force at `at`. */
export function utcOffset(timeZone: string, at = new Date()): string {
  const part = new Intl.DateTimeFormat("en", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(part);
  return m ? `${m[1]}:${m[2] ?? "00"}` : "+00:00";
}

/** "Malaysia", "United Kingdom" — or undefined when there is no country. */
export function countryName(l: Locale): string | undefined {
  if (!l.country) return undefined;
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(l.country) ?? l.country;
  } catch {
    return l.country;
  }
}
