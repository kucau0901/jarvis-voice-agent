import { button, el } from "./ui/util";

/**
 * Replying to one of Jarvis's answers, as Hark's chat ties a question to what
 * it is about. Each answer has a reply button; pressed, the answer is quoted
 * above the message box, and the question sent carries a hook beside it that,
 * pressed, brings that answer back into view. The router is given the
 * answer's words with the question (`said`), so "close that one" means the
 * thing quoted, however far up it was.
 */

/** As much of the answer as the router is given back: enough to know what it was. */
const QUOTED = 600;

export class Reply {
  private to: { row: HTMLElement; text: string } | null = null;
  private chip: HTMLElement | null = null;

  constructor(
    private tray: HTMLElement,
    private box: HTMLTextAreaElement,
  ) {}

  /** An answer of Jarvis's, given its reply button. */
  offer(row: HTMLElement, text: string): void {
    const b = button("", () => this.quote(row, text), "rpl");
    b.setAttribute("aria-label", "Reply to this");
    b.title = "Reply";
    row.appendChild(b);
  }

  /** The answer being replied to, if any, for the question being sent; the box is emptied of it. */
  take(): { row: HTMLElement; text: string } | null {
    const to = this.to;
    this.clear();
    return to;
  }

  clear(): void {
    this.to = null;
    this.chip?.remove();
    this.chip = null;
    this.tray.hidden = !this.tray.childElementCount;
  }

  /** The question as the router reads it: the answer it replies to, then its words. */
  static said(to: { text: string } | null, words: string): string {
    if (!to) return words;
    const quoted = to.text.length > QUOTED ? `${to.text.slice(0, QUOTED)}…` : to.text;
    return `(Replying to this answer of yours: "${quoted}")\n${words}`;
  }

  /** A sent question's hook back to the answer it replies to. */
  static hook(question: HTMLElement, answer: HTMLElement): void {
    const h = button("", () => {
      answer.scrollIntoView({ block: "center", behavior: "smooth" });
      answer.classList.remove("flash");
      // Restarted, so a second press flashes it again.
      void answer.offsetWidth;
      answer.classList.add("flash");
    }, "hook");
    h.setAttribute("aria-label", "Go to the answer this replies to");
    question.classList.add("replies");
    question.appendChild(h);
  }

  private quote(row: HTMLElement, text: string): void {
    this.to = { row, text };
    this.chip?.remove();
    const chip = el("span", "tchip quote");
    chip.append(el("span", "tq", text));
    const off = button("", () => this.clear(), "tremove");
    off.setAttribute("aria-label", "Do not reply to it");
    chip.appendChild(off);
    this.chip = chip;
    this.tray.prepend(chip);
    this.tray.hidden = false;
    this.box.focus();
  }
}
