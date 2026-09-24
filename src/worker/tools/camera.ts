import type { Tool, ToolContext } from "./registry";

/**
 * Put a camera on the screen.
 *
 * Home Assistant is already reachable over MCP, but that path returns text and
 * this needs a picture — so the entity is resolved through MCP and the frame
 * itself comes from the Worker's camera proxy, keeping the Home Assistant token
 * server-side.
 */

interface Cam {
  entity: string;
  name: string;
}

/** Cached briefly: the camera list changes far less often than it is asked for. */
const CACHE_KEY = "cams:v1";
const CACHE_TTL_S = 900;

async function cameras(ctx: ToolContext): Promise<Cam[]> {
  try {
    const hit = (await ctx.env.CONFIG.get(CACHE_KEY, "json")) as Cam[] | null;
    if (hit?.length) return hit;
  } catch {
    /* a cache miss is not a failure */
  }

  const base = ctx.env.HA_BASE_URL?.replace(/\/+$/, "");
  const token = ctx.env.HA_TOKEN;
  if (!base || !token) return [];

  const res = await fetch(`${base}/api/states`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return [];

  const states = (await res.json()) as {
    entity_id: string;
    attributes?: { friendly_name?: string };
  }[];
  const list = states
    .filter((s) => s.entity_id.startsWith("camera."))
    .map((s) => ({
      entity: s.entity_id,
      name: s.attributes?.friendly_name ?? s.entity_id.replace("camera.", "").replace(/_/g, " "),
    }));

  if (list.length) {
    // A cache: failing to write it must not fail the camera (see tools/mcp.ts).
    await ctx.env.CONFIG.put(CACHE_KEY, JSON.stringify(list), { expirationTtl: CACHE_TTL_S })
      .catch(() => {});
  }
  return list;
}

/** Spoken names are loose — "the gate", "front door" — so match generously. */
function pick(list: Cam[], want: string): Cam | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const q = norm(want);
  if (!q) return undefined;

  const exact = list.find((c) => norm(c.name) === q || norm(c.entity) === q);
  if (exact) return exact;

  const words = q.split(" ").filter((w) => w.length > 2);
  let best: { cam: Cam; score: number } | undefined;
  for (const c of list) {
    const hay = norm(c.name + " " + c.entity);
    const score = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
    if (score && (!best || score > best.score)) best = { cam: c, score };
  }
  return best?.cam;
}

export const showCamera: Tool = {
  name: "show_camera",
  scope: "home",
  pace: "fast",
  available: (env) => !!(env.HA_BASE_URL && env.HA_TOKEN),
  description:
    "Put a camera from the user's home on the car's screen — the gate, the porch, the " +
    "doorbell, the back garden. Use when they ask to SEE what a camera shows. The view " +
    "refreshes on its own, so say one short sentence and stop. To list what cameras " +
    "exist, call it with an empty name.",
  parameters: {
    type: "object",
    properties: {
      camera: {
        type: "string",
        description:
          "Which camera, in the user's own words — 'the gate', 'front porch'. " +
          "Empty string lists what is available.",
      },
    },
    required: ["camera"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const list = await cameras(ctx);
    if (!list.length) return "I cannot reach the cameras at the moment.";

    const want = String(args.camera ?? "").trim();
    if (!want) return `Cameras available: ${list.map((c) => c.name).join(", ")}.`;

    const cam = pick(list, want);
    if (!cam) {
      // Naming what exists is more useful than refusing, and stops the model
      // inventing a camera that does not.
      return `There is no camera matching "${want}". There is: ${list
        .map((c) => c.name)
        .join(", ")}.`;
    }

    ctx.display({ kind: "camera", entity: cam.entity, label: cam.name });
    return `Showing the ${cam.name} camera.`;
  },
};

export const cameraTools: Tool[] = [showCamera];
