import { authHeaders } from "../key";
import { ago, arm, esc } from "./util";

/**
 * What Jarvis remembers, where the owner can see it.
 *
 * Facts arrive by voice, which makes them easy to save and impossible to
 * audit: a misheard name or a stale address sits there quietly shaping every
 * answer. This panel lists them, adds one, and forgets one — one fact per
 * request, never a replace-all, so a fact saved by voice while the panel is
 * open cannot be overwritten by what the page loaded earlier.
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
  profile: { chars: number; budget: number; text: string };
}

interface Hit {
  id: string;
  score: number;
}

/** Display order, and what each kind is called in the list. */
const KINDS: [string, string][] = [
  ["place", "Places"],
  ["person", "People"],
  ["preference", "Preferences"],
  ["vehicle", "The car"],
  ["routine", "Routines"],
  ["note", "Notes"],
  ["reference", "Reference"],
];

export class Memory {
  private el: HTMLElement;
  private list: HTMLElement;
  private key: string;
  private data: Loaded | null = null;
  /** The last Test recall, ranked; null when showing the plain list. */
  private hits: Hit[] | null = null;

  constructor(key: string) {
    this.key = key;
    this.el = document.createElement("div");
    this.el.id = "memory";
    this.el.className = "panel";
    this.el.innerHTML = `
      <div class="sheet">
        <header>
          <h2>Memory</h2>
          <button class="close" aria-label="Close">Done</button>
        </header>
        <p class="note">
          What Jarvis knows about you. Tell it “remember that…” while driving, or add
          something here. Reference material (rosters, directories) is only looked up
          when asked; everything else rides along on every request.
        </p>

        <div class="gauge">
          <span class="count"></span>
          <div class="bar"><i></i></div>
          <span class="budget"></span>
        </div>
        <details class="profile">
          <summary>What Jarvis reads on every request</summary>
          <pre></pre>
        </details>

        <div class="add">
          <input class="ftext" type="text" maxlength="240"
                 placeholder="one short sentence, e.g. I prefer the cabin at 21°">
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
          <button class="save primary">Remember</button>
        </div>

        <div class="find">
          <input class="q" type="text" placeholder="filter, or test what a question would recall">
          <button class="probe">Test recall</button>
        </div>
        <div class="msg"></div>
        <div class="list"></div>

        <details class="trash">
          <summary>Recently forgotten</summary>
          <div></div>
        </details>
      </div>`;
    document.body.appendChild(this.el);
    this.list = this.el.querySelector(".list")!;

    this.el.querySelector(".close")!.addEventListener("click", () => this.hide());
    this.el.querySelector(".save")!.addEventListener("click", () => void this.add());
    this.el.querySelector(".ftext")!.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") void this.add();
    });
    this.el.querySelector(".fkind")!.addEventListener("change", () => this.shapeForm());
    this.el.querySelector(".probe")!.addEventListener("click", () => void this.probe());
    const q = this.el.querySelector<HTMLInputElement>(".q")!;
    q.addEventListener("input", () => {
      this.hits = null;
      this.render();
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
    this.msg("");
    await this.load();
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

  private async load(): Promise<void> {
    try {
      const res = await fetch("/api/memory", { headers: authHeaders(this.key) });
      if (!res.ok) throw new Error(`memory ${res.status}`);
      this.data = (await res.json()) as Loaded;
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
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: authHeaders(this.key),
        body: JSON.stringify({ text, kind, name, address, pinned }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; replaced?: Fact | null };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `status ${res.status}`);

      for (const sel of [".ftext", ".fname", ".faddr"]) this.$<HTMLInputElement>(sel).value = "";
      this.$<HTMLInputElement>(".fpin input").checked = false;
      this.msg(body.replaced ? `Updated what was there: “${body.replaced.text}”.` : "Saved.");
      await this.load();
    } catch (e) {
      // The server's reasons already say "not saved" when they need to.
      const why = e instanceof Error ? e.message : String(e);
      this.msg(/not saved/i.test(why) ? why[0]!.toUpperCase() + why.slice(1) : `Not saved: ${why}`, true);
    }
  }

  private async forget(f: Fact): Promise<void> {
    try {
      const res = await fetch("/api/memory", {
        method: "DELETE",
        headers: authHeaders(this.key),
        body: JSON.stringify({ id: f.id }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `status ${res.status}`);
      if (this.hits) this.hits = this.hits.filter((h) => h.id !== f.id);
      this.msg(`Forgot “${f.text}”.`);
      await this.load();
    } catch (e) {
      this.msg(`That did not work: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  /**
   * Run the query through the same ranking the `recall` tool uses. The server
   * does not count it as a use, so probing never reshuffles what Jarvis carries.
   */
  private async probe(): Promise<void> {
    const query = this.$<HTMLInputElement>(".q").value.trim();
    if (!query) {
      this.msg("Type a question, e.g. “how long to the office”.", true);
      return;
    }
    try {
      const res = await fetch("/api/memory/search", {
        method: "POST",
        headers: authHeaders(this.key),
        body: JSON.stringify({ query }),
      });
      const body = (await res.json()) as { hits?: Hit[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `status ${res.status}`);
      this.hits = body.hits ?? [];
      this.msg(this.hits.length ? "" : "Nothing saved matches that — Jarvis would not recall anything.");
      this.render();
    } catch (e) {
      this.msg(`Could not test it: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  private row(f: Fact, score?: number): string {
    const meta = [
      f.slug ? `<code>${esc(f.slug)}</code>` : "",
      f.address ? esc(f.address) : "",
      f.pinned ? `<span class="pin">kept forever</span>` : "",
      f.source === "ui" ? "added here" : "by voice",
      `updated ${ago(f.updatedAt)}`,
      f.useCount ? `used ${f.useCount}×` : "never used",
      score !== undefined ? `score ${score}` : "",
    ].filter(Boolean);
    return `
      <div class="fact" data-id="${esc(f.id)}">
        <div class="ftxt">${esc(f.text)}</div>
        <div class="meta">${meta.join(" · ")}</div>
        <button class="forget">Forget</button>
      </div>`;
  }

  private render(): void {
    const d = this.data;
    if (!d) return;

    const hot = d.facts.filter((f) => f.kind !== "reference").length;
    this.$(".count").textContent = `${hot} of ${d.cap} saved` +
      (d.facts.length > hot ? ` · ${d.facts.length - hot} reference` : "");
    const pct = Math.min(100, Math.round((d.profile.chars / d.profile.budget) * 100));
    this.$<HTMLElement>(".bar i").style.width = `${pct}%`;
    this.$(".bar").classList.toggle("full", pct >= 100);
    this.$(".budget").textContent = `${d.profile.chars} / ${d.profile.budget} characters per request`;
    this.$(".profile pre").textContent = d.profile.text || "(nothing yet)";

    const byId = new Map(d.facts.map((f) => [f.id, f]));
    let html = "";

    if (this.hits) {
      const found = this.hits.filter((h) => byId.has(h.id));
      html = found.length
        ? `<h3>Jarvis would recall, best first</h3>` +
          found.map((h) => this.row(byId.get(h.id)!, h.score)).join("")
        : "";
    } else {
      const q = this.$<HTMLInputElement>(".q").value.trim().toLowerCase();
      const match = (f: Fact) =>
        !q || [f.text, f.slug ?? "", f.address ?? ""].some((s) => s.toLowerCase().includes(q));
      for (const [kind, label] of KINDS) {
        const facts = d.facts.filter((f) => f.kind === kind && match(f));
        if (!facts.length) continue;
        const rows = facts
          .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt)
          .map((f) => this.row(f))
          .join("");
        const head = `${label} <span class="dim">${facts.length}</span>`;
        // Reference can run to hundreds; fold it away unless a filter is looking in it.
        html += kind === "reference"
          ? `<details class="ref"${q ? " open" : ""}><summary>${head}</summary>${rows}</details>`
          : `<h3>${head}</h3>${rows}`;
      }
      if (!html) {
        html = `<p class="note">${q ? "Nothing matches that filter." : "Nothing saved yet."}</p>`;
      }
    }
    this.list.innerHTML = html;

    for (const el of this.list.querySelectorAll<HTMLElement>(".fact")) {
      const f = byId.get(el.dataset.id!);
      if (f) arm(el.querySelector<HTMLButtonElement>(".forget")!, "Forget it?", () => this.forget(f));
    }

    const trash = this.$(".trash");
    trash.hidden = !d.trash.length;
    trash.querySelector("summary")!.textContent = `Recently forgotten (${d.trash.length})`;
    trash.querySelector("div")!.innerHTML = d.trash
      .map((f) => `<div class="gone">${esc(f.text)}</div>`)
      .join("");
  }
}
