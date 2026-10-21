import type { Tool } from "./registry.ts";
import { stateStub } from "../lib/state-client.ts";
import { openaiBase } from "../lib/openai-base.ts";
import { localeOf } from "../lib/locale.ts";
import { dayOf } from "../lib/usage.ts";
import { OWNER } from "../lib/context.ts";
import { redact } from "../lib/http.ts";
import { recordUsage } from "../routes/usage.ts";

/**
 * "Draw me a red Tesla on a beach." A picture made from a description, kept
 * in the Durable Object (lib/images.ts) and put on the screen with a Download
 * button (src/app/ui/Stage.ts), as Hark's chat hands over a picture it made.
 *
 * On the OpenAI key only: the ChatGPT plan's route has no images, as it has no
 * audio and no embeddings (docs/DESIGN.md). The model never sees the picture
 * it made: it is told only that it is on the screen, so it is not paid for
 * twice.
 */

export const IMAGE_MODEL = "gpt-image-2";
/** A person's pictures a day: each costs a few cents, and nothing else in Jarvis is that dear per call. */
export const IMAGES_A_DAY = 10;
const SIZE = { square: "1024x1024", wide: "1536x1024", tall: "1024x1536" } as const;

export const makeImage: Tool = {
  name: "make_image",
  scope: "screen",
  pace: "fast",
  available: (env) => !!env.OPENAI_API_KEY,
  description:
    "Draw a NEW picture from a description and put it on the screen, with a Download button. Only when " +
    "the user asks for a picture, drawing, illustration or image to be made. Never to show a real place " +
    "(show_place) or a camera (show_camera). It takes ten to forty seconds. Once it is shown, say so in " +
    "one short sentence and do not describe it.",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What to draw, complete and self-contained: the user's words plus any detail they gave." },
      shape: { type: ["string", "null"], enum: ["square", "wide", "tall", null], description: "wide or tall only when asked; null for square." },
    },
    required: ["prompt", "shape"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const prompt = typeof args.prompt === "string" ? args.prompt.trim().slice(0, 4000) : "";
    if (!prompt) return "No description was supplied.";
    const state = stateStub(ctx.env);
    if (!state) return "Pictures cannot be made on this deployment: it has no state object.";
    const person = ctx.env.JARVIS_PERSON ?? OWNER;
    const day = dayOf(Date.now(), localeOf(ctx.env).timeZone);
    if (!(await state.consume(`img:${person}`, IMAGES_A_DAY, day)).ok) return `That is the ${IMAGES_A_DAY} pictures for today; say they can ask again tomorrow.`;
    ctx.progress("drawing it");
    const started = Date.now();
    const size = SIZE[args.shape === "wide" || args.shape === "tall" ? args.shape : "square"];
    const r = await fetch(`${openaiBase(ctx.env)}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      // JPEG, a few hundred kilobytes: well under what the Durable Object keeps in one value.
      body: JSON.stringify({ model: IMAGE_MODEL, prompt, n: 1, size, quality: "medium", output_format: "jpeg", output_compression: 80 }),
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(90_000)]),
    });
    const j = (await r.json().catch(() => ({}))) as {
      data?: { b64_json?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
      error?: { message?: string };
    };
    // A refusal by OpenAI's safety system comes back this way too: said as it is.
    if (!r.ok) return `The picture could not be made (${r.status})${j.error?.message ? `: ${redact(j.error.message).slice(0, 160)}` : ""}.`;
    const data = j.data?.[0]?.b64_json;
    if (!data) return "OpenAI sent no picture.";
    const id = await state.imagePut(person, { mime: "image/jpeg", data, prompt }, Date.now());
    ctx.display({ kind: "image", image: id, label: prompt.slice(0, 120) });
    await recordUsage(ctx.env, {
      at: started, surface: "image", by: IMAGE_MODEL, ok: true, ms: Date.now() - started,
      input: j.usage?.input_tokens ?? 0, cached: 0, written: 0, output: j.usage?.output_tokens ?? 0, searches: 0,
      tools: ["make_image"], ask: prompt.slice(0, 80), ...(ctx.env.JARVIS_PERSON ? { who: ctx.env.JARVIS_PERSON } : {}),
    });
    return "The picture is on the screen, with a Download button. Say so in one short sentence; do not describe it.";
  },
};
