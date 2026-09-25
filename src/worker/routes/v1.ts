import type { Env } from "../types";
import { err, json } from "../lib/http";
import { Collector, type Collected } from "../lib/collector";
import { buildHistory, type Turn } from "../lib/history";
import { run, handleDelegate, type RunOptions } from "./delegate";
import type { Principal } from "../lib/auth";
import { stateStub } from "../lib/state-client";
import { assistConfig, tryAssist } from "../lib/assist";
import { charBudget, forGlasses, latestUserText, toChatCompletion, waitSeconds } from "../lib/glasses";
import { allows, saneGrants, SCOPES, WILDCARD, type Grant } from "../lib/scopes";
import { handleAlertApi } from "./alerts";
import { handleRoutines } from "./routines";
import { handleVoice } from "./voice";
import { handleJobs } from "./jobs";

/** Everything a wildcard grant covers, minus the screen this route does not have. */
const SCREENLESS: Grant[] = SCOPES.filter((s) => s !== "screen");
import * as devices from "../lib/devices";

/**
 * The versioned surface other things talk to.
 *
 * `/api/delegate` is the browser's contract and always answers with an SSE
 * stream, because that is what the car needs. Firmware needs the opposite: one
 * request, one JSON object, no frame reassembly and no heartbeat handling. So
 * this is a separate route rather than content negotiation on the old one —
 * a minimal HTTP client gets negotiation wrong, and keeping them apart means
 * the browser's contract stays free to change.
 */

const MAX_BODY = 32 * 1024;
const DEFAULT_WAIT_S = 60;
const MAX_WAIT_S = 120;
/** Under the ~30s the runtime allows after a response, leaving room to save. */
const AFTER_TIMEOUT_GRACE_MS = 20_000;

/** Reject an oversized body before parsing it, which no route did before. */
async function readJson(req: Request): Promise<{ ok: true; body: any } | { ok: false; res: Response }> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_BODY) {
    return { ok: false, res: err(413, `body must be under ${MAX_BODY} bytes`) };
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY) {
    return { ok: false, res: err(413, `body must be under ${MAX_BODY} bytes`) };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, res: err(400, "body is not valid JSON") };
  }
}

/**
 * A device sends one string, not a transcript. `context` is there for anything
 * that keeps a conversation, and both go through the same validator the car's
 * transcript does, so the 100-item and 20,000-character caps apply unchanged.
 */
function turnsFrom(body: { text?: unknown; context?: unknown }): Turn[] {
  const raw: unknown[] = Array.isArray(body.context) ? [...body.context] : [];
  if (typeof body.text === "string" && body.text.trim()) {
    raw.push({ role: "user", text: body.text });
  }
  const items = buildHistory(raw);
  if (!items) return [];
  return items.map((i) => ({
    role: i.role === "assistant" ? ("assistant" as const) : ("user" as const),
    text: (i.content as { text: string }[])[0]!.text,
  }));
}

const clampWait = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WAIT_S;
  return Math.min(MAX_WAIT_S, Math.max(1, Math.round(n)));
};

/* ---------- one delegation, waited on ------------------------------------ */

type Deadline =
  | { timedOut: true; ms: number }
  | { timedOut: false; ms: number; result: Collected };

/**
 * Run one delegation into a Collector and wait at most `waitS` seconds for it.
 *
 * Shared by /api/v1/ask and the glasses route, so there is exactly one account
 * of what a timeout does to the work still running.
 */
async function collectWithDeadline(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  turns: Turn[],
  grants: readonly Grant[],
  waitS: number,
  label: string,
  opts?: RunOptions,
): Promise<Deadline> {
  const startedAt = Date.now();
  const sink = new Collector();
  const ac = new AbortController();
  req.signal.addEventListener("abort", () => ac.abort());

  const work = run(env, turns, sink, ac.signal, grants, { ...opts, waitUntil: (p) => ctx.waitUntil(p) }).catch((e) => {
    console.error(`${label} failed:`, e instanceof Error ? e.message : String(e));
  });

  /*
   * What happens after our timeout, stated honestly. waitUntil does NOT keep
   * the work alive for as long as it needs: the runtime cancels it roughly 30s
   * after the response ends (measured). An earlier comment
   * here, and docs/api.md, promised the opposite — that the turn would finish
   * and anything it learned would still reach memory.
   *
   * A hard cancel skips run()'s finally block, so memory from steps that DID
   * finish would be lost too. So on timeout the work is given a short grace to
   * finish on its own, then aborted cleanly — which does run the finally and
   * save what was learned — before the runtime would kill it outright.
   */
  ctx.waitUntil(work);

  let timer: number | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), waitS * 1000) as unknown as number;
  });
  const outcome = await Promise.race([work.then(() => "done" as const), timeout]);
  clearTimeout(timer);

  const ms = Date.now() - startedAt;

  if (outcome === "timeout") {
    setTimeout(() => ac.abort(), AFTER_TIMEOUT_GRACE_MS);
    return { timedOut: true, ms };
  }
  return { timedOut: false, ms, result: sink.finish() };
}

