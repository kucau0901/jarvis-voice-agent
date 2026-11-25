import { api } from "../key";
import { sizeSaid } from "../jobWords";
import { arm, button, el } from "./util";

/**
 * Jobs → Sites: what jobs built and a tap published (src/worker/lib/sites.ts),
 * where each is, and how to put it back as it was or take it down.
 */

interface Site { name: string; at: number; files: number; bytes: number; down?: true; before?: number }

const when = (at: number) => new Date(at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Sites {
  el = document.createElement("details");
  private key: string;
  private list = el("div", "rlist");
  private msg = el("small", "rfacts", "");

  constructor(key: string) {
    this.key = key;
    this.el.className = "projects";
    this.el.hidden = true;
    this.msg.setAttribute("role", "status");
    this.el.append(el("summary", "", "Sites"), el("p", "note", "What jobs built and you published. Each keeps the version before it, to put back."), this.msg, this.list);
  }

  async load(): Promise<void> {
    try {
      const { sites, address } = (await api(this.key, "GET", "/api/v1/sites")) as { sites: Site[] | null; address: string | null };
      this.el.hidden = !sites?.length;
      this.el.querySelector("summary")!.textContent = `Sites (${sites?.length ?? 0})`;
      this.list.replaceChildren(...(sites ?? []).map((s) => this.row(s, address)));
    } catch (e) {
      this.say(why(e), true);
    }
  }

  private say(text: string, bad = false): void {
    this.msg.textContent = text;
    this.msg.classList.toggle("bad", bad);
  }

  private async act(name: string, op: "back" | "down", done: string): Promise<void> {
    try {
      await api(this.key, "POST", "/api/v1/sites", { name, op });
      this.say(done);
    } catch (e) {
      this.say(why(e), true);
    }
    await this.load();
  }

  private row(s: Site, address: string | null): HTMLElement {
    const row = el("div", "routine");
    const top = el("div", "rtop");
    // Only an address its owner gave the sites folder, and only one a browser opens.
    const at = address && /^https?:\/\//.test(address) && !s.down ? `${address.replace(/\/+$/, "")}/${s.name}/` : "";
    const name = at ? Object.assign(document.createElement("a"), { href: at, target: "_blank", rel: "noopener noreferrer", textContent: s.name }) : el("b", "", s.name);
    top.append(name, el("span", `chip ${s.down ? "off" : "on"}`, s.down ? "taken down" : "published"));
    row.append(top, el("div", "rfacts", `${s.files} ${s.files === 1 ? "file" : "files"}, ${sizeSaid(s.bytes)} · ${s.down ? "was " : ""}published ${when(s.at)}${s.before ? ` · the one before, ${when(s.before)}` : ""}`));
    const btns = el("div", "rowbtns");
    if (s.down || s.before) btns.appendChild(button("Put back", () => void this.act(s.name, "back", `“${s.name}” is put back as it was.`)));
    if (!s.down) {
      const down = button("Take down", () => {});
      arm(down, "Take it down?", () => this.act(s.name, "down", `“${s.name}” is taken down, and kept: Put back shows it again.`));
      btns.appendChild(down);
    }
    row.appendChild(btns);
    return row;
  }
}
