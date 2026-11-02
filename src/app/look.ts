import { api } from "./key";
import { button, el } from "./ui/util";

/**
 * Answering what a look around said (src/worker/lib/notice.ts): Not now
 * quiets their looks for three hours; Less of this keeps it as something like
 * which not to raise. Drawn under its words in the conversation (main.ts
 * routineSaid), and replaced by what was done once answered.
 */
export function lookActions(key: string, id: string): HTMLElement {
  const box = el("div", "relayacts");
  const why = el("span", "relayerr");
  const go = async (answer: "later" | "less", done: string) => {
    why.textContent = "";
    try {
      await api(key, "POST", "/api/hub/looks/answer", { id, answer });
      box.replaceWith(el("div", "cdone", done));
    } catch (e) {
      why.textContent = e instanceof Error ? e.message : String(e);
    }
  };
  box.appendChild(button("Not now", () => void go("later", "Quiet for three hours.")));
  box.appendChild(button("Less of this", () => void go("less", "Noted: less of this.")));
  box.appendChild(why);
  return box;
}
