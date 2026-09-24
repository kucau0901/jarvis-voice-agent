import { carState, milesToKm, metricState, KM_PER_MILE } from "../src/worker/tools/tessie.ts";

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

/*
 * The reading that exposed the bug, measured on 23 September 2026: the car at
 * 69% and Jarvis saying "176 km of range". Tessie's 176 was MILES. The right
 * answer was 283 km.
 */
const BATTERY = { battery_level: 69, battery_range: 176.0 };

/** Shaped like Tessie's own /{vin}/state example, which is in miles and mph. */
const STATE = {
  charge_state: {
    battery_level: 69,
    battery_range: 176.0,
    est_battery_range: 150.2,
    ideal_battery_range: 180.4,
    charge_miles_added_rated: 14.5,
    charge_miles_added_ideal: 17.0,
    charge_rate: 0,
    charger_power: 0,
    charging_state: "Disconnected",
  },
  climate_state: { inside_temp: 31.5, outside_temp: 29, is_climate_on: false, driver_temp_setting: 22 },
  drive_state: { speed: 60, shift_state: "D", active_route_miles_to_arrival: 4.12, active_route_minutes_to_arrival: 5.43 },
  vehicle_state: { locked: true, odometer: 14096.485641, speed_limit_mode: { current_limit_mph: 85 } },
  gui_settings: { gui_distance_units: "km/hr" },
};

/** Answers Tessie's two read endpoints from the fixtures above. */
function stubTessie(battery: unknown = BATTERY, state: unknown = STATE) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = url.includes("/battery") ? battery : url.includes("/state") ? state : null;
    return new Response(JSON.stringify(body), { status: body ? 200 : 404 });
  }) as typeof fetch;
}

const ctx = {
  env: { TESSIE_TOKEN: "test-token", TESSIE_VIN: "LRWTEST0000000000" },
  signal: new AbortController().signal,
} as never;

const read = (what: string) => carState.run({ what }, ctx) as Promise<string>;

console.log("the conversion");
{
  check("a mile is 1.609344 km", KM_PER_MILE === 1.609344);
  check("the reading that exposed the bug: 176 mi is 283 km", milesToKm(176) === 283);
  check("zero is zero, not missing", milesToKm(0) === 0);
  check("a missing reading stays missing", milesToKm(undefined) === undefined && milesToKm(null) === undefined);
  check("a string is not a reading", milesToKm("176") === undefined);
}

console.log("\ncar_state — battery");
{
  stubTessie();
  const out = await read("battery");
  check("says 283 km, not 176", /range 283 km/.test(out), out);
  check("never says the raw miles figure", !/\b176\b/.test(out), out);
  check("keeps the percentage", /Battery 69%/.test(out), out);

  // Used to be `?? 0`, which turned "no reading" into "0 km" — a confident,
  // alarming, invented number.
  stubTessie({ battery_level: 69 });
  const missing = await read("battery");
  check("a missing range is left out, not reported as 0 km", !/km/.test(missing) && missing === "Battery 69%.", missing);
}

console.log("\ncar_state — summary");
{
  stubTessie();
  const out = await read("summary");
  check("says about 283 km of range", /about 283 km of range/.test(out), out);
  check("never says the raw miles figure", !/\b176\b/.test(out), out);
  check("the rest of the summary is intact", /It is locked\./.test(out) && /Shift state D\./.test(out), out);

  stubTessie(BATTERY, { ...STATE, charge_state: { battery_level: 69 } });
  const missing = await read("summary");
  check("no range reading means no range claim", /^Battery 69%\. /.test(missing) && !/km/.test(missing), missing);
}

console.log("\ncar_state — everything");
{
  stubTessie();
  const out = await read("everything");
  const doc = JSON.parse(out) as Record<string, Record<string, unknown>>;
  const charge = doc.charge_state!;
  const drive = doc.drive_state!;
  const vehicle = doc.vehicle_state!;

  check("range is converted and named for its unit", charge.battery_range_km === 283.2, charge);
  check("the miles-named key is gone, so it cannot be misread", !("battery_range" in charge));
  check("estimated range too", charge.est_battery_range_km === 241.7, charge.est_battery_range_km);
  check("ideal range too", charge.ideal_battery_range_km === 290.3, charge.ideal_battery_range_km);
  // The only route to the odometer the tool description promises.
  check("odometer: 14096 mi is 22686 km", vehicle.odometer_km === 22686.1 && !("odometer" in vehicle), vehicle);
  check("speed: 60 mph is 96.6 km/h", drive.speed_kmh === 96.6 && !("speed" in drive), drive);
  check("route distance converted", drive.active_route_km_to_arrival === 6.6, drive);
  check("route MINUTES untouched — a time is not a distance", drive.active_route_minutes_to_arrival === 5.43);
  check("charge added converted", charge.charge_km_added_rated === 23.3 && charge.charge_km_added_ideal === 27.4, charge);
  check("charge rate converted", charge.charge_rate_km_per_hour === 0 && !("charge_rate" in charge), charge);
  check("charger power is kW and untouched", charge.charger_power === 0);
  check("battery percentage untouched", charge.battery_level === 69);
  check("temperatures untouched — the API reports Celsius already", (doc.climate_state as Record<string, unknown>).inside_temp === 31.5);
  check("a field already named for its unit is left alone",
    (vehicle.speed_limit_mode as Record<string, unknown>).current_limit_mph === 85);
  check("non-numeric values pass through", charge.charging_state === "Disconnected" && drive.shift_state === "D");
}

console.log("\ncar_state — odometer");
{
  stubTessie();
  const out = await read("odometer");
  // 14096.485641 mi x 1.609344 = 22686.09 km.
  check("reads the odometer in km", out === "Odometer 22686 km.", out);
  check("never the raw miles figure", !/14096/.test(out), out);

  // A missing reading is said to be missing, never turned into "0 km".
  stubTessie(BATTERY, { ...STATE, vehicle_state: { locked: true } });
  const missing = await read("odometer");
  check("a missing odometer is said to be missing", missing === "The car did not report an odometer reading.", missing);

  stubTessie(BATTERY, { charge_state: {} });
  check("so is a state with no vehicle_state at all",
    (await read("odometer")) === "The car did not report an odometer reading.");
}

console.log("\nthe schema the router is handed");
{
  const params = carState.parameters as {
    properties: { what: { enum: string[]; description: string } };
    required: string[];
    additionalProperties: boolean;
  };
  check("odometer is an option", params.properties.what.enum.includes("odometer"));
  check("the description tells the router what it is for", /odometer is the total distance driven/.test(params.properties.what.description));
  // The old description said summary covered location. It never did, so a
  // router trusting it would ask for the summary and get no location back.
  check("summary no longer claims to cover location", /not where it is; that is location/.test(params.properties.what.description));
  // OpenAI strict mode rejects the WHOLE tool list if any property is missing
  // from `required` — this has taken Jarvis down once already.
  check("strict mode: every property is required",
    Object.keys(params.properties).every((k) => params.required.includes(k)) && params.additionalProperties === false);
}

console.log("\nmetricState on its own");
{
  check("arrays are walked", JSON.stringify(metricState([{ odometer: 1 }])) === '[{"odometer_km":1.6}]');
  check("null speed (parked) is not invented into a number",
    JSON.stringify(metricState({ speed: null })) === '{"speed":null}');
  check("scalars pass through", metricState(7) === 7 && metricState("x") === "x" && metricState(null) === null);
  const input = { odometer: 10 };
  metricState(input);
  check("the input is not mutated", input.odometer === 10);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
