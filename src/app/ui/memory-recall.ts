import { api } from "../key";
import { button, el } from "./util";

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
  }) : [el("p", "note", "Nothing yet. Each background job, each question whose tools failed, and each answer that took two tools or more, is noted here, so the next one like it goes better.")]));
  return all.length;
}
