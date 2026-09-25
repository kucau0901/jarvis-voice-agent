/**
 * One connection to each MCP server for the length of one question.
 *
 * Connecting is a round trip of its own before the call, and over a slow link
 * home it took 0.8 to 1.9 s every time: 2.7 s of a 14 s answer was spent
 * connecting twice (measured 26 Sep 2026). So a question keeps the connection
 * it opened until the answer is written, and starts opening it while the model
 * is still working out the first step, so the first call finds it ready.
 *
 * Without one, each call connects and closes on its own (tools/mcp.ts), as
 * background jobs and the settings page's tool listing still do.
 *
 * Kept apart from tools/mcp.ts, which Node cannot load, so it can be tested.
 */

export interface Closable {
  close(): Promise<void>;
}

export class McpSessions<S extends { label: string }, C extends Closable> {
  private open = new Map<string, Promise<C>>();
  private readonly connect: (server: S) => Promise<C>;

  constructor(connect: (server: S) => Promise<C>) {
    this.connect = connect;
  }

  client(server: S): Promise<C> {
    let c = this.open.get(server.label);
    if (!c) {
      const opening = this.connect(server);
      // A connection that never opened is tried again by the next call.
      opening.catch(() => this.forget(server, opening));
      this.open.set(server.label, opening);
      c = opening;
    }
    return c;
  }

  /** Start connecting now. A failure is left for the first call to report. */
  warm(server: S): void {
    this.client(server).catch(() => {});
  }

  /** A connection that failed mid-question is not handed out again. */
  forget(server: S, which?: Promise<C>): void {
    const c = this.open.get(server.label);
    if (c && (!which || c === which)) {
      this.open.delete(server.label);
      c.then((cl) => cl.close()).catch(() => {});
    }
  }

  async close(): Promise<void> {
    const all = [...this.open.values()];
    this.open.clear();
    await Promise.all(all.map((c) => c.then((cl) => cl.close()).catch(() => {})));
  }
}
