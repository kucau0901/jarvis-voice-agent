import { api } from "../key";
import { button, el } from "./util";

/**
 * Settings → Export your data: everything Jarvis keeps of you, as one JSON
 * file to keep or take elsewhere (GET /api/export). Secrets are never in it,
 * as they are never sent to this page.
 */
export function exportSection(key: string): HTMLElement {
  const box = el("section", "svc export");
  box.dataset.section = "export";
  box.dataset.title = "Export your data";
  box.dataset.state = "on";
  box.appendChild(el("h3", "", "Export your data"));
  box.appendChild(el("p", "note",
    "Your memory, specialties, past attempts, routines, panels, conversation and jobs, and the household's settings without any key or token, " +
    "as one JSON file."));
  const res = el("div", "res");
  const go = button("Download", async () => {
    go.disabled = true;
    res.textContent = "Gathering it…";
    try {
      const data = await api(key, "GET", "/api/export");
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: `jarvis-export-${new Date().toISOString().slice(0, 10)}.json` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      res.textContent = "Downloaded.";
    } catch (e) {
      res.textContent = `Could not export: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      go.disabled = false;
    }
  }, "primary");
  const row = el("div", "rowbtns");
  row.appendChild(go);
  box.append(row, res);
  return box;
}
