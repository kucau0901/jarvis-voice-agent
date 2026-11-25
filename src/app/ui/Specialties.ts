import { api } from "../key";
import { settle, type ProposalView } from "../proposal";
import { sizeSaid } from "../jobWords";
import { toB64u } from "../passkey";
import { saveFrom } from "./JobFiles";
import { arm, button, el } from "./util";

/**
 * Memory → Specialties: ways of doing something, kept to be done the same way
 * again (src/worker/lib/specialties.ts, lib/specialty-more.ts). Saved from an
 * answer by asking, kept from a job, written here, or chosen from a file. Each
 * may be changed in a form, put back as it was, taken elsewhere, or forgotten.
 *
 * Built with textContent throughout: one may be someone else's words.
 */

interface WayFile { n: number; name: string; size: number }
interface Way {
  id: string;
  updatedAt: number;
  name: string;
  when: string[];
  steps: string[];
  why?: string;
  source: "answer" | "learned" | "written" | "imported";
  more: boolean;
  files: WayFile[];
  before: number;
}
interface Before { at: number; name: string; steps: string[]; text?: string; files: WayFile[] }
interface Whole { specialty: Way; source: Way["source"]; text?: string; files: WayFile[]; before: Before[] }

/** What the form holds: one kept, by its id, or a new one. */
export interface WayDraft {
  id?: string;
  name: string;
  when: string[];
  steps: string[];
  why?: string;
  text: string;
  /** Kept already, by number; or new, its bytes (base64url). */
  files: ({ n: number; name: string; size: number } | { name: string; data: string })[];
  notes: string[];
  source?: "written" | "imported" | "learned";
  /** The card this came from, answered when it is saved here (proposal.ts), and what it would change as it stood then. */
  card?: string;
  at?: number;
  add?: string[];
}

const SOURCE: Record<Way["source"], string> = { answer: "from an answer", learned: "from a job", written: "written", imported: "from a file" };

