import { authHeaders } from "../key";
import { speakText } from "../alerts";
import { AlertsPanel } from "./AlertsPanel";
import { esc } from "./util";

/**
 * What is a person's own, in Family → You (lib/context.ts on the server):
 * their Google and Spotify, where their Telegram messages go, their voice and
 * language, notifications on this screen, and what they have used.
 *
 * The family's settings (Settings, for admins) are the defaults; these lay
 * over them for this one person.
 */

export interface Prefs {
  voice?: string;
  style?: string;
  language?: string;
  telegram?: string;
  presence?: string;
}

/** The voices the server accepts (lib/speech.ts TTS_VOICES). */
const VOICES = ["cedar", "marin", "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];

interface CarView {
  id: string;
  name: string;
  owner: string;
  ownerName: string;
  level: "own" | "see" | "drive";
  vinHint?: string;
  shares?: Record<string, "see" | "drive">;
}

/** What Jarvis will do with the car for them: nothing to do with who can drive it, which is the Tesla app's or key's. */
const LEVEL_WORDS: Record<string, string> = { "": "not shared", see: "can check it", drive: "can control it" };

const ACCOUNTS: { id: "google" | "spotify"; name: string; what: string }[] = [
  { id: "google", name: "Google", what: "your mail, calendar and contacts" },
  { id: "spotify", name: "Spotify", what: "your music" },
];

export class Mine {
  private key: string;
  private box: HTMLElement;
  private prefs: Prefs;
  private haToken: boolean;
  /** What this person may reach (GET /api/hub/me); absent, everything. */
  private scopes: string[] | undefined;

  constructor(key: string, box: HTMLElement, prefs: Prefs, haToken = false, scopes?: string[]) {
    this.key = key;
    this.box = box;
    this.prefs = prefs;
    this.haToken = haToken;
    this.scopes = scopes;
  }

  render(): void {
    // Each a section of Family's menu (sections.ts), under You.
    this.box.innerHTML = `
      <div class="res m-res"></div>
      <section class="svc" data-section="m-accounts" data-title="Accounts">
        <h3>Your accounts</h3>
        <div class="m-accounts"></div>
      </section>

      <section class="svc" data-section="m-cars" data-title="Cars">
        <h3>Cars</h3>
        <div class="m-cars"><p class="note">loading…</p></div>
      </section>

      <section class="svc" data-section="m-home" data-title="Home">
        <h3>Home</h3>
        <h4>Getting home</h4>
        <p class="note">So “remind her when she gets home” waits until you are: your person in Home Assistant,
          which follows your phone. Empty, such reminders go by the time alone.</p>
        <input type="text" class="m-presence" maxlength="60" placeholder="person.yourname" value="${esc(this.prefs.presence ?? "")}">
        <div class="rowbtns"><button class="m-psave">Save</button></div>
        <h4>Your own Home Assistant user</h4>
        <p class="note">Optional. With a token for your own Home Assistant user, the house answers you as yourself:
          its logbook says it was you, and whatever Home Assistant allows your user is what you can do.
          Without one, the family's is used. <b class="m-haset"></b></p>
        <input type="password" class="m-ha" autocomplete="off" placeholder="A long-lived access token from your Home Assistant profile">
        <div class="rowbtns m-harow"><button class="m-hasave">Save</button></div>
      </section>

      <section class="svc" data-section="m-voice" data-title="Voice and language">
        <h3>Your voice and language</h3>
        <p class="note">How Jarvis sounds when it answers you out loud, and the language it expects.
          Empty means the family's.</p>
        <select class="m-voice">
          <option value="">The family's voice</option>
          ${VOICES.map((v) => `<option value="${v}"${this.prefs.voice === v ? " selected" : ""}>${v}</option>`).join("")}
        </select>
        <input type="text" class="m-lang" maxlength="12" placeholder="Language, e.g. en, ms, en-GB (empty: the family's)"
          value="${esc(this.prefs.language ?? "")}">
        <div class="rowbtns"><button class="primary m-vsave">Save</button><button class="m-hear">Hear it</button></div>
      </section>

      <section class="svc" data-section="m-alerts" data-title="Alerts">
        <h3>Alerts</h3>
        <div class="m-alerts"></div>
        <h4>Telegram</h4>
        <p class="note">If your family has a Telegram bot, your alerts can reach you there too. Send the bot a message,
          and it tells you your chat number.</p>
        <input type="text" class="m-tg" maxlength="40" placeholder="Your chat number" value="${esc(this.prefs.telegram ?? "")}">
        <div class="rowbtns"><button class="m-tgsave">Save</button></div>
      </section>

      <section class="svc" data-section="m-usage" data-title="What you have used">
        <h3>What you have used</h3>
        <div class="m-usage"><p class="note">loading…</p></div>
      </section>`;

    this.box.querySelector(".m-vsave")!.addEventListener("click", () =>
      void this.save({
        voice: (this.box.querySelector(".m-voice") as unknown as HTMLSelectElement).value,
        language: this.box.querySelector<HTMLInputElement>(".m-lang")!.value.trim(),
      }, "Saved. Jarvis answers you in it from now on."),
    );
    this.box.querySelector(".m-hear")!.addEventListener("click", async () => {
      const ok = await speakText(this.key, "This is how I sound when I answer you.");
      if (!ok) this.say("Could not play it here.", true);
    });
    this.box.querySelector(".m-psave")!.addEventListener("click", () =>
      void this.save({ presence: this.box.querySelector<HTMLInputElement>(".m-presence")!.value.trim() }, "Saved."),
    );
    this.box.querySelector(".m-tgsave")!.addEventListener("click", () =>
      void this.save({ telegram: this.box.querySelector<HTMLInputElement>(".m-tg")!.value.trim() }, "Saved."),
    );
    this.box.querySelector(".m-alerts")!.appendChild(new AlertsPanel(this.key).render());
    this.box.querySelector(".m-hasave")!.addEventListener("click", () => void this.setHa(this.box.querySelector<HTMLInputElement>(".m-ha")!.value.trim()));
    this.showHa();

    // Only what this person may use: a guest has no accounts, cars or alerts to set up.
    const may = (...need: string[]) => !this.scopes || this.scopes.includes("*") || need.some((x) => this.scopes!.includes(x));
    const shown: Record<string, boolean> = {
      "m-accounts": may("mail", "calendar", "media"),
      "m-cars": may("car.read", "car.control"),
      "m-home": may("home", "chat"),
      "m-alerts": may("alerts"),
    };
    for (const [id, ok] of Object.entries(shown)) if (!ok) this.box.querySelector(`[data-section="${id}"]`)?.remove();
    if (shown["m-cars"]) void this.cars();
    if (shown["m-accounts"]) void this.accounts();
    void this.usage();
  }

  private say(text: string, bad = false): void {
    const r = this.box.querySelector<HTMLElement>(".m-res")!;
    r.textContent = text;
    r.classList.toggle("bad", bad);
  }

  private async save(prefs: Prefs, ok: string): Promise<void> {
    try {
      const res = await fetch("/api/hub/me", { method: "PATCH", headers: authHeaders(this.key), body: JSON.stringify({ prefs }) });
      const body = (await res.json()) as { prefs?: Prefs; error?: string };
      if (!res.ok) throw new Error(body.error ?? `the server said ${res.status}`);
      this.prefs = body.prefs ?? this.prefs;
      this.say(ok);
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), true);
    }
  }

  private async setHa(token: string): Promise<void> {
    try {
      const res = await fetch("/api/hub/me", { method: "PATCH", headers: authHeaders(this.key), body: JSON.stringify({ haToken: token }) });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `the server said ${res.status}`);
      this.haToken = !!token;
      // In place: rendering the whole box again would close its section in Family's menu, and this message with it.
      this.box.querySelector<HTMLInputElement>(".m-ha")!.value = "";
      this.showHa();
      this.say(token ? "Saved: the house now answers you as yourself." : "Removed: the family's is used again.");
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), true);
    }
  }

  /** Whether your own Home Assistant token is set, and the button to remove it if so. */
  private showHa(): void {
    this.box.querySelector(".m-haset")!.textContent = this.haToken ? "Yours is set." : "";
    const row = this.box.querySelector<HTMLElement>(".m-harow")!;
    row.querySelector(".m-haoff")?.remove();
    if (!this.haToken) return;
    const off = document.createElement("button");
    off.className = "m-haoff";
    off.textContent = "Remove mine";
    off.addEventListener("click", () => void this.setHa(""));
    row.appendChild(off);
  }

  /**
   * Cars (routes/hub.ts): your own, with who you share each with and how far,
   * those shared with you, and adding yours.
   */
  private async cars(): Promise<void> {
    const box = this.box.querySelector<HTMLElement>(".m-cars")!;
    let data: { cars: CarView[]; people: { id: string; name: string }[] };
    try {
      const res = await fetch("/api/hub/cars", { headers: authHeaders(this.key) });
      if (!res.ok) throw new Error(String(res.status));
      data = await res.json();
    } catch {
      box.innerHTML = `<p class="note">Could not load cars.</p>`;
      return;
    }
    const mine = data.cars.filter((c) => c.level === "own");
    const shared = data.cars.filter((c) => c.level !== "own");
    const others = (c: CarView) => data.people.filter((p) => p.id !== c.owner);
    box.innerHTML = `
      ${mine.length ? "" : `<p class="note">No car of your own here yet.</p>`}
      ${mine
        .map(
          (c) => `<div class="m-car" data-id="${esc(c.id)}">
            <div class="svchead"><b>${esc(c.name)}</b><span class="chip">yours${c.vinHint ? ` · ${esc(c.vinHint)}` : ""}</span></div>
            ${others(c).length ? `<p class="note">Shared with:</p>` : ""}
            ${others(c)
              .map(
                (p) => `<div class="fieldfoot"><span class="help">${esc(p.name)}</span>
                  <select class="m-share" data-who="${esc(p.id)}">${["", "see", "drive"]
                    .map((l) => `<option value="${l}"${(c.shares?.[p.id] ?? "") === l ? " selected" : ""}>${LEVEL_WORDS[l]}</option>`)
                    .join("")}</select></div>`,
              )
              .join("")}
            ${others(c).length ? `<p class="note">Check: where it is, the battery, the climate. Control: that too, and commands such as lock and unlock, climate, charging and navigation. This is only what Jarvis will do for them. Driving the car is up to the Tesla app or key.</p>` : ""}
            ${c.id === "family" ? `<p class="note">The car in Settings. To change its token, use Settings.</p>` : `<div class="rowbtns"><button class="m-carrm">Remove</button></div>`}
          </div>`,
        )
        .join("")}
      ${shared.length ? `<p class="note">Shared with you:</p>` : ""}
      ${shared.map((c) => `<p class="note"><b>${esc(c.name)}</b>, ${esc(c.ownerName)}'s: through Jarvis you ${c.level === "drive" ? "can control it, locking and unlocking it too" : "can check it (where it is, the battery), not control it"}.</p>`).join("")}
      <details class="m-addcar"><summary>Add my car (Tessie)</summary>
        <input type="text" class="m-carname" maxlength="40" placeholder="Its name, e.g. Aisyah's car">
        <input type="password" class="m-cartoken" autocomplete="off" placeholder="Tessie token: dash.tessie.com → Settings → API">
        <select class="m-carvin" hidden></select>
        <div class="rowbtns"><button class="primary m-caradd">Add</button></div>
      </details>`;

    for (const row of box.querySelectorAll<HTMLElement>(".m-car")) {
      const id = row.dataset.id!;
      for (const sel of [...row.querySelectorAll(".m-share")] as unknown as HTMLSelectElement[]) {
        sel.addEventListener("change", () => void this.carPatch({ id, shares: { [sel.dataset.who!]: sel.value || null } }, "Shared as you chose."));
      }
      row.querySelector(".m-carrm")?.addEventListener("click", async () => {
        await this.said(fetch("/api/hub/cars", { method: "DELETE", headers: authHeaders(this.key), body: JSON.stringify({ id }) }), "Removed.");
        await this.cars();
      });
    }
    box.querySelector(".m-caradd")!.addEventListener("click", () => void this.addCar(box));
  }

  private async carPatch(body: unknown, ok: string): Promise<void> {
    try {
      const res = await fetch("/api/hub/cars", { method: "PATCH", headers: authHeaders(this.key), body: JSON.stringify(body) });
      const b = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(b.error ?? `the server said ${res.status}`);
      this.say(ok);
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), true);
      await this.cars();
    }
  }

  private async addCar(box: HTMLElement): Promise<void> {
    const vinSel = box.querySelector(".m-carvin") as unknown as HTMLSelectElement;
    const body = {
      name: box.querySelector<HTMLInputElement>(".m-carname")!.value.trim(),
      token: box.querySelector<HTMLInputElement>(".m-cartoken")!.value.trim(),
      ...(vinSel.hidden ? {} : { vin: vinSel.value }),
    };
    try {
      const res = await fetch("/api/hub/cars", { method: "POST", headers: authHeaders(this.key), body: JSON.stringify(body) });
      const b = (await res.json()) as { error?: string; choose?: { vin: string; name: string }[] };
      if (res.status === 409 && b.choose) {
        // More than one car on that Tessie account: which is this one?
        vinSel.innerHTML = b.choose.map((v) => `<option value="${esc(v.vin)}">${esc(v.name || v.vin)}</option>`).join("");
        vinSel.hidden = false;
        this.say("That Tessie account has more than one car: choose which, and Add again.");
        return;
      }
      if (!res.ok) throw new Error(b.error ?? `the server said ${res.status}`);
      this.say("Added. Share it with the family below, if you like.");
      await this.cars();
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), true);
    }
  }

  /** Each account: set up for the family or not, and whether this person has linked theirs. */
  private async accounts(): Promise<void> {
    const box = this.box.querySelector<HTMLElement>(".m-accounts")!;
    box.innerHTML = "";
    for (const a of ACCOUNTS) {
      const row = document.createElement("div");
      row.className = "fieldfoot";
      const text = document.createElement("span");
      text.className = "help";
      const btns = document.createElement("div");
      btns.className = "rowbtns";
      row.appendChild(text);
      row.appendChild(btns);
      box.appendChild(row);
      try {
        const res = await fetch(`/api/${a.id}/status`, { headers: authHeaders(this.key) });
        if (res.status === 503) {
          text.textContent = `${a.name}: not set up for the family yet (an admin adds it in Settings).`;
          continue;
        }
        const s = (await res.json()) as { linked?: boolean; account?: string | null };
        text.textContent = s.linked
          ? `${a.name}: linked${s.account ? ` as ${s.account}` : ""}. Jarvis reads ${a.what}.`
          : `${a.name}: not linked. Link yours so Jarvis can reach ${a.what}.`;
        btns.appendChild(this.button(s.linked ? "Link again" : `Link my ${a.name}`, () => void this.link(a.id), !s.linked));
        if (s.linked) btns.appendChild(this.button("Unlink", () => void this.unlink(a.id)));
      } catch {
        text.textContent = `${a.name}: could not check.`;
      }
    }
  }

  private button(label: string, go: () => void, primary = false): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    if (primary) b.className = "primary";
    b.addEventListener("click", go);
    return b;
  }

  private async link(id: string): Promise<void> {
    try {
      const r = await fetch(`/api/${id}/auth`, { headers: authHeaders(this.key) });
      const body = (await r.json()) as { url?: string; error?: string };
      if (!body.url) throw new Error(body.error ?? `the server said ${r.status}`);
      window.open(body.url, "_blank", "noopener");
      this.say("Finish signing in in the new tab, then come back here.");
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), true);
    }
  }

  private async unlink(id: string): Promise<void> {
    await this.said(fetch(`/api/${id}/unlink`, { method: "POST", headers: authHeaders(this.key), body: "{}" }), "Unlinked.");
    await this.accounts();
  }

  /** `ok` if the server agreed; its reason if not. Never "done" for something that was not. */
  private async said(req: Promise<Response>, ok: string): Promise<void> {
    try {
      const res = await req;
      if (res.ok) return this.say(ok);
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      this.say(body.error ?? `the server said ${res.status}`, true);
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), true);
    }
  }

  /** This month, for this person (routes/usage.ts). */
  private async usage(): Promise<void> {
    const box = this.box.querySelector<HTMLElement>(".m-usage")!;
    try {
      const res = await fetch("/api/usage", { headers: authHeaders(this.key) });
      if (!res.ok) throw new Error(String(res.status));
      const r = (await res.json()) as { total: { questions: number; cost: { router: number; live: number; jobs: number }; liveSeconds: number; jobs: number } };
      const t = r.total;
      const dollars = t.cost.router + t.cost.live + t.cost.jobs;
      box.innerHTML = `<p class="note">This month: ${t.questions} question${t.questions === 1 ? "" : "s"}, ` +
        `${Math.round(t.liveSeconds / 60)} minutes of live conversation, ${t.jobs} background job${t.jobs === 1 ? "" : "s"}; ` +
        `about <b>$${dollars.toFixed(2)}</b> at OpenAI's prices.</p>`;
    } catch {
      box.innerHTML = `<p class="note">Could not load it.</p>`;
    }
  }
}
