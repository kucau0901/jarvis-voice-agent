/**
 * Minimal SSE writer.
 *
 * A Hermes call can run for minutes, so the stream has to prove it is still
 * alive: without periodic traffic an intermediary is free to drop an idle
 * connection, and the car would just see the conversation stall.
 */
export interface SseEvent {
  /** transcript and audio are push-to-talk's (routes/voice.ts); the rest are the router's. */
  type: "progress" | "result" | "error" | "tool" | "used" | "display" | "transcript" | "audio";
  [k: string]: unknown;
}

/**
 * All the delegation loop actually touches.
 *
 * Narrow on purpose: it lets the same `run()` write either to a live stream or
 * to a collector that hands back one JSON object, with no branching inside the
 * loop. `SseStream` below already satisfies this structurally, so nothing about
 * the streaming path changes.
 */
export interface EventSink {
  send(ev: SseEvent): void;
  readonly isClosed: boolean;
}

export class SseStream {
  private enc = new TextEncoder();
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private heartbeat = 0;
  private closed = false;
  readonly body: ReadableStream<Uint8Array>;

  constructor(private heartbeatMs = 15_000) {
    this.body = new ReadableStream({
      start: (c) => {
        this.controller = c;
        this.heartbeat = setInterval(() => {
          // A comment line: valid SSE, ignored by EventSource, keeps the pipe warm.
          this.raw(": ping\n\n");
        }, this.heartbeatMs) as unknown as number;
      },
      cancel: () => this.close(),
    });
  }

  private raw(s: string) {
    if (this.closed) return;
    try {
      this.controller.enqueue(this.enc.encode(s));
    } catch {
      this.close();
    }
  }

  send(ev: SseEvent) {
    this.raw(`data: ${JSON.stringify(ev)}\n\n`);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    try { this.controller.close(); } catch { /* already closed */ }
  }

  get isClosed() {
    return this.closed;
  }

  response(): Response {
    return new Response(this.body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Belt and braces against any proxy that would otherwise buffer the stream.
        "x-accel-buffering": "no",
      },
    });
  }
}
