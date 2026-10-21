import { api } from "../key";
import { button, el } from "./util";

/**
 * Search, from Chat (POST /api/hub/search, lib/search.ts): what you and
 * Jarvis said, what it remembers and your mail, at once, grouped as Hark's
 * search has them: Top hit, Messages, Memory, Mail. By words only, so it costs
 * nothing. Searched on Enter, not as you type, which would ask Gmail every
 * letter. A message found is shown in the chat, a routine's or a job's opens
 * it; a mail opens in Gmail. Everything is text, never HTML: subjects and
 * snippets are written by whoever sent them.
 */

interface MessageHit { id: string; at: number; role: "user" | "assistant"; text: string; routine?: string; job?: string }
interface FactHit { id: string; text: string; kind: string; family?: boolean }
interface MailHit { id: string; from: string; subject: string; at: number; unread: boolean; snippet: string }
type Hit = { kind: "message"; hit: MessageHit } | { kind: "fact"; hit: FactHit } | { kind: "mail"; hit: MailHit };
interface Found { top: Hit | null; messages: MessageHit[]; memory: FactHit[] | null; mail: MailHit[] | null; mailNote?: string }

export interface SearchOpen {
  /** A message of the conversation, by its id: shown in the chat. */
  message(id: string): void;
  routine(id: string): void;
  job(id: string): void;
}

const when = (at: number) => new Date(at).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export class Search {
  private key: string;
  private open: SearchOpen;
  private el: HTMLElement;
  private box: HTMLInputElement;
  private list: HTMLElement;

  constructor(key: string, open: SearchOpen) {
    this.key = key;
    this.open = open;
    this.el = el("div", "panel");
    this.el.id = "search";
    const sheet = el("div", "sheet");
    const head = el("header", "");
    head.append(el("h2", "", "Search"), button("Done", () => this.hide(), "close"));
    const form = el("div", "rform");
    this.box = document.createElement("input");
    this.box.type = "search";
    this.box.placeholder = "Messages, memory and mail";
    this.box.setAttribute("aria-label", "Search messages, memory and mail");
    this.box.enterKeyHint = "search";
    this.box.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.find();
    });
    form.appendChild(this.box);
    this.list = el("div", "rlist");
    sheet.append(head, form, this.list);
    this.el.appendChild(sheet);
    document.body.appendChild(this.el);
    this.el.addEventListener("click", (e) => {
      if (e.target === this.el) this.hide();
    });
  }

  show(): void {
    this.el.classList.add("open");
    this.box.focus();
  }

  hide(): void {
    this.el.classList.remove("open");
  }

  private async find(): Promise<void> {
    const q = this.box.value.trim();
    if (q.length < 2) return;
    this.list.replaceChildren(el("p", "note", "Looking…"));
    let f: Found;
    try {
      f = (await api(this.key, "POST", "/api/hub/search", { q })) as Found;
    } catch (e) {
      this.list.replaceChildren(el("p", "warn", e instanceof Error ? e.message : String(e)));
      return;
    }
    const out: HTMLElement[] = [];
    if (f.top) out.push(el("h3", "", "Top hit"), this.row(f.top));
    const group = (title: string, kind: Hit["kind"], hits: Hit[] | null, note?: string) => {
      // Not offered them, or the top hit was all there was of them.
      if (hits === null || (!hits.length && !note && f.top?.kind === kind)) return;
      out.push(el("h3", "", title));
      if (note) out.push(el("p", "note", note));
      out.push(...(hits.length ? hits.map((h) => this.row(h)) : [el("p", "note", "Nothing.")]));
    };
    group("Messages", "message", f.messages.map((hit) => ({ kind: "message", hit })));
    group("Memory", "fact", f.memory && f.memory.map((hit) => ({ kind: "fact", hit })));
    group("Mail", "mail", f.mail && f.mail.map((hit) => ({ kind: "mail", hit })), f.mailNote);
    this.list.replaceChildren(...out);
  }

  /** One thing found: what it is, and pressed, where it is. */
  private row(h: Hit): HTMLElement {
    const row = el("div", "routine found");
    const top = el("div", "rtop");
    let go: (() => void) | null = null;
    if (h.kind === "message") {
      const m = h.hit;
      top.append(el("b", "", m.role === "user" ? "You" : "Jarvis"), el("small", "", when(m.at)));
      row.append(top, el("div", "rwhen", m.text));
      go = () => (m.routine ? this.open.routine(m.routine) : m.job ? this.open.job(m.job) : this.open.message(m.id));
    } else if (h.kind === "fact") {
      top.append(el("b", "", h.hit.kind), el("small", "", h.hit.family ? "the family's" : "yours"));
      row.append(top, el("div", "rwhen", h.hit.text));
    } else {
      const m = h.hit;
      top.append(el("b", "", `${m.unread ? "● " : ""}${m.from}`), el("small", "", m.at ? when(m.at) : ""));
      row.append(top, el("div", "rwhen", m.subject), el("div", "rfacts", m.snippet));
      go = () => window.open(`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(m.id)}`, "_blank", "noopener");
    }
    if (go) {
      const act = go;
      row.classList.add("go");
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.addEventListener("click", () => {
        if (h.kind === "message") this.hide();
        act();
      });
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter") row.click();
      });
    }
    return row;
  }
}
