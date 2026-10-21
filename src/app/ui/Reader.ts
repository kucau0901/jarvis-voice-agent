import { button, el } from "./util";
import { markdown, type Doc } from "./rich";

/**
 * A document Jarvis wrote, to read at length (ui/rich.ts docCard), as Hark
 * opens its document cards: the whole of it, with Copy for its words and
 * Reply to ask about it. Escape or Done closes it.
 */
export class Reader {
  private el: HTMLElement;
  private title: HTMLElement;
  private body: HTMLElement;
  private doc: Doc | null = null;
  /** Reply, for the answer this document is. */
  private reply: () => void = () => {};

  constructor() {
    this.el = el("div", "panel");
    this.el.id = "reader";
    const sheet = el("div", "sheet");
    const head = el("header", "");
    this.title = el("h2", "");
    head.append(this.title, button("Done", () => this.hide(), "close"));
    const btns = el("div", "rowbtns");
    const copy = button("Copy", () => {
      if (!this.doc) return;
      void navigator.clipboard?.writeText(`# ${this.doc.title}\n\n${this.doc.body}`).then(() => (copy.textContent = "Copied"), () => (copy.textContent = "Could not copy"));
    });
    btns.append(copy, button("Reply", () => {
      this.reply();
      this.hide();
    }, "primary"));
    this.body = el("div", "reading");
    sheet.append(head, btns, this.body);
    this.el.appendChild(sheet);
    document.body.appendChild(this.el);
    this.el.addEventListener("click", (e) => {
      if (e.target === this.el) this.hide();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.el.classList.contains("open")) this.hide();
    });
  }

  show(doc: Doc, reply: () => void): void {
    this.doc = doc;
    this.reply = reply;
    this.title.textContent = doc.title;
    this.body.replaceChildren(markdown(doc.body));
    this.el.querySelector<HTMLButtonElement>(".rowbtns button")!.textContent = "Copy";
    this.el.classList.add("open");
    this.el.querySelector(".sheet")!.scrollTop = 0;
  }

  hide(): void {
    this.el.classList.remove("open");
  }
}
