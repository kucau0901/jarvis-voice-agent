import { api } from "../key";
import { button, el, richText } from "./util";

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
  engine: "jarvis" | "hermes" | "research";
  status: "running" | "done" | "failed" | "cancelled";
  createdAt: number;
  finishedAt?: number;
  steps: number;
  summary?: string;
  result?: string;
  hasResult?: boolean;
  error?: string;
  deliveredBy?: string | null;
  /** Dollars so far, at OpenAI's prices; null when the model has no listed price. */
  cost?: number | null;
  /** Research as a team: how many teams reported and, while it runs, which part it is in. */
  team?: { of: number; reported: number; phase?: "planning" | "teams" | "merging" | "checking" };
}

/** What a running research team is doing, after "min so far". */
const PHASE: Record<"planning" | "merging" | "checking", string> = {
  planning: "planning the teams",
  merging: "merging the teams' reports",
  checking: "checking the report",
};

/** What Hermes is asked to do with a finished research report, until the person says otherwise. */
const HAND_OVER = "Build this with Claude Code in a new project folder, and tell me when it is done";

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
  /** Whether this person may ask Hermes: only then is a finished report offered to it. */
  private hermes = false;
  /** Research being handed to Hermes: the job, and the instruction as typed so far. */
  private handing = new Map<string, string>();

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
    // Research: a stronger model, searching widely, with sources (lib/jobs.ts).
    const deep = el("label", "on");
    const deepBox = document.createElement("input");
    deepBox.type = "checkbox";
    deep.appendChild(deepBox);
    deep.appendChild(document.createTextNode(" Research in depth: a stronger model and sources, 10–40 minutes, roughly $1–2 (shown below once done)"));
    form.appendChild(deep);
    // Research as a team: research too, so each box keeps the other right.
    const asTeam = el("label", "on");
    const teamBox = document.createElement("input");
    teamBox.type = "checkbox";
    asTeam.appendChild(teamBox);
    asTeam.appendChild(document.createTextNode(" As a team: three teams, each from an angle chosen for the question, sharing what they find; 20–55 minutes, roughly $4–7, one at a time"));
    form.appendChild(asTeam);
    teamBox.addEventListener("change", () => {
      if (teamBox.checked) deepBox.checked = true;
    });
    deepBox.addEventListener("change", () => {
      if (!deepBox.checked) teamBox.checked = false;
    });
    form.appendChild(
      button("Start", () =>
        void this.act(async () => {
          await api(this.key, "POST", "/api/v1/jobs", {
            task: task.value,
            ...(deepBox.checked ? { engine: "research" } : {}),
            ...(teamBox.checked ? { team: true } : {}),
          });
          task.value = "";
          deepBox.checked = teamBox.checked = false;
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
    // Offered only where Hermes is set up and theirs to ask (routes/hub.ts). A device is not a person: no button.
    this.hermes = await api(this.key, "GET", "/api/hub/me").then((me) => (me as { hermes?: boolean }).hermes === true, () => false);
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
      jobs = ((await api(this.key, "GET", "/api/v1/jobs")) as { jobs: JobView[] }).jobs;
    } catch (e) {
      this.list.replaceChildren(el("p", "warn", `Could not load jobs: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    // A report no longer here (removed, pruned) is no longer being handed over.
    for (const id of this.handing.keys()) {
      if (!jobs.some((j) => j.id === id && j.engine === "research" && j.status === "done")) this.handing.delete(id);
    }
    if (!jobs.length) {
      this.list.replaceChildren(el("p", "note", "None yet."));
    } else {
      this.list.replaceChildren(...jobs.map((j) => this.row(j)));
    }
    // Keep up with running jobs while the panel is open, but not while an instruction to Hermes is being written.
    if (this.el.classList.contains("open") && !this.handing.size && jobs.some((j) => j.status === "running")) {
      this.timer = setTimeout(() => void this.load(), 5000);
    }
  }

  private row(j: JobView): HTMLElement {
    // Only a cancelled job is dimmed: a finished one is there to be read.
    const row = el("div", `routine${j.status === "cancelled" ? " off" : ""}`);
    const top = el("div", "rtop");
    top.appendChild(el("b", "", j.title));
    top.appendChild(el("span", `chip ${j.status === "done" ? "on" : "off"}`, STATUS[j.status]));
    row.appendChild(top);

    const facts: string[] = [j.team ? "Research team" : j.engine === "hermes" ? "Hermes" : j.engine === "research" ? "Research" : "Jarvis", `started ${when(j.createdAt)}`];
    if (j.status === "running") facts.push(`${Math.max(1, Math.round((Date.now() - j.createdAt) / 60_000))} min so far${j.engine === "jarvis" ? `, step ${j.steps}` : ""}`);
    if (j.team?.phase) facts.push(j.team.phase === "teams" ? `${j.team.reported} of ${j.team.of} teams done` : PHASE[j.team.phase]);
    else if (j.team && j.status !== "running" && j.team.reported < j.team.of) facts.push(`${j.team.reported} of ${j.team.of} teams reported`);
    if (j.finishedAt) facts.push(`took ${Math.max(1, Math.round((j.finishedAt - j.createdAt) / 60_000))} min`);
    if (j.status !== "running" && j.deliveredBy !== undefined) facts.push(j.deliveredBy ? `sent by ${j.deliveredBy}` : "not delivered");
    if (typeof j.cost === "number" && j.cost > 0) facts.push(`about ${j.cost < 0.01 ? "under 1¢" : `$${j.cost.toFixed(2)}`}`);
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
    if (j.engine === "research" && j.status === "done" && this.hermes) {
      btns.appendChild(
        button(this.handing.has(j.id) ? "Don't send" : "Send to Hermes", () => {
          if (this.handing.has(j.id)) this.handing.delete(j.id);
          else this.handing.set(j.id, HAND_OVER);
          void this.load();
        }),
      );
    }
    if (j.status === "running") btns.appendChild(button("Cancel", () => void this.act(() => api(this.key, "POST", "/api/v1/jobs/cancel", { id: j.id }))));
    else btns.appendChild(button("Remove", () => void this.act(() => api(this.key, "DELETE", `/api/v1/jobs?id=${encodeURIComponent(j.id)}`))));
    row.appendChild(btns);
    if (this.handing.has(j.id)) row.appendChild(this.handOver(j));
    return row;
  }

  /** What Hermes should do with a finished report: sent with the whole report, which it gets as reference, not instructions. */
  private handOver(j: JobView): HTMLElement {
    const form = el("div", "rform");
    const instruction = document.createElement("textarea");
    instruction.rows = 2;
    instruction.value = this.handing.get(j.id) ?? "";
    instruction.addEventListener("input", () => this.handing.set(j.id, instruction.value));
    form.appendChild(instruction);
    form.appendChild(
      button("Send", () =>
        void this.act(async () => {
          await api(this.key, "POST", "/api/v1/jobs", { engine: "hermes", title: `Hermes: ${j.title}`, task: instruction.value, from: j.id });
          this.handing.delete(j.id);
        }, "Sent to Hermes with the whole report — its answer arrives as an alert."), "primary"),
    );
    return form;
  }

  private async fill(id: string, box: HTMLElement): Promise<void> {
    try {
      const j = ((await api(this.key, "GET", `/api/v1/jobs?id=${encodeURIComponent(id)}`)) as { job: JobView }).job;
      box.replaceChildren();
      if (j.result) box.appendChild(richText(j.result, "jobtext"));
      const asked = el("details", "");
      asked.appendChild(el("summary", "", "What was asked"));
      asked.appendChild(el("div", "jobtext", j.task));
      box.appendChild(asked);
    } catch (e) {
      box.textContent = e instanceof Error ? e.message : String(e);
    }
  }
}

const when = (ts: number) =>
  new Intl.DateTimeFormat([], { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ts));
