import { api } from "../key";
import { button, el } from "./util";

/**
 * Memory → Specialties: the ways of doing things the user saved
 * (lib/specialties.ts), each with its steps and a Forget. Saved by asking
 * Jarvis ("save this as my Monday report"), never typed in here: the steps
 * are what Jarvis did.
 */

interface Specialty { id: string; name: string; when: string[]; steps: string[]; why?: string }

/** Drawn into `box`; how many there are, for the menu. */
export async function showSpecialties(key: string, box: HTMLElement): Promise<number> {
  let all: Specialty[];
  try {
    all = ((await api(key, "GET", "/api/memory/specialties")) as { specialties: Specialty[] }).specialties;
  } catch (e) {
    box.replaceChildren(el("p", "note", `Could not load them: ${e instanceof Error ? e.message : String(e)}`));
    return 0;
  }
  box.replaceChildren(...(all.length ? all.map((s) => {
    const row = el("div", "routine");
    const top = el("div", "rtop");
    top.appendChild(el("b", "", s.name));
    row.appendChild(top);
    if (s.when.length) row.appendChild(el("div", "rwhen", `When you say: ${s.when.join(" · ")}`));
    const steps = el("ol", "rsteps");
    for (const step of s.steps) steps.appendChild(el("li", "", step));
    row.appendChild(steps);
    if (s.why) row.appendChild(el("div", "rfacts", s.why));
    const btns = el("div", "rowbtns");
    btns.appendChild(button("Forget", async () => {
      try {
        await api(key, "DELETE", `/api/memory/specialties?id=${encodeURIComponent(s.id)}`);
        row.remove();
      } catch (e) {
        row.appendChild(el("p", "note", e instanceof Error ? e.message : String(e)));
      }
    }));
    row.appendChild(btns);
    return row;
  }) : [el("p", "note", 'None yet. After Jarvis does something in a few steps, say "save this as a specialty", and it does it the same way next time you ask.')]));
  return all.length;
}

/**
 * Memory → Past attempts: what Jarvis tried for you and how it went
 * (lib/episodes.ts), given to it when a question is like one of them. Each
 * can be forgotten.
 */
interface Episode { id: string; at: number; source: string; goal: string; outcome: "ok" | "failed"; lesson: string; seen: number }

export async function showPast(key: string, box: HTMLElement): Promise<number> {
  let all: Episode[];
  try {
    all = ((await api(key, "GET", "/api/memory/past")) as { past: Episode[] }).past;
  } catch (e) {
    box.replaceChildren(el("p", "note", `Could not load them: ${e instanceof Error ? e.message : String(e)}`));
    return 0;
  }
  const when = (at: number) => new Date(at).toLocaleDateString([], { day: "numeric", month: "short" });
  box.replaceChildren(...(all.length ? all.map((e) => {
    const row = el("div", "routine");
    const top = el("div", "rtop");
    top.append(el("b", "", e.goal), el("small", "", `${when(e.at)} · ${e.outcome === "ok" ? "worked" : "failed"}${e.seen > 1 ? ` · ${e.seen} times` : ""}`));
    row.appendChild(top);
    if (e.lesson) row.appendChild(el("div", `rfacts${e.outcome === "ok" ? "" : " bad"}`, e.lesson));
    const btns = el("div", "rowbtns");
    btns.appendChild(button("Forget", async () => {
      try {
        await api(key, "DELETE", `/api/memory/past?id=${encodeURIComponent(e.id)}`);
        row.remove();
      } catch (err) {
        row.appendChild(el("p", "note", err instanceof Error ? err.message : String(err)));
      }
    }));
    row.appendChild(btns);
    return row;
  }) : [el("p", "note", "Nothing yet. Each background job, and each question whose tools failed, is noted here, so the next one like it goes better.")]));
  return all.length;
}
