import { createHash } from "node:crypto";
import { AUTHORIZE_URL, ChatGptPlan, LIMIT_MS, PENDING_MS, PLAN_BASE, REDIRECT, TOKEN_URL, planFailureOf, verifyIdToken } from "../src/worker/lib/chatgpt-plan.ts";
import { b64u } from "../src/worker/lib/webauthn.ts";
import { requiredScope } from "../src/worker/lib/scopes.ts";

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
    _m: m,
  };
}

// A made-up signing key, standing in for OpenAI's.
const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as { n: string; e: string };
const JWKS = { keys: [{ kid: "k1", kty: "RSA", n: pub.n, e: pub.e }] };
const enc = (o: unknown) => b64u(new TextEncoder().encode(JSON.stringify(o)));
async function idToken(claims: Record<string, unknown>, kid = "k1", key = pair.privateKey): Promise<string> {
  const head = `${enc({ alg: "RS256", kid, typ: "JWT" })}.${enc(claims)}`;
  return `${head}.${b64u(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head)))}`;
}

const T0 = 1_800_000_000_000;
const CLIENT = "oaiapp_test1";

/** A stand-in for auth.openai.com: what it was asked, and what it answers. */
function fakeAuth() {
  const asked: { url: string; body: URLSearchParams }[] = [];
  let nonce = "";
  const answers = {
    token: async (body: URLSearchParams): Promise<Response> =>
      Response.json({
        access_token: body.get("grant_type") === "refresh_token" ? "at_refreshed" : "at_first",
        refresh_token: body.get("grant_type") === "refresh_token" ? "rt_rotated" : "rt_first",
        expires_in: 3600,
        earliest_refresh_at: Math.floor((T0 + 50 * 60_000) / 1000),
        token_type: "Bearer",
        scope: "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke",
        id_token: await idToken({ iss: "https://auth.openai.com", aud: [CLIENT], nonce, sub: "user-1", email: "owner@example.com", exp: Math.floor(T0 / 1000) + 3600 }),
      }),
  };
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = new URLSearchParams(String(init?.body ?? ""));
    asked.push({ url: u, body });
    if (u === TOKEN_URL) return answers.token(body);
    if (u.endsWith("/jwks.json")) return Response.json(JWKS);
    if (u.endsWith("/revoke")) return new Response(null, { status: 200 });
    return new Response("not here", { status: 404 });
  }) as typeof fetch;
  return { fetcher, asked, answers, setNonce: (n: string) => (nonce = n) };
}

/** Signs in the way the owner does: start, then paste what the browser ended on. */
async function signIn(plan: ChatGptPlan, auth: ReturnType<typeof fakeAuth>, now = T0) {
  const at = new URL(await plan.start(now));
  auth.setNonce(at.searchParams.get("nonce")!);
  const back = `${REDIRECT}?code=c0de&scope=openid&state=${at.searchParams.get("state")}&client_id=${CLIENT}`;
  return { at, result: await plan.finish(back, now + 1000) };
}

console.log("starting a sign-in");
{
  const storage = fakeStorage();
  const plan = new ChatGptPlan(storage, fakeAuth().fetcher);
  const at = new URL(await plan.start(T0));
  const q = at.searchParams;
  check("at OpenAI's authorize address", `${at.origin}${at.pathname}` === AUTHORIZE_URL);
  check("first time: the dynamic client and Jarvis's name", q.get("client_id") === "dynamic_agent_client" && q.get("agent_name_hint") === "Jarvis");
  check("the plan's scope and resource, to the loopback address",
    q.get("scope") === "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct" && q.get("resource") === PLAN_BASE && q.get("redirect_uri") === REDIRECT && q.get("response_type") === "code");
  check("a host id, kept", /^urn:uuid:[0-9a-f-]{36}$/.test(q.get("ext_agent_host_id")!) && (await storage.get("chatgpt:host")) === q.get("ext_agent_host_id"));
  const pending = (await storage.get("chatgpt:pending")) as { verifier: string; state: string };
  check("PKCE: the challenge is the verifier's S256",
    q.get("code_challenge_method") === "S256" && q.get("code_challenge") === createHash("sha256").update(pending.verifier).digest("base64url") && q.get("state") === pending.state);
  const again = new URL(await plan.start(T0 + 1));
  check("the same host id the next time, and a fresh state", again.searchParams.get("ext_agent_host_id") === q.get("ext_agent_host_id") && again.searchParams.get("state") !== q.get("state"));
}

