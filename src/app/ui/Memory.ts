import { authHeaders } from "../key";
import { ago, arm, esc } from "./util";
import { SectionMenu, type NavGroup } from "./sections";

/**
 * What Jarvis remembers, where the owner can see it.
 *
 * Facts arrive by voice, which makes them easy to save and impossible to
 * audit: a misheard name or a stale address sits there quietly shaping every
 * answer. This panel lists them, adds one, and forgets one — one fact per
 * request, never a replace-all, so a fact saved by voice while the panel is
 * open cannot be overwritten by what the page loaded earlier.
 *
 * Laid out as Settings is (sections.ts): each kind of fact, yours and the
 * family's, is a section of its own in the menu, and so are adding, finding,
 * what Jarvis reads, and what was forgotten.
 *
 * Every fact is text somebody said, so all of it goes through esc().
 */

interface Fact {
  id: string;
  text: string;
  kind: string;
  slug?: string;
  address?: string;
  updatedAt: number;
  lastUsedAt?: number;
  useCount: number;
  pinned?: boolean;
  source: "voice" | "ui";
}

interface Loaded {
  facts: Fact[];
  trash: Fact[];
  count: number;
  cap: number;
  profile: { chars: number; used: number; budget: number; listed: number; text: string };
}

interface Hit {
  id: string;
  score: number;
}

/** Whose: this person's own memory, or the family's shared one (lib/context.ts). */
type Book = "mine" | "family";

/** Display order, and what each kind is called in the menu. */
const KINDS: [string, string][] = [
  ["place", "Places"],
  ["person", "People"],
  ["preference", "Preferences"],
  ["vehicle", "The car"],
  ["routine", "Routines"],
  ["note", "Notes"],
  ["reference", "Reference"],
];

const BOOK_NOTE: Record<Book, string> = {
  mine: "Only you see these. Tell Jarvis “remember that…”, or add one under Remember something.",
  family: "Everyone in the family sees these, and adults can change them. Say “remember for the family that…”.",
};

const REMEMBER = "jarvis.memory.section";

export class Memory {
  private el: HTMLElement;
  private key: string;
  private menu: SectionMenu;
  private data: Record<Book, Loaded | null> = { mine: null, family: null };
  /** The last Test recall, ranked, from each book; null when not testing. */
  private hits: { book: Book; hit: Hit }[] | null = null;
  /** Whether there is a family memory to show at all. */
  private hasFamily = false;

