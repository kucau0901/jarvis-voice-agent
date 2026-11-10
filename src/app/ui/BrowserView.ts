import { api } from "../key";
import { button, el } from "./util";

/**
 * The browser's screen as a picture that takes a hand (src/worker/routes/browser.ts):
 * fetched a few times a second while it can be seen, with taps, drags, the
 * wheel and keys sent back as real input. The Browser panel is built round
 * one (ui/Browser.ts); so is the card Jarvis puts in a conversation when it
 * hands the page over (browserCard, below).
 */

export interface Screen {
  jpeg: string;
  width: number;
  height: number;
  url: string;
  title: string;
}

export type ViewEvent = Record<string, unknown>;

/** The keys passed on as keys; anything else typed is text. */
const KEYS = new Set(["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"]);

export class BrowserView {
  readonly el: HTMLImageElement;
  private key: string;
  private screen: Screen | null = null;
  private timer = 0;
  private on = false;
  /** A finger or the mouse is down on the picture. */
  private held = false;
  /** Moves of a drag not yet sent. */
  private moves: ViewEvent[] = [];
  /** What is being sent, one request after another, so nothing overtakes. */
  private sending: Promise<void> = Promise.resolve();
  private seen: (s: Screen) => void;
  private say: (text: string, bad?: boolean) => void;

  /** `calm`: in a conversation, the wheel scrolls the conversation until the picture has been pressed. */
  constructor(key: string, seen: (s: Screen) => void, say: (text: string, bad?: boolean) => void, calm = false) {
    this.key = key;
    this.seen = seen;
    this.say = say;
    this.el = el("img", "bscreen");
    this.el.alt = "The browser's screen";
    this.el.tabIndex = 0;
    this.el.draggable = false;

    this.el.addEventListener("pointerdown", (e) => {
      const at = this.at(e);
      if (!at) return;
      e.preventDefault();
      // Without moving the page under the finger: the next tap must land where it was aimed.
      this.el.focus({ preventScroll: true });
      this.el.setPointerCapture(e.pointerId);
      this.held = true;
      this.send([{ kind: "mouse", type: "down", ...at }]);
    });
    this.el.addEventListener("pointermove", (e) => {
      const at = this.held ? this.at(e) : null;
      if (at) this.moves.push({ kind: "mouse", type: "move", ...at });
    });
    this.el.addEventListener("pointerup", (e) => {
      if (!this.held) return;
      this.held = false;
      const at = this.at(e);
      this.send([...this.moves.splice(0), ...(at ? [{ kind: "mouse", type: "up", ...at }] : [])]);
    });
    // A touch that turned into a pinch (zooming in to see): let go in a corner, so nothing on the page is pressed.
    this.el.addEventListener("pointercancel", () => {
      if (!this.held) return;
      this.held = false;
      this.moves.length = 0;
      this.send([{ kind: "mouse", type: "move", x: 0, y: 0 }, { kind: "mouse", type: "up", x: 0, y: 0 }]);
    });
    this.el.addEventListener("wheel", (e) => {
      if (calm && document.activeElement !== this.el) return;
      e.preventDefault();
      this.wheel(e.deltaY, this.at(e) ?? undefined);
    }, { passive: false });
    // With a keyboard: keys pressed while the picture has focus go straight to the browser.
    this.el.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (KEYS.has(e.key)) this.send([{ kind: "key", key: e.key }]);
      else if (e.key.length === 1) this.send([{ kind: "text", text: e.key }]);
      else return;
      e.preventDefault();
    });
  }

  start(): void {
    if (this.on) return;
    this.on = true;
    void this.tick();
  }

  stop(): void {
    this.on = false;
    clearTimeout(this.timer);
  }

  /** Where on the browser's own screen a point on the picture is. */
  private at(e: MouseEvent): { x: number; y: number } | null {
    const r = this.el.getBoundingClientRect();
    if (!this.screen || !r.width || !r.height) return null;
    return { x: Math.round(((e.clientX - r.left) / r.width) * this.screen.width), y: Math.round(((e.clientY - r.top) / r.height) * this.screen.height) };
  }

  wheel(dy: number, at?: { x: number; y: number }): void {
    if (!this.screen) return;
    this.send([{ kind: "wheel", x: at?.x ?? Math.round(this.screen.width / 2), y: at?.y ?? Math.round(this.screen.height / 2), dy }]);
  }

  send(events: ViewEvent[]): void {
    if (!events.length) return;
    this.sending = this.sending.then(async () => {
      try {
        await api(this.key, "POST", "/api/browser/input", { events });
        this.say("");
      } catch (e) {
        this.say(e instanceof Error ? e.message : String(e), true);
      }
    });
  }

  /** Whether the picture is on the page and where it can be seen: nothing is fetched for one that is not. */
  private inSight(): boolean {
    if (document.hidden || !this.el.isConnected) return false;
    // A card in the conversation rests while a panel is open over it.
    if (!this.el.closest(".panel") && document.querySelector(".panel.open")) return false;
    const r = this.el.getBoundingClientRect();
    return r.width > 0 && r.bottom > 0 && r.top < window.innerHeight;
  }

  /** The picture, again and again: quicker while a drag is under way. */
  private async tick(): Promise<void> {
    clearTimeout(this.timer);
    if (!this.on) return;
    if (this.inSight()) {
      // A drag's moves go as it happens, so a slider is seen to follow the finger.
      if (this.held) this.send(this.moves.splice(0));
      try {
        await this.sending;
        const s = (await api(this.key, "GET", "/api/browser/screen")) as Screen;
        this.screen = s;
        this.el.src = `data:image/jpeg;base64,${s.jpeg}`;
        this.seen(s);
      } catch (e) {
        this.say(e instanceof Error ? e.message : String(e), true);
      }
    }
    if (this.on) this.timer = window.setTimeout(() => void this.tick(), this.held ? 120 : 500);
  }
}

/** The one card that is live: a newer one takes over from it. */
let live: BrowserView | null = null;

/**
 * The browser, handed over in the conversation (the browser_show tool): its
 * screen to watch and to press and type on, Enlarge for the whole panel with
 * its address bar and its box for a phone's typing, and Close.
 */
export function browserCard(key: string, enlarge: () => void): HTMLElement {
  const card = el("div", "pagecard bcard");
  card.appendChild(el("div", "doctag", "Browser"));
  const where = el("div", "pagesaid");
  const msg = el("div", "msg");
  const view = new BrowserView(key, (s) => (where.textContent = s.title || s.url), (text, bad) => {
    msg.textContent = text;
    msg.classList.toggle("bad", !!bad);
  }, true);
  const done = () => {
    view.stop();
    view.el.replaceWith(el("div", "note", "Closed. Ask to see the browser again, or open Browser in the menu."));
    row.remove();
  };
  const row = el("div", "mdbtns");
  row.append(button("Enlarge", enlarge, "docopen primary"), button("Close", done, "docopen"));
  // The buttons above the picture: a tall page must not push them out of reach.
  card.append(row, where, view.el, msg);
  live?.stop();
  live = view;
  view.start();
  return card;
}
