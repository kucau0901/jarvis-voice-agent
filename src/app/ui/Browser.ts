import { api } from "../key";
import { button, el } from "./util";
import { browserLogins } from "./BrowserLogins";

/**
 * The browser Jarvis works in, under your own hands (src/worker/routes/browser.ts):
 * for what Jarvis never does itself, signing in and passing an "are you
 * human" check. Its screen is a picture fetched a few times a second; a tap,
 * a drag and what is typed go to the browser as real input, and nowhere else.
 */

interface Screen {
  jpeg: string;
  width: number;
  height: number;
  url: string;
  title: string;
}

type ViewEvent = Record<string, unknown>;

/** The keys passed on as keys; anything else typed is text. */
const KEYS = new Set(["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"]);

export class Browser {
  private el: HTMLElement;
  private key: string;
  private img: HTMLImageElement;
  private where: HTMLElement;
  private screen: Screen | null = null;
  private timer = 0;
  /** A finger or the mouse is down on the picture. */
  private held = false;
  /** Moves of a drag not yet sent. */
  private moves: ViewEvent[] = [];
  /** What is being sent, one request after another, so nothing overtakes. */
  private sending: Promise<void> = Promise.resolve();
  private logins: ReturnType<typeof browserLogins>;

  constructor(key: string) {
    this.key = key;
    this.el = el("div", "panel");
    this.el.id = "browser";
    const sheet = el("div", "sheet");
    const head = el("header", "");
    head.appendChild(el("h2", "", "Browser"));
    head.appendChild(button("Done", () => this.hide(), "close"));
    sheet.appendChild(head);
    sheet.appendChild(el("p", "note",
      "The browser Jarvis works in. Sign in here yourself, or pass an \"are you human\" check, and it stays signed in. " +
      "What you type here goes to the browser only. On a phone, pinch to zoom in."));

    const bar = el("div", "rform bbar");
    const address = el("input");
    address.type = "text";
    address.placeholder = "https://example.com";
    address.autocomplete = "off";
    address.setAttribute("aria-label", "Address to open");
    const go = () => {
      if (address.value.trim()) this.send([{ kind: "open", address: address.value.trim() }]);
    };
    address.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
    });
    const nav = el("div", "rowbtns");
    nav.append(button("Go", go, "primary"), button("Back", () => this.send([{ kind: "back" }])),
      button("Up", () => this.wheel(-500)), button("Down", () => this.wheel(500)));
    bar.append(address, nav);
    sheet.appendChild(bar);

    this.where = el("p", "note bwhere");
    sheet.appendChild(this.where);
    this.img = el("img", "bscreen");
    this.img.alt = "The browser's screen";
    this.img.tabIndex = 0;
    this.img.draggable = false;
    sheet.appendChild(this.img);

    // A phone has no keys to press on a picture: type here, then Send.
    const keys = el("div", "rform bkeys");
    const text = el("input");
    text.type = "password";
    text.placeholder = "Type here, then Send";
    text.autocomplete = "off";
    text.setAttribute("aria-label", "Text to type into the browser");
    const type = () => {
      if (!text.value) return;
      this.send([{ kind: "text", text: text.value }]);
      text.value = "";
    };
    text.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      type();
      this.send([{ kind: "key", key: "Enter" }]);
    });
    const show = el("label", "on");
    const showBox = el("input");
    showBox.type = "checkbox";
    showBox.addEventListener("change", () => (text.type = showBox.checked ? "text" : "password"));
    show.append(showBox, document.createTextNode(" Show what I type"));
    const row = el("div", "rowbtns");
    row.append(button("Send", type, "primary"), ...["Enter", "Tab", "Backspace"].map((k) => button(k, () => this.send([{ kind: "key", key: k }]))));
    keys.append(text, show, row);
    sheet.appendChild(keys);
    sheet.appendChild(el("div", "msg"));
    this.logins = browserLogins(key);
    sheet.appendChild(this.logins.el);
    this.el.appendChild(sheet);
    document.body.appendChild(this.el);
    this.el.addEventListener("click", (e) => {
      if (e.target === this.el) this.hide();
    });

    this.img.addEventListener("pointerdown", (e) => {
      const at = this.at(e);
      if (!at) return;
      e.preventDefault();
      // Without moving the page under the finger: the next tap must land where it was aimed.
      this.img.focus({ preventScroll: true });
      this.img.setPointerCapture(e.pointerId);
      this.held = true;
      this.send([{ kind: "mouse", type: "down", ...at }]);
    });
    this.img.addEventListener("pointermove", (e) => {
      const at = this.held ? this.at(e) : null;
      if (at) this.moves.push({ kind: "mouse", type: "move", ...at });
    });
    const up = (e: PointerEvent) => {
      if (!this.held) return;
      this.held = false;
      const at = this.at(e);
      this.send([...this.moves.splice(0), ...(at ? [{ kind: "mouse", type: "up", ...at }] : [])]);
    };
    this.img.addEventListener("pointerup", up);
    // A touch that turned into a pinch (zooming in to see): let go in a corner, so nothing on the page is pressed.
    this.img.addEventListener("pointercancel", () => {
      if (!this.held) return;
      this.held = false;
      this.moves.length = 0;
      this.send([{ kind: "mouse", type: "move", x: 0, y: 0 }, { kind: "mouse", type: "up", x: 0, y: 0 }]);
    });
    this.img.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.wheel(e.deltaY, this.at(e) ?? undefined);
    }, { passive: false });
    // With a keyboard: keys pressed while the picture has focus go straight to the browser.
    this.img.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (KEYS.has(e.key)) this.send([{ kind: "key", key: e.key }]);
      else if (e.key.length === 1) this.send([{ kind: "text", text: e.key }]);
      else return;
      e.preventDefault();
    });
  }

  show(): void {
    this.el.classList.add("open");
    void this.logins.load();
    void this.tick();
  }

  hide(): void {
    this.el.classList.remove("open");
    clearTimeout(this.timer);
  }

  private msg(text: string, bad = false): void {
    const m = this.el.querySelector<HTMLElement>(".msg")!;
    m.textContent = text;
    m.classList.toggle("bad", bad);
  }

  /** Where on the browser's own screen a point on the picture is. */
  private at(e: MouseEvent): { x: number; y: number } | null {
    const r = this.img.getBoundingClientRect();
    if (!this.screen || !r.width || !r.height) return null;
    return { x: Math.round(((e.clientX - r.left) / r.width) * this.screen.width), y: Math.round(((e.clientY - r.top) / r.height) * this.screen.height) };
  }

  private wheel(dy: number, at?: { x: number; y: number }): void {
    if (!this.screen) return;
    this.send([{ kind: "wheel", x: at?.x ?? Math.round(this.screen.width / 2), y: at?.y ?? Math.round(this.screen.height / 2), dy }]);
  }

  private send(events: ViewEvent[]): void {
    if (!events.length) return;
    this.sending = this.sending.then(async () => {
      try {
        await api(this.key, "POST", "/api/browser/input", { events });
        this.msg("");
      } catch (e) {
        this.msg(e instanceof Error ? e.message : String(e), true);
      }
    });
  }

  /** The picture, again and again while the panel is open: quicker while a drag is under way. */
  private async tick(): Promise<void> {
    clearTimeout(this.timer);
    if (!this.el.classList.contains("open")) return;
    if (!document.hidden) {
      // A drag's moves go as it happens, so a slider is seen to follow the finger.
      if (this.held) this.send(this.moves.splice(0));
      try {
        await this.sending;
        const s = (await api(this.key, "GET", "/api/browser/screen")) as Screen;
        this.screen = s;
        this.img.src = `data:image/jpeg;base64,${s.jpeg}`;
        this.where.textContent = s.title ? `${s.title} · ${s.url}` : s.url;
        if (/^https?:/.test(s.url)) this.logins.site(new URL(s.url).origin);
      } catch (e) {
        this.msg(e instanceof Error ? e.message : String(e), true);
      }
    }
    this.timer = window.setTimeout(() => void this.tick(), this.held ? 120 : 500);
  }
}