const TIMEOUT_TEXT = "That is taking longer than I can wait on. Ask me again in a moment.";

/* ---------- POST /api/v1/ask --------------------------------------------- */

async function handleAsk(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  grants: readonly Grant[],
): Promise<Response> {
  if (req.method !== "POST") return err(405, "method not allowed");
  if (!env.OPENAI_API_KEY) return err(503, "OPENAI_API_KEY is not configured");

  const parsed = await readJson(req);
  if (!parsed.ok) return parsed.res;
  const body = parsed.body ?? {};

  const turns = turnsFrom(body);
  if (!turns.length) return err(400, "text is required");

  const waitS = clampWait(body.timeout);
  const clientRef = typeof body.clientRef === "string" ? body.clientRef.slice(0, 64) : undefined;
  const requestId = "r_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8);

  const d = await collectWithDeadline(req, env, ctx, turns, grants, waitS, "v1/ask");

  if (d.timedOut) {
    return json({
      ok: false,
      text: TIMEOUT_TEXT,
      error: "timeout",
      tools: [],
      ms: d.ms,
      requestId,
      ...(clientRef ? { clientRef } : {}),
    });
  }

  return json({
    ...d.result,
    ms: d.ms,
    requestId,
    ...(clientRef ? { clientRef } : {}),
  });
}

/* ---------- POST /api/v1/chat/completions (Even Realities G2) ------------- */

/**
 * Jarvis as a custom agent on Even Realities G2 glasses.
 *
 * The Even app speaks a narrow dialect of the OpenAI chat-completions API (see
 * lib/glasses.ts for what was measured): one message in, one completion out,
 * no streaming. So this is /api/v1/ask in the shape the app reads, with three
 * differences.
 *
 *  - Home Assistant's own Assist is tried first (lib/assist.ts). It answers
 *    "turn on the study light" in well under a second where the router takes
 *    8 to 11, and anything it does not understand reaches the router untouched.
 *  - The app sends only the latest message, so the last few exchanges are kept
 *    in the Durable Object and handed to the router as the conversation.
 *  - Every outcome is a 200 with something readable in it. Anything else makes
 *    the glasses show a bare "AI server error", which tells the user nothing.
 *    Only a body that is not a chat request at all is refused.
 */
async function handleChatCompletions(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  grants: readonly Grant[],
  principal: Principal,
): Promise<Response> {
  if (req.method !== "POST") return err(405, "method not allowed");

  const parsed = await readJson(req);
  if (!parsed.ok) return parsed.res;
  const text = latestUserText(parsed.body);
  if (!text) return err(400, "messages must include a user message");

  const budget = charBudget(env.G2_CHAR_BUDGET);
  const thread = threadOf(principal);
  const reply = (answer: string, model?: string) => json(toChatCompletion(answer, model));

  // Read alongside Assist rather than after it: if Assist hands over, the
  // router should not then wait on a second round trip before starting.
  const prior = priorTurns(env, thread);

  const assist = assistConfig(env, grants);
  if (assist) {
    const a = await tryAssist(assist, text);
    console.log(`g2 assist: ${a.handled ? a.kind : a.reason} ${a.ms}ms`);
    if (a.handled) {
      const answer = forGlasses(a.text, budget);
      ctx.waitUntil(recordTurns(env, thread, text, answer));
      return reply(answer, "home-assistant");
    }
  }

  if (!env.OPENAI_API_KEY) {
    return reply("Jarvis has no OpenAI key configured, so only the house can answer right now.");
  }

  const turns: Turn[] = [...(await prior), { role: "user", text }];
  const d = await collectWithDeadline(
    req, env, ctx, turns, grants, waitSeconds(env.G2_WAIT_S), "v1/chat/completions",
    { surface: "glasses", charBudget: budget },
  );

  if (d.timedOut) {
    console.log(`g2 router: timeout ${d.ms}ms`);
    return reply(TIMEOUT_TEXT);
  }

  const r = d.result;
  console.log(`g2 router: ${r.ok ? "ok" : r.error} ${d.ms}ms tools=${r.tools.join(",") || "-"}`);
  const answer = forGlasses(r.text || (r.ok ? "Done." : "Something went wrong."), budget);
  // A failed turn is not context worth carrying: the user will ask again.
  if (r.ok) ctx.waitUntil(recordTurns(env, thread, text, answer));
  return reply(answer, r.model);
}

/** One thread per device, and one for the owner key. */
const threadOf = (p: Principal): string => (p.kind === "owner" ? "owner" : p.id);

