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

/**
 * Settings → Move another Jarvis here: everything the other one keeps, secrets
 * and sign-ins included, pulled by this one's server a page at a time
 * (POST /api/move/import; lib/move.ts). Nothing of it comes to this page: only
 * how much has been taken in.
 */
export function moveSection(key: string): HTMLElement {
  const box = el("section", "svc move");
  box.dataset.section = "move";
  box.dataset.title = "Move another Jarvis here";
  box.dataset.state = "on";
  box.appendChild(el("h3", "", "Move another Jarvis here"));
  box.appendChild(el("p", "note",
    "Brings everything from a Jarvis running somewhere else to this one: the family and how they sign in, devices, memory, routines, " +
    "panels, conversations, settings with their keys, and linked accounts. On the other Jarvis, set a MOVE_KEY secret first " +
    "(24 characters or more) and remove it once the move is done."));
  const from = el("input");
  from.type = "text";
  from.placeholder = "https://jarvis.example.com";
  from.setAttribute("aria-label", "The other Jarvis's address");
  const moveKey = el("input");
  moveKey.type = "password";
  moveKey.placeholder = "Its MOVE_KEY";
  moveKey.autocomplete = "off";
  moveKey.setAttribute("aria-label", "The other Jarvis's MOVE_KEY");
  const replace = el("label", "on");
  const replaceBox = el("input");
  replaceBox.type = "checkbox";
  replace.append(replaceBox, document.createTextNode(" Erase what this Jarvis holds first"));
  const res = el("div", "res");
  const go = button("Move it here", async () => {
    go.disabled = true;
    res.textContent = "Asking the other Jarvis…";
    try {
      let state = 0;
      let kv = 0;
      for (let after: string | null = null; ; ) {
        const step = (await api(key, "POST", "/api/move/import", { from: from.value, key: moveKey.value, after, replace: replaceBox.checked })) as { state: number; kv: number; next: string | null; version: string };
        state += step.state;
        kv += step.kv;
        res.textContent = `Moving from version ${step.version}: ${state + kv} entries so far…`;
        if (step.next === null) break;
        after = step.next;
      }
      moveKey.value = "";
      res.textContent = `Moved ${state + kv} entries. Reload this page and sign in as you did on the other Jarvis; then remove its MOVE_KEY.`;
    } catch (e) {
      res.textContent = `Could not move: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      go.disabled = false;
    }
  }, "primary");
  // After a move: the other Jarvis read again and compared with this one, nothing written.
  const check = button("Check against it", async () => {
    check.disabled = true;
    res.textContent = "Comparing with the other Jarvis…";
    try {
      let same = 0;
      const missing: string[] = [];
      const differ: string[] = [];
      for (let after: string | null = null; ; ) {
        const step = (await api(key, "POST", "/api/move/import", { from: from.value, key: moveKey.value, after, check: true })) as { same: number; missing: string[]; differ: string[]; next: string | null };
        same += step.same;
        missing.push(...step.missing);
        differ.push(...step.differ);
        res.textContent = `Compared ${same + missing.length + differ.length} entries so far…`;
        if (step.next === null) break;
        after = step.next;
      }
      const lines = [`${same} entries are here as the other Jarvis has them.`];
      if (missing.length) lines.push(`Not here (${missing.length}): ${missing.join(", ")}`);
      if (differ.length) lines.push(`Different, as anything the other one has done since the move would be (${differ.length}): ${differ.join(", ")}`);
      if (!missing.length && !differ.length) lines.push("Nothing is missing and nothing differs.");
      res.textContent = lines.join("\n");
    } catch (e) {
      res.textContent = `Could not check: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      check.disabled = false;
    }
  });
  const row = el("div", "rowbtns");
  row.append(go, check);
  res.style.whiteSpace = "pre-wrap";
  box.append(from, moveKey, replace, row, res);
  return box;
}
