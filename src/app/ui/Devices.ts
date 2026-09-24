import qrcode from "qrcode-generator";
import { authHeaders } from "../key";

/**
 * Minting and killing device credentials.
 *
 * The token exists in readable form exactly once — only its digest is stored —
 * so this panel's real job is that single moment: show it large, make it
 * copyable, and make it scannable, because typing thirty-seven characters into a
 * pair of glasses is not a thing anyone will do twice.
 *
 * The QR is generated in the browser. A QR *service* would mean handing a
 * credential that can unlock a car to a third party, which is not a trade worth
 * making for a picture.
 */

interface Device {
  id: string;
  name: string;
  scopes: string[];
  hint: string;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const ago = (t?: number) => {
  if (!t) return "never";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 2) return "just now";
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

/** What each scope actually lets a device do, in the words the panel shows. */
const MEANING: Record<string, string> = {
  "*": "everything, including anything added later",
  ask: "ask questions",
  "memory.read": "read saved facts",
  "memory.write": "save and forget facts",
  "car.read": "battery, range, location",
  "car.control": "operate the car, including unlock",
  home: "the house, cameras, Hermes",
  media: "Spotify",
  screen: "maps on the screen",
  voice: "live voice sessions",
};

export class Devices {
  private el: HTMLElement;
  private list: HTMLElement;
  private key: string;
  private scopes: string[] = [];

  constructor(key: string) {
    this.key = key;
    this.el = document.createElement("div");
    this.el.id = "devices";
    this.el.className = "panel";
    this.el.innerHTML = `
      <div class="sheet">
        <header>
          <h2>Devices</h2>
          <button class="close" aria-label="Close">Done</button>
        </header>
        <p class="note">
          Anything that is not the car: a microcontroller, a pair of glasses, a script.
          Each gets its own token and its own reach, and can be revoked on its own.
          See <code>docs/api.md</code>.
        </p>

        <div class="mint">
          <input class="dname" type="text" placeholder="what is it? e.g. garage esp32">
          <div class="scopes"></div>
          <button class="add primary">Create token</button>
        </div>

        <div class="reveal"></div>
        <div class="list"></div>
        <div class="msg"></div>
      </div>`;
    document.body.appendChild(this.el);
    this.list = this.el.querySelector(".list")!;

    this.el.querySelector(".close")!.addEventListener("click", () => this.hide());
    this.el.querySelector(".add")!.addEventListener("click", () => void this.create());
    // Click the backdrop to dismiss, as the settings sheet does.
    this.el.addEventListener("click", (e) => {
      if (e.target === this.el) this.hide();
    });
  }

  async show(): Promise<void> {
    this.el.classList.add("open");
    this.msg("");
    this.el.querySelector<HTMLElement>(".reveal")!.innerHTML = "";
    await this.load();
  }

  hide(): void {
    this.el.classList.remove("open");
    // Never leave a token sitting on screen in a parked car.
    this.el.querySelector<HTMLElement>(".reveal")!.innerHTML = "";
  }

