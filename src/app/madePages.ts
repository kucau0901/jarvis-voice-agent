/** A page Jarvis made (tools/page.ts). */
export type Page = { id: string; title: string };

/** A kept entry that is a page set apart (main.ts pageApart): drawn as its card alone, and not told to the model as words. */
export const isApart = (s: { role: string; text: string; page?: Page; links?: unknown[] }): boolean =>
  s.role === "assistant" && !!s.page && s.text === s.page.title && !s.links?.length;

/**
 * The pages a question makes, typed or spoken, for their cards (pageCard.ts):
 * the last goes under its answer and is kept with it. One before it in the
 * same answer, or one whose answer never came (it failed, it was stopped),
 * goes to `apart`, a card and an entry of its own, so no page is made that
 * nothing can open.
 */
export class MadePages {
  private last: Page | null = null;
  private apart: (p: Page) => void;

  constructor(apart: (p: Page) => void) {
    this.apart = apart;
  }

  /** A display event: true when it was a page, now waiting for its answer. */
  seen(payload: Record<string, unknown>): boolean {
    if (payload.kind !== "page" || typeof payload.page !== "string") return false;
    if (this.last) this.apart(this.last);
    this.last = { id: payload.page, title: String(payload.label ?? "Page") };
    return true;
  }

  /** The page for the answer now ending, if one is waiting. */
  take(): Page | undefined {
    const p = this.last ?? undefined;
    this.last = null;
    return p;
  }

  /** No answer will take it: apart. */
  flush(): void {
    const p = this.take();
    if (p) this.apart(p);
  }

  /** Forgotten with the chat. */
  clear(): void {
    this.last = null;
  }
}
