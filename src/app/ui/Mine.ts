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
}

/** The voices the server accepts (lib/speech.ts TTS_VOICES). */
const VOICES = ["cedar", "marin", "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];

const ACCOUNTS: { id: "google" | "spotify"; name: string; what: string }[] = [
  { id: "google", name: "Google", what: "your mail, calendar and contacts" },
  { id: "spotify", name: "Spotify", what: "your music" },
];

export class Mine {
  private key: string;
  private box: HTMLElement;
  private prefs: Prefs;

  constructor(key: string, box: HTMLElement, prefs: Prefs) {
    this.key = key;
    this.box = box;
    this.prefs = prefs;
  }

  render(): void {
    this.box.innerHTML = `
      <h3>Your accounts</h3>
      <div class="srv m-accounts"></div>

      <h3>Your voice and language</h3>
      <div class="srv">
        <p class="note">How Jarvis sounds when it answers you out loud, and the language it expects.
          Empty means the family's.</p>
        <select class="m-voice">
          <option value="">The family's voice</option>
          ${VOICES.map((v) => `<option value="${v}"${this.prefs.voice === v ? " selected" : ""}>${v}</option>`).join("")}
        </select>
        <input type="text" class="m-lang" maxlength="12" placeholder="Language, e.g. en, ms, en-GB (empty: the family's)"
          value="${esc(this.prefs.language ?? "")}">
        <div class="rowbtns"><button class="primary m-vsave">Save</button><button class="m-hear">Hear it</button></div>
      </div>

      <h3>Telegram</h3>
      <div class="srv">
        <p class="note">If your family has a Telegram bot, your alerts can reach you there too. Send the bot a message,
          and it tells you your chat number.</p>
        <input type="text" class="m-tg" maxlength="40" placeholder="Your chat number" value="${esc(this.prefs.telegram ?? "")}">
        <div class="rowbtns"><button class="m-tgsave">Save</button></div>
      </div>

      <h3>Alerts on this screen</h3>
      <div class="srv m-alerts"></div>

      <h3>What you have used</h3>
      <div class="srv m-usage"><p class="note">loading…</p></div>
      <div class="res m-res"></div>`;

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
    this.box.querySelector(".m-tgsave")!.addEventListener("click", () =>
      void this.save({ telegram: this.box.querySelector<HTMLInputElement>(".m-tg")!.value.trim() }, "Saved."),
    );
    this.box.querySelector(".m-alerts")!.appendChild(new AlertsPanel(this.key).render());
    void this.accounts();
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
    await fetch(`/api/${id}/unlink`, { method: "POST", headers: authHeaders(this.key), body: "{}" }).catch(() => {});
    this.say("Unlinked.");
    await this.accounts();
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
