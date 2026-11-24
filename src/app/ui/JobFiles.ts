import { authHeaders } from "../key";
import { ended, sizeSaid, type JobFile, type JobRan } from "../jobWords";
import { button, el } from "./util";

/**
 * What a background job made for you, to save, and what it ran
 * (src/worker/lib/workshop.ts). A file is only ever saved, never opened as a
 * page: whatever is in it, it was made by a program from things strangers may
 * have written. Built with textContent throughout, for the same reason.
 */

/** Something the server has, saved as a file. */
export async function saveFrom(key: string, path: string, name: string): Promise<void> {
  const r = await fetch(path, { headers: authHeaders(key) });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `the server said ${r.status}`);
  const url = URL.createObjectURL(await r.blob());
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The files a job gave, each a button that saves it. `say`: told why one could not be, by who may draw this afresh meanwhile. */
export function jobFiles(key: string, id: string, files: readonly Omit<JobFile, "at">[], say?: (why: string) => void): HTMLElement {
  const box = el("div", "jobfiles");
  const why = el("small", "bad");
  why.setAttribute("role", "status");
  say ??= (t) => (why.textContent = t);
  for (const f of files) {
    const b = button("", async () => {
      b.disabled = true;
      say("");
      try {
        await saveFrom(key, `/api/v1/jobs/file?${new URLSearchParams({ id, n: String(f.n) })}`, f.name);
      } catch (e) {
        say(`Could not save ${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
      b.disabled = false;
    }, "jobfile");
    b.append(el("span", "", f.name), el("small", "", sizeSaid(f.size)));
    b.setAttribute("aria-label", `Save ${f.name}, ${sizeSaid(f.size)}`);
    box.appendChild(b);
  }
  box.appendChild(why);
  return box;
}

/** What it ran, newest last, and how each ended; `over`, its job is too. */
export function jobRan(ran: readonly JobRan[], over = false): HTMLElement {
  const list = el("ol", "jobran");
  for (const r of ran) {
    const li = el("li", "");
    li.append(el("code", "", r.cmd), el("small", "", ended(r, over)));
    list.appendChild(li);
  }
  return list;
}
