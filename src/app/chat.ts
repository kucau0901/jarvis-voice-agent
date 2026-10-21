import { authHeaders } from "./key";
import { originHere } from "./alerts";
import type { Turn } from "./history";
import type { Attached } from "./attach";

/**
 * Typed chat: the conversation so far, sent to the same router a spoken
 * question reaches, and the answer read rather than heard. No speech either
 * way, so it is the cheapest way to ask — and GPT-Live is not involved, so
 * nothing stands between the question and the tools.
 */

interface ChatHooks {
  /** The question reached Jarvis: the stream is open. */
  opened?(): void;
  /** A tool call started or finished (lib/router.ts runCalls); `id` keeps two calls of one tool apart. */
  tool?(ev: { name: string; id?: string; phase: string }): void;
  /** A background job was started for this question (start_job, ask_hermes): its id, to follow it to its result. */
  job?(j: { id: string; title: string; engine: string }): void;
  /** A note from a tool as it works, with the call it belongs to when the server says. */
  progress(text: string, call?: string): void;
  display(payload: Record<string, unknown>): void;
  /** The answer; `limit` when a limit stopped it (a device's day, the ChatGPT plan's), shown as a notice rather than a failure. */
  answer(text: string, ok: boolean, limit?: boolean): void;
  /** A limit met on the way to an answer that was still given (this month's research used up): a notice under it. */
  limit?(text: string): void;
}

/** What typed chat says when start_job met the month's research cap, or research is switched off (lib/jobs.ts isResearchCap). */
const RESEARCH_CAP: Record<string, string> = {
  research: "This month's research jobs are used up: the limit is in Settings → OpenAI.",
  "research-off": "Research jobs are switched off: Settings → OpenAI → Research jobs a month.",
};

export async function askTyped(key: string, transcript: Turn[], hooks: ChatHooks, signal: AbortSignal, attached: Attached[] = []): Promise<void> {
  // Photos and files go with this question only (attach.ts); what stays in the transcript is their names.
  const images = attached.filter((a) => a.kind === "image").map((a) => a.data);
  const files = attached.filter((a) => a.kind !== "image").map(({ name, kind, data }) => ({ name, kind, data }));
  let answered = false;
  try {
    const res = await fetch("/api/delegate", {
      method: "POST",
      headers: authHeaders(key),
      // "chat": the router writes for reading — exact figures, links, short lists.
      body: JSON.stringify({ delegationId: "typed", transcript, surface: "chat", origin: originHere(), ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) }),
      signal,
    });
    if (!res.ok || !res.body) {
      const b = (await res.json().catch(() => ({}))) as { error?: string; text?: string };
      // A device's day or a burst of requests (index.ts): its own words, as a notice.
      if (res.status === 429 && b.text) return hooks.answer(b.text, false, true);
      hooks.answer(b.error ? `Could not ask: ${b.error}.` : `Could not ask (server said ${res.status}).`, false);
      return;
    }
    let notice = "";
    hooks.opened?.();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
        buf = buf.slice(i + 2);
        if (!line) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (ev.type === "progress" && ev.text) hooks.progress(String(ev.text), typeof ev.id === "string" ? ev.id : typeof ev.name === "string" ? ev.name : undefined);
        else if (ev.type === "tool" && typeof ev.name === "string") {
          hooks.tool?.({ name: ev.name, id: typeof ev.id === "string" ? ev.id : undefined, phase: String(ev.phase) });
          if (typeof ev.limit === "string" && RESEARCH_CAP[ev.limit]) notice = RESEARCH_CAP[ev.limit]!;
        }
        else if (ev.type === "job" && typeof ev.id === "string" && typeof ev.title === "string") hooks.job?.({ id: ev.id, title: ev.title, engine: String(ev.engine ?? "") });
        else if (ev.type === "display") hooks.display(ev);
        else if (ev.type === "result" || ev.type === "error") {
          answered = true;
          hooks.answer(String(ev.text ?? ""), ev.type === "result", ev.type === "error" && !!ev.limit);
          if (notice) hooks.limit?.(notice);
        }
      }
    }
    if (!answered) hooks.answer("That ended without an answer. Try again.", false);
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return;
    hooks.answer(`Could not reach Jarvis: ${e instanceof Error ? e.message : String(e)}`, false);
  }
}
