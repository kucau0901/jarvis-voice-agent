// "Talk to me about alerts", by voice (tools/alerts.ts): only the person
// signed in, only asked in their own latest message, and offered wherever they
// speak to Jarvis (push-to-talk and Live's delegations) but never to a job.
import { alertTalk } from "../src/worker/tools/alerts.ts";
import { baseTools } from "../src/worker/tools/registry.ts";
import { DRAWS_ON_SCREEN } from "../src/worker/tools/place.ts";
import { jobTool } from "../src/worker/lib/jobs.ts";
import { ROLE_SCOPES, type Prefs } from "../src/worker/lib/hub.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 300) : ""); }
}

// The hub as the tool reaches it (lib/hub-client.ts hubStub): one RPC method, by name.
const prefs = new Map<string, Prefs>();
const hub = {
  async prefsOf(id: string) {
    return prefs.get(id) ?? {};
  },
  async setPrefs(id: string, patch: Prefs) {
    const next = { ...prefs.get(id), ...patch };
    prefs.set(id, next);
    return next;
  },
};
const stub = { hubCall: (m: string, a: unknown[]) => (hub as unknown as Record<string, (...x: unknown[]) => unknown>)[m]!(...a) };
const STATE = { idFromName: () => "j", get: () => stub };
// The first person signed in: their data is "owner", their own id is theirs.
const sara = { JARVIS_PERSON: "owner", JARVIS_USER: "u_sara", STATE };
const ctx = (env: object, asked?: string) => ({ env, asked, signal: new AbortController().signal, progress() {}, display() {}, grants: ["*"] }) as never;
const run = async (on: boolean | null, env: object, asked?: string) => String(await alertTalk.run({ on }, ctx(env, asked)));

console.log("asking what it is");
{
  check("on when never chosen", /^On:/.test(await run(null, sara, "do you talk to me about alerts?")));
  check("asking changes nothing", !prefs.has("u_sara"));
}

console.log("\nchanging it");
{
  check("asked in their own words: off, by their own id", /^Done\. Off:/.test(await run(false, sara, "Stop talking to me about alerts")) && prefs.get("u_sara")?.alertTalk === "off");
  check("…and said so when asked", /^Off:/.test(await run(null, sara, "are alerts read to me?")));
  check("in Malay too", /^Done\. On:/.test(await run(true, sara, "tolong baca amaran saya")) && prefs.get("u_sara")?.alertTalk === "on");
  check("their latest message not about it (a mail read to them asks): refused", /only the user can change this/.test(await run(false, sara, "yes")) && prefs.get("u_sara")?.alertTalk === "on");
  check("no latest message of theirs (a routine's run): refused", /only the user can change this/.test(await run(false, sara)) && prefs.get("u_sara")?.alertTalk === "on");
}

console.log("\nonly a person has it");
{
  const owner = { JARVIS_PERSON: "owner", STATE };
  check("the owner key, or a device: told so, nothing changed", /device or the owner key/.test(await run(false, owner, "stop talking about alerts")) && prefs.size === 1);
  check("…asking what it is too", /device or the owner key/.test(await run(null, owner, "do you read alerts?")));
  check("without the state object: said so", /no state object/.test(await run(false, { JARVIS_USER: "u_sara" }, "stop talking about alerts")));
}

console.log("\nwhere it is offered");
{
  const names = (g: readonly string[]) => baseTools({} as never, g as never).map((t) => t.name);
  check("to an adult and a child, by the alerts scope", names(ROLE_SCOPES.adult).includes("alert_talk") && names(ROLE_SCOPES.child).includes("alert_talk"));
  check("to an admin", names(["*"]).includes("alert_talk"));
  check("on a screen or none: push-to-talk and Live's delegations are screenless", !DRAWS_ON_SCREEN.includes("alert_talk"));
  check("never to a background job", !jobTool(alertTalk));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
