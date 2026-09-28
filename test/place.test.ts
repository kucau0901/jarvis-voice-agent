// show_place (tools/place.ts): Google refusing is not a place that does not exist.
import { showPlace } from "../src/worker/tools/place.ts";

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

const shown: unknown[] = [];
const ctx = {
  env: { GOOGLE_MAPS_API_KEY: "test-maps-key" },
  signal: new AbortController().signal,
  memory: { findPlace: () => undefined },
  progress() {},
  display: (x: unknown) => void shown.push(x),
  grants: ["*"],
} as never;
const answer = (body: unknown) => {
  globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
};
const show = async (query: string) => String(await showPlace.run({ query, view: "map" }, ctx));

console.log("show_place: what the geocoder says");
const realFetch = globalThis.fetch;
try {
  answer({ status: "ZERO_RESULTS", results: [] });
  const none = await show("Nowhere Street");
  check("no results: not found, ask for the address", /could not find "Nowhere Street"/.test(none), none);

  answer({ status: "REQUEST_DENIED", error_message: "This API project is not authorized to use this API.", results: [] });
  const denied = await show("Pavilion");
  check("a refused key is said as a refusal, not a missing place", denied === "Could not look that place up: Google Maps said REQUEST_DENIED (This API project is not authorized to use this API.).", denied);

  answer({ status: "OVER_QUERY_LIMIT", results: [] });
  const quota = await show("Pavilion");
  check("so is being over the quota", quota === "Could not look that place up: Google Maps said OVER_QUERY_LIMIT.", quota);
  check("and nothing was put on the screen", shown.length === 0, shown);

  answer({ status: "OK", results: [{ formatted_address: "Jalan Bukit Bintang, Kuala Lumpur", geometry: { location: { lat: 3.149, lng: 101.713 } } }] });
  await show("Pavilion");
  check("found: it goes on the screen", shown.length === 1, shown);
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
