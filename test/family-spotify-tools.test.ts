// Two tools no test reached, as they behave today: pass_on's reading of when
// and how long (tools/family.ts), and what the Spotify tools say when they
// cannot work (tools/spotify.ts guard). Written before the Google and Spotify
// guards are shared and before pass_on's time pattern moves (REFACTOR_PLAN.md
// steps 21 and 22).
import { familyTools } from "../src/worker/tools/family.ts";
import { spotifyTools } from "../src/worker/tools/spotify.ts";
import { zonedToUtc } from "../src/worker/lib/routines.ts";

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

const TZ = "Asia/Kuala_Lumpur";
const tool = (list: { name: string; run: (a: Record<string, unknown>, c: never) => Promise<unknown> }[], name: string) => list.find((t) => t.name === name)!;

console.log("pass_on: when, how long, and what is said back");
{
  const made: Record<string, unknown>[] = [];
  let reply: unknown = { relays: [{ status: "sent", toName: "Sara" }], noHome: [] };
  const stub = { relayCreate: async (input: Record<string, unknown>) => (made.push(input), reply) };
  const env = { STATE: { idFromName: () => "jarvis", get: () => stub }, TIMEZONE: TZ, JARVIS_FAMILY: "fam:s_test", JARVIS_PERSON: "owner", JARVIS_PERSON_NAME: "Adam" };
  const ctx = { env, signal: new AbortController().signal, progress() {}, display() {}, memory: {}, grants: ["*"] } as never;
  const passOn = tool(familyTools as never, "pass_on");
  const base = { to: "Sara", kind: "remind", text: "Buy milk", local_time: null, in_minutes: null, when_home: null, answer_within_minutes: null };
  const run = async (over: Record<string, unknown>) => {
    made.length = 0;
    return String(await passOn.run({ ...base, ...over }, ctx));
  };

  let said = await run({});
  check("now: no time given to the relay", made[0]?.after === undefined && made[0]?.kind === "remind" && made[0]?.from === "owner" && made[0]?.fromName === "Adam", made[0]);
  check("and it says it reached them", said === "Passed on to Sara: it has reached them. Their answer will come back to the user by itself.", said);

  await run({ local_time: "2030-01-05T17:00" });
  check("a local time is the family's zone's", made[0]?.after === zonedToUtc(2030, 1, 5, 17, 0, TZ), made[0]);
  await run({ local_time: "2030-01-05 17:00" });
  check("a space between date and time works too", made[0]?.after === zonedToUtc(2030, 1, 5, 17, 0, TZ), made[0]);

  const t0 = Date.now();
  await run({ in_minutes: 30 });
  const after = Number(made[0]?.after);
  check("in 30 minutes", after >= t0 + 30 * 60_000 && after <= Date.now() + 30 * 60_000, made[0]);
  await run({ in_minutes: 2.6 });
  check("minutes are rounded", Math.abs(Number(made[0]?.after) - Date.now() - 3 * 60_000) < 5_000, made[0]);
  await run({ in_minutes: 0 });
  check("zero minutes is now", made[0]?.after === undefined, made[0]);
  await run({ local_time: "2030-01-05T17:00", in_minutes: 30 });
  check("a local time wins over minutes", made[0]?.after === zonedToUtc(2030, 1, 5, 17, 0, TZ), made[0]);
  await run({ local_time: "tomorrow at five" });
  check("a time it cannot read is ignored", made[0]?.after === undefined, made[0]);

  said = await run({ local_time: "2020-01-01T10:00" });
  check("a time already gone is refused, and nothing is made", said === "Not passed on: that time has already gone. Ask when." && made.length === 0, said);

  await run({ when_home: true, answer_within_minutes: 15 });
  check("when home and a time to answer go through", made[0]?.whenHome === true && made[0]?.answerMin === 15, made[0]);
  await run({ answer_within_minutes: 2.5 });
  check("a time to answer that is not whole is left out", !("answerMin" in (made[0] ?? {})), made[0]);
  await run({ kind: "shout" });
  check("an unknown kind is a tell", made[0]?.kind === "tell", made[0]);

  reply = "nobody in the family is called \"Zed\"";
  said = await run({ to: "Zed" });
  check("a refusal is said back", said === 'Not passed on: nobody in the family is called "Zed".', said);

  reply = { relays: [{ status: "waiting", toName: "Sara", after: zonedToUtc(2030, 1, 5, 17, 0, TZ) }], noHome: ["Sara"] };
  said = await run({ local_time: "2030-01-05T17:00", when_home: true });
  check(
    "later, with no home person: scheduled, not sent, and said so",
    said === "Scheduled, not sent yet: it will reach Sara at Sat 5 Jan, 17:00. It is in the user's conversation with Sara already, and Sara has been told it is coming. Sara has no Home Assistant person set, so it goes by the time alone. Their answer will come back to the user by itself.",
    said,
  );
  reply = { relays: [{ status: "waiting", toName: "Aisyah", home: "person.aisyah" }], noHome: [] };
  said = await run({ to: "Aisyah", when_home: true });
  check(
    "when she is home: once they are home",
    said === "Scheduled, not sent yet: it will reach Aisyah once they are home. It is in the user's conversation with Aisyah already, and Aisyah has been told it is coming. Their answer will come back to the user by itself.",
    said,
  );
}

console.log("\nSpotify: what it says when it cannot work");
{
  const kv = new Map<string, string>();
  const CONFIG = { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v), delete: async (k: string) => void kv.delete(k) };
  const ctx = (env: Record<string, unknown>) => ({ env: { CONFIG, ...env }, signal: new AbortController().signal, progress() {}, display() {}, memory: {}, grants: ["*"] }) as never;
  const state = tool(spotifyTools as never, "music_state");
  const LINK = "Spotify is not linked yet. The user needs to open /api/spotify/auth once from a phone or laptop and approve access. Tell them that plainly; do not retry.";

  check("not set up", String(await state.run({}, ctx({}))) === "Spotify error: Spotify is not configured");
  const keys = { SPOTIFY_CLIENT_ID: "id", SPOTIFY_CLIENT_SECRET: "secret" };
  check("set up, not linked", String(await state.run({}, ctx(keys))) === LINK);
  check("each person's own: a member's is not the first person's", String(await state.run({}, ctx({ ...keys, JARVIS_PERSON: "u_sara" }))) === LINK);

  kv.set("spotify:refresh", "refresh-token");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token revoked" }), { status: 400 })) as typeof fetch;
  try {
    check("a refresh Spotify refuses, in Spotify's words", String(await state.run({}, ctx(keys))) === "Spotify error: Refresh token revoked");
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    check("and without them, the status", String(await state.run({}, ctx(keys))) === "Spotify error: could not refresh Spotify access (503)");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
