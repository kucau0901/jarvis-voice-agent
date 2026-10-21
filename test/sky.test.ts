// The sky behind the app: where the sun is (src/app/sun.ts), the weather and
// the air it is drawn from (lib/sky.ts), and how it holds its cost
// (src/app/orb/governor.ts, shared with the orb).
import { clockSun, sunHeight } from "../src/app/sun.ts";
import { hazeOf, skyOf } from "../src/worker/lib/sky.ts";
import { Governor } from "../src/app/orb/governor.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 300) : "");
  }
}

console.log("the sun");
{
  const noon = sunHeight(0, 0, new Date(Date.UTC(2026, 2, 20, 12, 0)));
  const midnight = sunHeight(0, 0, new Date(Date.UTC(2026, 2, 20, 0, 0)));
  check("at the equator at the equinox: overhead at noon, under at midnight", noon > 0.99 && midnight < -0.99, [noon, midnight]);
  const winter = sunHeight(60, 0, new Date(Date.UTC(2026, 11, 21, 12, 0)));
  check("at 60° north in December, low even at noon", winter > 0 && winter < 0.15, winter);
  // Kuala Lumpur, 3.1°N 101.7°E: up at about 07:15 local, so before dawn at 06:00 (22:00 UTC).
  check("by where it is: dark before dawn, high after noon", sunHeight(3.1, 101.7, new Date(Date.UTC(2026, 9, 20, 22, 0))) < 0 && sunHeight(3.1, 101.7, new Date(Date.UTC(2026, 9, 21, 5, 0))) > 0.9);
  check("by the clock when nowhere is known", Math.abs(clockSun(6)) < 1e-9 && clockSun(12) === 1 && clockSun(0) < -0.99 && Math.abs(clockSun(18)) < 1e-9);
}

console.log("\nthe weather and the air");
{
  check("sunny, with a place", JSON.stringify(skyOf('{"lat": 3.1, "lng": 101.7, "state": "sunny", "cloud": null}')) === JSON.stringify({ lat: 3.1, lng: 101.7, cloud: 0, rain: 0 }));
  check("pouring", JSON.stringify(skyOf('{"state": "pouring"}')) === JSON.stringify({ cloud: 1, rain: 1 }));
  check("a measured cover beats the word", skyOf('{"state": "sunny", "cloud": 75}').cloud === 0.75);
  check("nothing it can read: a clear sky, no place", JSON.stringify(skyOf("not json")) === JSON.stringify({ cloud: 0, rain: 0 }) && !("lat" in skyOf('{"lat": 300, "lng": 1}')));
  const tile = (ask: string) => ({ kind: "tile" as const, ref: JSON.stringify({ read: { ask, every: 60 } }), label: "Air" });
  const panels = [{ id: "p1", title: "Outside", items: [tile("Latest weather for the town"), tile("Latest air-quality reading (API) for the town")], at: 0 }];
  const reading = (text: string) => async () => ({ text, figures: [], at: 0 });
  check("haze from a kept air-quality reading", (await hazeOf(panels, reading("API 175, unhealthy"))) === 0.5 && (await hazeOf(panels, reading("API 30, good"))) === 0);
  check("…none without one", (await hazeOf([{ ...panels[0]!, items: [tile("Latest weather")] }], reading("31 degrees"))) === 0 && (await hazeOf(panels, async () => null)) === 0);
}

console.log("\nits cost");
{
  const g = new Governor(20, 7);
  let step: number = 0;
  for (let i = 0; i < 90; i++) step = g.push(30, 10_000);
  check("a slow 90 frames: do less", step === -1);
  for (let i = 0; i < 90; i++) step = g.push(30, 11_000);
  check("…not again within 4 seconds", step === 0);
  for (let i = 0; i < 90; i++) step = g.push(2, 20_000);
  check("fast: may do more", step === 1);
  for (let i = 0; i < 90; i++) step = g.push(12, 30_000);
  check("in between: as it is", step === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
