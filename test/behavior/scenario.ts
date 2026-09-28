// The API half of the behavior checks (test/behavior/check.mjs): a family is
// made and uses Jarvis through its HTTP API, every request and its answer is
// recorded, and nothing depends on waiting for the clock. Invented people
// only; it runs against a local copy with stand-ins (fakes.mjs), never a real
// deployment.
//
//   node test/behavior/scenario.ts <base url> <out.json> <tokens.json>
import { writeFileSync } from "node:fs";
import { makeFake, register, signIn, type Fake } from "../fake-authenticator.ts";

const [BASE, OUT, TOKENS] = process.argv.slice(2) as [string, string, string];
const OWNER_KEY = "BEHAVIORKEY234567";
const OPENAI = process.env.FAKE_OPENAI ?? "http://127.0.0.1:8791";
const HA = process.env.FAKE_HA ?? "http://127.0.0.1:8792";
const SITE = { origin: BASE, rpId: new URL(BASE).hostname };

type J = Record<string, unknown>;
const records: J[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One request, recorded under a label: who sent it, what, and what came back. */
async function call(as: string, token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: J }> {
  const headers: Record<string, string> = { origin: BASE, "content-type": "application/json" };
  if (token === OWNER_KEY) headers["x-jarvis-key"] = token;
  else if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON: kept as text */
  }
  records.push({ as, method, path, ...(body !== undefined ? { sent: body } : {}), status: r.status, body: parsed });
  return { status: r.status, body: (parsed && typeof parsed === "object" ? parsed : {}) as J };
}

const ask = (as: string, token: string, text: string) => call(as, token, "POST", "/api/v1/ask", { text, timeout: 60 });
const str = (v: unknown) => (typeof v === "string" ? v : "");

async function join(inviteToken: string, name: string): Promise<{ token: string; fake: Fake }> {
  const fake = await makeFake();
  await call("new member", null, "POST", "/api/auth/invite", { token: inviteToken });
  const opt = await call("new member", null, "POST", "/api/auth/invite/options", { token: inviteToken, name });
  const challenge = str((opt.body.options as J | undefined)?.challenge);
  const credential = await register(fake, { challenge, ...SITE });
  const done = await call("new member", null, "POST", "/api/auth/invite/verify", { token: inviteToken, name, credential, label: `${name}'s phone` });
  return { token: str(done.body.token), fake };
}

async function login(as: string, fake: Fake): Promise<string> {
  const opt = await call(as, null, "POST", "/api/auth/login/options", {});
  const credential = await signIn(fake, { challenge: str((opt.body.options as J | undefined)?.challenge), ...SITE });
  return str((await call(as, null, "POST", "/api/auth/login/verify", { credential, label: "laptop" })).body.token);
}

/* ---------- before anyone signs in ---------- */
await call("anyone", null, "GET", "/api/auth/status");
await call("anyone", null, "GET", "/api/hub/me");
await call("wrong key", "WRONGKEY", "GET", "/api/memory");
await call("owner key", OWNER_KEY, "GET", "/api/nowhere");

/* ---------- a family is made ---------- */
const claim = await call("owner key", OWNER_KEY, "POST", "/api/hub/claim", { name: "Adam", spaceName: "The Testers", agentName: "Jarvis" });
const adam = await join(str(claim.body.token), "Adam");
const invite = async (name: string, role: string, access?: unknown) =>
  str((await call("Adam", adam.token, "POST", "/api/hub/invites", { name, role, ...(access ? { access } : {}) })).body.token);
