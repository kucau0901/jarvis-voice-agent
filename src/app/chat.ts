import { authHeaders } from "./key";
import type { Turn } from "./history";

/**
 * Typed chat: the conversation so far, sent to the same router a spoken
 * question reaches, and the answer read rather than heard. No speech either
 * way, so it is the cheapest way to ask — and GPT-Live is not involved, so
 * nothing stands between the question and the tools.
 */

export interface ChatHooks {
  progress(text: string): void;
  display(payload: Record<string, unknown>): void;
  answer(text: string, ok: boolean): void;
}

export async function askTyped(key: string, transcript: Turn[], hooks: ChatHooks, signal: AbortSignal): Promise<void> {
  let answered = false;
  try {
    const res = await fetch("/api/delegate", {
      method: "POST",
      headers: authHeaders(key),
      // "chat": the router writes for reading — exact figures, links, short lists.
      body: JSON.stringify({ delegationId: "typed", transcript, surface: "chat" }),
      signal,
    });
    if (!res.ok || !res.body) {
      const why = ((await res.json().catch(() => ({}))) as { error?: string }).error;
      hooks.answer(why ? `Could not ask: ${why}.` : `Could not ask (server said ${res.status}).`, false);
      return;
    }
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
        if (ev.type === "progress" && ev.text) hooks.progress(String(ev.text));
        else if (ev.type === "display") hooks.display(ev);
        else if (ev.type === "result" || ev.type === "error") {
          answered = true;
          hooks.answer(String(ev.text ?? ""), ev.type === "result");
        }
      }
    }
    if (!answered) hooks.answer("That ended without an answer. Try again.", false);
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return;
    hooks.answer(`Could not reach Jarvis: ${e instanceof Error ? e.message : String(e)}`, false);
  }
}
