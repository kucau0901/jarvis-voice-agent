import { authHeaders } from "../key";

/**
 * Background jobs (src/worker/lib/jobs.ts): what is running, what came back,
 * and the whole of each result — the alert carries only the summary. Starting
 * one is usually said, not typed: "look into dashcams under RM800 and let me
 * know".
 *
 * Built with textContent throughout: results are written from web pages and
 * mail, which is to say by strangers.
 */

interface JobView {
  id: string;
  title: string;
  task: string;
  engine: "jarvis" | "hermes";
  status: "running" | "done" | "failed" | "cancelled";
  createdAt: number;
  finishedAt?: number;
  steps: number;
  summary?: string;
  result?: string;
  hasResult?: boolean;
  error?: string;
  deliveredBy?: string | null;
}

const STATUS: Record<JobView["status"], string> = {
  running: "working",
  done: "done",
  failed: "could not finish",
  cancelled: "cancelled",
};

export class Jobs {
  private el: HTMLElement;
  private list: HTMLElement;
  private key: string;
  private open = new Set<string>();
  private timer = 0;

  constructor(key: string) {
    this.key = key;
    this.el = el("div", "panel");
    this.el.id = "jobs";
    const sheet = el("div", "sheet");
    const head = el("header", "");
    head.appendChild(el("h2", "", "Jobs"));
    head.appendChild(button("Done", () => this.hide(), "close"));
    sheet.appendChild(head);
    sheet.appendChild(
      el("p", "note",
        "Work that takes minutes — research, comparisons, going through mail, a question for Hermes. " +
        "It runs on its own, even with every screen closed, and the result comes to you as an alert " +
        "and stays here. Jobs read but never act: anything they would do, they tell you instead. " +
        "Usually quicker to say: \"look into the best dashcams under RM800 and let me know\"."),
    );
    this.list = el("div", "rlist");
    sheet.appendChild(this.list);
    sheet.appendChild(el("h3", "", "New job"));
    const form = el("div", "rform");
    const task = document.createElement("textarea");
    task.rows = 3;
    task.placeholder = "Compare the three cheapest EV chargers I can get installed at home, with prices and what the reviews say.";
    form.appendChild(task);
    form.appendChild(
      button("Start", () =>
        void this.act(async () => {
          await this.api("POST", "/api/v1/jobs", { task: task.value });
          task.value = "";
        }, "Started — it arrives as an alert when done."), "primary"),
    );
    sheet.appendChild(form);
    sheet.appendChild(el("div", "msg"));
    this.el.appendChild(sheet);
    document.body.appendChild(this.el);
    this.el.addEventListener("click", (e) => {
      if (e.target === this.el) this.hide();
    });
  }

  async show(): Promise<void> {
    this.el.classList.add("open");
    await this.load();
  }

  hide(): void {
    this.el.classList.remove("open");
    clearTimeout(this.timer);
  }