console.log("finishing it with the pasted address");
{
  const storage = fakeStorage();
  const auth = fakeAuth();
  const plan = new ChatGptPlan(storage, auth.fetcher);
  const { result } = await signIn(plan, auth);
  check("connected, as the account in the ID token", typeof result === "object" && result.connected && result.email === "owner@example.com", result);
  const trade = auth.asked.find((a) => a.url === TOKEN_URL)!.body;
  check("the code traded with the verifier, the issued client id, the same redirect and resource",
    trade.get("grant_type") === "authorization_code" && trade.get("client_id") === CLIENT && trade.get("code") === "c0de" && !!trade.get("code_verifier") && trade.get("redirect_uri") === REDIRECT && trade.get("resource") === PLAN_BASE);
  check("the client id is kept, and the sign-in spent", (await storage.get("chatgpt:client")) === CLIENT && !(await storage.get("chatgpt:pending")));
  const status = JSON.stringify(await plan.status(T0));
  check("the status shows no token", !status.includes("at_first") && !status.includes("rt_first"), status);
  check("a model call gets the access token", (await plan.accessToken(T0 + 60_000))?.token === "at_first");

  const at = new URL(await plan.start(T0 + 2000));
  check("again: the issued client id, without the name", at.searchParams.get("client_id") === CLIENT && !at.searchParams.has("agent_name_hint"));
}

console.log("what a paste can get wrong");
{
  const auth = fakeAuth();
  const plan = new ChatGptPlan(fakeStorage(), auth.fetcher);
  check("nothing pasted", typeof (await plan.finish("  ", T0)) === "string");
  check("no sign-in started", String(await plan.finish(`${REDIRECT}?code=c&state=s&client_id=${CLIENT}`, T0)).includes("press Connect"));
  const at = new URL(await plan.start(T0));
  const state = at.searchParams.get("state")!;
  check("another sign-in's state", String(await plan.finish(`${REDIRECT}?code=c&state=wrong&client_id=${CLIENT}`, T0)).includes("another sign-in"));
  check("an expired sign-in", String(await plan.finish(`${REDIRECT}?code=c&state=${state}&client_id=${CLIENT}`, T0 + PENDING_MS + 1)).includes("expired"));
  await plan.start(T0);
  const s2 = new URL(await plan.start(T0)).searchParams.get("state")!;
  check("declined", String(await plan.finish(`${REDIRECT}?error=access_denied&state=${s2}`, T0)).includes("declined"));
  check("declined: the sign-in is spent", String(await plan.finish(`${REDIRECT}?code=c&state=${s2}&client_id=${CLIENT}`, T0)).includes("press Connect"));
  const s3 = new URL(await plan.start(T0)).searchParams.get("state")!;
  check("no client id on a first registration", String(await plan.finish(`${REDIRECT}?code=c&state=${s3}`, T0)).includes("no code"));
  check("no token was asked for in any of these", !auth.asked.some((a) => a.url === TOKEN_URL));
  const s4 = new URL(await plan.start(T0)).searchParams.get("state")!;
  auth.setNonce("someone-else");
  check("just the query pasted is read too, and a wrong nonce is refused",
    String(await plan.finish(`code=c&state=${s4}&client_id=${CLIENT}`, T0)).includes("another sign-in"));
}

console.log("the ID token");
{
  const want = { clientId: CLIENT, nonce: "n1", now: T0 };
  const good = { iss: "https://auth.openai.com", aud: [CLIENT], nonce: "n1", sub: "u", exp: Math.floor(T0 / 1000) + 60 };
  check("a good one", typeof (await verifyIdToken(await idToken(good), want, JWKS.keys)) === "object");
  const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  check("signed by another key", String(await verifyIdToken(await idToken(good, "k1", other.privateKey), want, JWKS.keys)).includes("signature"));
  check("an unknown key id", String(await verifyIdToken(await idToken(good, "k9"), want, JWKS.keys)).includes("key"));
  check("another issuer", String(await verifyIdToken(await idToken({ ...good, iss: "https://evil.example.com" }), want, JWKS.keys)).includes("not OpenAI's"));
  check("another app", String(await verifyIdToken(await idToken({ ...good, aud: "oaiapp_other" }), want, JWKS.keys)).includes("another app"));
  check("expired", String(await verifyIdToken(await idToken({ ...good, exp: Math.floor(T0 / 1000) - 1 }), want, JWKS.keys)).includes("expired"));
  check("not a JWT", typeof (await verifyIdToken("abc", want, JWKS.keys)) === "string");
}

