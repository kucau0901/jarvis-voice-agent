import type { EventSink, SseEvent } from "./sse";

/** A pathological loop must not be able to balloon memory before it is cut off. */
const MAX_EVENTS = 200;

export interface Collected {
  ok: boolean;
  text: string;
  error?: string;
  detail?: string;
  tools: string[];
  /** The router model that produced this, after any fallback. */
  model?: string;
}

/**
 * Collects what the delegation loop emits instead of streaming it.
 *
 * Satisfies the same `EventSink` the SSE stream does, so `run()` is reused
 * verbatim — no branch inside the loop, and no second code path to keep honest.
 */
export class Collector implements EventSink {
  private events: SseEvent[] = [];
  private terminal: SseEvent | undefined;
  private usedTools: string[] = [];
  private done = false;

  send(ev: SseEvent): void {
    if (this.done) return;
    if (this.events.length < MAX_EVENTS) this.events.push(ev);

    if (ev.type === "used" && Array.isArray(ev.tools)) {
      this.usedTools = (ev.tools as string[]).slice(0, 20);
      return;
    }
    if (ev.type === "result" || ev.type === "error") {
      this.terminal = ev;
      // Closing here stops the waiting ladder queuing progress notes nobody will
      // read, and makes the loop's catch skip its own error once an answer has
      // already landed.
      this.done = true;
    }
  }

  get isClosed(): boolean {
    return this.done;
  }

  finish(): Collected {
    const t = this.terminal;
    const model = typeof t?.model === "string" ? { model: t.model } : {};

    /*
     * One path through the loop genuinely ends without saying anything: the
     * `if (signal.aborted) return;` guard at the top of each step. Everything
     * else — including running out of steps — emits a terminal event. So an
     * empty terminal here means the work was cut off, and the route says so
     * rather than returning a bare failure with nothing speakable in it.
     */
    if (!t) {
      return {
        ok: false,
        text: "That request was cut off before it finished.",
        error: "aborted",
        tools: this.usedTools,
      };
    }
    if (t.type === "error") {
      return {
        ok: false,
        text: String(t.text ?? "Something went wrong."),
        error: t.aborted ? "aborted" : "failed",
        detail: typeof t.detail === "string" ? t.detail : undefined,
        tools: this.usedTools,
        ...model,
      };
    }
    return { ok: true, text: String(t.text ?? ""), tools: this.usedTools, ...model };
  }
}