  private msg(text: string, bad = false): void {
    const m = this.el.querySelector<HTMLElement>(".msg")!;
    m.textContent = text;
    m.classList.toggle("bad", bad);
  }

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const r = await fetch(path, { method, headers: authHeaders(this.key), ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data as { error?: string }).error ?? `server said ${r.status}`);
    return data;
  }

  private async act(fn: () => Promise<unknown>, done = ""): Promise<void> {
    try {
      await fn();
      this.msg(done);
    } catch (e) {
      this.msg(e instanceof Error ? e.message : String(e), true);
    }
    await this.load();
  }

  private async load(): Promise<void> {
    clearTimeout(this.timer);
    let jobs: JobView[];
    try {
      jobs = ((await this.api("GET", "/api/v1/jobs")) as { jobs: JobView[] }).jobs;
    } catch (e) {
      this.list.replaceChildren(el("p", "warn", `Could not load jobs: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    if (!jobs.length) {
      this.list.replaceChildren(el("p", "note", "None yet."));
    } else {
      this.list.replaceChildren(...jobs.map((j) => this.row(j)));
    }
    // Keep up with running jobs while the panel is open.
    if (this.el.classList.contains("open") && jobs.some((j) => j.status === "running")) {
      this.timer = setTimeout(() => void this.load(), 5000) as unknown as number;
    }
  }

  private row(j: JobView): HTMLElement {
    // Only a cancelled job is dimmed: a finished one is there to be read.
    const row = el("div", `routine${j.status === "cancelled" ? " off" : ""}`);
    const top = el("div", "rtop");
    top.appendChild(el("b", "", j.title));
    top.appendChild(el("span", `chip ${j.status === "done" ? "on" : "off"}`, STATUS[j.status]));
    row.appendChild(top);

    const facts: string[] = [j.engine === "hermes" ? "Hermes" : "Jarvis", `started ${when(j.createdAt)}`];
    if (j.status === "running") facts.push(`${Math.max(1, Math.round((Date.now() - j.createdAt) / 60_000))} min so far${j.engine === "jarvis" ? `, step ${j.steps}` : ""}`);
    if (j.finishedAt) facts.push(`took ${Math.max(1, Math.round((j.finishedAt - j.createdAt) / 60_000))} min`);
    if (j.status !== "running" && j.deliveredBy !== undefined) facts.push(j.deliveredBy ? `sent by ${j.deliveredBy}` : "not delivered");
    row.appendChild(el("div", "rfacts", facts.join(" · ")));

    if (j.summary) row.appendChild(el("div", "rwhen", j.summary));
    if (j.error) row.appendChild(el("div", "rfacts bad", j.error));

    const full = el("div", "jobresult");
    full.hidden = !this.open.has(j.id);
    row.appendChild(full);
    if (!full.hidden) void this.fill(j.id, full);

    const btns = el("div", "rowbtns");
    if (j.hasResult || j.task) {
      btns.appendChild(
        button(this.open.has(j.id) ? "Hide" : j.hasResult ? "Read it all" : "What was asked", () => {
          if (this.open.has(j.id)) this.open.delete(j.id);
          else this.open.add(j.id);
          void this.load();
        }),
      );
    }
    if (j.status === "running") btns.appendChild(button("Cancel", () => void this.act(() => this.api("POST", "/api/v1/jobs/cancel", { id: j.id }))));
    else btns.appendChild(button("Remove", () => void this.act(() => this.api("DELETE", `/api/v1/jobs?id=${encodeURIComponent(j.id)}`))));
    row.appendChild(btns);
    return row;
  }

  private async fill(id: string, box: HTMLElement): Promise<void> {
    try {
      const j = ((await this.api("GET", `/api/v1/jobs?id=${encodeURIComponent(id)}`)) as { job: JobView }).job;
      box.replaceChildren();
      if (j.result) box.appendChild(linked(j.result));
      const asked = el("details", "");
      asked.appendChild(el("summary", "", "What was asked"));
      asked.appendChild(el("div", "jobtext", j.task));
      box.appendChild(asked);
    } catch (e) {
      box.textContent = e instanceof Error ? e.message : String(e);
    }
  }
}

/**
 * A result's text with its sources as links. Web answers cite as markdown —
 * "([example.com](https://…))" — which reads as noise left raw. Built as
 * text and anchors, never as HTML, and only for https addresses: the text
 * came from web pages.
 */
function linked(text: string): HTMLElement {
  const box = el("div", "jobtext");
  const re = /\(?\[([^\]\n]{1,120})\]\((https:\/\/[^\s)]{1,2000})\)\)?/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    box.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = el("a", "", m[1]);
    try {
      const u = new URL(m[2]!);
      u.searchParams.delete("utm_source");
      a.href = u.toString();
    } catch {
      a.href = "about:blank";
    }
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    box.appendChild(document.createTextNode(m[0].startsWith("(") ? "(" : ""));
    box.appendChild(a);
    box.appendChild(document.createTextNode(m[0].startsWith("(") ? ")" : ""));
    last = m.index! + m[0].length;
  }
  box.appendChild(document.createTextNode(text.slice(last)));
  return box;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

const when = (ts: number) =>
  new Intl.DateTimeFormat([], { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ts));
