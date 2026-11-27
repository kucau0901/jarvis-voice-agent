import { personOfWho } from "./context.ts";
import type { LiveSocket } from "./live.ts";

/**
 * A person's Macs (tools/computer.ts): asking one to do something, and its answer.
 *
 * A Mac is a device of its person's (lib/devices.ts), made by the Jarvis
 * desktop app when they turn on "Let Jarvis control this Mac". The app's main
 * process keeps its own socket to the object, as any device may, and the web
 * page in its window never holds what runs commands. A request goes to that
 * one Mac's newest socket and waits, in memory, for its answer on the same
 * socket, as an alert waits for a screen's ack (lib/live.ts): the object is
 * awake while it waits. The Mac says at once that it got the request, so one
 * that has just gone to sleep is told apart from one still working.
 *
 * Several requests may be in flight at once, to different Macs and from
 * different people: each is waited for under its own id, and only the Mac it
 * went to can answer it.
 *
 * Free of `cloudflare:workers`, so Node tests it with fake sockets.
 */

export type ComputerOp = "look" | "do" | "run";
export type ComputerAct = "press" | "type" | "key" | "scroll" | "open" | "front";

/** What a Mac is asked: one look, act or command, and how long it has. */
export interface ComputerRequest {
  op: ComputerOp;
  act: ComputerAct | null;
  element: number | null;
  text: string | null;
  picture: boolean;
  ms: number;
}

/**
 * A Claude Code session on a Mac (lib/mac-build.ts), in its folder there, by
 * its session id, under the job's name; and what it is told: to begin, with
 * what its person asked and what their job found (their tap); to go on, with
 * the job's answer to its round; to bring back what it made; or to stop. The
 * Mac says it got it, and says what came of it later by its own requests
 * (routes/computer.ts), never on the socket.
 */
export type BuildRequest = { op: "build"; folder: string; session: string; name: string } & (
  | { start: { task: string; notes: string; repo: boolean } }
  | { round: number; reply: string }
  | { finish: true }
  | { stop: true }
);

/** What a Mac said: whether it worked, in words, and a screenshot for a look that asked for one. */
export interface ComputerAnswer {
  ok: boolean;
  text: string;
  image: string | null;
}

/** "offline": it did not say it got the request; "late": it did, but did not answer in time. */
export type ComputerResult = ComputerAnswer | "offline" | "late";

/** How long a Mac has to say it got a request before it counts as asleep or gone. */
export const GOT_MS = 5_000;
/** Past a request's own time, for the answer to travel back. */
export const GRACE_MS = 5_000;
/** The most an answer may be, a screenshot included. */
export const MAX_ANSWER = 512 * 1024;
/** The most of an answer's words kept: the Mac cuts a command's output to this too. */
export const MAX_TEXT = 16_000;

const JPEG = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;

interface Waiting {
  who: string;
  got(): void;
  answer(a: ComputerAnswer): void;
}

/** The newest socket of `person`'s Mac `who`; none for another person's: a slip elsewhere must not reach someone else's. */
function newestOf(sockets: LiveSocket[], person: string, who: string): LiveSocket | undefined {
  if (personOfWho(who) !== person) return undefined;
  return sockets.filter((s) => s.client()?.who === who).sort((a, b) => (b.client()?.since ?? 0) - (a.client()?.since ?? 0))[0];
}

export class Computers {
  /** Requests waiting on a Mac. In memory only: the object is awake while it waits. */
  private waiting = new Map<string, Waiting>();

  /** Which of these Macs (by `who`) have a socket open now. */
  online(sockets: LiveSocket[], whos: readonly string[]): string[] {
    const open = new Set(sockets.map((s) => s.client()?.who).filter((w): w is string => !!w));
    return whos.filter((w) => open.has(w));
  }

  /** Ask one Mac of `person`'s: to its newest socket, waited for until it answers, or did not say it got it, or ran out of time. */
  ask(sockets: LiveSocket[], person: string, who: string, req: ComputerRequest, id: string = crypto.randomUUID()): Promise<ComputerResult> {
    const newest = newestOf(sockets, person, who);
    if (!newest) return Promise.resolve("offline");
    return new Promise((resolve) => {
      const end = (r: ComputerResult) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve(r);
      };
      let timer = setTimeout(() => end("offline"), GOT_MS);
      this.waiting.set(id, {
        who,
        got: () => {
          clearTimeout(timer);
          timer = setTimeout(() => end("late"), req.ms + GRACE_MS);
        },
        answer: end,
      });
      try {
        newest.send(JSON.stringify({ type: "computer.do", id, ...req }));
      } catch {
        end("offline"); // closing; the runtime will report it
      }
    });
  }

  /** Tell one Mac of `person`'s what its build is to do: true once it says it got it, false when it did not, or one for that build is still on its way. What came of it comes later, by its own request. */
  start(sockets: LiveSocket[], person: string, who: string, req: BuildRequest, id: string): Promise<boolean> {
    const newest = newestOf(sockets, person, who);
    if (!newest || this.waiting.has(id)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const end = (ok: boolean) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve(ok);
      };
      const timer = setTimeout(() => end(false), GOT_MS);
      this.waiting.set(id, { who, got: () => end(true), answer: () => {} });
      try {
        newest.send(JSON.stringify({ type: "computer.do", id, ...req }));
      } catch {
        end(false);
      }
    });
  }

  /**
   * A message from a socket: true when it was a Mac's (taken, or dropped as
   * not fit), false for anything else, which the screens' hub reads
   * (lib/live.ts). Only a request still waiting, and only from the Mac it
   * went to.
   */
  receive(sock: LiveSocket, raw: string | ArrayBuffer): boolean {
    if (typeof raw !== "string" || !raw.startsWith('{"type":"computer.')) return false;
    if (raw.length > MAX_ANSWER) return true;
    let msg: { type?: unknown; id?: unknown; ok?: unknown; text?: unknown; image?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return true;
    }
    const w = typeof msg.id === "string" ? this.waiting.get(msg.id) : undefined;
    if (!w || sock.client()?.who !== w.who) return true;
    if (msg.type === "computer.got") w.got();
    else if (msg.type === "computer.answer" && typeof msg.ok === "boolean" && typeof msg.text === "string") {
      const image = typeof msg.image === "string" && JPEG.test(msg.image) ? msg.image : null;
      w.answer({ ok: msg.ok, text: msg.text.slice(0, MAX_TEXT), image });
    }
    return true;
  }
}
