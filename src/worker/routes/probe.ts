import type { Env } from "../types";
import { json, err } from "../lib/http";

const KEY = (gear: string) => `probe:${gear}`;
const INDEX = "probe:index";

/**
 * Phase 0 diagnostic sink.
 *
 * The Tesla browser has no devtools, so the car uploads its results here and they
 * get read back from a laptop.
 */
export async function handleProbe(req: Request, env: Env): Promise<Response> {
  if (req.method === "GET") {
    const index: string[] = (await env.CONFIG.get(INDEX, "json")) ?? [];
    const runs = await Promise.all(
      index.map(async (k) => ({ key: k, data: await env.CONFIG.get(k, "json") })),
    );
    return json({ runs });
  }

  if (req.method !== "POST") return err(405, "method not allowed");

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err(400, "body is not valid JSON");
  }

  const meta = (body._meta ?? {}) as { gear?: string };
  const gear = typeof meta.gear === "string" ? meta.gear : "UNKNOWN";
  const stamp = new Date().toISOString();
  const key = `${KEY(gear)}:${stamp}`;

  await env.CONFIG.put(key, JSON.stringify({ ...body, _received: stamp }), {
    expirationTtl: 60 * 60 * 24 * 30,
  });

  const index: string[] = (await env.CONFIG.get(INDEX, "json")) ?? [];
  index.unshift(key);
  await env.CONFIG.put(INDEX, JSON.stringify(index.slice(0, 50)));

  return json({ ok: true, stored: key, gear });
}
