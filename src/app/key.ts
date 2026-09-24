/**
 * The shared secret gating /api/*.
 *
 * Reachable three ways, in order of convenience: already stored, passed once as
 * `#key=…`, or typed into the unlock screen. Typing is the fallback that matters,
 * because the Tesla's on-screen keyboard makes a long URL genuinely painful.
 */
const STORAGE_KEY = "jarvis.key";

/** A device token, which is exact bytes rather than a typed-in key. */
const DEVICE_TOKEN = /^jdv1_[abcdefghijkmnpqrstuvwxyz23456789]{32}$/;

/** Uppercase and drop anything not in the key alphabet, so spaces, dashes and
 *  the car keyboard's stray capitalisation all still work.
 *
 *  A device token is returned untouched: uppercasing it and stripping the
 *  underscore would throw away most of its entropy and it would never match.
 *  The owner's key contains no lowercase and no underscore, so the two shapes
 *  cannot be confused for one another. */
export function normalise(raw: string): string {
  const t = raw.trim();
  if (DEVICE_TOKEN.test(t)) return t;
  return t.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function loadKey(): string {
  try {
    const m = /key=([^&]+)/.exec(location.hash);
    if (m?.[1]) {
      const v = normalise(decodeURIComponent(m[1]));
      localStorage.setItem(STORAGE_KEY, v);
      // Strip it from the address bar so it is not left on screen in the car.
      history.replaceState(null, "", location.pathname + location.search);
      return v;
    }
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return normalise(/key=([^&]+)/.exec(location.hash)?.[1] ?? "");
  }
}

export function saveKey(raw: string): string {
  const v = normalise(raw);
  try { localStorage.setItem(STORAGE_KEY, v); } catch { /* private mode */ }
  return v;
}

export function clearKey(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

export function authHeaders(key: string): Record<string, string> {
  // A device token goes as a Bearer credential because the Worker's redact()
  // scrubs that form out of logs; X-Jarvis-Key gets no such treatment.
  return DEVICE_TOKEN.test(key)
    ? { "Content-Type": "application/json", Authorization: `Bearer ${key}` }
    : { "Content-Type": "application/json", "X-Jarvis-Key": key };
}
