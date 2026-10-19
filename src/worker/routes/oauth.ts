import type { Env } from "../types.ts";
import { err, json, readObject } from "../lib/http.ts";
import { hubStub } from "../lib/hub-client.ts";
import { personOf, type Principal } from "../lib/auth.ts";
import { saneGrants } from "../lib/scopes.ts";
import * as devices from "../lib/devices.ts";
import { backTo, readAuthRequest, tradeOk } from "../lib/oauth.ts";

/**
 * OAuth for MCP clients (lib/oauth.ts), in three steps:
 *
 *  1. GET /api/v1/oauth/authorize: the client sends the person's browser here.
 *     It carries no credential, so it comes before the gate (index.ts), checks
 *     the request and passes it to the app, which signs the person in if need
 *     be and asks them (ui/Connect.ts).
 *  2. POST /api/v1/devices/connect: the person, signed in, allows it with the
 *     scopes they picked, and is sent back to the client with a code.
 *  3. POST /api/v1/oauth/token: the client's server trades the code, which is
 *     its only credential, for a new device token. Before the gate too.
 */

export function handleAuthorize(req: Request): Response {
  if (req.method !== "GET") return err(405, "method not allowed");
  const url = new URL(req.url);
  const r = readAuthRequest(url.searchParams);
  if (typeof r === "string") return err(400, r);
  return new Response(null, { status: 302, headers: { location: `/?connect=${encodeURIComponent(url.search.slice(1))}` } });
}

/** Allowed: a code for the client, and where to send the person with it. */
export async function handleConnect(req: Request, env: Env, principal: Principal): Promise<Response> {
  if (req.method !== "POST") return err(405, "method not allowed");
  const body = await readObject(req, 8 * 1024);
  if (!body) return err(400, "body must be a JSON object");
  const r = readAuthRequest(new URLSearchParams(typeof body.request === "string" ? body.request : ""));
  if (typeof r === "string") return err(400, r);
  const scopes = saneGrants(body.scopes);
  if (!scopes.length) return err(400, "pick at least one thing it may do");
  const hub = hubStub(env);
  if (!hub) return err(503, "this deployment has no state object");
  const code = await hub.issueOAuthCode(
    { clientId: r.clientId, redirectUri: r.redirectUri, challenge: r.challenge, person: personOf(principal), scopes },
    Date.now(),
  );
  if (!code) return err(429, "too many connections waiting; try again in a few minutes");
  return json({ redirect: backTo(r, code) });
}

const tokenErr = (error: string) =>
  json({ error }, { status: 400, headers: { "cache-control": "no-store" } });

export async function handleToken(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return err(405, "method not allowed");
  const form = new URLSearchParams(await req.text());
  if (form.get("grant_type") !== "authorization_code") return tokenErr("unsupported_grant_type");
  const code = form.get("code") ?? "";
  const hub = hubStub(env);
  if (!code || !hub) return tokenErr("invalid_request");
  const g = await hub.takeOAuthCode(code, Date.now());
  const ok = await tradeOk(g, {
    clientId: form.get("client_id") ?? "",
    redirectUri: form.get("redirect_uri") ?? "",
    verifier: form.get("code_verifier") ?? "",
  });
  if (!ok || !g) return tokenErr("invalid_grant");
  const { token } = await devices.create(env, g.clientId, g.scopes, undefined, g.person);
  return json({ access_token: token, token_type: "Bearer" }, { headers: { "cache-control": "no-store" } });
}
