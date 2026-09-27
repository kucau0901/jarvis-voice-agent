import { HubHost } from "../src/worker/lib/hub.ts";
import { _clearSessionCache } from "../src/worker/lib/hub-client.ts";
import { authorize, grantsOf, isAdmin, whoOf, type Principal } from "../src/worker/lib/auth.ts";
import { requiredScope } from "../src/worker/lib/scopes.ts";
import { lookup, sha256Hex } from "../src/worker/lib/devices.ts";
import { handleAuth, handleHub } from "../src/worker/routes/hub.ts";
import { makeFake, register, signIn } from "./fake-authenticator.ts";

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

function fakeStorage() {
  const m = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => (m.has(k) ? (structuredClone(m.get(k)) as T) : undefined),
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string) => m.delete(k),
    list: async <T,>({ prefix }: { prefix: string }) =>
      new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T])),
  };
}

const kv = new Map<string, string>();
const forgotten: string[] = [];
const people = new HubHost(fakeStorage());
const env = {
  JARVIS_SHARED_SECRET: "NOTAREALKEY12345",
  CONFIG: {
    get: async (k: string, t?: unknown) => {
      const v = kv.get(k);
      if (v === undefined) return null;
      const json = t === "json" || (typeof t === "object" && t !== null && (t as { type?: string }).type === "json");
      return json ? JSON.parse(v) : v;
    },
    put: async (k: string, v: string) => void kv.set(k, v),
    delete: async (k: string) => void kv.delete(k),
  },
  // The Durable Object, as the Worker reaches it: one hubCall for everything.
  STATE: {
    idFromName: () => "jarvis",
    get: () => ({
      hubCall: (m: string, a: unknown[]) => (people as unknown as Record<string, (...x: unknown[]) => unknown>)[m]!(...a),
      forgetDevice: async (who: string) => void forgotten.push(who),
    }),
  },
} as never;