  constructor(key: string) {
    this.key = key;
    this.el = document.createElement("div");
    this.el.id = "memory";
    this.el.className = "panel";
    this.el.innerHTML = `
      <div class="sheet setsheet">
        <header>
          <button class="back" type="button">‹ Memory</button>
          <h2>Memory</h2>
          <button class="close" aria-label="Close">Done</button>
        </header>
        <div class="setwrap">
          <nav class="setnav" aria-label="Memory sections"></nav>
          <div class="setbody">
            <div class="msg"></div>
            <div class="kinds"></div>

            <section class="svc" data-section="add" data-title="Remember something">
              <h3>Remember something</h3>
              <p class="note">One short sentence. Reference material (rosters, directories) is only looked up
                when asked; everything else rides along on every request.</p>
              <select class="fbook" hidden>
                <option value="mine">For me</option>
                <option value="family">For the family</option>
              </select>
              <input class="ftext" type="text" maxlength="240"
                     placeholder="e.g. I prefer the cabin at 21°">
              <div class="addrow">
                <select class="fkind">
                  ${KINDS.map(([k, label]) => `<option value="${k}"${k === "note" ? " selected" : ""}>${label}</option>`).join("")}
                </select>
                <label class="on fpin"><input type="checkbox"> keep forever</label>
              </div>
              <div class="named">
                <input class="fname" type="text" maxlength="60" placeholder="what you call it, e.g. home">
                <input class="faddr" type="text" maxlength="300" placeholder="full street address">
              </div>
              <div class="rowbtns"><button class="save primary">Remember</button></div>
            </section>

            <section class="svc" data-section="find" data-title="Find and test recall">
              <h3>Find and test recall</h3>
              <p class="note">Type to find a fact. Test recall shows what Jarvis would bring to mind for a
                question, best first, without counting it as a use.</p>
              <div class="find">
                <input class="q" type="text" placeholder="a word, or a question like “how long to the office”">
                <button class="probe">Test recall</button>
              </div>
              <div class="found"></div>
            </section>

            <section class="svc" data-section="reads" data-title="What Jarvis reads">
              <h3>What Jarvis reads</h3>
              <p class="note">The summary that goes with every question you ask, so it is kept short.
                What does not fit is still found by searching.</p>
              <div class="gauge">
                <span class="count"></span>
                <div class="bar"><i></i></div>
                <span class="budget"></span>
              </div>
              <pre class="profile"></pre>
            </section>

            <section class="svc" data-section="trash" data-title="Recently forgotten">
              <h3>Recently forgotten</h3>
              <div class="gonelist"></div>
            </section>
          </div>
        </div>
      </div>`;
    document.body.appendChild(this.el);
    this.menu = new SectionMenu(this.$(".sheet"), REMEMBER);

    this.el.querySelector(".close")!.addEventListener("click", () => this.hide());
    this.el.querySelector(".save")!.addEventListener("click", () => void this.add());
    this.el.querySelector(".ftext")!.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") void this.add();
    });
    this.el.querySelector(".fkind")!.addEventListener("change", () => this.shapeForm());
    this.el.querySelector(".probe")!.addEventListener("click", () => void this.probe());
    const q = this.$<HTMLInputElement>(".q");
    q.addEventListener("input", () => {
      this.hits = null;
      this.renderFound();
    });
    q.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.probe();
    });
    this.el.addEventListener("click", (e) => {
      if (e.target === this.el) this.hide();
    });
    this.shapeForm();
  }

  async show(): Promise<void> {
    this.el.classList.add("open");
    this.menu.toList();
    this.msg("");
    // Is there a family memory? Only with a family, and for someone who may read memory.
    this.hasFamily = await fetch("/api/memory?book=family", { headers: authHeaders(this.key) }).then((r) => r.ok).catch(() => false);
    this.$(".fbook").hidden = !this.hasFamily;
    await this.load();
  }

  /** A memory route for a book. */
  private path(p: string, book: Book): string {
    return book === "family" ? `${p}?book=family` : p;
  }

  hide(): void {
    this.el.classList.remove("open");
  }

  // Unconstrained: the Worker's types define a global Element of their own,
  // which HTMLSelectElement does not satisfy.
  private $<T = HTMLElement>(sel: string): T {
    return this.el.querySelector(sel) as T;
  }

  private msg(text: string, bad = false): void {
    const m = this.$(".msg");
    m.textContent = text;
    m.classList.toggle("bad", bad);
  }

  /** A name for places and people, an address for places, pinning for all but reference. */
  private shapeForm(): void {
    const kind = this.$<HTMLSelectElement>(".fkind").value;
    const named = kind === "place" || kind === "person";
    this.$(".named").hidden = !named;
    this.$(".faddr").hidden = kind !== "place";
    this.$(".fpin").hidden = kind === "reference";
  }

  private async fetchBook(book: Book): Promise<Loaded> {
    const res = await fetch(this.path("/api/memory", book), { headers: authHeaders(this.key) });
    if (!res.ok) throw new Error(`memory ${res.status}`);
    return (await res.json()) as Loaded;
  }

  private async load(): Promise<void> {
    try {
      const [mine, family] = await Promise.all([this.fetchBook("mine"), this.hasFamily ? this.fetchBook("family") : null]);
      this.data = { mine, family };
      this.render();
    } catch (e) {
      this.msg(`Could not load memory: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  private async add(): Promise<void> {
    const text = this.$<HTMLInputElement>(".ftext").value.trim();
    if (!text) {
      this.msg("Type the fact first — one short sentence.", true);
      return;
    }
    const book: Book = this.hasFamily && this.$<HTMLSelectElement>(".fbook").value === "family" ? "family" : "mine";
    const kind = this.$<HTMLSelectElement>(".fkind").value;
    const name = this.$<HTMLInputElement>(".fname").value.trim();
    const address = this.$<HTMLInputElement>(".faddr").value.trim();
    if (kind === "place" && (!name || !address)) {
      this.msg("A place needs what you call it and its address, so directions can use it.", true);
      return;
    }
    const pinned = this.$<HTMLInputElement>(".fpin input").checked;

    this.msg("Saving…");
    try {
      const res = await fetch(this.path("/api/memory", book), {
        method: "POST",
        headers: authHeaders(this.key),
        body: JSON.stringify({ text, kind, name, address, pinned }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; replaced?: Fact | null };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `status ${res.status}`);

      for (const sel of [".ftext", ".fname", ".faddr"]) this.$<HTMLInputElement>(sel).value = "";
      this.$<HTMLInputElement>(".fpin input").checked = false;
      this.msg(body.replaced ? `Updated what was there: “${body.replaced.text}”.` : `Saved, under ${KINDS.find(([k]) => k === kind)?.[1] ?? "Notes"}.`);
      await this.load();
    } catch (e) {
      // The server's reasons already say "not saved" when they need to.
      const why = e instanceof Error ? e.message : String(e);
      this.msg(/not saved/i.test(why) ? why[0]!.toUpperCase() + why.slice(1) : `Not saved: ${why}`, true);
    }
  }

  private async forget(f: Fact, book: Book): Promise<void> {
    try {
      const res = await fetch(this.path("/api/memory", book), {
        method: "DELETE",
        headers: authHeaders(this.key),
        body: JSON.stringify({ id: f.id }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `status ${res.status}`);
      if (this.hits) this.hits = this.hits.filter((h) => h.hit.id !== f.id);
      this.msg(`Forgot “${f.text}”.`);
      await this.load();
    } catch (e) {
      this.msg(`That did not work: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  /**
   * Change a fact where it is: its words, and a place's or person's name (and a
   * place's address). One fact, by its id (PATCH), so nothing else is touched.
   */
  private editIn(el: HTMLElement, f: Fact, book: Book): void {
    if (el.querySelector(".fedit")) return;
    const named = f.kind === "place" || f.kind === "person";
    const form = document.createElement("div");
    form.className = "fedit";
    form.innerHTML = `
      <input type="text" class="etext" maxlength="240" value="${esc(f.text)}" aria-label="What Jarvis remembers">
      ${named ? `<input type="text" class="ename" maxlength="60" value="${esc(f.slug ?? "")}" placeholder="${f.kind === "place" ? "What you call it, e.g. home" : "Their name"}" aria-label="Name">` : ""}
      ${f.kind === "place" ? `<input type="text" class="eaddr" maxlength="300" value="${esc(f.address ?? "")}" placeholder="Its full address" aria-label="Address">` : ""}
      <div class="rowbtns"><button class="primary esave">Save</button><button class="ecancel">Cancel</button></div>`;
    // Hidden by style: .rowbtns sets display, which would win over the hidden attribute.
    const shown = [...el.children] as HTMLElement[];
    for (const c of shown) c.style.display = "none";
    el.appendChild(form);
    const close = () => {
      form.remove();
      for (const c of shown) c.style.display = "";
    };
    form.querySelector(".ecancel")!.addEventListener("click", close);
    form.querySelector(".esave")!.addEventListener("click", () => void this.edit(f, book, form));
    form.querySelector<HTMLInputElement>(".etext")!.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.edit(f, book, form);
      if (e.key === "Escape") close();
    });
    form.querySelector<HTMLInputElement>(".etext")!.focus();
  }

  private async edit(f: Fact, book: Book, form: HTMLElement): Promise<void> {
    const text = form.querySelector<HTMLInputElement>(".etext")!.value.trim();
    const name = form.querySelector<HTMLInputElement>(".ename")?.value.trim();
    const address = form.querySelector<HTMLInputElement>(".eaddr")?.value.trim();
    if (!text) {
      this.msg("Say what it is, or Forget it instead.", true);
      return;
    }
    if (f.kind === "place" && (!name || !address)) {
      this.msg("A place needs what you call it and its address, so directions can use it.", true);
      return;
    }
    this.msg("Saving…");
    try {
      const res = await fetch(this.path("/api/memory", book), {
        method: "PATCH",
        headers: authHeaders(this.key),
        body: JSON.stringify({ id: f.id, text, ...(name === undefined ? {} : { name }), ...(address === undefined ? {} : { address }) }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `status ${res.status}`);
      this.msg(`Changed to “${text}”.`);
      await this.load();
    } catch (e) {
      this.msg(`Not changed: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  /** From this person's memory to the family's, or back (routes/memory.ts). */
  private async move(f: Fact, from: Book): Promise<void> {
    const to = from === "family" ? "mine" : "family";
    try {
      const res = await fetch("/api/memory/move", {
        method: "POST",
        headers: authHeaders(this.key),
        body: JSON.stringify({ id: f.id, to }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `status ${res.status}`);
      this.msg(to === "family" ? `Moved to the family's: “${f.text}”.` : `Moved to yours: “${f.text}”.`);
      await this.load();
    } catch (e) {
      this.msg(`That did not work: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  /**
   * Run the query through the same ranking the `recall` tool uses, in each
   * book, as Jarvis looks in both. The server does not count it as a use, so
   * probing never reshuffles what Jarvis carries.
   */
  private async probe(): Promise<void> {
    const query = this.$<HTMLInputElement>(".q").value.trim();
    if (!query) {
      this.msg("Type a question, e.g. “how long to the office”.", true);
      return;
    }
    const books: Book[] = this.hasFamily ? ["mine", "family"] : ["mine"];
    try {
      const found = await Promise.all(
        books.map(async (book) => {
          const res = await fetch(this.path("/api/memory/search", book), {
            method: "POST",
            headers: authHeaders(this.key),
            body: JSON.stringify({ query }),
          });
          const body = (await res.json()) as { hits?: Hit[]; error?: string };
          if (!res.ok) throw new Error(body.error ?? `status ${res.status}`);
          return (body.hits ?? []).map((hit) => ({ book, hit }));
        }),
      );
      this.hits = found.flat().sort((a, b) => b.hit.score - a.hit.score);
      this.msg("");
      this.renderFound();
    } catch (e) {
      this.msg(`Could not test it: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  private row(f: Fact, book: Book, extra: string[] = []): string {
    const meta = [
      ...extra,
      f.slug ? `<code>${esc(f.slug)}</code>` : "",
      f.address ? esc(f.address) : "",
      f.pinned ? `<span class="pin">kept forever</span>` : "",
      f.source === "ui" ? "added here" : "by voice",
      `updated ${ago(f.updatedAt)}`,
      f.useCount ? `used ${f.useCount}×` : "never used",
    ].filter(Boolean);
    return `
      <div class="fact" data-id="${esc(f.id)}" data-book="${book}">
        <div class="ftxt">${esc(f.text)}</div>
        <div class="meta">${meta.join(" · ")}</div>
        <div class="rowbtns">
          <button class="edit">Edit</button>
          ${this.hasFamily ? `<button class="move">${book === "family" ? "Move to mine" : "Move to the family's"}</button>` : ""}
          <button class="forget">Forget</button>
        </div>
      </div>`;
  }

  /** Edit, Forget and Move on every row under `box`. */
  private armRows(box: HTMLElement): void {
    for (const el of box.querySelectorAll<HTMLElement>(".fact")) {
      const book: Book = el.dataset.book === "family" ? "family" : "mine";
      const f = this.data[book]?.facts.find((x) => x.id === el.dataset.id);
      if (!f) continue;
      arm(el.querySelector<HTMLButtonElement>(".forget")!, "Forget it?", () => this.forget(f, book));
      el.querySelector(".move")?.addEventListener("click", () => void this.move(f, book));
      el.querySelector(".edit")?.addEventListener("click", () => this.editIn(el, f, book));
    }
  }

  /** Each kind in each book, as a section; the tools after them. */
  private render(): void {
    const books: Book[] = this.hasFamily ? ["mine", "family"] : ["mine"];
    const groups: NavGroup[] = [];
    let html = "";
    for (const book of books) {
      const d = this.data[book];
      if (!d) continue;
      const ids: string[] = [];
      for (const [kind, label] of KINDS) {
        const facts = d.facts
          .filter((f) => f.kind === kind)
          .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
        if (!facts.length) continue;
        const id = `${book}:${kind}`;
        ids.push(id);
        html += `
          <section class="svc" data-section="${id}" data-title="${esc(label)}" data-aside="${facts.length}">
            <div class="svchead"><h3>${esc(label)}</h3><span class="chip">${book === "family" ? "the family's" : "yours"}</span></div>
            <p class="note">${BOOK_NOTE[book]}</p>
            ${facts.map((f) => this.row(f, book)).join("")}
          </section>`;
      }
      if (!ids.length) {
        const id = `${book}:none`;
        ids.push(id);
        html += `
          <section class="svc" data-section="${id}" data-title="Nothing yet">
            <h3>${book === "family" ? "The family's" : "Yours"}</h3>
            <p class="note">Nothing saved yet. ${BOOK_NOTE[book]}</p>
          </section>`;
      }
      groups.push([book === "family" ? "The family's" : "Yours", ids]);
    }
    const kinds = this.$(".kinds");
    kinds.innerHTML = html;
    this.armRows(kinds);

    this.renderReads();
    this.renderFound();
    const gone = books.flatMap((b) => (this.data[b]?.trash ?? []).map((f) => ({ f, b })));
    this.$(".setbody [data-section=trash]").dataset.aside = String(gone.length);
    this.$(".gonelist").innerHTML = gone.length
      ? gone.map(({ f, b }) => `<div class="gone">${esc(f.text)}${this.hasFamily && b === "family" ? ` <span class="dim">the family's</span>` : ""}</div>`).join("")
      : `<p class="note">Nothing forgotten lately.</p>`;

    groups.push(["Add and check", ["add", "find", "reads", "trash"]]);
    this.menu.build(groups, groups[0]?.[1][0] ?? "add");
  }

  /** The summary that rides on every request: yours, with the family's attached. */
  private renderReads(): void {
    const d = this.data.mine;
    if (!d) return;
    const hot = d.facts.filter((f) => f.kind !== "reference").length;
    this.$(".count").textContent = `${hot} of ${d.cap} saved` + (d.facts.length > hot ? ` · ${d.facts.length - hot} reference` : "");
    // The budget bounds the fact lines, not the block's fixed header.
    const pct = Math.min(100, Math.round((d.profile.used / d.profile.budget) * 100));
    const left = hot - d.profile.listed;
    this.$<HTMLElement>(".bar i").style.width = `${pct}%`;
    this.$(".bar").classList.toggle("full", left > 0);
    this.$(".budget").textContent =
      `${d.profile.listed} of ${hot} in the summary · ${d.profile.used} / ${d.profile.budget} characters` +
      (left > 0 ? ` · ${left} found only by searching` : "");
    this.$(".profile").textContent = d.profile.text || "(nothing yet)";
  }

  /** What the find box turns up: a test recall, ranked, or facts containing the words. */
  private renderFound(): void {
    const box = this.$(".found");
    const q = this.$<HTMLInputElement>(".q").value.trim().toLowerCase();
    const label = (b: Book) => (this.hasFamily ? [b === "family" ? "the family's" : "yours"] : []);
    if (this.hits) {
      const rows = this.hits
        .map(({ book, hit }) => {
          const f = this.data[book]?.facts.find((x) => x.id === hit.id);
          return f ? this.row(f, book, [...label(book), `score ${hit.score}`]) : "";
        })
        .join("");
      box.innerHTML = rows ? `<h4>Jarvis would recall, best first</h4>${rows}` : `<p class="note">Nothing saved matches that: Jarvis would not recall anything.</p>`;
    } else if (q) {
      const books: Book[] = this.hasFamily ? ["mine", "family"] : ["mine"];
      const match = (f: Fact) => [f.text, f.slug ?? "", f.address ?? ""].some((s) => s.toLowerCase().includes(q));
      const rows = books
        .flatMap((book) => (this.data[book]?.facts ?? []).filter(match).map((f) => this.row(f, book, label(book))))
        .join("");
      box.innerHTML = rows || `<p class="note">Nothing contains that.</p>`;
    } else {
      box.innerHTML = "";
    }
    this.armRows(box);
  }
}
