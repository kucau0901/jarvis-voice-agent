import { api } from "../key";
import { cameOf, heard, linesOf, nowDoing, powers, progress, type JobCard, type JobView, type Todo } from "../jobWords";
import { askCard, askedIn, askId } from "./JobAsk";
import { jobRan } from "./JobFiles";
import { arm, button, el } from "./util";

/**
 * A background job as it works (src/worker/lib/job-tools.ts): its card, which
 * its person may change, its checklist, and what it is doing this moment. In
 * Jobs (ui/Jobs.ts), and under its pill in the conversation (fromRoutine.ts).
 *
 * Built with textContent throughout: a job's own words may come from pages
 * and mail, which is to say from strangers.
 */

const STATE: Record<Todo["state"], string> = { open: "not yet", doing: "now", done: "done", dropped: "not done" };

/** The checklist, its state said as well as shown. */
function checklist(todo: readonly Todo[]): HTMLElement {
  const list = el("ul", "jobtodo");
  for (const t of todo) {
    const li = el("li", t.state);
    li.append(el("span", "jobstate", `${STATE[t.state]}: `), el("span", "", t.text));
    if (t.why) li.appendChild(el("small", "", t.why));
    list.appendChild(li);
  }
  return list;
}

/** The card: what it will come to, what it keeps to, what it assumes, and what it may do, which code says. */
function card(j: JobView, c: JobCard): HTMLElement {
  const box = el("div", "jobcard");
  box.appendChild(el("b", "", c.outcome));
  if (c.limits.length) box.appendChild(el("div", "", `Keeping to: ${c.limits.join(" · ")}`));
  if (c.assumptions.length) box.appendChild(el("div", "", `Assuming: ${c.assumptions.join(" · ")}`));
  if (j.status === "running") box.appendChild(el("small", "", powers(j)));
  return box;
}

/** In Jobs: the card, the list, what it asked and was told. Null for a job with none of them (one or two lookups, research, Hermes). */
export function jobLive(j: JobView): HTMLElement | null {
  const box = el("div", "jobwork");
  if (j.card) box.appendChild(card(j, j.card));
  if (j.todo?.length) box.appendChild(checklist(j.todo));
  // The last it ran, while it works; after, all of it is with the whole (ui/Jobs.ts).
  if (j.status === "running" && j.ran?.length) box.appendChild(jobRan(j.ran.slice(-3)));
  // With the whole of it, what it asked and what came of that; while it works, the last things it was told.
  const ended = j.status === "running" ? [] : (j.asked ?? []);
  for (const q of ended) box.appendChild(told(`It asked: ${q.text}`, cameOf(q, j) ?? ""));
  for (const h of heard(ended.length ? { ...j, told: j.told?.filter((t) => !t.to) } : j)) box.appendChild(told(h.said, h.state));
  return box.childElementCount ? box : null;
}

function told(said: string, state: string): HTMLElement {
  const line = el("div", "jobheard", said);
  line.appendChild(el("small", "", state));
  return line;
}

/** The moment, for a running job that has its own tools. */
export const jobNow = (j: JobView): HTMLElement => el("div", "jobnow", nowDoing(j));

/** Changing the card of one still working: what is typed here reaches it at its next step. `typed` is kept by whoever shows it. */
export function cardForm(typed: JobCard, save: (c: JobCard) => void, cancel: () => void): HTMLElement {
  const form = el("div", "rform jobchange");
  const field = (label: string, rows: number, value: string, set: (v: string) => void) => {
    const l = el("label", "", label);
    const t = document.createElement("textarea");
    t.rows = rows;
    t.value = value;
    t.addEventListener("input", () => set(t.value));
    l.appendChild(t);
    form.appendChild(l);
  };
  field("What you will have", 2, typed.outcome, (v) => (typed.outcome = v));
  field("Keeping to, a line each", 3, typed.limits.join("\n"), (v) => (typed.limits = linesOf(v)));
  field("Assuming, a line each", 3, typed.assumptions.join("\n"), (v) => (typed.assumptions = linesOf(v)));
  const btns = el("div", "rowbtns");
  btns.append(button("Tell it", () => save(typed), "primary"), button("Leave it", cancel));
  form.appendChild(btns);
  return form;
}

