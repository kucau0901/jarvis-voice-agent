import { createHash } from "node:crypto";
import { CODE_MS, CODE_SHAPE, OAuthCodes, backTo, pkceMatches, readAuthRequest, tradeOk, type AuthRequest } from "../src/worker/lib/oauth.ts";
import { handleToken } from "../src/worker/routes/oauth.ts";
import { HUB_METHODS } from "../src/worker/lib/hub.ts";
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

const T0 = 1_800_000_000_000;
const VERIFIER = "a".repeat(20) + "-._~" + "B".repeat(25);
// Worked out here with Node's own crypto, not the code under test.
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const REDIRECT = "https://assistant.example.com/connectors/callback";
const query = (over: Record<string, string | null> = {}) => {
  const base: Record<string, string> = {
    response_type: "code",
    client_id: "grok",
    redirect_uri: REDIRECT,
    state: "xyz",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
  };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) q.set(k, v);
  return q;
};

console.log("reading what the client asks for");
{
  const r = readAuthRequest(query()) as AuthRequest;
  check("a good request", typeof r === "object" && r.clientId === "grok" && r.redirectUri === REDIRECT && r.state === "xyz" && r.challenge === CHALLENGE, r);
  check("no state is fine", typeof readAuthRequest(query({ state: null })) === "object");
  check("plain PKCE is refused", typeof readAuthRequest(query({ code_challenge_method: "plain" })) === "string");
  check("no PKCE is refused", typeof readAuthRequest(query({ code_challenge: null, code_challenge_method: null })) === "string");
  check("a token response is refused", typeof readAuthRequest(query({ response_type: "token" })) === "string");
  check("an http return address is refused", typeof readAuthRequest(query({ redirect_uri: "http://assistant.example.com/cb" })) === "string");
  check("a javascript: return address is refused", typeof readAuthRequest(query({ redirect_uri: "javascript:alert(1)" })) === "string");
  check("a return address with a fragment is refused", typeof readAuthRequest(query({ redirect_uri: REDIRECT + "#x" })) === "string");
  check("no client id is refused", typeof readAuthRequest(query({ client_id: "" })) === "string");
  check("a client id with spaces is refused", typeof readAuthRequest(query({ client_id: "my app" })) === "string");
  check("a huge state is refused", typeof readAuthRequest(query({ state: "s".repeat(513) })) === "string");
}

console.log("sending the person back");
{
  const r = readAuthRequest(query({ redirect_uri: REDIRECT + "?keep=1" })) as AuthRequest;
  const u = new URL(backTo(r, "c0de"));
  check("the code and state go back, and the client's own query stays",
    u.origin + u.pathname === REDIRECT && u.searchParams.get("code") === "c0de" && u.searchParams.get("state") === "xyz" && u.searchParams.get("keep") === "1", u.href);
}

console.log("PKCE");
{
  check("the right verifier", await pkceMatches(VERIFIER, CHALLENGE));
  check("another verifier", !(await pkceMatches(VERIFIER.replace("a", "b"), CHALLENGE)));
  check("a short verifier", !(await pkceMatches("short", CHALLENGE)));
  check("the challenge itself is not a verifier", !(await pkceMatches(CHALLENGE, CHALLENGE)));
}

console.log("codes");
{
  const storage = fakeStorage();
  const codes = new OAuthCodes(storage);
  const grant = { clientId: "grok", redirectUri: REDIRECT, challenge: CHALLENGE, person: "u_adam1", scopes: ["ask" as const, "home" as const] };
  const code = (await codes.issue(grant, T0))!;
  check("a code is made", typeof code === "string" && code.length >= 40, code);
  check("of the one shape the token endpoint takes", CODE_SHAPE.test(code), code);
  check("only its digest is stored", ![...storage._m.keys()].some((k) => k.includes(code)), [...storage._m.keys()]);

  const form = { clientId: "grok", redirectUri: REDIRECT, verifier: VERIFIER };
  const g = await codes.take(code, T0 + 1000);
  check("taking it gives the grant", g?.person === "u_adam1" && g.scopes.join() === "ask,home", g);
  check("and the trade is good", await tradeOk(g, form));
  check("it cannot be taken twice", (await codes.take(code, T0 + 2000)) === null);

  const c2 = (await codes.issue(grant, T0))!;
  check("a stale code is no good", (await codes.take(c2, T0 + CODE_MS + 1)) === null);
  check("and it is spent anyway", storage._m.size === 0, [...storage._m.keys()]);

  const c3 = (await codes.issue(grant, T0))!;
  const g3 = await codes.take(c3, T0);
  check("another client's id fails the trade", !(await tradeOk(g3, { ...form, clientId: "other" })));
  check("another return address fails it", !(await tradeOk(g3, { ...form, redirectUri: REDIRECT + "x" })));
  check("another verifier fails it", !(await tradeOk(g3, { ...form, verifier: VERIFIER.replace("B", "C") })));
  check("no grant fails it", !(await tradeOk(null, form)));
  check("an unknown code is nothing", (await codes.take("made-up", T0)) === null);

  const full = new OAuthCodes(fakeStorage());
  let made = 0;
  for (let i = 0; i < 25; i++) if (await full.issue(grant, T0)) made++;
  check("at most five of a person's wait at once", made === 5, made);
  check("…and they never crowd out another person's", (await full.issue({ ...grant, person: "u_other" }, T0)) !== null);
  check("and room comes back once they are stale", (await full.issue(grant, T0 + CODE_MS + 1)) !== null);
}

console.log("the token endpoint, reached before any credential");
{
  const asked: string[] = [];
  const env = { STATE: { idFromName: () => "jarvis", get: () => ({ hubCall: async (m: string) => void asked.push(m) }) } } as never;
  const trade = async (body: string) => {
    const res = await handleToken(new Request("https://jarvis.example.com/api/v1/oauth/token", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } }), env);
    return { status: res.status, error: ((await res.json()) as { error?: string }).error };
  };
  const odd = await trade("grant_type=authorization_code&code=made-up&client_id=grok");
  check("a code not of the shape issued never reaches the object", odd.status === 400 && odd.error === "invalid_request" && asked.length === 0, { odd, asked });
  const huge = await trade(`grant_type=authorization_code&code=${"A".repeat(43)}&pad=${"x".repeat(8000)}`);
  check("nor does a form over 4 KB", huge.status === 400 && huge.error === "invalid_request" && asked.length === 0, { huge, asked });
  const right = await trade(`grant_type=authorization_code&code=${"A".repeat(43)}&client_id=grok`);
  check("one of the right shape is looked up, and found wanting", right.status === 400 && right.error === "invalid_grant" && asked.join() === "takeOAuthCode", { right, asked });
}

console.log("who may reach it");
{
  check("the hub offers the codes", HUB_METHODS.includes("issueOAuthCode") && HUB_METHODS.includes("takeOAuthCode"));
  check("allowing is a person's, never a device's", requiredScope("/api/v1/devices/connect", "POST") === "person");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
