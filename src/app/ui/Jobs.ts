import { api } from "../key";
import { arm, button, el } from "./util";
import { markdown } from "./rich";
import { proposalsBox } from "../proposal";
import type { JobCard, JobView } from "../jobWords";
import { askCard, askId } from "./JobAsk";
import { cardForm, jobLive, jobNow } from "./JobLive";
import { jobFiles, jobRan, saveFrom } from "./JobFiles";

/**
 * Background jobs (src/worker/lib/jobs.ts): what is running, what came back,
 * and the whole of each result — the alert carries only the summary. Starting
 * one is usually said, not typed: "look into dashcams under RM800 and let me
 * know".
 *
 * Built with textContent throughout: results are written from web pages and
 * mail, which is to say by strangers.
 */

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
  /** Files, in the New job form: offered only where the workshop is set up and theirs to use. */
  private files: HTMLElement;
  /** Research being handed to Hermes: the job, and the instruction as typed so far. */
  private handing = new Map<string, string>();
  /** A working job's card being changed: the job, and the card as typed so far. */
  private changing = new Map<string, JobCard>();
  /** A working job being told something: the job, and the words as typed so far. */
  private telling = new Map<string, string>();
  /** Answers to what jobs ask, as typed so far (ui/JobAsk.ts). */
  private answering = new Map<string, string>();

  /** Told what is listed each time, so the chat's job pills keep up (fromRoutine.ts jobsSeen). */
  private seen: (jobs: JobView[]) => void;
  private asks: { el: HTMLElement; load(): Promise<void> };

  constructor(key: string, seen: (jobs: JobView[]) => void) {
    this.key = key;
    this.seen = seen;
    this.asks = proposalsBox(key);
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
        "and stays here. Jobs read, and never act on their own: what one would do, it proposes, and only your tap does it, " +
        "unless you let jobs do that kind without asking (listed below, with Stop). " +
        "Usually quicker to say: \"look into the best dashcams under RM800 and let me know\"."),
    );
    // What jobs proposed, and what they may do without asking (proposal.ts).
    sheet.appendChild(this.asks.el);
    this.list = el("div", "rlist");
    sheet.appendChild(this.list);
    sheet.appendChild(el("h3", "", "New job"));
    const form = el("div", "rform");
    const task = document.createElement("textarea");
    task.rows = 3;
    task.placeholder = "Compare the three cheapest EV chargers I can get installed at home, with prices and what the reviews say.";
    form.appendChild(task);
    // One side or the other, never both (lib/jobs.ts Reach): what is looked up on the web leaves by the words of the search.
    const reach = document.createElement("select");
    for (const [value, label] of [["web", "On the web, and nothing of mine"], ["private", "In my own things, not the web"]] as const) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      reach.appendChild(o);
    }
    reach.setAttribute("aria-label", "Where this job may look");
    form.appendChild(reach);
    // Thorough: research's model, for an ordinary job.
    const hard = el("label", "on");
    const hardBox = document.createElement("input");
    hardBox.type = "checkbox";
    hard.appendChild(hardBox);
    hard.appendChild(document.createTextNode(" Thorough: a stronger model, for work with many things to weigh; several times the cost, five a day"));
    form.appendChild(hard);
    // Helpers (src/worker/lib/job-helpers.ts): asked for, never by itself.
    const split = el("label", "on");
    const splitBox = document.createElement("input");
    splitBox.type = "checkbox";
    split.appendChild(splitBox);
    split.appendChild(document.createTextNode(" Helpers: splits the work between up to three, who work at the same time; several times the cost"));
    form.appendChild(split);
    // Files: in the workshop, for whoever may have one use it (show).
    this.files = el("label", "on");
    const filesBox = document.createElement("input");
    filesBox.type = "checkbox";
    this.files.appendChild(filesBox);
    this.files.appendChild(document.createTextNode(" Files: makes them with programs, on a machine with no network, for you to save (a spreadsheet, a document, a chart)"));
    this.files.hidden = true;
    form.appendChild(this.files);
    hardBox.addEventListener("change", () => {
      if (hardBox.checked) filesBox.checked = false;
    });
    filesBox.addEventListener("change", () => {
      if (filesBox.checked) hardBox.checked = false;
    });
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
    const asTable = el("label", "on");
    const tableBox = document.createElement("input");
    tableBox.type = "checkbox";
    asTable.appendChild(tableBox);
    asTable.appendChild(document.createTextNode(" As a table: the team fills rows of many items instead of writing a report, to download as CSV"));
    form.appendChild(asTable);
    tableBox.addEventListener("change", () => {
      if (tableBox.checked) deepBox.checked = teamBox.checked = true;
    });
    teamBox.addEventListener("change", () => {
      if (teamBox.checked) deepBox.checked = true;
    });
    deepBox.addEventListener("change", () => {
      if (!deepBox.checked) teamBox.checked = tableBox.checked = false;
    });
    // Research is the web's.
    form.addEventListener("change", () => {
      if (deepBox.checked) reach.value = "web";
      if (deepBox.checked) hardBox.checked = filesBox.checked = splitBox.checked = false;
      reach.disabled = hardBox.disabled = filesBox.disabled = splitBox.disabled = deepBox.checked;
    });
    teamBox.addEventListener("change", () => {
      if (!teamBox.checked) tableBox.checked = false;
    });
    form.appendChild(
      button("Start", () =>
        void this.act(async () => {
          await api(this.key, "POST", "/api/v1/jobs", {
            task: task.value,
            reach: reach.value,
            ...(hardBox.checked ? { mode: "thorough" } : filesBox.checked ? { mode: "files" } : {}),
            ...(splitBox.checked ? { helpers: true } : {}),
            ...(deepBox.checked ? { engine: "research" } : {}),
            ...(teamBox.checked ? { team: true } : {}),
            ...(tableBox.checked ? { table: true } : {}),
          });
          task.value = "";
          hardBox.checked = filesBox.checked = splitBox.checked = deepBox.checked = teamBox.checked = tableBox.checked = false;
          reach.disabled = hardBox.disabled = filesBox.disabled = splitBox.disabled = false;
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

  /** Open; with `focus`, that job opened out, brought into view and marked (a job's pill in the conversation). */
  async show(focus?: string): Promise<void> {
    this.el.classList.add("open");
    if (focus) this.open.add(focus);
    // Offered only where Hermes is set up and theirs to ask (routes/hub.ts). A device is not a person: no button.
    const me = await api(this.key, "GET", "/api/hub/me").then((r) => r as { hermes?: boolean; workshop?: boolean }, () => ({}) as { hermes?: boolean; workshop?: boolean });
    this.hermes = me.hermes === true;
    this.files.hidden = me.workshop !== true;
    await this.load();
    const row = focus ? [...this.list.querySelectorAll<HTMLElement>(".routine")].find((r) => r.dataset.id === focus) : undefined;
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    row.classList.add("flash");
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
    void this.asks.load();
    let jobs: JobView[];
    try {
      jobs = ((await api(this.key, "GET", "/api/v1/jobs")) as { jobs: JobView[] }).jobs;
    } catch (e) {
      this.list.replaceChildren(el("p", "warn", `Could not load jobs: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    this.seen(jobs);
    // A report no longer here (removed, pruned) is no longer being handed over.
    for (const id of this.handing.keys()) {
      if (!jobs.some((j) => j.id === id && j.engine === "research" && j.status === "done")) this.handing.delete(id);
    }
    // Nor is the card of one that has ended, or been told to write what it has, still being changed.
    for (const id of this.changing.keys()) {
      if (!jobs.some((j) => j.id === id && j.status === "running" && j.card && !j.wrapping)) this.changing.delete(id);
    }
    for (const id of this.telling.keys()) {
      if (!jobs.some((j) => j.id === id && hears(j))) this.telling.delete(id);
    }
    for (const k of this.answering.keys()) {
      if (!jobs.some((j) => j.asks?.some((q) => askId(j.id, q.id) === k))) this.answering.delete(k);
    }
    if (!jobs.length) {
      this.list.replaceChildren(el("p", "note", "None yet."));
    } else {
      this.list.replaceChildren(...jobs.map((j) => this.row(j)));
    }
    // Keep up with running jobs while the panel is open, but not while something is being written to one.
    const running = jobs.filter((j) => j.status === "running");
    if (this.el.classList.contains("open") && running.length) this.soon(running.every((j) => j.waiting) ? 20_000 : 5000);
  }

  private soon(ms: number): void {
    this.timer = setTimeout(() => (this.writing() ? this.soon(ms) : void this.load()), ms);
  }

  private writing(): boolean {
    const at = document.activeElement;
    return (
      this.handing.size + this.changing.size + this.telling.size > 0 ||
      [...this.answering.values()].some((t) => t.trim()) ||
      (this.list.contains(at) && (at instanceof HTMLInputElement || at instanceof HTMLTextAreaElement))
    );
  }

  private row(j: JobView): HTMLElement {
    // Only a cancelled job is dimmed: a finished one is there to be read.
    const row = el("div", `routine${j.status === "cancelled" ? " off" : ""}`);
    row.dataset.id = j.id;
    const top = el("div", "rtop");
    top.appendChild(el("b", "", j.title));
    top.appendChild(el("span", `chip ${j.status === "done" || j.asks ? "on" : "off"}`, j.asks ? "asks you" : j.waiting ? "waiting" : j.status === "failed" && j.hasResult ? "part done" : STATUS[j.status]));
    row.appendChild(top);

    const facts: string[] = [j.team ? "Research team" : j.engine === "hermes" ? "Hermes" : j.engine === "research" ? "Research" : j.mode === "thorough" ? "Jarvis, thorough" : j.mode === "files" ? "Jarvis, making files" : "Jarvis", ...(j.helpers && (j.status === "running" || j.helpers.length) ? ["with helpers"] : []), `started ${when(j.createdAt)}`];
    if (j.status === "running") facts.push(`${Math.max(1, Math.round((Date.now() - j.createdAt) / 60_000))} min so far${j.engine === "jarvis" ? `, step ${j.steps}` : ""}`);
    if (j.team?.phase) facts.push(j.team.phase === "teams" ? `${j.team.reported} of ${j.team.of} teams done` : PHASE[j.team.phase]);
    else if (j.team && j.status !== "running" && j.team.reported < j.team.of) facts.push(`${j.team.reported} of ${j.team.of} teams reported`);
    if (j.finishedAt) facts.push(`took ${Math.max(1, Math.round((j.finishedAt - j.createdAt) / 60_000))} min`);
    if (j.status !== "running" && j.deliveredBy !== undefined) facts.push(j.deliveredBy ? `sent by ${j.deliveredBy}` : "not delivered");
    if (typeof j.cost === "number" && j.cost > 0) facts.push(`about ${j.cost < 0.01 ? "under 1¢" : `$${j.cost.toFixed(2)}`}`);
    if (j.engine !== "hermes") facts.push(j.engine === "research" || j.reach === "web" ? "the web only" : "your own things, no web");
    if (j.onKey) facts.push("on the API key");
    row.appendChild(el("div", "rfacts", facts.join(" · ")));
    if (j.waiting) {
      row.appendChild(
        el("div", "rwhen", j.waiting.for === "you"
          ? `It has done what it can without you. If you have not answered by ${when(j.waiting.until)}, it finishes without, and says what that leaves open.`
          : `The ChatGPT plan is at its limit. This goes on by itself at about ${when(j.waiting.until)}.`),
      );
    }

    if (j.status === "running") {
      for (const q of j.asks ?? []) row.appendChild(askCard(this.key, j, q, { tag: "It asks you", typed: this.answering, after: () => void this.load() }));
      const work = jobLive(j, (n) => void this.act(() => api(this.key, "POST", "/api/v1/jobs/cancel", { id: j.id, helper: n }), "Stopped: the job is told."));
      if (work) row.appendChild(work);
      if (j.engine === "jarvis" && !j.waiting) row.appendChild(jobNow(j));
      if (this.telling.has(j.id)) row.appendChild(this.tell(j));
      const typed = this.changing.get(j.id);
      if (typed) {
        row.appendChild(cardForm(typed, (c) => {
          this.changing.delete(j.id);
          void this.act(() => api(this.key, "POST", "/api/v1/jobs/card", { id: j.id, ...c }), "Told: it goes on from there at its next step.");
        }, () => {
          this.changing.delete(j.id);
          void this.load();
        }));
      }
    }

    if (j.summary) row.appendChild(el("div", "rwhen", j.summary));
    if (j.error) row.appendChild(el("div", "rfacts bad", j.error));
    if (j.files?.length) row.appendChild(jobFiles(this.key, j.id, j.files, (why) => this.msg(why, true)));
    // Before the result, not after it: what it does not have, and what it rests on.
    if (j.missing?.length) row.appendChild(flags("Not done", j.missing));
    if (j.assumed?.length) row.appendChild(flags("Assumed", j.assumed));

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
    if (j.table?.rows) btns.appendChild(button(`Download CSV (${j.table.rows} rows)`, () => void this.act(() => this.csv(j))));
    if (j.engine === "research" && j.status === "done" && this.hermes) {
      btns.appendChild(
        button(this.handing.has(j.id) ? "Don't send" : "Send to Hermes", () => {
          if (this.handing.has(j.id)) this.handing.delete(j.id);
          else this.handing.set(j.id, HAND_OVER);
          void this.load();
        }),
      );
    }
    if (j.waiting?.key) {
      const soFar = j.waiting.key.soFar;
      const use = button("Use the API key now", () => {});
      arm(use, soFar ? `About ${soFar < 0.01 ? "under 1¢" : `$${soFar.toFixed(2)}`} so far. Sure?` : "It costs money. Sure?", () => this.act(() => api(this.key, "POST", "/api/v1/jobs/key", { id: j.id })));
      btns.appendChild(use);
    }
    if (j.status === "running" && j.card && !j.wrapping && !this.changing.has(j.id)) {
      const c = j.card;
      btns.appendChild(button("Change", () => {
        this.changing.set(j.id, { outcome: c.outcome, limits: [...c.limits], assumptions: [...c.assumptions] });
        void this.load();
      }));
    }
    if (hears(j)) {
      btns.appendChild(
        button(this.telling.has(j.id) ? "Leave it" : "Tell it", () => {
          if (this.telling.has(j.id)) this.telling.delete(j.id);
          else this.telling.set(j.id, "");
          void this.load().then(() => this.list.querySelector<HTMLElement>(`.routine[data-id="${CSS.escape(j.id)}"] .jobtell textarea`)?.focus());
        }),
      );
    }
    if (j.status === "running") btns.appendChild(button("Stop", () => void this.act(() => api(this.key, "POST", "/api/v1/jobs/cancel", { id: j.id }))));
    else btns.appendChild(button("Remove", () => void this.act(() => api(this.key, "DELETE", `/api/v1/jobs?id=${encodeURIComponent(j.id)}`))));
    row.appendChild(btns);
    if (this.handing.has(j.id)) row.appendChild(this.handOver(j));
    return row;
  }

  /** A research table's rows, saved as a spreadsheet file (GET /api/v1/jobs/csv). */
  private csv(j: JobView): Promise<void> {
    return saveFrom(this.key, `/api/v1/jobs/csv?id=${encodeURIComponent(j.id)}`, `${j.title.replace(/[\\/:*?"<>|]/g, "").slice(0, 60) || "table"}.csv`).catch((e) => {
      throw new Error(`Could not download it: ${e instanceof Error ? e.message : String(e)}`);
    });
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

  /** Telling a working job something, in their own words: it takes it in at its next step. */
  private tell(j: JobView): HTMLElement {
    const form = el("div", "rform jobtell");
    const words = document.createElement("textarea");
    words.rows = 2;
    words.maxLength = 1000;
    words.placeholder = "Only ones I can have this week.";
    words.setAttribute("aria-label", `What to tell ${j.title}`);
    words.value = this.telling.get(j.id) ?? "";
    words.addEventListener("input", () => this.telling.set(j.id, words.value));
    // Why it was not passed on is said here, beside what was typed; passed on, the row says when it is taken in.
    const problem = el("small", "rfacts bad");
    const send = button("Send", async () => {
      if (!words.value.trim()) return;
      send.disabled = true;
      try {
        await api(this.key, "POST", "/api/v1/jobs/tell", { id: j.id, text: words.value });
        this.telling.delete(j.id);
        await this.load();
      } catch (e) {
        problem.textContent = e instanceof Error ? e.message : String(e);
        send.disabled = false;
      }
    }, "primary");
    form.append(words, problem, send);
    return form;
  }

  private async fill(id: string, box: HTMLElement): Promise<void> {
    try {
      const j = ((await api(this.key, "GET", `/api/v1/jobs?id=${encodeURIComponent(id)}`)) as { job: JobView }).job;
      box.replaceChildren();
      // Where a link goes is shown, not only what it is called; a research report's are its own searches', listed at its end.
      if (j.result) box.appendChild(markdown(j.result, j.engine === "jarvis" ? "jobtext whole" : "jobtext"));
      if (j.ran?.length) {
        const ran = el("details", "");
        ran.append(el("summary", "", "What it ran"), jobRan(j.ran, j.status !== "running", j.helpers));
        box.appendChild(ran);
      }
      const went = j.status === "running" ? null : jobLive(j);
      if (went) {
        const how = el("details", "");
        how.append(el("summary", "", "What it set out to do"), went);
        box.appendChild(how);
      }
      const asked = el("details", "");
      asked.appendChild(el("summary", "", "What was asked"));
      asked.appendChild(el("div", "jobtext", j.task));
      box.appendChild(asked);
    } catch (e) {
      box.textContent = e instanceof Error ? e.message : String(e);
    }
  }
}

/** Whether a job may be told something: an ordinary one, still working, and not already writing what it has. */
const hears = (j: JobView): boolean => j.engine === "jarvis" && j.status === "running" && !j.wrapping;

/** What a job's answer is missing, or rests on, a line each. */
function flags(head: string, lines: readonly string[]): HTMLElement {
  const box = el("div", "jobflags");
  box.appendChild(el("b", "", head));
  const list = el("ul", "");
  for (const l of lines) list.appendChild(el("li", "", l));
  box.appendChild(list);
  return box;
}

const when = (ts: number) =>
  new Intl.DateTimeFormat([], { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ts));