const EVERY_MS = 4000;
/** One that waits, for its person or the plan: up to a day, so looked at less often. */
const WAITING_MS = 20_000;

/**
 * Under a job's pill in the conversation, while it works: its checklist, the
 * moment, and Stop; the pill says how far it has got, or that it asks them
 * something, and the question is here where its alert did not bring it to this
 * screen (a socket that was down). Asked of the server only
 * while the page is seen, and gone once the result has come, the job has ended
 * (`ended`), or it is not this screen's to see (a device is not shown the jobs
 * its chat starts).
 */
export function follow(key: string, id: string, row: HTMLElement, ended: (j: JobView) => void): void {
  const box = el("div", "joblive");
  const inner = el("div", "jobbox");
  const list = el("div", "");
  const asks = el("div", "jobasks");
  const foot = el("div", "jobfoot");
  const now = el("span", "jobnow");
  const stop = button("Stop", () => {}, "jobstop");
  arm(stop, "Stop it?", async () => {
    await api(key, "POST", "/api/v1/jobs/cancel", { id }).catch(() => {});
    void look();
  });
  foot.append(now, stop);
  inner.append(list, asks, foot);
  box.appendChild(inner);
  let timer = 0;
  let misses = 0;
  let every = EVERY_MS;
  let drawn = "";
  const typed = new Map<string, string>();
  const gone = () => {
    clearTimeout(timer);
    box.remove();
  };
  const look = async (): Promise<void> => {
    clearTimeout(timer);
    const pill = row.querySelector<HTMLElement>(".frompill.working");
    if (!row.isConnected || !pill) return gone();
    if (document.visibilityState === "visible") {
      const j = await api(key, "GET", `/api/v1/jobs?id=${encodeURIComponent(id)}`).then((r) => (r as { job: JobView }).job, () => null);
      if (!j && ++misses > 2) return gone();
      if (j) {
        misses = 0;
        every = j.waiting ? WAITING_MS : EVERY_MS;
        if (j.status !== "running") {
          gone();
          return ended(j);
        }
        const open = j.asks ?? [];
        const thread = row.parentElement;
        // Shown here where the conversation does not show it; one already here stays, its answer may be half typed.
        const drawnHere = new Map([...asks.querySelectorAll<HTMLElement>(".askcard")].map((c) => [c.dataset.ask ?? "", c]));
        const mine = open.filter((q) => drawnHere.has(askId(id, q.id)) || !askedIn(thread, id, q.id, box));
        const here = mine.map((q) => q.id).join();
        const as = JSON.stringify([j.todo, nowDoing(j), open.length]);
        if ((as !== drawn || here !== asks.dataset.asks) && pill.classList.contains("working")) {
          drawn = as;
          const atEnd = !!thread && thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
          list.replaceChildren(...(j.todo?.length ? [checklist(j.todo)] : []));
          if (here !== (asks.dataset.asks ?? "")) asks.replaceChildren(...mine.map((q) => drawnHere.get(askId(id, q.id)) ?? askCard(key, j, q, { tag: "It asks you", typed })));
          asks.dataset.asks = here;
          now.textContent = nowDoing(j);
          pill.querySelector("small")!.textContent = open.length ? "asks you" : (progress(j) ?? "working");
          if (!box.isConnected) row.appendChild(box);
          if (atEnd) thread.scrollTop = thread.scrollHeight;
        }
      }
    }
    timer = setTimeout(() => void look(), every);
  };
  // The row is put in the conversation by whoever asked for it.
  timer = setTimeout(() => void look(), 1500);
}