const SITE = "https://jarvis.example.com";
const call = async (path: string, body?: unknown, o: { method?: string; origin?: string; principal?: Principal } = {}) => {
  const req = new Request(SITE + path, {
    method: o.method ?? (body === undefined ? "GET" : "POST"),
    headers: { origin: o.origin ?? SITE, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = o.principal ? await handleHub(req, env, o.principal) : await handleAuth(req, env);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const who = async (token: string) => {
  const r = await authorize(new Request(SITE + "/api/health", { headers: { authorization: `Bearer ${token}` } }), env);
  return r.ok ? r.principal : null;
};
const want = (challenge: string) => ({ challenge, origin: SITE, rpId: "jarvis.example.com" });

/** Join with an invite the way the app does: look, get options, make a passkey, send it. */
async function join(token: string, name: string) {
  const fake = await makeFake();
  const opt = await call("/api/auth/invite/options", { token, name });
  const credential = await register(fake, want(opt.body.options.challenge));
  const done = await call("/api/auth/invite/verify", { token, name, credential, label: `${name}'s phone` });
  return { fake, done };
}

const OWNER: Principal = { kind: "owner" };

console.log("before anyone is here");
{
  const s = await call("/api/auth/status");
  check("the hub says it has no family yet", s.status === 200 && s.body.claimed === false);
  const me = await call("/api/hub/me", undefined, { principal: OWNER });
  check("the owner key sees the same", me.body.owner === true && me.body.claimed === false);
  const members = await call("/api/hub/members", undefined, { principal: OWNER });
  check("there are no members to list", members.status === 409);
}

console.log("\nclaiming, with the owner key");
let admin: Principal;
let adminFake: Awaited<ReturnType<typeof makeFake>>;
{
  const notOwner: Principal = { kind: "device", id: "d_1", name: "esp", scopes: ["*"] };
  check("a device cannot claim, even with every scope", (await call("/api/hub/claim", { name: "x", spaceName: "y" }, { principal: notOwner })).status === 403);
  const claim = await call("/api/hub/claim", { name: "Adam", spaceName: "The Rahmans", agentName: "Friday" }, { principal: OWNER });
  check("the owner makes the family and gets the admin's invite", claim.status === 200 && claim.body.token.startsWith("jin1_") && claim.body.space.agentName === "Friday");
  const peek = await call("/api/auth/invite", { token: claim.body.token });
  check("the invite says who it is for", peek.body.role === "admin" && peek.body.name === "Adam" && !("digest" in peek.body));
  const { fake, done } = await join(claim.body.token, "Adam");
  adminFake = fake;
  check("making a passkey joins, and signs in", done.status === 200 && done.body.token.startsWith("jss1_") && done.body.agentName === "Friday", done.body);
  admin = (await who(done.body.token))!;
  check("the session is the admin, bounded by nothing", admin?.kind === "member" && isAdmin(admin) && grantsOf(admin).join() === "*");
  check("an admin's things are the owner's, until they are each person's", whoOf(admin) === "owner");
  check("the status now shows the assistant's name", (await call("/api/auth/status")).body.agentName === "Friday");
}

console.log("\ninviting a member");
let sara: Principal;
let saraFake: Awaited<ReturnType<typeof makeFake>>;
let saraToken = "";
{
  const inv = await call("/api/hub/invites", { role: "adult", name: "Sara" }, { principal: admin });
  check("an admin makes an invite link", inv.status === 200 && inv.body.url === `${SITE}/#invite=${inv.body.token}`);
  const { fake, done } = await join(inv.body.token, "Sara");
  saraFake = fake;
  saraToken = done.body.token;
  sara = (await who(saraToken))!;
  check("she is a member, with an adult's reach", sara?.kind === "member" && !isAdmin(sara) && grantsOf(sara).includes("home") && !grantsOf(sara).includes("memory.read"));
  check("her things are her own", whoOf(sara) === (sara as { id: string }).id);
  check("she cannot invite", (await call("/api/hub/invites", { role: "admin", name: "x" }, { principal: sara })).status === 403);
  check("nor change anyone", (await call("/api/hub/members", { user: (admin as { id: string }).id, role: "guest" }, { method: "PATCH", principal: sara })).status === 403);
  const list = await call("/api/hub/members", undefined, { principal: sara });
  check("she sees who is in the family, but not their reach or the invites", list.body.members.length === 2 && list.body.members.every((m: Record<string, unknown>) => !("scopes" in m)) && !("invites" in list.body));
  const full = await call("/api/hub/members", undefined, { principal: admin });
  check("the admin sees reach and pending invites", full.body.members.every((m: Record<string, unknown>) => Array.isArray(m.scopes)) && Array.isArray(full.body.invites));
  const reused = await call("/api/auth/invite/options", { token: inv.body.token, name: "Sara" });
  check("the used invite is spent", reused.status === 404);
}

console.log("\nsigning in again");
{
  const opt = await call("/api/auth/login/options", {});
  check("a sign-in gets a challenge for this site", opt.body.options.rpId === "jarvis.example.com" && opt.body.options.userVerification === "required");
  const credential = await signIn(saraFake, want(opt.body.options.challenge));
  const v = await call("/api/auth/login/verify", { credential, label: "Laptop" });
  check("her passkey signs her in", v.status === 200 && v.body.name === "Sara" && (await who(v.body.token))?.kind === "member");
  const again = await call("/api/auth/login/verify", { credential, label: "Laptop" });
  check("the same signed answer cannot be used twice", again.status === 400);

  const opt2 = await call("/api/auth/login/options", {});
  const elsewhere = await signIn(saraFake, { ...want(opt2.body.options.challenge), origin: "https://evil.example" });
  const bad = await call("/api/auth/login/verify", { credential: elsewhere }, { origin: "https://evil.example" });
  check("an answer made on another site is refused", bad.status === 401, bad.body);

  const opt3 = await call("/api/auth/login/options", {});
  const stranger = await makeFake();
  const unknown = await call("/api/auth/login/verify", { credential: await signIn(stranger, want(opt3.body.options.challenge)) });
  check("a passkey never registered here is refused", unknown.status === 401 && /not registered/.test(unknown.body.error));
}

console.log("\npairing the car");
{
  const start = await call("/api/auth/pair/start", { label: "Tesla browser" });
  check("the car gets a code to show", /^[A-Z2-9]{6}$/.test(start.body.code));
  check("and waits", (await call("/api/auth/pair/poll", { poll: start.body.poll })).body.status === "waiting");
  const forAdmin = await call("/api/hub/pair", { code: start.body.code, user: (admin as { id: string }).id }, { principal: sara });
  check("a member cannot pair a screen as someone else", forAdmin.status === 403);
  const yes = await call("/api/hub/pair", { code: start.body.code }, { principal: sara });
  check("she approves it from her phone", yes.status === 200 && yes.body.label === "Tesla browser");
  const done = await call("/api/auth/pair/poll", { poll: start.body.poll });
  check("the car is now signed in as her", done.body.status === "approved" && (await who(done.body.token)) !== null && (await who(done.body.token) as { id: string }).id === (sara as { id: string }).id);

  const tablet = await call("/api/auth/pair/start", { label: "Kitchen tablet" });
  const byAdmin = await call("/api/hub/pair", { code: tablet.body.code, user: (sara as { id: string }).id }, { principal: admin });
  const tab = await call("/api/auth/pair/poll", { poll: tablet.body.poll });
  check("an admin may pair a screen for a member, and it is theirs", byAdmin.status === 200 && ((await who(tab.body.token)) as { id: string } | null)?.id === (sara as { id: string }).id);
}

console.log("\nher sessions, and removing her");
{
  const mine = await call("/api/hub/sessions", undefined, { principal: sara });
  check("she sees each screen she is signed in on", mine.body.sessions.length === 4 && mine.body.sessions.filter((s: { current: boolean }) => s.current).length === 1, mine.body.sessions.map((s: { label: string; current: boolean }) => `${s.label}:${s.current}`));
  const keys = await call("/api/hub/passkeys", undefined, { principal: sara });
  check("and her passkey", keys.body.passkeys.length === 1);
  const owner = await call("/api/hub/passkeys", undefined, { principal: OWNER });
  check("the owner key has no passkeys of its own", owner.status === 400);

  const gone = await call("/api/hub/members", { user: (sara as { id: string }).id }, { method: "DELETE", principal: admin });
  check("the admin removes her", gone.status === 200);
  check("and at once, her sessions stop working here", (await who(saraToken)) === null);
  check("her open screens and phones stop getting alerts", forgotten.includes((sara as { id: string }).id));
  const lastAdmin = await call("/api/hub/members", { user: (admin as { id: string }).id }, { method: "DELETE", principal: admin });
  check("the last admin cannot remove themselves", lastAdmin.status === 400);
}

console.log("\nsigning out");
{
  const opt = await call("/api/auth/login/options", {});
  const v = await call("/api/auth/login/verify", { credential: await signIn(adminFake, want(opt.body.options.challenge)), label: "Car" });
  const p = (await who(v.body.token))!;
  check("signed in", p !== null);
  await call("/api/hub/signout", {}, { principal: p });
  _clearSessionCache();
  check("signing out ends that session", (await who(v.body.token)) === null);
  check("and only that one", (await who((await call("/api/auth/login/verify", {})).body.token ?? "")) === null && (await call("/api/hub/sessions", undefined, { principal: admin })).body.sessions.length >= 1);
}

console.log("\na shared screen, with PINs");
{
  const inv = await call("/api/hub/invites", { role: "adult", name: "Nur" }, { principal: admin });
  const { done } = await join(inv.body.token, "Nur");
  const token = done.body.token;
  const as = async () => (await who(token))!;
  const withToken = async (path: string, body: unknown) => {
    const req = new Request(SITE + path, { method: "POST", headers: { origin: SITE, "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const res = await handleHub(req, env, await as());
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  check("a PIN can be set", (await withToken("/api/hub/pin", { pin: "2468" })).status === 200);
  _clearSessionCache();
  check("and shows as set", (await as() as { hasPin?: boolean }).hasPin === true);
  const lock = await withToken("/api/hub/lock", {});
  check("switching away locks her", lock.body.locked === true);
  const locked = await as();
  check("a locked session says so", (locked as { locked?: boolean }).locked === true);
  const me = await call("/api/hub/me", undefined, { principal: locked });
  check("and reaches nothing", me.body.locked === true && me.body.scopes.length === 0);
  check("a wrong PIN is refused", (await withToken("/api/hub/unlock", { pin: "1357" })).status === 403);
  check("the right one unlocks her at once", (await withToken("/api/hub/unlock", { pin: "2468" })).status === 200 && !(await as() as { locked?: boolean }).locked);
  const clear = await call("/api/hub/members", { user: (await as() as { id: string }).id, clearPin: true }, { method: "PATCH", principal: admin });
  _clearSessionCache();
  check("an admin can clear a forgotten PIN", clear.status === 200 && (await as() as { hasPin?: boolean }).hasPin === false);
  const notAdmin = await call("/api/hub/members", { user: (admin as { id: string }).id, clearPin: true }, { method: "PATCH", principal: await as() });
  check("nobody else can", notAdmin.status === 403);
}

console.log("\nscopes and devices");
{
  check("the family routes gate themselves", requiredScope("/api/hub/members", "GET") === "any");
  const device: Principal = { kind: "device", id: "d_1", name: "esp", scopes: ["*"] };
  check("a device cannot see the family", (await call("/api/hub/members", undefined, { principal: device })).status === 403);

  // A device made before Hermes had its own scope, with `home`, keeps it.
  const token = "jdv1_" + "a".repeat(32);
  kv.set(`dev:tok:${await sha256Hex(token)}`, JSON.stringify({ id: "d_old", name: "G2", scopes: ["ask", "home"], digest: "x", createdAt: 1 }));
  const old = await lookup(env, token);
  check("an older device with the house keeps Hermes", old.ok && old.device.scopes.includes("hermes"));
  const token2 = "jdv1_" + "b".repeat(32);
  kv.set(`dev:tok:${await sha256Hex(token2)}`, JSON.stringify({ v: 2, id: "d_new", name: "gate", scopes: ["ask", "home"], digest: "y", createdAt: 1 }));
  const fresh = await lookup(env, token2);
  check("a new one with the house does not get it", fresh.ok && !fresh.device.scopes.includes("hermes"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
