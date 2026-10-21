import { doing, said } from "./steps";

/**
 * Typed chat while Jarvis works on a question (main.ts sendTyped): a row of
 * pills where the answer will be, one per tool call as it runs (steps.ts),
 * "Thinking" while none is, gone when the answer takes its place. Never in
 * #status, which push-to-talk and Live also write. And the question being
 * answered, pinned at the top while its answer is read.
 */

/** The question being answered stays at the top of the chat while its answer is read (index.html .pinned); a long one cut short is tapped to read it all. */
export function pin(transcript: HTMLElement, row: HTMLElement): void {
  transcript.querySelector(".row.pinned")?.classList.remove("pinned", "whole");
  row.classList.add("pinned");
  // On its words, not the row's reply hook or photos; and not at the end of selecting some of them.
  row.querySelector(".txt")?.addEventListener("click", () => {
    if (row.classList.contains("pinned") && !getSelection()?.toString()) row.classList.toggle("whole");
  });
}

/** The pills' row, added to the end of the chat. */
export function working(transcript: HTMLElement) {
  const el = document.createElement("div");
  el.className = "row jarvis working";
  el.appendChild(Object.assign(document.createElement("span"), { className: "who", textContent: "Jarvis" }));
  const steps = Object.assign(document.createElement("div"), { className: "steps" });
  steps.setAttribute("role", "status");
  steps.setAttribute("aria-live", "polite");
  const think = Object.assign(document.createElement("span"), { className: "step think", textContent: "Thinking" });
  steps.appendChild(think);
  el.appendChild(steps);
  transcript.appendChild(el);
  const pills = new Map<string, HTMLSpanElement>();
  // Kept in view only if it was in view: someone reading further up is not pulled down.
  const settle = (grow: () => void) => {
    const atEnd = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
    grow();
    think.hidden = [...pills.values()].some((p) => p.classList.contains("run"));
    if (atEnd) transcript.scrollTop = transcript.scrollHeight;
  };
  settle(() => {});
  return {
    /** A tool call started or finished: its pill, by its call's id. */
    tool(ev: { name: string; id?: string; phase: string }) {
      settle(() => {
        const key = ev.id ?? ev.name;
        let pill = pills.get(key);
        if (!pill) {
          pill = Object.assign(document.createElement("span"), { className: "step", textContent: doing(ev.name) });
          pills.set(key, pill);
          steps.insertBefore(pill, think);
        }
        pill.classList.toggle("run", ev.phase === "start");
        pill.classList.toggle("done", ev.phase !== "start");
      });
    },
    /** A tool's own words for what it is doing ("checking Home"), on its pill; without a call, the newest running one. */
    note(text: string, call?: string) {
      const words = said(text);
      if (!words) return;
      settle(() => {
        const running = [...pills.values()].filter((p) => p.classList.contains("run"));
        const pill = (call && pills.get(call)) || running.at(-1) || think;
        pill.textContent = words;
      });
    },
    stop: () => el.remove(),
  };
}
