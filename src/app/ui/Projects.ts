import { api } from "../key";
import { sizeSaid } from "../jobWords";
import { saveFrom } from "./JobFiles";
import { toB64u } from "../passkey";
import { arm, button, el } from "./util";

/**
 * Jobs → Projects: a name, a few rules and files for jobs that belong together
 * (src/worker/lib/projects.ts). Built with textContent throughout: a file's
 * name may be anyone's.
 */

export interface ProjectView {
  id: string;
  name: string;
  rules: string[];
  files: { n: number; name: string; size: number }[];
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Projects {
  el = document.createElement("details");
  all: ProjectView[] = [];
  private key: string;
  private list = el("div", "rlist");
  private form = el("div", "");
  private msg = el("small", "rfacts", "");
  private changed: (all: ProjectView[]) => void;
  private only: (p: ProjectView) => void;
  /** Whether what is open has been typed in. */
  private touched = false;

  /** `changed`: told what there are, each time; `only`: to list the jobs of one. */
  constructor(key: string, changed: (all: ProjectView[]) => void, only: (p: ProjectView) => void) {
    this.key = key;
    this.changed = changed;
    this.only = only;
    this.el.className = "projects";
    this.msg.setAttribute("role", "status");
    this.el.append(
      el("summary", "", "Projects"),
      el("p", "note", "A name, a few rules and files for jobs that belong together. A job in one is given those and what its last jobs came back with, and nothing of any other's."),
      button("New project", () => this.edit(null)),
      this.msg,
      this.form,
      this.list,
    );
  }

  private say(text: string, bad = false): void {
    this.msg.textContent = text;
    this.msg.classList.toggle("bad", bad);
  }

  async load(): Promise<void> {
    try {
      this.all = ((await api(this.key, "GET", "/api/v1/projects")) as { projects: ProjectView[] }).projects;
    } catch (e) {
      this.say(why(e), true);
      return;
    }
    this.el.querySelector("summary")!.textContent = this.all.length ? `Projects (${this.all.length})` : "Projects";
    this.changed(this.all);
    this.list.replaceChildren(...this.all.map((p) => this.row(p)));
  }

  private async act(fn: () => Promise<unknown>, done = ""): Promise<boolean> {
    let ok = true;
    try {
      await fn();
      this.say(done);
    } catch (e) {
      ok = false;
      this.say(why(e), true);
    }
    await this.load();
    return ok;
  }

  private row(p: ProjectView): HTMLElement {
    const row = el("div", "routine");
    const top = el("div", "rtop");
    top.appendChild(el("b", "", p.name));
    row.appendChild(top);
    if (p.rules.length) {
      const rules = el("ol", "rsteps");
      for (const r of p.rules) rules.appendChild(el("li", "", r));
      row.appendChild(rules);
    }
    const files = el("div", "wayfiles");
    for (const f of p.files) {
      const one = el("div", "rowbtns projectfile");
      const at = `/api/v1/projects/file?${new URLSearchParams({ id: p.id, n: String(f.n) })}`;
      const gone = button("Remove", () => {});
      arm(gone, "Remove it?", async () => void (await this.act(() => api(this.key, "DELETE", at))));
      one.append(el("span", "", `${f.name} (${sizeSaid(f.size)})`), button("Save a copy", () => void saveFrom(this.key, at, f.name.split("/").pop()!).catch((e) => this.say(why(e), true))), gone);
      files.appendChild(one);
    }
    row.appendChild(files);
    const pick = document.createElement("input");
    pick.type = "file";
    pick.multiple = true;
    pick.hidden = true;
    pick.addEventListener("change", () => {
      const chosen = [...(pick.files ?? [])];
      pick.value = "";
      void this.act(async () => {
        for (const f of chosen) await api(this.key, "POST", "/api/v1/projects/file", { id: p.id, name: f.name, data: toB64u(await f.arrayBuffer()) });
      });
    });
    const btns = el("div", "rowbtns");
    const remove = button("Remove", () => {});
    arm(remove, "Remove it and its files?", async () => void (await this.act(() => api(this.key, "DELETE", `/api/v1/projects?id=${encodeURIComponent(p.id)}`), "Removed. Its jobs stay.")));
    btns.append(button("Its jobs", () => this.only(p)), button("Change", () => this.edit(p)), button("Add files…", () => pick.click()), pick, remove);
    row.appendChild(btns);
    return row;
  }

  /** The form, for one or a new one. Never over something half written. */
  private edit(p: ProjectView | null): void {
    if (this.touched) return this.say("Save or cancel what is open first.", true);
    this.say("");
    const form = el("div", "rform wayform");
    const field = (label: string, t: HTMLInputElement | HTMLTextAreaElement, value: string, hint: string) => {
      const l = el("label", "", label);
      t.value = value;
      t.placeholder = hint;
      t.addEventListener("input", () => (this.touched = true));
      l.appendChild(t);
      form.appendChild(l);
      return t;
    };
    const name = field("Name", document.createElement("input"), p?.name ?? "", "Kitchen");
    const rules = field("Rules, a line each", document.createElement("textarea"), p?.rules.join("\n") ?? "", "Prices in ringgit, with delivery");
    const close = () => {
      this.touched = false;
      this.form.replaceChildren();
    };
    const save = button("Save", async () => {
      save.disabled = true;
      const ok = await this.act(() => api(this.key, "POST", "/api/v1/projects", { ...(p ? { id: p.id } : {}), name: name.value, rules: rules.value.split("\n").map((r) => r.trim()).filter(Boolean) }), "Saved.");
      save.disabled = false;
      if (ok) close();
    }, "primary");
    const btns = el("div", "rowbtns");
    btns.append(save, button("Cancel", close));
    form.appendChild(btns);
    this.form.replaceChildren(form);
    name.focus();
  }
}
