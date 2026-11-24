import { api } from "../key";
import { cameOf, type JobAsk, type JobAsked, type JobView } from "../jobWords";
import { button, el } from "./util";

/**
 * A question a background job put to its person (src/worker/lib/job-tools.ts
 * ask_person), as a card: its choices as buttons, a box for any other words,
 * and Go on without me. In Jobs (ui/Jobs.ts), under its alert and in the
 * conversation (main.ts), and in Home's Now strip (ui/Now.ts). Answered on
 * one, every card for it on this screen says so; answered elsewhere meanwhile
 * (in words, on another screen), or its job over, it says so within seconds
 * (watch).
 *
 * Built with textContent throughout: the question may come from a page the
 * job read, which is to say from strangers.
 */

type Of = Pick<JobView, "id" | "reach">;

/** Which question a card is for: its ids begin again in every job. */
export const askId = (job: string, id: string): string => `${job}:${id}`;

const cards = (job: string, id: string) => document.querySelectorAll<HTMLElement>(`.askcard[data-ask="${CSS.escape(askId(job, id))}"]`);

/** Whether the conversation shows a question already, apart from inside `besides`. */
export const askedIn = (thread: HTMLElement | null, job: string, id: string, besides: HTMLElement): boolean =>
  [...cards(job, id)].some((c) => thread?.contains(c) && !besides.contains(c));

/** What came of it, in place of its buttons. */
function settled(card: HTMLElement, said: string): void {
  card.dataset.said = "1";
  card.querySelectorAll(".askdo").forEach((x) => x.remove());
  card.appendChild(el("small", "pagesaid", said));
}

/** Answered on this screen: every card for it says so. */
function settle(job: string, id: string, said: string): void {
  for (const c of cards(job, id)) if (!c.dataset.said) settled(c, said);
}

/** How often the cards still open are looked at again: soon, while the question is new, and then less. */
const SOON_MS = 8_000;
const LATER_MS = 60_000;
const NEW_MS = 10 * 60_000;
let watching = 0;
let latest = 0;
/** Jobs not found this many times running, or not this screen's to see: not looked at again. */
const misses = new Map<string, number>();
const MISSES = 3;

/** While a card is open and the page is seen, what came of its question, by one look at its job. */
function watch(key: string): void {
  latest = Date.now();
  if (watching) return;
  const again = async (): Promise<void> => {
    const open = [...document.querySelectorAll<HTMLElement>(".askcard:not([data-said])")];
    const jobs = [...new Set(open.map((c) => (c.dataset.ask ?? "").split(":")[0]!))].filter((id) => (misses.get(id) ?? 0) < MISSES);
    if (!jobs.length) return void (watching = 0);
    if (document.visibilityState === "visible") {
      for (const id of jobs) {
        const j = await readJob(key, id);
        misses.set(id, j ? 0 : (misses.get(id) ?? 0) + 1);
        for (const q of j?.asked ?? []) {
          const said = cameOf(q, j!);
          if (said) settle(id, q.id, said);
        }
      }
    }
    watching = setTimeout(() => void again(), Date.now() - latest < NEW_MS ? SOON_MS : LATER_MS);
  };
  watching = setTimeout(() => void again(), SOON_MS);
}

const readJob = (key: string, id: string): Promise<JobView | null> =>
  api(key, "GET", `/api/v1/jobs?id=${encodeURIComponent(id)}`).then((r) => (r as { job: JobView }).job, () => null);

export interface AskShown {
  /** Above the question, where it is not plain whose it is; none where its own words are above the card. */
  tag?: string;
  /** What is typed and not sent, kept by whoever draws the card again (ui/Jobs.ts). */
  typed?: Map<string, string>;
  /** Once it has been answered here. */
  after?: () => void;
}

/** One question, to be answered: with `tag`, its words too. */
export function askCard(key: string, j: Of, q: JobAsk, shown: AskShown = {}): HTMLElement {
  const k = askId(j.id, q.id);
  const card = el("div", "pagecard askcard");
  card.dataset.ask = k;
  if (shown.tag) card.append(el("span", "doctag", shown.tag), el("b", "doctitle", q.text));
  const problem = el("small", "pagesaid bad askdo");
  const send = async (body: { text: string } | { skip: true }, said: string): Promise<void> => {
    const controls = [...card.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")];
    for (const c of controls) c.disabled = true;
    problem.textContent = "";
    try {
      await api(key, "POST", "/api/v1/jobs/tell", { id: j.id, question: q.id, ...body });
    } catch (e) {
      problem.textContent = e instanceof Error ? e.message : String(e);
      for (const c of controls) c.disabled = false;
      // Answered elsewhere meanwhile, or its job has ended: as it stands now. Otherwise why it was refused stays, to be tried again.
      const now = await look(key, j.id, q.id);
      if (now?.said) settle(j.id, q.id, now.said);
      return;
    }
    shown.typed?.delete(k);
    settle(j.id, q.id, said);
    shown.after?.();
  };
  const answer = (text: string) => send({ text }, `You answered: ${text}`);

  if (q.choices.length) {
    const row = el("div", "mdbtns askdo");
    for (const c of q.choices) row.appendChild(button(c, () => void answer(c), "docopen"));
    card.appendChild(row);
  }
  const typing = el("div", "askrow askdo");
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 1000;
  input.placeholder = q.choices.length ? "Or in your own words" : "Your answer";
  input.setAttribute("aria-label", `Your answer to: ${q.text}`);
  input.value = shown.typed?.get(k) ?? "";
  input.addEventListener("input", () => shown.typed?.set(k, input.value));
  const go = () => {
    const text = input.value.trim();
    if (text) void answer(text);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) go();
  });
  typing.append(input, button("Send", go, "docopen primary"));
  const foot = el("div", "askfoot askdo");
  foot.appendChild(button("Go on without me", () => void send({ skip: true }, "You chose to go on without an answer."), "askskip"));
  // What a job on the web is told may go out again in the words of a search.
  if (j.reach === "web") foot.appendChild(el("small", "pagesaid", "This job searches the web: your answer may be part of a search."));
  card.append(typing, foot, problem);
  watch(key);
  return card;
}

/** A question as it stands: what came of it, or that it may be answered; null where this screen may not see its job, or it is gone. */
async function look(key: string, job: string, id: string): Promise<{ j: JobView; q: JobAsked; said: string | null } | null> {
  const j = await readJob(key, job);
  const q = j?.asked?.find((x) => x.id === id);
  return j && q ? { j, q, said: cameOf(q, j) } : null;
}

/** Under the words of a question's alert: its card, as it stands now (one request); its choices in words, where this screen may not answer. */
export function askUnder(key: string, ask: { job: string; id: string }, choices: readonly string[]): HTMLElement {
  const box = el("div", "proposals");
  void look(key, ask.job, ask.id).then((now) => {
    if (!now) return box.append(...(choices.length ? [el("small", "pagesaid", choices.join(" · "))] : []));
    const card = askCard(key, now.j, now.q);
    if (now.said) settled(card, now.said);
    // At the foot of the conversation, it is kept in sight.
    const thread = box.closest<HTMLElement>("#transcript");
    const atEnd = !!thread && thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
    box.appendChild(card);
    if (atEnd) thread.scrollTop = thread.scrollHeight;
  });
  return box;
}