/** Never throws: an unreadable thread costs a follow-up its context, not the question. */
async function priorTurns(env: Env, key: string): Promise<Turn[]> {
  const state = stateStub(env);
  if (!state) return [];
  try {
    return await state.loadThread(key);
  } catch (e) {
    console.warn("thread unavailable:", e instanceof Error ? e.message : String(e));
    return [];
  }
}

async function recordTurns(env: Env, key: string, asked: string, answered: string): Promise<void> {
  const state = stateStub(env);
  if (!state) return;
  try {
    await state.appendThread(key, [
      { role: "user", text: asked },
      { role: "assistant", text: answered },
    ]);
  } catch (e) {
    console.warn("thread not saved:", e instanceof Error ? e.message : String(e));
  }
}

/* ---------- GET/POST/PATCH/DELETE /api/v1/devices ------------------------- */

async function handleDevices(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET") {
    return json({ devices: await devices.list(env), scopes: [WILDCARD, ...SCOPES] });
  }

  const parsed = await readJson(req);
  if (!parsed.ok) return parsed.res;
  const body = parsed.body ?? {};

  if (req.method === "POST") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return err(400, "name is required");

    const scopes = saneGrants(body.scopes);
    if (!scopes.length) {
      return err(400, `scopes must include at least one of: ${[WILDCARD, ...SCOPES].join(", ")}`);
    }
    const expiresAt =
      typeof body.expiresAt === "number" && body.expiresAt > Date.now() ? body.expiresAt : undefined;

    const { device, token } = await devices.create(env, name, scopes, expiresAt);
    return json(
      {
        ...device,
        token,
        note: "This is the only time the token is shown. Only its digest is stored, so it cannot be recovered — mint a new one if it is lost.",
      },
      { status: 201 },
    );
  }

  if (req.method === "PATCH") {
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) return err(400, "id is required");
    const patch: { name?: string; scopes?: Grant[]; revoked?: boolean } = {};
    if (typeof body.name === "string") patch.name = body.name.trim();
    if (body.scopes !== undefined) patch.scopes = saneGrants(body.scopes);
    if (typeof body.revoked === "boolean") patch.revoked = body.revoked;

    const updated = await devices.update(env, id, patch);
    // Its open screens and its notifications go with the grant.
    if (updated && (patch.revoked === true || (patch.scopes && !allows(patch.scopes, "alerts")))) {
      await stateStub(env)?.forgetDevice(id).catch(() => {});
    }
    return updated ? json(updated) : err(404, `no device ${id}`);
  }

  if (req.method === "DELETE") {
    const id = typeof body.id === "string" ? body.id : url.searchParams.get("id") ?? "";
    if (!id) return err(400, "id is required");
    if (!(await devices.remove(env, id))) return err(404, `no device ${id}`);
    await stateStub(env)?.forgetDevice(id).catch(() => {});
    return json({ ok: true, id });
  }

  return err(405, "method not allowed");
}

/* ---------- the router ---------------------------------------------------- */

export async function handleV1(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  principal: Principal,
): Promise<Response> {
  const url = new URL(req.url);
  const grants: readonly Grant[] = principal.kind === "owner" ? [WILDCARD] : principal.scopes;

  // No display channel on this route at all, so screen tools are dropped
  // rather than offered and silently discarded.
  const noScreen = grants.filter((g) => g !== "screen");
  if (url.pathname === "/api/v1/ask") {
    return handleAsk(req, env, ctx, grants.includes(WILDCARD) ? SCREENLESS : noScreen);
  }

  // Even Realities G2 glasses. Text only, like /ask: the glasses draw text but
  // nothing here can put a map or a camera on them.
  if (url.pathname === "/api/v1/chat/completions") {
    return handleChatCompletions(
      req, env, ctx, grants.includes(WILDCARD) ? SCREENLESS : noScreen, principal,
    );
  }

  // The same delegation, streamed, for clients that want progress while a slow
  // tool runs. Identical contract to /api/delegate — this is just the versioned
  // name, so firmware never has to reference the browser's internal route.
  if (url.pathname === "/api/v1/stream") return handleDelegate(req, env, ctx, grants);

  // Push-to-talk: a spoken question in, a spoken answer out, never a live session.
  if (url.pathname === "/api/v1/voice") return handleVoice(req, env, ctx, principal, grants);

  if (url.pathname === "/api/v1/devices") {
    if (principal.kind !== "owner") return err(403, "owner credential required");
    return handleDevices(req, env);
  }

  // Alerts: open screens, notifications, and asking Jarvis to tell you something.
  const alerts = await handleAlertApi(req, env, url, principal);
  if (alerts) return alerts;

  // Routines: things Jarvis does by itself, and the events that set them off.
  const routines = await handleRoutines(req, env, url, principal);
  if (routines) return routines;

  // Background jobs: minutes of work, answered later.
  const jobs = await handleJobs(req, env, url, principal);
  if (jobs) return jobs;

  return err(404, `no route for ${url.pathname}`);
}
