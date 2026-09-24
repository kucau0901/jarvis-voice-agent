import type { ClientKind } from "../worker/lib/prompt.ts";

/**
 * Working out where Jarvis is running.
 *
 * This matters because the answer changes: a driver cannot spare attention,
 * someone at a desk can read a list. Getting it wrong is not fatal either way —
 * the worst case is answers terser than they needed to be.
 *
 * ── What the car actually reports ──────────────────────────────────────────
 *
 * Measured, finally, on 21 September 2026 from the real dashboard:
 *
 *   ua                Mozilla/5.0 (X11; Linux x86_64) … Chrome/148.0.0.0
 *   platform          Linux x86_64      deviceMemory 2, hardwareConcurrency 8
 *   innerWidth        773 x 601         screen 1254 x 784, DPR 1.53
 *   pointerFine       true
 *   pointerCoarse     false
 *   anyPointerCoarse  true
 *
 * Two things follow. **There is no `Tesla` token in the user agent** — the
 * probe reports "NOT a Tesla browser", and it is right. Any detection that
 * waits for one waits forever.
 *
 * And the window is 773 CSS pixels wide, which is narrower than a lot of
 * phones in landscape. Size cannot separate them.
 *
 * ── What does separate them ────────────────────────────────────────────────
 *
 * The pointer pair, which is exactly what the probe recorded:
 *
 *   primary coarse                    a phone or tablet — you touch it
 *   primary fine, nothing coarse      a computer — mouse or trackpad, no touch
 *   primary fine, something coarse    the car — it reports a precise pointer
 *                                     AND has a touchscreen
 *
 * That last combination is unusual enough to be a decent fingerprint. A
 * touchscreen laptop shares it and would be read as a car; the cost of that is
 * shorter answers, and `?client=` settles it for anyone who minds.
 */

export interface Signals {
  /** `(pointer: coarse)` — the PRIMARY input is a finger. */
  pointerCoarse: boolean;
  /** `(any-pointer: coarse)` — some input is a finger, primary or not. */
  anyPointerCoarse: boolean;
  override?: string | null;
}

const VALID = new Set(["car", "desktop", "mobile", "device"]);

export function detectClient(s: Signals): ClientKind {
  if (s.override && VALID.has(s.override)) return s.override as ClientKind;

  // Touch as the primary way in: a phone or a tablet.
  if (s.pointerCoarse) return "mobile";

  // A precise pointer, and a touchscreen alongside it. The dashboard.
  if (s.anyPointerCoarse) return "car";

  // A precise pointer and no touch at all.
  return "desktop";
}

/** Read what this browser reports. */
export function currentClient(): ClientKind {
  try {
    const override = new URLSearchParams(location.search).get("client");
    return detectClient({
      pointerCoarse: matchMedia("(pointer: coarse)").matches,
      anyPointerCoarse: matchMedia("(any-pointer: coarse)").matches,
      override,
    });
  } catch {
    // The car is the safe default: its instructions are the briefest, and
    // brevity is never the thing that causes harm.
    return "car";
  }
}
