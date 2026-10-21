import { api } from "./key";
import { inCar } from "./client";
import { clockSun, sunHeight } from "./sun";

/**
 * The sky behind the app (orb/Sky.ts): the sun where it is now, where home is
 * when the house says, else by the clock; the clouds, the rain and the air
 * from the house and a panel (GET /api/hub/panels/sky). The sun's own
 * maths is sun.ts.
 */

/** Whether the sky holds still: the car's view while driving (narrow), or a screen asking for less motion. */
export const stillHere = (): boolean =>
  (inCar() && innerWidth < 900) || matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface SkyFeed {
  set(s: { sun: number; cloud: number; rain: number; haze: number }): void;
  freeze(still: boolean): void;
}

const PLACE = "jarvis.skyPlace";
const EVERY_MS = 15 * 60_000;

/**
 * Kept up while the page is shown: the weather every quarter hour, the sun
 * every minute. The key is read each time, since unlocking can change it
 * without a reload; what it returns fetches the weather now.
 */
export function watchSky(keyOf: () => string, sky: SkyFeed): () => void {
  let place: { lat: number; lng: number } | null = null;
  try {
    place = JSON.parse(localStorage.getItem(PLACE) ?? "null");
  } catch {
    // none kept: by the clock until the house says
  }
  let weather = { cloud: 0, rain: 0, haze: 0 };
  const now = () => {
    const d = new Date();
    sky.set({ sun: place ? sunHeight(place.lat, place.lng, d) : clockSun(d.getHours() + d.getMinutes() / 60), ...weather });
  };
  const fetchIt = async () => {
    const key = keyOf();
    if (document.hidden || !key) return;
    try {
      const s = (await api(key, "GET", "/api/hub/panels/sky")) as { lat?: number; lng?: number; cloud: number; rain: number; haze: number };
      weather = { cloud: s.cloud, rain: s.rain, haze: s.haze };
      if (typeof s.lat === "number" && typeof s.lng === "number") {
        place = { lat: s.lat, lng: s.lng };
        try {
          localStorage.setItem(PLACE, JSON.stringify(place));
        } catch {
          // private mode: asked again next time
        }
      }
    } catch {
      // a guest, a device, the house away: the sky by the clock, clear
    }
    now();
  };
  now();
  sky.freeze(stillHere());
  void fetchIt();
  setInterval(() => void fetchIt(), EVERY_MS);
  setInterval(now, 60_000);
  addEventListener("resize", () => sky.freeze(stillHere()));
  document.addEventListener("visibilitychange", () => !document.hidden && void fetchIt());
  return () => void fetchIt();
}