console.log("keeping it fresh");
{
  const storage = fakeStorage();
  const auth = fakeAuth();
  const plan = new ChatGptPlan(storage, auth.fetcher);
  await signIn(plan, auth);
  const before = auth.asked.length;
  check("before the earliest refresh, the token as it is", (await plan.accessToken(T0 + 40 * 60_000))?.token === "at_first" && auth.asked.length === before);
  const fresh = await plan.accessToken(T0 + 51 * 60_000);
  const sent = auth.asked.at(-1)!.body;
  check("after it, refreshed with the issued client id and the resource",
    fresh?.token === "at_refreshed" && sent.get("grant_type") === "refresh_token" && sent.get("refresh_token") === "rt_first" && sent.get("client_id") === CLIENT && sent.get("resource") === PLAN_BASE, fresh);
  check("the rotated refresh token is kept", ((await storage.get("chatgpt:session")) as { refreshToken: string }).refreshToken === "rt_rotated");

  const was = auth.asked.length;
  const both = await Promise.all([plan.accessToken(T0 + 51 * 60_000 + 3_600_000), plan.accessToken(T0 + 51 * 60_000 + 3_600_000)]);
  check("two at once share one refresh", auth.asked.length === was + 1 && both[0]?.token === both[1]?.token, auth.asked.length - was);

  auth.answers.token = async () => new Response(null, { status: 502 });
  check("a passing failure keeps the token while it lasts", (await plan.accessToken(T0 + 2 * 3_600_000 - 60_000))?.token === "at_refreshed");
  auth.answers.token = async () => Response.json({ error: "refresh_token_reused" }, { status: 400 });
  check("a dead refresh token: none, and Settings says to sign in again",
    (await plan.accessToken(T0 + 3 * 3_600_000)) === null && !!(await plan.status(T0)).problem);
}

console.log("when a plan call fails");
{
  check("the error codes", planFailureOf("subscription_sharing_usage_limit_exceeded") === "limit" && planFailureOf("subscription_sharing_usage_unavailable") === "unavailable" &&
    planFailureOf("subscription_sharing_invalid_user") === "signin" && planFailureOf("subscription_sharing_user_not_eligible") === "not_eligible" &&
    planFailureOf("subscription_sharing_unsupported_capability") === "unsupported" && planFailureOf("rate_limit_exceeded") === null);
  const auth = fakeAuth();
  const plan = new ChatGptPlan(fakeStorage(), auth.fetcher);
  await signIn(plan, auth);
  const first = await plan.failed("limit", T0);
  check("the limit: the key for an hour, said the first time", first.first && (await plan.accessToken(T0 + 1)) === null && (await plan.status(T0)).limitedUntil === T0 + LIMIT_MS);
  check("then the plan again (its token refreshed by now)", (await plan.accessToken(T0 + LIMIT_MS + 1))?.token === "at_refreshed");
  check("the limit again within a day is not said again", !(await plan.failed("limit", T0 + LIMIT_MS + 2)).first);
  check("a passing unavailability changes nothing", !(await plan.failed("unavailable", T0)).first && !(await plan.status(T0)).problem);
  check("not eligible: kept until fixed", (await plan.failed("not_eligible", T0)).first && (await plan.accessToken(T0 + 10 * LIMIT_MS)) === null);
}

console.log("choosing the model, and disconnecting");
{
  const storage = fakeStorage();
  const auth = fakeAuth();
  const plan = new ChatGptPlan(storage, auth.fetcher);
  check("no model without a plan", !(await plan.setModel("gpt-6-luna")));
  await signIn(plan, auth);
  await plan.setModel("gpt-6.1-sol");
  check("the plan's model goes with its token", (await plan.accessToken(T0 + 1))?.model === "gpt-6.1-sol");
  await plan.disconnect();
  const revoke = auth.asked.find((a) => a.url.endsWith("/revoke"))!;
  check("disconnecting revokes the refresh token", revoke.body.get("token") === "rt_first" && revoke.body.get("client_id") === CLIENT);
  check("and forgets the session, keeping the host and client ids",
    !(await storage.get("chatgpt:session")) && !!(await storage.get("chatgpt:host")) && (await storage.get("chatgpt:client")) === CLIENT && (await plan.accessToken(T0)) === null);
}

console.log("who may reach it");
check("connecting the house's plan is the owner's alone",
  ["/api/chatgpt", "/api/chatgpt/start", "/api/chatgpt/finish", "/api/chatgpt/model"].every((p) => requiredScope(p, "POST") === "owner"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
