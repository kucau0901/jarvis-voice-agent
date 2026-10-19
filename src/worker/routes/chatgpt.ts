import type { Env } from "../types.ts";
import { err, json, readObject, redact } from "../lib/http.ts";
import { stateStub } from "../lib/state-client.ts";
import { PLAN_BASE } from "../lib/chatgpt-plan.ts";
import { saneModelId } from "../lib/router-model.ts";
import { probeModel } from "./router.ts";

/**
 * The owner's ChatGPT plan (lib/chatgpt-plan.ts), from Settings:
 *
 *   GET    /api/chatgpt           connected or not, as whom, the plan's model and the plan's models
 *   POST   /api/chatgpt/start     {url}: where to sign in
 *   POST   /api/chatgpt/finish    {address}: the address the browser ended on, traded for the session
 *   PUT    /api/chatgpt/model     {model}: probed on the plan, saved only if it passed; null for the router model
 *   DELETE /api/chatgpt           disconnected, and its refresh token revoked
 *
 * Owner-only (no rule in lib/scopes.ts): whose plan pays for the house's
 * questions is not something a device or a member decides.
 */
export async function handleChatgpt(req: Request, env: Env): Promise<Response> {
  const state = stateStub(env);
  if (!state) return err(503, "the ChatGPT plan needs the STATE Durable Object");
  const path = new URL(req.url).pathname;
  const now = Date.now();

  if (path === "/api/chatgpt") {
    if (req.method === "DELETE") {
      await state.chatgptDisconnect();
      return json(await state.chatgptStatus(now));
    }
    if (req.method !== "GET") return err(405, "GET or DELETE");
    const status = await state.chatgptStatus(now);
    const token = status.connected ? await state.chatgptToken(now).catch(() => null) : null;
    // Whether there is a key too: for live voice, and to carry on at the plan's limit. Never the key itself.
    return json({ ...status, key: !!env.OPENAI_API_KEY, ...(token ? await planModels(token.token) : {}) });
  }

  if (path === "/api/chatgpt/start" && req.method === "POST") return json({ url: await state.chatgptStart(now) });

  if (path === "/api/chatgpt/finish" && req.method === "POST") {
    const body = await readObject(req, 4_000);
    const address = typeof body?.address === "string" ? body.address : "";
    const r = await state.chatgptFinish(address, now);
    return typeof r === "string" ? err(400, r) : json(r);
  }

  if (path === "/api/chatgpt/model" && req.method === "PUT") {
    const body = await readObject(req, 1_000);
    if (body?.model === null) {
      await state.chatgptSetModel(null);
      return json(await state.chatgptStatus(now));
    }
    const model = saneModelId(body?.model);
    if (!model) return err(400, "model must be a model id");
    const token = await state.chatgptToken(now);
    if (!token) return err(409, "the ChatGPT plan is not connected, or cannot be used just now");
    // Saved only if it routes: a model that cannot would fail every question in the house.
    const probe = await probeModel(env, model, { kind: "plan", ...token });
    if (!probe.ok) return json({ saved: false, probe, error: probe.error ?? "it did not pass the check" }, { status: 422 });
    await state.chatgptSetModel(model);
    return json({ saved: true, probe, ...(await state.chatgptStatus(now)) });
  }

  return err(404, `no route for ${path}`);
}

/** The models this ChatGPT account may use, as OpenAI lists them for it. */
async function planModels(token: string): Promise<{ models?: { id: string; name: string }[]; modelsError?: string }> {
  try {
    const r = await fetch(`${PLAN_BASE}/models`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return { modelsError: `OpenAI answered ${r.status}` };
    const j = (await r.json()) as { models?: { slug?: string; display_name?: string; visibility?: string }[] };
    const models = (j.models ?? []).filter((m) => m.slug && (m.visibility ?? "list") === "list").map((m) => ({ id: m.slug!, name: m.display_name || m.slug! }));
    return { models };
  } catch (e) {
    return { modelsError: redact(e instanceof Error ? e.message : String(e)) };
  }
}