const sara = await join(await invite("Sara", "adult"), "Sara");
const aisyah = await join(await invite("Aisyah", "child"), "Aisyah");
const nenek = await join(await invite("Nenek", "adult"), "Nenek");
const siti = await join(
  await invite("Siti", "guest", { until: Date.now() + 7 * 86_400_000, allow: [{ entity: "cover.main_gate", label: "Main gate" }, { entity: "switch.garden_lights", label: "Garden lights" }] }),
  "Siti",
);
for (const [name, p] of [["Adam", adam], ["Sara", sara], ["Aisyah", aisyah], ["Nenek", nenek], ["Siti", siti]] as const) {
  await call(name, p.token, "GET", "/api/hub/me");
}
const members = await call("Adam", adam.token, "GET", "/api/hub/members");
await call("Sara", sara.token, "GET", "/api/hub/members");
const idOf = (name: string) => {
  const m = (members.body.members as J[]).find((x) => x.name === name)!;
  return { user: str(m.id), person: m.first ? "owner" : str(m.id) };
};

/* ---------- signing in again, pairing, a PIN ---------- */
const saraLaptop = await login("Sara", sara.fake);
const pair = await call("a screen", null, "POST", "/api/auth/pair/start", { label: "Tesla" });
await call("Adam", adam.token, "POST", "/api/hub/pair", { code: pair.body.code });
await call("a screen", null, "POST", "/api/auth/pair/poll", { poll: pair.body.poll });
await call("Sara (laptop)", saraLaptop, "POST", "/api/hub/pin", { pin: "2468" });
await call("Sara (laptop)", saraLaptop, "POST", "/api/hub/lock", {});
await call("Sara (laptop, locked)", saraLaptop, "GET", "/api/memory");
await call("Sara (laptop, locked)", saraLaptop, "POST", "/api/hub/unlock", { pin: "0000" });
await call("Sara (laptop, locked)", saraLaptop, "POST", "/api/hub/unlock", { pin: "2468" });

/* ---------- memory ---------- */
await ask("Sara", sara.token, "remember that I am planning a surprise party for Adam");
await ask("Adam", adam.token, "remember for the family that the spare key is under the blue pot");
await ask("Aisyah", aisyah.token, "remember for the family that bedtime is midnight");
await call("Adam", adam.token, "POST", "/api/memory", { text: "The office is on level 12", kind: "note" });
await call("Sara", sara.token, "GET", "/api/memory");
await call("Adam", adam.token, "GET", "/api/memory");
await call("Aisyah", aisyah.token, "GET", "/api/memory?book=family");
await call("Sara", sara.token, "POST", "/api/memory/search", { query: "party" });

/* ---------- cars and Hermes ---------- */
await call("Adam", adam.token, "PATCH", "/api/hub/cars", { id: "family", name: "Adam's Model Y", shares: { [idOf("Sara").person]: "see" } });
await call("Sara", sara.token, "GET", "/api/hub/cars");
await call("Aisyah", aisyah.token, "GET", "/api/hub/cars");
await ask("Sara", sara.token, "unlock Adam's Model Y");
await ask("Sara", sara.token, "ask hermes to check the server");

/* ---------- passing things on ---------- */
await ask("Adam", adam.token, "remind Sara to buy milk");
await call("Sara", sara.token, "GET", "/api/hub/relays");
await ask("Sara", sara.token, "done");
await ask("Adam", adam.token, "ask Nenek are you coming for dinner?");
const nenekQ = ((await call("Nenek", nenek.token, "GET", "/api/hub/relays")).body.received as J[])[0]!;
await call("Nenek", nenek.token, "POST", "/api/hub/relays/answer", { id: nenekQ.id, status: "answered", answer: "Yes, at seven" });
await ask("Adam", adam.token, "ask everyone where shall we eat on Saturday?");
for (const [name, p] of [["Sara", sara], ["Aisyah", aisyah], ["Nenek", nenek]] as const) {
  const q = ((await call(name, p.token, "GET", "/api/hub/relays")).body.received as J[]).find((x) => str(x.text).startsWith("where shall we eat"))!;
  await call(name, p.token, "POST", "/api/hub/relays/answer", { id: q.id, status: "answered", answer: `${name} likes nasi lemak` });
}
await ask("Adam", adam.token, "remind Siti to water the plants");
await ask("Adam", adam.token, "tell Siti the gate code is new");
await ask("Aisyah", aisyah.token, "tell Adam I am home");
await call("Adam", adam.token, "GET", "/api/hub/relays");
await ask("Adam", adam.token, "points");