  private msg(text: string, bad = false): void {
    const m = this.el.querySelector<HTMLElement>(".msg")!;
    m.textContent = text;
    m.classList.toggle("bad", bad);
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch("/api/v1/devices", { headers: authHeaders(this.key) });
      if (!res.ok) throw new Error(`devices ${res.status}`);
      const body = (await res.json()) as { devices: Device[]; scopes: string[] };
      this.scopes = body.scopes ?? [];
      this.renderScopes();
      this.render(body.devices ?? []);
    } catch (e) {
      this.msg(`Could not load devices: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  private renderScopes(): void {
    const box = this.el.querySelector<HTMLElement>(".scopes")!;
    if (box.children.length) return;
    box.innerHTML = this.scopes
      .map(
        (s) => `
        <label class="scope${s === "*" ? " wild" : ""}">
          <input type="checkbox" value="${esc(s)}"${s === "ask" ? " checked" : ""}>
          <span><code>${esc(s)}</code> ${esc(MEANING[s] ?? "")}</span>
        </label>`,
      )
      .join("");
  }

  private chosen(): string[] {
    return [...this.el.querySelectorAll<HTMLInputElement>(".scopes input:checked")].map(
      (i) => i.value,
    );
  }

  private async create(): Promise<void> {
    const nameEl = this.el.querySelector<HTMLInputElement>(".dname")!;
    const name = nameEl.value.trim();
    if (!name) {
      this.msg("Give it a name, so you know which one to revoke later.", true);
      return;
    }
    const scopes = this.chosen();
    if (!scopes.length) {
      this.msg("Pick at least one thing it may do.", true);
      return;
    }

    this.msg("Creating…");
    try {
      const res = await fetch("/api/v1/devices", {
        method: "POST",
        headers: authHeaders(this.key),
        body: JSON.stringify({ name, scopes }),
      });
      const body = (await res.json()) as { token?: string; error?: string };
      if (!res.ok || !body.token) throw new Error(body.error ?? `status ${res.status}`);

      nameEl.value = "";
      this.reveal(body.token, name);
      this.msg("");
      await this.load();
    } catch (e) {
      this.msg(`Could not create it: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  /**
   * The one moment the token exists in readable form.
   *
   * The QR encodes the app URL with the token in the fragment, which is the same
   * `#key=…` route the car already uses — so a pair of glasses can scan it and
   * arrive already authenticated, rather than being typed into.
   */
  private reveal(token: string, name: string): void {
    const url = `${location.origin}/#key=${token}`;
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();

    const box = this.el.querySelector<HTMLElement>(".reveal")!;
    box.innerHTML = `
      <div class="token">
        <strong>${esc(name)} — copy this now</strong>
        <p>This is the only time it is shown. Only a digest is stored, so it cannot
           be recovered; if you lose it, delete this device and make another.</p>
        <div class="tok"><code>${esc(token)}</code><button class="copy">Copy</button></div>
        <div class="qr">${qr.createSvgTag({ cellSize: 4, margin: 2 })}</div>
        <p class="dim">Scan to open Jarvis already signed in — for glasses or a phone.
           For firmware, copy the token and send it as
           <code>Authorization: Bearer …</code>.</p>
      </div>`;

    box.querySelector(".copy")!.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(token);
        this.msg("Copied.");
      } catch {
        // Clipboard needs a secure context and permission; selecting is the fallback.
        const r = document.createRange();
        r.selectNodeContents(box.querySelector(".tok code")!);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(r);
        this.msg("Select and copy it manually.");
      }
    });
  }

  private render(devices: Device[]): void {
    if (!devices.length) {
      this.list.innerHTML = `<p class="note">Nothing connected yet.</p>`;
      return;
    }
    this.list.innerHTML = devices
      .map(
        (d) => `
        <div class="dev${d.revokedAt ? " dead" : ""}" data-id="${esc(d.id)}">
          <div class="who">
            <strong>${esc(d.name)}</strong>
            <span class="dim">${esc(d.hint)} · seen ${ago(d.lastSeenAt)}</span>
          </div>
          <div class="grants">${d.scopes.map((s) => `<code>${esc(s)}</code>`).join(" ")}</div>
          <div class="rowbtns">
            ${d.revokedAt ? `<span class="dim">revoked</span>` : `<button class="revoke">Revoke</button>`}
            <button class="del">Delete</button>
          </div>
        </div>`,
      )
      .join("");

    for (const row of this.list.querySelectorAll<HTMLElement>(".dev")) {
      const id = row.dataset.id!;
      const name = row.querySelector("strong")!.textContent ?? id;
      const rev = row.querySelector<HTMLButtonElement>(".revoke");
      const del = row.querySelector<HTMLButtonElement>(".del");
      if (rev) {
        this.arm(rev, "Revoke", () =>
          this.mutate("PATCH", { id, revoked: true }, `Revoked ${name}.`),
        );
      }
      if (del) this.arm(del, "Delete", () => this.mutate("DELETE", { id }, `Deleted ${name}.`));
    }
  }

  /**
   * Two taps instead of a native confirm().
   *
   * confirm() halts the renderer until it is answered — it froze an automated
   * click outright — and a modal dialog is a poor thing to put in front of
   * someone sitting in a car. Arming the button in place asks the same question
   * without stopping everything, and it disarms itself after a few seconds so a
   * stray tap cannot sit there loaded.
   */
  private arm(btn: HTMLButtonElement, label: string, go: () => Promise<void>): void {
    let armed = false;
    let timer = 0;
    const reset = () => {
      armed = false;
      btn.textContent = label;
      btn.classList.remove("armed");
    };
    btn.addEventListener("click", () => {
      if (armed) {
        clearTimeout(timer);
        reset();
        void go();
        return;
      }
      armed = true;
      btn.textContent = label === "Delete" ? "Delete for good?" : "Revoke for good?";
      btn.classList.add("armed");
      timer = setTimeout(reset, 4000) as unknown as number;
    });
  }

  private async mutate(method: string, body: unknown, ok: string): Promise<void> {
    try {
      const res = await fetch("/api/v1/devices", {
        method,
        headers: authHeaders(this.key),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      this.msg(ok);
      await this.load();
    } catch (e) {
      this.msg(`That did not work: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }
}
