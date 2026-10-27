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

  // Newest first, so a long conversation keeps its recent end; put back in order below.
  const turns: Turn[] = [];
  let chars = 0;
  for (const item of raw.slice(-MAX_HISTORY_ITEMS).reverse()) {
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
  turns.reverse();

  return turns.map((t) =>
    t.role === "user"
      ? { role: "user" as const, content: [{ text: t.text, type: "input_text" as const }] }
      : { role: "assistant" as const, content: [{ text: t.text, type: "output_text" as const }] },
  );
}

/** An alert a Live session opens by saying (routes/session.ts): its id, and how it reads. */
export interface Opening {
  id: string;
  said: string;
}

/**
 * The alert a screen opens a Live session with, from what it sent: "Title:
 * text" as the app's history has it (src/app/main.ts onAlert), within an
 * alert's own limits (lib/alerts.ts makeAlert). Null when it is not one.
 */
export function openingOf(raw: unknown): Opening | null {
  if (!raw || typeof raw !== "object") return null;
  const { id, title, text } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{6,64}$/.test(id) || typeof text !== "string" || !text.trim()) return null;
  const t = typeof title === "string" ? title.trim().slice(0, 80) : "";
  const words = text.trim().slice(0, 1500);
  return { id, said: t && t !== "Jarvis" ? `${t}: ${words}` : words };
}

/**
 * The history with the alert last, as Jarvis's, so "yes, do that" has it to
 * refer to: as untrusted as the rest, so never a developer message. Not twice
 * when the screen's history ends with it already.
 */
export function withOpening(input: OpenAI.Live.InitialItem[] | undefined, o: Opening): OpenAI.Live.InitialItem[] {
  const all = input ?? [];
  const last = all.at(-1);
  if (last?.role === "assistant" && last.content[0]?.text === o.said) return all;
  return [...all, { role: "assistant", content: [{ text: o.said, type: "output_text" }] }];
}

/**
 * What the screen sends on `oai-events` as soon as it opens, for the session
 * to start by saying the alert. GPT-Live has no way to speak first from the
 * server with client delegation (response.create needs Responses delegation),
 * so this is the speakable context the web app sends for an alert that comes
 * in during a session (src/app/main.ts onAlert); its event_id comes back on
 * session.commentary.appended.
 */
export const openingEvent = (o: Opening) => ({
  type: "session.commentary.append" as const,
  content: o.said,
  delegation_id: null,
  event_id: `opening_${o.id}`,
});