/* ---------- the family chat ---------- */
await call("Sara", sara.token, "POST", "/api/hub/chat/messages", { c: "family", text: "Dinner at eight tonight" });
await call("Sara", sara.token, "POST", "/api/hub/chat/messages", { c: "family", text: "Jarvis, what is the plan?" });
await sleep(4000);
await call("Adam", adam.token, "GET", "/api/hub/chat");
await call("Adam", adam.token, "GET", "/api/hub/chat/messages?c=family");
await call("Sara", sara.token, "GET", `/api/hub/chat/messages?c=${encodeURIComponent(`dm:${[idOf("Adam").person, idOf("Sara").person].sort().join("|")}`)}`);
await call("Siti", siti.token, "GET", "/api/hub/chat");
await call("Adam", adam.token, "GET", "/api/hub/points");

/* ---------- a guest's pass ---------- */
await call("Siti", siti.token, "POST", "/api/hub/pass", { entity: "cover.main_gate", action: "open" });
await ask("Siti", siti.token, "open the main gate");
await ask("Siti", siti.token, "open the garage door");
await call("Siti", siti.token, "GET", "/api/memory");
await call("Adam", adam.token, "GET", "/api/hub/house");
await call("Sara", sara.token, "GET", "/api/hub/house");

/* ---------- devices, routines, usage, the owner's views ---------- */
const g2 = await call("Sara", sara.token, "POST", "/api/v1/devices", { name: "Sara's G2", scopes: ["*"] });
await call("Sara's G2", str(g2.body.token), "GET", "/api/memory");
await call("Sara's G2", str(g2.body.token), "GET", "/api/settings");
await call("Adam", adam.token, "GET", "/api/v1/devices");
await call("Sara", sara.token, "GET", "/api/v1/devices");
await call("Adam", adam.token, "POST", "/api/v1/routines", { when: "daily", time: "07:30", say: "Good morning" });
await call("Adam", adam.token, "GET", "/api/v1/routines");
await call("Sara", sara.token, "GET", "/api/v1/routines");
await call("Adam", adam.token, "GET", "/api/usage");
await call("Sara", sara.token, "GET", "/api/usage");
await call("owner key", OWNER_KEY, "GET", "/api/alerts");
await call("owner key", OWNER_KEY, "GET", "/api/settings");

/* ---------- hours: a new sign-in is not cached, so the change is felt at once ---------- */
const hhmm = (t: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kuala_Lumpur", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(t));
await call("Adam", adam.token, "PATCH", "/api/hub/members", { user: idOf("Siti").user, access: { hours: { from: hhmm(Date.now() + 3 * 3600_000), to: hhmm(Date.now() + 4 * 3600_000) } } });
const sitiAgain = await login("Siti", siti.fake);
await call("Siti (outside hours)", sitiAgain, "GET", "/api/memory");
await call("Siti (outside hours)", sitiAgain, "GET", "/api/hub/me");

/* ---------- someone leaves ---------- */
await call("Adam", adam.token, "DELETE", "/api/hub/members", { user: idOf("Nenek").user });
await call("Nenek (removed)", nenek.token, "GET", "/api/hub/me");
await call("Sara", sara.token, "DELETE", "/api/hub/members", { user: idOf("Adam").user });

/* ---------- what the stand-ins saw ---------- */
const model = await (await fetch(`${OPENAI}/__log`)).json();
const house = await (await fetch(`${HA}/__calls`)).json();

writeFileSync(OUT, JSON.stringify({ records, model, house }, null, 1));
writeFileSync(TOKENS, JSON.stringify({ Adam: adam.token, Sara: sara.token, Siti: siti.token }));
console.log(`scenario: ${records.length} requests recorded`);
