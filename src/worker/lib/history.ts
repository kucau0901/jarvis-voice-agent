import type OpenAI from "openai";

/** API ceiling is 128 messages / 8,192 rendered tokens; stay well inside it. */
const MAX_HISTORY_ITEMS = 100;
const MAX_HISTORY_CHARS = 20_000;

export type Turn = { role: "user" | "assistant"; text: string };

/**
 * Build the initial conversation history for a reconnecting session.
 *
 * The browser is untrusted, so this only ever emits `user` and `assistant`
 * messages. A `developer` message would be able to override Jarvis's
 * instructions, and nothing coming from the car should be able to do that.
 */
export function buildHistory(raw: unknown): OpenAI.Live.InitialItem[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;

  const turns: Turn[] = [];
  let chars = 0;
  for (const item of raw.slice(-MAX_HISTORY_ITEMS)) {
    if (!item || typeof item !== "object") continue;
    const { role, text } = item as Partial<Turn>;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof text !== "string") continue;
    const trimmed = text.trim().slice(0, 4000);
    if (!trimmed) continue;
    chars += trimmed.length;
    if (chars > MAX_HISTORY_CHARS) break;
    turns.push({ role, text: trimmed });
  }
  if (!turns.length) return undefined;

  return turns.map((t) =>
    t.role === "user"
      ? { role: "user" as const, content: [{ text: t.text, type: "input_text" as const }] }
      : { role: "assistant" as const, content: [{ text: t.text, type: "output_text" as const }] },
  );
}
