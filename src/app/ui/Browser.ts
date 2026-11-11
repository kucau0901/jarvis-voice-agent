import { button, el } from "./util";
import { browserLogins } from "./BrowserLogins";
import { BrowserView, type ViewEvent } from "./BrowserView";

/**
 * The browser Jarvis works in, under your own hands (src/worker/routes/browser.ts):
 * for what Jarvis never does itself, signing in and passing an "are you
 * human" check. Its screen is a BrowserView (ui/BrowserView.ts); round it,
 * an address bar, a box for a phone's typing, and the sign-ins you saved.
 * Full screen puts the screen and those controls over everything, and turns
 * a phone on its side where the phone allows it.
 */

export class Browser {
  private el: HTMLElement;
  private view: BrowserView;
  private where: HTMLElement;
  /** The screen and its controls: what Full screen fills the window with. */
  private stage: HTMLElement;
  private fuller: HTMLButtonElement;
  private logins: ReturnType<typeof browserLogins>;

  constructor(key: string) {
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
    this.logins = browserLogins(key);
    this.view = new BrowserView(key, (s) => {
      this.where.textContent = s.title ? `${s.title} · ${s.url}` : s.url;
      if (/^https?:/.test(s.url)) this.logins.site(new URL(s.url).origin);
    }, (text, bad) => this.msg(text, bad));
    const send = (events: ViewEvent[]) => this.view.send(events);

    const bar = el("div", "rform bbar");
    const address = el("input");
    address.type = "text";
    address.placeholder = "https://example.com";
    address.autocomplete = "off";
    address.setAttribute("aria-label", "Address to open");
    const go = () => {
      if (address.value.trim()) send([{ kind: "open", address: address.value.trim() }]);
    };
    address.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
    });
    const nav = el("div", "rowbtns");
    nav.append(button("Go", go, "primary"), button("Back", () => send([{ kind: "back" }])),
      button("Up", () => this.view.wheel(-500)), button("Down", () => this.view.wheel(500)));
    this.fuller = button("Full screen", () => void this.full(!this.stage.classList.contains("full")));
    nav.appendChild(this.fuller);
    bar.append(address, nav);

    this.where = el("p", "note bwhere");

    // A phone has no keys to press on a picture: type here, then Send.
    const keys = el("div", "rform bkeys");
    const text = el("input");
    text.type = "password";
    text.placeholder = "Type here, then Send";
    text.autocomplete = "off";
    text.setAttribute("aria-label", "Text to type into the browser");
    const type = () => {
      if (!text.value) return;
      send([{ kind: "text", text: text.value }]);
      text.value = "";
    };
    text.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      type();
      send([{ kind: "key", key: "Enter" }]);
    });
    const show = el("label", "on");
    const showBox = el("input");
    showBox.type = "checkbox";
    showBox.addEventListener("change", () => (text.type = showBox.checked ? "text" : "password"));
    show.append(showBox, document.createTextNode(" Show what I type"));
    const row = el("div", "rowbtns");
    row.append(button("Send", type, "primary"), ...["Enter", "Tab", "Backspace"].map((k) => button(k, () => send([{ kind: "key", key: k }]))));
    keys.append(text, show, row);
    // The controls in one element, so that full screen can stand them beside the picture (index.html, .bstage).
    const side = el("div", "bside");
    side.append(bar, this.where, keys, el("div", "msg"));
    this.stage = el("div", "bstage");
    this.stage.append(side, this.view.el);
    sheet.appendChild(this.stage);
    // Left by the phone's own back gesture.
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement) void this.full(false);
    });
    sheet.appendChild(this.logins.el);
    this.el.appendChild(sheet);
    document.body.appendChild(this.el);
    this.el.addEventListener("click", (e) => {
      if (e.target === this.el) this.hide();
    });
  }

  show(): void {
    this.el.classList.add("open");
    void this.logins.load();
    this.view.start();
  }

  hide(): void {
    this.el.classList.remove("open");
    this.view.stop();
    void this.full(false);
  }

  /** The screen over everything, and a phone turned on its side to give it the room. */
  private async full(on: boolean): Promise<void> {
    if (this.stage.classList.contains("full") === on) return;
    this.stage.classList.toggle("full", on);
    this.fuller.textContent = on ? "Exit full screen" : "Full screen";
    try {
      if (!on) return void (document.fullscreenElement && (await document.exitFullscreen()));
      await this.stage.requestFullscreen();
      // Android's Chrome turns a full-screen page on request; TypeScript's DOM types leave `lock` out.
      const turn: ScreenOrientation & { lock?: (to: "landscape") => Promise<void> } = screen.orientation;
      await turn.lock?.("landscape");
    } catch {
      // An iPhone has neither, and a desk has no side to turn on: the screen still fills the window.
    }
  }

  private msg(text: string, bad = false): void {
    const m = this.el.querySelector<HTMLElement>(".msg")!;
    m.textContent = text;
    m.classList.toggle("bad", bad);
  }
}
