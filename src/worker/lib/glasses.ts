/**
 * Even Realities G2 glasses, as a Jarvis device.
 *
 * The Even app lets Even AI use a custom agent, and it speaks a narrow dialect
 * of the OpenAI chat-completions API. Everything below was measured against the
 * real app (user-agent `EvenCore/1.0`), not taken from documentation:
 *
 *  - It POSTs to exactly the URL it is given and appends nothing.
 *  - It sends one message, the latest thing the user said, never a transcript,
 *    so follow-ups need context kept here (see the thread in lib/state-host.ts).
 *  - It never asks to stream, and cannot read SSE.
 *  - It hangs up after 300 seconds.
 *  - Its renderer draws about one screen, roughly 400 to 500 characters, then
 *    shows "Struggling to render more...". Nothing is spoken aloud.
 *
 * Speech never reaches the Worker: the phone app does the transcription. So this
 * is a text device like any other, plus a length budget and a response shape.
 *
 * Pure functions only, so Node can test them.
 */

/**
 * Under the measured ceiling on purpose. The measurement used `.` as filler,
 * one of the narrowest glyphs in a font that is not monospaced, so real prose
 * runs out of room sooner.
 */
export const DEFAULT_CHAR_BUDGET = 350;
const MIN_CHAR_BUDGET = 80;
const MAX_CHAR_BUDGET = 2000;

/** Most of the app's 300 seconds, leaving room to answer before it hangs up. */
export const DEFAULT_WAIT_S = 240;
const MAX_WAIT_S = 280;

/** The same per-turn cap lib/history.ts applies to the car. */
const MAX_TEXT = 4000;

const clampInt = (raw: string | undefined, dflt: number, lo: number, hi: number): number => {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

export const charBudget = (raw: string | undefined): number =>
  clampInt(raw, DEFAULT_CHAR_BUDGET, MIN_CHAR_BUDGET, MAX_CHAR_BUDGET);

export const waitSeconds = (raw: string | undefined): number =>
  clampInt(raw, DEFAULT_WAIT_S, 1, MAX_WAIT_S);

/**
 * The latest thing the user said, or null.
 *
 * Only `user` messages are read. A `system` message in the body is ignored
 * rather than obeyed, for the same reason lib/history.ts never lets the car
 * write a developer message: a request body is not somewhere instructions may
 * come from. Content may be a string or OpenAI's array of text parts.
 */
export function latestUserText(body: unknown): string | null {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null;
    if (!m || m.role !== "user") continue;

    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content
        .map((p) => {
          const part = p as { type?: unknown; text?: unknown } | null;
          return part && typeof part.text === "string" ? part.text : "";
        })
        .filter(Boolean)
        .join(" ");
    }
    const trimmed = text.trim().slice(0, MAX_TEXT);
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * Remove what the display cannot draw.
 *
 * The firmware font silently drops glyphs it does not have, so markdown and
 * emoji do not degrade gracefully: they eat characters and leave gaps. Bullets
 * are normalised to "- " before emphasis is stripped, so "* item" keeps its
 * marker. Single underscores are left alone, so an entity id like
 * `light.study_lamp` survives.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "")
    .replace(/^[ \t]*[-*+•][ \t]+/gm, "- ")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    // Emoji-presentation characters only: box drawing, arrows and card suits
    // default to text presentation and the firmware font has many of them.
    .replace(/[\p{Emoji_Presentation}\u{FE0F}\u{200D}]/gu, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Fit a reply to the budget.
 *
 * A whole sentence reads better than a few more words, so cut at the last
 * sentence end when that keeps most of the budget, otherwise at a word, and
 * never return more than `limit` characters.
 */
export function shorten(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const end = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("! "),
    head.lastIndexOf("? "),
    head.lastIndexOf("\n"),
  );
  if (end > limit * 0.6) return head.slice(0, end + 1).trimEnd();

  const room = head.slice(0, limit - 3);
  const space = room.lastIndexOf(" ");
  return (space > limit * 0.6 ? room.slice(0, space) : room).trimEnd() + "...";
}

export const forGlasses = (text: string, limit: number): string =>
  shorten(stripMarkdown(text), limit);

/**
 * Appended to the router's instructions when the answer is going to glasses.
 *
 * The router otherwise writes for a voice that will rephrase it. Here nothing
 * rephrases it: what the router says is what the user reads, so the length and
 * form have to be right at the source. `forGlasses` enforces the budget anyway,
 * but a reply cut mid-thought is worse than one written to fit.
 */
export function glassesInstructions(limit: number): string {
  return (
    "\n\nTHIS REQUEST IS SHOWN ON SMART GLASSES\n" +
    "The answer appears as text on the user's Even Realities glasses: a small " +
    "monochrome display they read while walking around. Nothing is spoken aloud. " +
    `Keep the whole answer under ${limit} characters; anything longer is cut off. ` +
    "Plain text only: no markdown, no bold, no headings, no tables, no emoji, " +
    "because the display font drops them. Put the answer in the first sentence, " +
    "with no preamble and no sign-off. For several items, one per line starting " +
    'with "- ", at most five, and say how many were left out. The user can ask a ' +
    "follow-up for more."
  );
}

/** The response shape the Even app reads: an OpenAI chat completion. */
export function toChatCompletion(text: string, model = "jarvis") {
  return {
    id: "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24),
    object: "chat.completion" as const,
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant" as const, content: text },
        finish_reason: "stop" as const,
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
