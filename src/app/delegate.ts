import { authHeaders } from "./key";
import type { Turn } from "./history";

/**
 * Drive one delegation from GPT-Live to the Worker and back.
 *
 * GPT-Live gives us only a delegation id and a timeline offset — never the task
 * text — so the whole transcript goes to the Worker and its router decides what
 * the user actually wanted.
 */
/**
 * Tools that routinely run for minutes rather than seconds.
 *
 * Only Hermes qualifies: everything else here answers inside about eight
 * seconds, which is not worth tearing a session down for.
 */
// ask_hermes is no longer here: it starts a background job and returns at once,
// and its answer arrives later as an alert (src/worker/lib/jobs.ts).
const SLOW_TOOLS = new Set(["control_home"]);

export interface DelegateHandlers {
  /** Something to look at, rather than something to say. */
  display(payload: Record<string, unknown>): void;
  /** Spoken aloud by Jarvis, in his own words. */
  say(text: string, delegationId: string): void;
  /** Silent context for Jarvis. */
  think(text: string, delegationId: string): void;
  log(type: string, data: Record<string, unknown>): void;
  /**
   * A tool that will take minutes has started.
   *
   * The voice session bills by the minute and the HTTP stream this runs on does
   * not, so the app can drop the session and keep waiting here for nothing.
   */
  slow?(name: string): void;
  done(): void;
}

/** commentary.append and thinking.append are both capped at 500 tokens. */
const CHUNK_CHARS = 1200;

function chunk(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > CHUNK_CHARS) {
    // Break on a sentence end where possible so each spoken piece stands alone.
    const window = rest.slice(0, CHUNK_CHARS);
    const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
    const at = cut > CHUNK_CHARS * 0.5 ? cut + 1 : CHUNK_CHARS;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export async function runDelegation(
  key: string,
  delegationId: string,
  transcript: Turn[],
  h: DelegateHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const started = Date.now();
  try {
    const res = await fetch("/api/delegate", {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify({ delegationId, transcript }),
      signal,
    });

    if (!res.ok || !res.body) {
      h.say(
        "Tell the user you could not reach the backend just now, in one short sentence.",
        delegationId,
      );
      h.log("[delegate.http]", { status: res.status });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let gotResult = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;          // a ": ping" heartbeat

        let ev: { type: string; text?: string; name?: string; tools?: string[] } & Record<string, unknown>;
        try {
          ev = JSON.parse(line.slice(6));
        } catch {
          continue;
        }

        switch (ev.type) {
          case "tool":
            h.log("[delegate.tool]", { name: ev.name });
            if (ev.phase === "start" && typeof ev.name === "string" && SLOW_TOOLS.has(ev.name)) {
              h.slow?.(ev.name);
            }
            break;

          case "progress":
            // Silent: Jarvis decides whether the wait has been long enough to
            // be worth mentioning, rather than narrating every step.
            if (ev.text) h.think(`Progress: ${ev.text}.`, delegationId);
            break;

          case "result":
            gotResult = true;
            // Which router model answered, after any fallback. Log only: the
            // driver has no use for it, but "is it really on the new model?"
            // should be answerable without a terminal.
            if (typeof ev.model === "string") h.log("[delegate.model]", { model: ev.model });
            if (ev.text) for (const part of chunk(ev.text)) h.say(part, delegationId);
            break;

          case "display":
            h.display(ev as unknown as Record<string, unknown>);
            break;

          case "used":
            // Factual record of what actually ran, so Jarvis can answer "which
            // system did you use" instead of guessing from his own narration.
            if (Array.isArray((ev as { tools?: string[] }).tools)) {
              const names = (ev as { tools: string[] }).tools;
              h.think(
                `Fact, for answering questions about how this was handled: the ` +
                `backend used ${names.join(", ")}. Home Assistant tools are named ` +
                `home-assistant__*; ask_hermes is the Hermes agent at home; ` +
                `music_* is Spotify; ` +
                `remember/recall/forget are your own saved notes about the user. ` +
                `Say only this if asked which system was used.`,
                delegationId,
              );
            }
            break;

          case "error":
            gotResult = true;
            if (ev.text) h.say(ev.text, delegationId);
            h.log("[delegate.error]", { text: ev.text });
            break;
        }
      }
    }

    if (!gotResult) {
      h.say(
        "Tell the user the request ended without an answer, in one short sentence.",
        delegationId,
      );
    }
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return;
    h.log("[delegate.failed]", { error: e instanceof Error ? e.message : String(e) });
    h.say("Tell the user something went wrong on the way to your backend.", delegationId);
  } finally {
    h.log("[delegate.done]", { ms: Date.now() - started });
    h.done();
  }
}
