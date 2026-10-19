import { api } from "../key";
import { scopeLabels } from "./Devices";
import { button, el } from "./util";

/**
 * An MCP client such as Grok asking to connect (src/worker/routes/oauth.ts).
 * The request came in the address, and anyone can make such an address, so
 * this says plainly what is asking and where it will send the person back to,
 * and nothing happens until Allow. Allowing makes a device of the person's
 * with what they ticked, which is how it is revoked later: in Devices.
 */
export class Connect {
  private el: HTMLElement;
  private key: string;
  private request: string;
  private scopes: HTMLElement;
  private msg: HTMLElement;

  constructor(key: string, request: string) {
    this.key = key;
    this.request = request;
    const q = new URLSearchParams(request);
    const client = q.get("client_id") ?? "something";
    let host = "";
    try {
      host = new URL(q.get("redirect_uri") ?? "").host;
    } catch {
      // the server says what is wrong with it when Allow is pressed
    }

    this.el = el("div", "panel");
    this.el.id = "connect";
    const sheet = el("div", "sheet");
    const head = el("header", "");
    head.appendChild(el("h2", "", `Connect ${client}`));
    head.appendChild(button("Done", () => this.hide(), "close"));
    sheet.appendChild(head);
    sheet.appendChild(
      el("p", "note",
        `${client} is asking to use Jarvis as you. Allowing it makes a device named "${client}" that ` +
        `may do what you tick below, and sends you back to ${host || "it"}. What it asks, and what ` +
        "Jarvis answers, pass through its servers. Revoke it any time in Devices."),
    );
    const box = el("div", "mint");
    this.scopes = el("div", "scopes");
    box.appendChild(this.scopes);
    box.appendChild(button("Allow", () => void this.allow(), "primary"));
    box.appendChild(button("Not now", () => this.hide()));
    sheet.appendChild(box);
    this.msg = el("div", "msg");
    sheet.appendChild(this.msg);
    this.el.appendChild(sheet);
    document.body.appendChild(this.el);
  }

  async show(): Promise<void> {
    this.el.classList.add("open");
    try {
      // What a device of this person's may be given, as the Devices panel offers it.
      const { scopes } = (await api(this.key, "GET", "/api/v1/devices")) as { scopes: string[] };
      this.scopes.replaceChildren(...scopeLabels(scopes, ["ask"]));
    } catch (e) {
      this.say(`Could not load what it may do: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Closed without allowing: the request leaves the address, and the client hears nothing. */
  hide(): void {
    this.el.classList.remove("open");
    const url = new URL(location.href);
    url.searchParams.delete("connect");
    window.history.replaceState(null, "", url);
  }

  private say(text: string): void {
    this.msg.textContent = text;
    this.msg.classList.add("bad");
  }

  private async allow(): Promise<void> {
    const scopes = [...this.scopes.querySelectorAll<HTMLInputElement>("input:checked")].map((i) => i.value);
    if (!scopes.length) {
      this.say("Pick at least one thing it may do.");
      return;
    }
    try {
      const { redirect } = (await api(this.key, "POST", "/api/v1/devices/connect", { request: this.request, scopes })) as { redirect: string };
      location.href = redirect;
    } catch (e) {
      this.say(`Not connected: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
