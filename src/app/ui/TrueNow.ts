import { api } from "../key";
import { button, el } from "./util";

/**
 * Memory → Which is true now? (src/worker/lib/true-now.ts): saved facts that may
 * say one thing twice, or disagree, and ones whose day has passed, found by
 * code when pressed, with a choice for each. Nothing here writes a fact: what
 * is not kept goes to Recently forgotten.
 */

type Book = "mine" | "family";
interface Fact { id: string; text: string; kind: string; slug?: string; address?: string; createdAt: number; updatedAt: number }
interface Found { pairs: { older: Fact; newer: Fact }[]; passed: { fact: Fact; day: string }[]; byMeaning: boolean }

const day = (at: number | string) => new Date(at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
const path = (b: Book) => `/api/memory/true${b === "family" ? "?book=family" : ""}`;

export class TrueNow {
  private key: string;
  private list = el("div", "rlist");
  private msg = el("p", "note", "");
  private books: () => Book[];
  private changed: () => void;

  /** `changed`: told when a fact was dropped, for the rest of the panel. */
  constructor(key: string, box: HTMLElement, books: () => Book[], changed: () => void) {
    this.key = key;
    this.books = books;
    this.changed = changed;
    this.msg.setAttribute("role", "status");
    const go = button("Look for them", () => {
      go.disabled = true;
      void this.look().finally(() => (go.disabled = false));
    });
    box.replaceChildren(go, this.msg, this.list);
  }

  private async look(): Promise<void> {
    this.msg.textContent = "Looking…";
    this.list.replaceChildren();
    let n = 0;
    try {
      for (const book of this.books()) {
        const found = (await api(this.key, "GET", path(book))) as Found;
        n += found.pairs.length + found.passed.length;
        this.list.append(...found.pairs.map((p) => this.pair(book, p.older, p.newer)), ...found.passed.map((p) => this.passed(book, p.fact, p.day)));
      }
      this.msg.textContent = n ? "" : "Nothing to ask about.";
    } catch (e) {
      this.msg.textContent = `Could not look: ${why(e)}`;
    }
  }

  /** One choice's buttons: pressed, the answer is sent and its row goes. */
  private choose(row: HTMLElement, book: Book, choices: [string, Record<string, unknown>][]): HTMLElement {
    const btns = el("div", "rowbtns");
    const problem = el("small", "rfacts bad");
    for (const [label, body] of choices) {
      btns.appendChild(button(label, async () => {
        btns.querySelectorAll("button").forEach((b) => (b.disabled = true));
        try {
          const r = (await api(this.key, "POST", path(book), body)) as { forgotten: string[] };
          // Another row may speak of one that has gone.
          for (const id of r.forgotten) this.list.querySelectorAll<HTMLElement>(".routine").forEach((x) => (x.dataset.facts ?? "").split(" ").includes(id) && x.remove());
          row.remove();
          if (!this.list.childElementCount) this.msg.textContent = "Nothing more to ask about.";
          if (r.forgotten.length) this.changed();
        } catch (e) {
          problem.textContent = why(e);
          btns.querySelectorAll("button").forEach((b) => (b.disabled = false));
        }
      }));
    }
    const box = el("div", "");
    box.append(btns, problem);
    return box;
  }

  private said(book: Book, f: Fact, when: string): HTMLElement {
    const one = el("div", "truefact");
    one.append(el("div", "", f.text), el("small", "rfacts", `${when} ${day(f.updatedAt)}${f.createdAt !== f.updatedAt ? `, first saved ${day(f.createdAt)}` : ""}${book === "family" ? " · the family's" : ""}`));
    if (f.address) one.insertBefore(el("div", "rfacts", f.address), one.lastChild);
    return one;
  }

  private pair(book: Book, older: Fact, newer: Fact): HTMLElement {
    const row = el("div", "routine");
    row.dataset.facts = `${older.id} ${newer.id}`;
    row.append(this.said(book, older, "Older: saved"), this.said(book, newer, "Newer: saved"));
    const pair = [older.id, newer.id];
    const seen = { [older.id]: older.updatedAt, [newer.id]: newer.updatedAt };
    row.appendChild(this.choose(row, book, [["Keep the older", { pair, seen, keep: [older.id] }], ["Keep the newer", { pair, seen, keep: [newer.id] }], ["Both are true", { pair, seen, keep: pair }], ["Neither", { pair, seen, keep: [] }]]));
    return row;
  }

  private passed(book: Book, f: Fact, on: string): HTMLElement {
    const row = el("div", "routine");
    row.dataset.facts = f.id;
    row.append(this.said(book, f, "Saved"), el("div", "rfacts", `Its day has passed: ${day(`${on}T12:00:00Z`)}.`));
    row.appendChild(this.choose(row, book, [["Still true", { id: f.id, keep: true, seen: { [f.id]: f.updatedAt } }], ["Forget it", { id: f.id, keep: false, seen: { [f.id]: f.updatedAt } }]]));
    return row;
  }
}