const day = (at: number) => new Date(at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A new file's words, to be read before it is kept; null when it is not text. */
function textOf(data: string): string | null {
  const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

export class Specialties {
  private key: string;
  private box: HTMLElement;
  private list = el("div", "rlist");
  private form = el("div", "");
  private msg = el("div", "msg");
  private top = el("div", "rowbtns");
  private count: (n: number) => void;
  private draft: WayDraft | null = null;
  /** Whether what is open has been typed in since. */
  private touched = false;
  /** Earlier versions shown, by id. */
  private open = new Set<string>();
  private may = { files: false, importing: false };

  /** `count`: told how many there are, for the menu. */
  constructor(key: string, box: HTMLElement, count: (n: number) => void) {
    this.key = key;
    this.box = box;
    this.count = count;
    const pick = document.createElement("input");
    pick.type = "file";
    pick.accept = ".md,.zip,text/markdown,application/zip";
    pick.hidden = true;
    pick.addEventListener("change", () => {
      const f = pick.files?.[0];
      pick.value = "";
      if (f) void this.import(f);
    });
    const bring = button("Import a file…", () => pick.click());
    bring.dataset.importing = "";
    this.top.append(button("New", () => this.edit({ name: "", when: [], steps: [], text: "", files: [], notes: [] })), bring, pick);
    this.msg.setAttribute("role", "status");
    this.box.replaceChildren(this.top, this.msg, this.form, this.list);
  }

  private say(text: string, bad = false): void {
    this.msg.textContent = text;
    this.msg.classList.toggle("bad", bad);
  }

  /** What this person may do here: asked before anything is drawn that depends on it. */
  private async known(): Promise<void> {
    const me = (await api(this.key, "GET", "/api/hub/me").catch(() => ({}))) as { workshop?: boolean; role?: string };
    this.may = { files: me.workshop === true, importing: me.role === "admin" };
    this.top.querySelector<HTMLElement>("[data-importing]")!.hidden = !this.may.importing;
  }

  async load(): Promise<void> {
    await this.known();
    let all: Way[];
    try {
      all = ((await api(this.key, "GET", "/api/memory/specialties")) as { specialties: Way[] }).specialties;
    } catch (e) {
      this.list.replaceChildren(el("p", "note", `Could not load them: ${why(e)}`));
      return;
    }
    this.count(all.length);
    this.list.replaceChildren(
      ...(all.length
        ? all.sort((a, b) => a.name.localeCompare(b.name)).map((w) => this.row(w))
        : [el("p", "note", "None yet. When an answer takes Jarvis a few steps, say “save this as” and a name; when you put a job right as it works, its result offers to keep that; or write one here.")]),
    );
  }

  private async act(fn: () => Promise<unknown>, done = ""): Promise<void> {
    try {
      await fn();
      this.say(done);
    } catch (e) {
      this.say(why(e), true);
    }
    await this.load();
  }

  private row(w: Way): HTMLElement {
    const row = el("div", "routine");
    const top = el("div", "rtop");
    top.append(el("b", "", w.name), el("span", "chip off", SOURCE[w.source]));
    row.appendChild(top);
    if (w.when.length) row.appendChild(el("div", "rwhen", `For: ${w.when.join(" · ")}`));
    if (w.steps.length) {
      const steps = el("ol", "rsteps");
      for (const s of w.steps) steps.appendChild(el("li", "", s));
      row.appendChild(steps);
    }
    if (w.why) row.appendChild(el("div", "rfacts", w.why));
    const has = [...(w.more ? ["notes for background jobs"] : []), ...(w.files.length ? [`${w.files.length} ${w.files.length === 1 ? "file" : "files"}`] : [])];
    if (has.length) row.appendChild(el("div", "rfacts", `With ${has.join(" and ")}`));
    const btns = el("div", "rowbtns");
    btns.append(
      button("Change", () => void this.change(w.id)),
      button("Export", () => void saveFrom(this.key, `/api/memory/specialties/export?id=${encodeURIComponent(w.id)}`, `${w.name.replace(/[^\p{L}\p{N} -]/gu, "").trim() || "specialty"}.zip`).catch((e) => this.say(why(e), true))),
    );
    if (w.before) {
      btns.appendChild(button(this.open.has(w.id) ? "Hide earlier" : "Earlier", () => {
        if (this.open.has(w.id)) this.open.delete(w.id);
        else this.open.add(w.id);
        void this.load();
      }));
    }
    const forget = button("Forget", () => {});
    arm(forget, "Forget it?", () => this.act(() => api(this.key, "DELETE", `/api/memory/specialties?id=${encodeURIComponent(w.id)}`), "Forgotten."));
    btns.appendChild(forget);
    row.appendChild(btns);
    if (this.open.has(w.id)) void this.earlier(w, row);
    return row;
  }

  /** What it was before it was changed, the newest first, each to put back. */
  private async earlier(w: Way, row: HTMLElement): Promise<void> {
    const box = el("div", "wayearlier");
    row.appendChild(box);
    try {
      const { before } = (await api(this.key, "GET", `/api/memory/specialties?id=${encodeURIComponent(w.id)}`)) as Whole;
      for (const b of before) {
        const was = el("details", "");
        const all = el("div", "jobtext", [...b.steps.map((s, i) => `${i + 1}. ${s}`), b.text ?? ""].filter(Boolean).join("\n"));
        was.append(el("summary", "", `Until ${day(b.at)}: ${b.name}`), all, button("Put this back", () => void this.act(() => api(this.key, "POST", "/api/memory/specialties/back", { id: w.id, at: b.at }), "Put back. What it was until now is under Earlier.")));
        box.appendChild(was);
      }
    } catch (e) {
      box.textContent = why(e);
    }
  }

  private async change(id: string): Promise<void> {
    try {
      const w = (await api(this.key, "GET", `/api/memory/specialties?id=${encodeURIComponent(id)}`)) as Whole;
      this.edit({ id, name: w.specialty.name, when: w.specialty.when, steps: w.specialty.steps, why: w.specialty.why, text: w.text ?? "", files: w.files, notes: [] });
    } catch (e) {
      this.say(why(e), true);
    }
  }

  private async import(f: File): Promise<void> {
    this.say("");
    try {
      const { draft } = (await api(this.key, "POST", "/api/memory/specialties/import", { name: f.name, data: toB64u(await f.arrayBuffer()) })) as { draft: WayDraft };
      this.edit({ ...draft, source: "imported", notes: ["Written elsewhere. Read all of it before you save it: background jobs follow it, and may run its files in the workshop.", ...draft.notes] });
    } catch (e) {
      this.say(`Not imported: ${why(e)}`, true);
    }
  }

  /** A finished job's way of doing it, in the form. */
  async fromJob(job: string): Promise<void> {
    try {
      await this.known();
      const { draft } = (await api(this.key, "GET", `/api/memory/specialties/draft?job=${encodeURIComponent(job)}`)) as { draft: WayDraft };
      const bare = !draft.steps.length && !draft.files.length;
      // Changing the one it used: what that holds besides stays.
      const was = draft.id ? ((await api(this.key, "GET", `/api/memory/specialties?id=${encodeURIComponent(draft.id)}`)) as Whole) : null;
      this.edit({ ...draft, text: was?.text ?? "", files: [...(was?.files ?? []).filter((f) => !draft.files.some((d) => d.name === f.name)), ...draft.files], source: "learned", notes: [...(bare ? ["You told that job nothing as it worked, so there is nothing to start from: write how you want it done."] : []), ...draft.notes] });
    } catch (e) {
      this.say(why(e), true);
    }
  }

  /** A card's draft, to be changed first (proposal.ts): of one kept already, with what that holds besides. */
  async fromCard(d: WayDraft): Promise<void> {
    try {
      await this.known();
      const was = d.id ? ((await api(this.key, "GET", `/api/memory/specialties?id=${encodeURIComponent(d.id)}`)) as Whole) : null;
      const text = was?.text ?? "";
      const files = was?.files ?? [];
      if (!was || was.specialty.updatedAt === d.at) return this.edit({ ...d, text, files });
      // Changed by hand since the card was made: as it stands, with what the card would add.
      const { name, when, steps, why } = was.specialty;
      this.edit({ ...d, name, when, steps: [...steps, ...(d.add ?? d.steps).filter((s) => !steps.includes(s))], why, text, files, notes: ["You changed this one after the card was made: here it is as it stands, with what the card would add."] });
    } catch (e) {
      this.say(why(e), true);
    }
  }

  /** The form, with this in it: nothing is kept until Save. Never over something half written. */
  edit(d: WayDraft): void {
    if (this.draft && this.touched) {
      this.form.scrollIntoView({ block: "start" });
      return this.say("Save or cancel what is open first.", true);
    }
    this.say("");
    this.touched = false;
    const draft: WayDraft = { ...d, when: [...d.when], steps: [...d.steps], files: [...d.files] };
    this.draft = draft;
    const form = el("div", "rform wayform");
    form.appendChild(el("h3", "", draft.id ? "Change it" : "New specialty"));
    for (const n of draft.notes) form.appendChild(el("p", "note", n));
    const field = (label: string, value: string, set: (v: string) => void, rows = 1, hint = "") => {
      const l = el("label", "", label);
      const t = rows > 1 ? document.createElement("textarea") : document.createElement("input");
      if (t instanceof HTMLTextAreaElement) t.rows = rows;
      t.value = value;
      t.placeholder = hint;
      t.addEventListener("input", () => {
        this.touched = true;
        set(t.value);
      });
      l.appendChild(t);
      form.appendChild(l);
      return t;
    };
    const split = (v: string) => v.split("\n").map((x) => x.trim()).filter(Boolean);
    const first = field("Name", draft.name, (v) => (draft.name = v), 1, "Weekly supplier report");
    field("When to use it, a line each", draft.when.join("\n"), (v) => (draft.when = split(v)), 2, "what did we spend with suppliers this week");
    field("Steps, a line each", draft.steps.join("\n"), (v) => (draft.steps = split(v)), Math.min(10, Math.max(4, draft.steps.length + 1)), "Only shops that deliver here");
    field("Notes: pitfalls, examples, anything else (background jobs read these)", draft.text, (v) => (draft.text = v), Math.min(18, Math.max(4, draft.text.split("\n").length + 1)));
    field("Why, if it helps", draft.why ?? "", (v) => (draft.why = v));

    const files = el("div", "wayfiles");
    const drawFiles = () => {
      files.replaceChildren(
        ...draft.files.map((f) => {
          const one = el("div", "wayfile");
          const head = el("div", "rowbtns");
          const size = "data" in f ? Math.floor((f.data.length * 3) / 4) : f.size;
          head.append(el("span", "", `${f.name} (${sizeSaid(size)})`), button("Remove", () => {
            this.touched = true;
            draft.files = draft.files.filter((x) => x !== f);
            drawFiles();
          }));
          one.appendChild(head);
          // What is new is read before it is kept, whole.
          const text = "data" in f ? textOf(f.data) : null;
          if (text !== null) {
            const seen = el("details", "");
            seen.append(el("summary", "", "What is in it"), el("pre", "", text));
            one.appendChild(seen);
          } else if ("data" in f) one.appendChild(el("small", "rfacts", "Not text: it cannot be shown here."));
          return one;
        }),
      );
    };
    drawFiles();
    if (this.may.files || draft.files.length) {
      form.append(el("h4", "", "Files with it"), files);
      if (this.may.files) {
        const add = document.createElement("input");
        add.type = "file";
        add.multiple = true;
        add.hidden = true;
        add.addEventListener("change", async () => {
          this.touched = true;
          for (const f of add.files ?? []) draft.files.push({ name: f.name, data: toB64u(await f.arrayBuffer()) });
          add.value = "";
          drawFiles();
        });
        form.append(button("Add a file…", () => add.click()), add);
      }
    }

    const btns = el("div", "rowbtns");
    const problem = el("small", "rfacts bad");
    const save = button("Save", async () => {
      save.disabled = true;
      problem.textContent = "";
      try {
        const files = draft.files.map((f) => ("data" in f ? { name: f.name, data: f.data } : { n: f.n }));
        await api(this.key, "POST", "/api/memory/specialties", { ...(draft.id ? { id: draft.id } : {}), name: draft.name, when: draft.when, steps: draft.steps, why: draft.why ?? "", text: draft.text, files, ...(draft.source ? { source: draft.source } : {}) });
        // The card it came from is settled by this: what it would have kept is kept, as they changed it.
        if (draft.card) await api(this.key, "POST", "/api/hub/proposals/answer", { id: draft.card, answer: "decline" }).then((r) => settle(this.key, (r as { proposal: ProposalView }).proposal), () => {});
        this.close();
        this.say("Saved.");
        await this.load();
      } catch (e) {
        problem.textContent = why(e);
        save.disabled = false;
      }
    }, "primary");
    btns.append(save, button("Cancel", () => this.close()));
    form.append(problem, btns);
    this.form.replaceChildren(form);
    this.form.scrollIntoView({ block: "start" });
    first.focus();
  }

  private close(): void {
    this.draft = null;
    this.touched = false;
    this.form.replaceChildren();
  }

  /** Whether something is being written, which a redraw of the panel would lose. */
  get writing(): boolean {
    return this.draft !== null;
  }
}
