import qrcode from "qrcode-generator";
import { authHeaders, isSession } from "../key";
import { addPasskeyHere, joinWithInvite } from "../account";
import { passkeyError, passkeysSupported } from "../passkey";
import { ago, arm, esc } from "./util";
import { dropPerson, loadPeople } from "../people";
import { Mine, type Prefs } from "./Mine";
import { limitsForm, limitsSaid, readLimits, type Access } from "./Limits";
import { SectionMenu, type NavGroup } from "./sections";
import { inCar } from "../client";
import { releasePush } from "../alerts";

/**
 * The family: who is in it, inviting someone, pairing a screen, and your own
 * passkeys and signed-in screens (src/worker/routes/hub.ts). Laid out as
 * Settings is (sections.ts): You, The family and Screens in the menu, one
 * section open at a time, and each member a section of their own.
 *
 * With the owner key and no family yet, this is where one is set up: the
 * holder names themselves, the family and its assistant, and makes the first
 * passkey, becoming its admin.
 */

interface Me {
  owner: boolean;
  claimed: boolean;
  space: { name: string; agentName: string } | null;
  user: { id: string; name: string } | null;
  role: string;
  session: string | null;
  hasPin: boolean;
  /** What this person may reach: the app offers only that. */
  scopes?: string[];
  prefs?: Prefs;
  haToken?: boolean;
  access?: (Omit<Access, "allow"> & { allow?: { entity: string; label: string; actions: string[] }[] }) | null;
}

interface Member {
  id: string;
  name: string;
  role: string;
  you: boolean;
  scopes?: string[];
  custom?: boolean;
  passkeys?: number;
  hasPin?: boolean;
  presence?: string;
  first?: boolean;
  access?: Access | null;
  lastSeenAt?: number;
}

interface Invite {
  id: string;
  role: string;
  name: string;
  user?: string;
  expiresAt: number;
}

/**
 * The car is the screen that shows a code, never the one that types another
 * screen's in: that is a job for the phone in your hand.
 */
const IN_CAR = inCar();

const ROLE_WORDS: Record<string, string> = {
  admin: "Admin — everything, and manages the family",
  adult: "Adult — the house, their own mail, calendar, memory, music and reminders",
  child: "Child — their own memory, calendar and reminders",
  guest: "Guest — asks only",
};

/** What each reach means, as the Devices panel says it. */
const SCOPE_WORDS: Record<string, string> = {
  ask: "ask questions",
  "memory.read": "read saved facts",
  "memory.write": "save facts",
  family: "change what the family shares",
  "car.read": "the car's battery and place",
  "car.control": "operate the car",
  home: "the house and cameras",
  hermes: "Hermes (runs commands)",
  media: "Spotify",
  mail: "mail",
  calendar: "calendar",
  screen: "maps on screen",
  voice: "live voice",
  alerts: "alerts",
  routines: "routines",
};

/** What went wrong, to say once the section is drawn again. */
const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class Family {
  private el: HTMLElement;
  private body: HTMLElement;
  private me: Me | null = null;
  private menu: SectionMenu;

  constructor(
    private readonly key: string,
    private readonly onSignedIn: (token: string) => void,
    /**
     * Show a pairing code on this screen (main.ts): how a screen on the owner
     * key becomes a person's, and how someone else is added to a shared one.
     */
    private readonly onPairHere: () => void,
    /** Something about who is signed in here changed (a PIN): main.ts refreshes it. */
    private readonly onChanged: () => void,
  ) {
    this.el = document.createElement("div");
    this.el.id = "family";
    this.el.className = "panel";
    this.el.innerHTML = `
      <div class="sheet">
        <header>
          <button class="back" type="button">‹ Family</button>
          <h2>Family</h2>
          <button class="close" aria-label="Close">Done</button>
        </header>
        <div class="msg"></div>
        <div class="fbody"></div>
      </div>`;
    document.body.appendChild(this.el);
    this.body = this.el.querySelector(".fbody")!;
    this.menu = new SectionMenu(this.el.querySelector<HTMLElement>(".sheet")!, "jarvis.family.section");
    this.el.querySelector(".close")!.addEventListener("click", () => this.hide());
    this.el.addEventListener("click", (e) => {
      if (e.target === this.el) this.hide();
    });
  }

  async show(): Promise<void> {
    this.el.classList.add("open");
    this.menu.toList();
    this.msg("");
    await this.load();
  }

  hide(): void {
    this.el.classList.remove("open");
    // An invite link is as good as a key to the house: never leave one on screen.
    this.el.querySelectorAll(".reveal").forEach((r) => (r.innerHTML = ""));
  }

  private msg(text: string, bad = false): void {
    const m = this.el.querySelector<HTMLElement>(".msg")!;
    m.textContent = text;
    m.classList.toggle("bad", bad);
  }

  private async api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const res = await fetch(path, {
      method,
      headers: authHeaders(this.key),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `the server said ${res.status}`);
    return data;
  }

  private async load(): Promise<void> {
    try {
      this.me = await this.api<Me>("/api/hub/me");
    } catch (e) {
      this.body.innerHTML = "";
      this.msg(`Could not load the family: ${e instanceof Error ? e.message : String(e)}`, true);
      return;
    }
    if (!this.me.claimed) return this.renderSetup();
    await this.render();
  }

  /* ---------- no family yet: the owner sets it up --------------------------------- */

  private renderSetup(): void {
    // One form, so no menu.
    this.el.querySelector(".sheet")!.classList.remove("setsheet");
    this.body.innerHTML = `
      <p class="note">Share this Jarvis with your family. Each person signs in with their own
        passkey (Face ID, a fingerprint or their phone's PIN), and sees what you let them.
        You become its admin. The owner key keeps working: keep it somewhere safe, as the way
        back in if every passkey is lost.</p>
      <div class="srv">
        <input type="text" class="f-name" maxlength="40" placeholder="Your name" autocomplete="name">
        <input type="text" class="f-space" maxlength="60" placeholder="The family's name, e.g. The Rahmans">
        <input type="text" class="f-agent" maxlength="24" placeholder="What you call the assistant" value="Jarvis">
        <button class="primary f-go">Create my passkey</button>
        ${passkeysSupported() ? "" : `<p class="warn">This browser cannot make a passkey. Do this on your phone or computer, then pair this screen.</p>`}
      </div>`;
    const go = this.body.querySelector<HTMLButtonElement>(".f-go")!;
    go.disabled = !passkeysSupported();
    go.addEventListener("click", async () => {
      const val = (c: string) => this.body.querySelector<HTMLInputElement>(c)!.value.trim();
      const name = val(".f-name");
      if (!name || !val(".f-space")) return this.msg("Your name and the family's name, please.", true);
      go.disabled = true;
      this.msg("Setting up…");
      try {
        const claim = await this.api<{ token: string }>("/api/hub/claim", "POST", {
          name,
          spaceName: val(".f-space"),
          agentName: val(".f-agent") || "Jarvis",
        });
        const joined = await joinWithInvite(claim.token, name);
        this.msg("Done. You are the admin.");
        this.onSignedIn(joined.token);
      } catch (e) {
        this.msg(passkeyError(e), true);
        go.disabled = false;
      }
    });
  }

  /* ---------- the family ------------------------------------------------------------ */

  private async render(): Promise<void> {
    const me = this.me!;
    const admin = me.role === "admin";
    let data: { members: Member[]; invites?: Invite[]; roles?: string[]; scopes?: string[] };
    try {
      data = await this.api("/api/hub/members");
    } catch (e) {
      this.msg(`Could not load the family: ${e instanceof Error ? e.message : String(e)}`, true);
      return;
    }
    const roles = data.roles ?? [];
    const scopes = (data.scopes ?? []).filter((s) => s !== "*");
    // A screen as the person who set up the family is the owner key's to sign in, or theirs.
    const pairable = data.members.filter((m) => !m.first || m.you || me.owner);
    // Chores ride on the family's messages: not for a guest.
    const talks = !me.scopes || me.scopes.includes("*") || me.scopes.includes("chat");

    this.el.querySelector(".sheet")!.classList.add("setsheet");
    this.body.innerHTML = `
      <div class="setwrap">
      <nav class="setnav" aria-label="Family sections"></nav>
      <div class="setbody">
      ${me.owner ? `
      <section class="svc" data-section="owner" data-title="This screen">
        <h3>This screen</h3>
        <p class="note">It is unlocked with the owner key. To make it yours, pair it with your phone: it shows a code,
          you approve it on your phone, and the owner key is kept until you do.</p>
        <div class="rowbtns"><button class="primary f-asme">Pair this screen with my phone</button></div>
      </section>` : ""}

      ${me.access ? `<section class="svc" data-section="pass" data-title="Your pass"><h3>Your pass</h3><div class="f-pass"></div></section>` : ""}

      ${me.user ? `
      <section class="svc" data-section="you" data-title="Profile">
        <div class="svchead"><h3>${esc(me.user.name)}</h3><span class="chip">${esc(me.role)}</span></div>
        <p class="note">${esc(me.space?.name ?? "")} · the assistant is <b>${esc(me.space?.agentName ?? "Jarvis")}</b>.</p>
        <div class="rowbtns">
          <button class="f-rename">Change my name</button>
          <button class="f-signout">Sign out of this screen</button>
        </div>
      </section>
      <div class="f-mine"></div>

      <section class="svc" data-section="screen" data-title="A screen you share">
        <h3>A screen you share</h3>
        <p class="note">The car, or a tablet at home: add each person once, and tap the name at the top to switch.
          With a PIN, nobody can switch into you there${me.hasPin ? "; yours is set" : ""}. Switching away locks you, and so does
          half an hour untouched when others share the screen.</p>
        <div class="rowbtns">
          <button class="primary f-addhere">Add someone to this screen</button>
          ${loadPeople().length > 1 ? `<button class="f-switch">Switch person</button>` : ""}
        </div>
        <input type="password" class="f-pin" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="new-password"
          placeholder="${me.hasPin ? "A new PIN" : "A PIN"}, 4 to 8 digits">
        <div class="rowbtns">
          <button class="f-pinset">${me.hasPin ? "Change my PIN" : "Set my PIN"}</button>
          ${me.hasPin ? `<button class="f-pinoff">Remove my PIN</button>` : ""}
        </div>
      </section>` : ""}

      <div class="f-members"></div>

      ${talks ? `
      <section class="svc" data-section="chores" data-title="Chores">
        <h3>Chores</h3>
        <div class="f-points"><p class="note">loading…</p></div>
      </section>` : ""}

      ${IN_CAR ? "" : `
      <section class="svc" data-section="pair" data-title="Sign in a screen">
        <h3>Sign in another screen</h3>
        <p class="note">Is the car, a tablet or another screen showing a code? Type it here, and that screen signs in.</p>
        <input type="text" class="f-code" maxlength="7" placeholder="ABC DEF" autocapitalize="characters" autocomplete="off">
        ${admin && pairable.length > 1 ? `<select class="f-for">${pairable
          .map((m) => `<option value="${esc(m.id)}"${m.you ? " selected" : ""}>as ${esc(m.you ? "me" : m.name)}</option>`)
          .join("")}</select>` : ""}
        <div class="rowbtns"><button class="primary f-pair">Sign it in</button></div>
      </section>`}

      ${admin ? `
      <section class="svc" data-section="invite" data-title="Invite someone">
        <h3>Invite someone</h3>
        <input type="text" class="f-iname" maxlength="40" placeholder="Their name">
        <select class="f-irole">${roles.map((r) => `<option value="${esc(r)}"${r === "adult" ? " selected" : ""}>${esc(ROLE_WORDS[r] ?? r)}</option>`).join("")}</select>
        <details class="f-ilimits"><summary>Limits for them: until, hours, a pass (for a guest or helper)</summary><div class="f-ilbox"></div></details>
        <div class="rowbtns"><button class="primary f-invite">Make an invite link</button></div>
        <div class="reveal f-ireveal"></div>
        <div class="f-invites"></div>
      </section>

      <section class="svc" data-section="names" data-title="Names">
        <h3>The family's name, and the assistant's</h3>
        <input type="text" class="f-sname" maxlength="60" value="${esc(me.space?.name ?? "")}">
        <input type="text" class="f-aname" maxlength="24" value="${esc(me.space?.agentName ?? "")}">
        <div class="rowbtns"><button class="f-ssave">Save</button></div>
      </section>` : ""}

      ${me.user ? `
      <section class="svc" data-section="signin" data-title="Passkeys and sign-ins">
        <h3>Your passkeys</h3>
        <div class="f-keys"></div>
        <h4>Where you are signed in</h4>
        <div class="f-sessions"></div>
      </section>` : ""}
      </div>
      </div>`;

    const mine = this.body.querySelector<HTMLElement>(".f-mine");
    if (mine) new Mine(this.key, mine, me.prefs ?? {}, !!me.haToken, me.scopes).render();
    this.body.querySelector(".f-ilbox")?.appendChild(limitsForm(null, () => this.houseThings()));
    this.renderPass(me);
    void this.renderPoints(admin);
    this.renderMembers(data.members, admin, roles, scopes);
    if (admin) this.renderInvites(data.invites ?? []);
    this.wire(admin);
    this.buildMenu(data.members, admin);
    if (me.user) await Promise.all([this.renderKeys(), this.renderSessions()]);
  }

  /**
   * You, the family, and screens. An admin has a section for each member;
   * anyone else, one list of who is in the family. Opens on a guest's pass,
   * the owner key's pairing, or your profile.
   */
  private buildMenu(members: Member[], admin: boolean): void {
    const groups: NavGroup[] = [
      ["You", ["owner", "pass", "you", "m-accounts", "m-cars", "m-home", "m-voice", "m-alerts", "m-usage"]],
      ["The family", [...(admin ? members.map((m) => `member:${m.id}`) : ["members"]), "invite", "chores", "names"]],
      ["Screens", ["screen", "pair", "signin"]],
    ];
    this.menu.build(groups, (sections) => ["pass", "owner", "you"].find((id) => sections.some((x) => x.dataset.section === id)) ?? sections[0]?.dataset.section ?? "");
  }

  private renderMembers(members: Member[], admin: boolean, roles: string[], scopes: string[]): void {
    const box = this.body.querySelector<HTMLElement>(".f-members")!;
    // Anyone but an admin: who is in the family, in one list.
    if (!admin) {
      box.innerHTML = `
        <section class="svc" data-section="members" data-title="Members" data-aside="${members.length}">
          <h3>Members</h3>
          ${members.map((m) => `<div class="fieldfoot"><span>${esc(m.name)}${m.you ? " (you)" : ""}</span><span class="chip">${esc(m.role)}</span></div>`).join("")}
        </section>`;
      return;
    }
    // An admin: a section for each, with what they can reach and their limits.
    // The first person's way back in (a passkey link, their PIN) is the owner key's (routes/hub.ts).
    const ownerKey = !!this.me?.owner;
    box.innerHTML = members
      .map(
        (m) => `
        <section class="svc" data-section="member:${esc(m.id)}" data-title="${esc(m.name)}${m.you ? " (you)" : ""}" data-aside="${esc(m.role)}" data-id="${esc(m.id)}" data-name="${esc(m.name)}">
          <div class="svchead">
            <h3>${esc(m.name)}${m.you ? " (you)" : ""}</h3>
            ${!m.you
              ? `<select class="m-role" aria-label="Role">${roles.map((r) => `<option value="${esc(r)}"${r === m.role ? " selected" : ""}>${esc(r)}</option>`).join("")}</select>`
              : `<span class="chip">${esc(m.role)}</span>`}
          </div>
          <p class="note">seen ${ago(m.lastSeenAt)} · ${m.passkeys ?? 0} passkey${m.passkeys === 1 ? "" : "s"}${m.access ? ` · <b>${esc(limitsSaid(m.access))}</b>` : ""}</p>
          ${m.role !== "admin"
            ? `<h4>What they can reach</h4>
               <div class="checks">${scopes
                .map((s) => `<button class="check${m.scopes?.includes(s) ? " on" : ""}" data-scope="${esc(s)}" title="${esc(s)}">${esc(SCOPE_WORDS[s] ?? s)}</button>`)
                .join("")}</div>
               ${m.custom ? `<div class="rowbtns"><button class="m-reset">Back to what a ${esc(m.role)} gets</button></div>` : ""}`
            : ""}
          ${!m.first ? `<details class="m-limits"><summary>Limits: until, hours, a pass</summary><div class="m-lbox"></div><div class="rowbtns"><button class="m-lsave">Save limits</button><button class="m-lclear">No limits</button></div></details>` : ""}
          <h4>Getting home</h4>
          <div class="fieldfoot"><input type="text" class="m-presence" maxlength="60" placeholder="Home Assistant person, for “when home”: person.name" value="${esc(m.presence ?? "")}"><button class="m-psave">Save</button></div>
          ${!m.you
            ? `${m.first && !ownerKey ? `<p class="note">A new passkey link or PIN for them needs the owner key.</p>` : ""}
               <div class="rowbtns">${!m.first || ownerKey ? `<button class="m-link">New passkey link</button>${m.hasPin ? `<button class="m-clearpin">Clear their PIN</button>` : ""}` : ""}<button class="m-remove">Remove</button></div>
               <div class="reveal"></div>`
            : ""}
        </section>`,
      )
      .join("");

    for (const row of box.querySelectorAll<HTMLElement>("[data-id]")) {
      const id = row.dataset.id!;
      const name = row.dataset.name ?? "";
      (row.querySelector(".m-role") as HTMLSelectElement | null)?.addEventListener("change", (e) =>
        void this.change({ user: id, role: (e.target as HTMLSelectElement).value }, `${name} is now ${(e.target as HTMLSelectElement).value}.`),
      );
      for (const b of row.querySelectorAll<HTMLButtonElement>(".check")) {
        b.addEventListener("click", () => {
          b.classList.toggle("on");
          const chosen = [...row.querySelectorAll<HTMLButtonElement>(".check.on")].map((x) => x.dataset.scope!);
          void this.change({ user: id, scopes: chosen }, `Saved what ${name} can reach.`);
        });
      }
      row.querySelector(".m-reset")?.addEventListener("click", () => void this.change({ user: id, scopes: null }, `${name} is back to the defaults.`));
      row.querySelector(".m-link")?.addEventListener("click", async () => {
        try {
          const r = await this.api<{ url: string }>("/api/hub/invites", "POST", { user: id });
          this.reveal(row.querySelector(".reveal")!, r.url, `A new passkey for ${name}`, "For a lost or new phone. It adds a passkey to them; it does not make anyone new.");
        } catch (e) {
          this.msg(e instanceof Error ? e.message : String(e), true);
        }
      });
      // Limits: a guest's pass, a helper's hours, a child's quiet time (lib/access.ts).
      const lbox = row.querySelector<HTMLElement>(".m-lbox");
      if (lbox) {
        const m = members.find((x) => x.id === id);
        const form = limitsForm(m?.access ?? null, () => this.houseThings());
        lbox.appendChild(form);
        row.querySelector(".m-lsave")!.addEventListener("click", () => void this.change({ user: id, access: readLimits(form) }, `Saved ${name}'s limits.`));
        row.querySelector(".m-lclear")!.addEventListener("click", () => void this.change({ user: id, access: null }, `${name} has no limits now.`));
      }
      row.querySelector(".m-psave")?.addEventListener("click", () =>
        void this.change({ user: id, presence: row.querySelector<HTMLInputElement>(".m-presence")!.value.trim() }, `Saved where ${name} is, for “when home”.`),
      );
      const cp = row.querySelector<HTMLButtonElement>(".m-clearpin");
      if (cp) arm(cp, "Clear it?", () => this.change({ user: id, clearPin: true }, `${name}'s PIN is cleared; they can set a new one.`));
      const rm = row.querySelector<HTMLButtonElement>(".m-remove");
      if (rm) {
        arm(rm, `Remove ${name}?`, async () => {
          try {
            await this.api("/api/hub/members", "DELETE", { user: id });
            this.msg(`${name} has been removed, and signed out everywhere.`);
            await this.render();
          } catch (e) {
            this.msg(e instanceof Error ? e.message : String(e), true);
          }
        });
      }
    }
  }

  /**
   * A guest's pass (lib/access.ts): a button for each thing they may work,
   * and when their access ends or is limited to.
   */
  private renderPass(me: Me): void {
    const box = this.body.querySelector<HTMLElement>(".f-pass");
    const a = me.access;
    if (!box || !a) return;
    // When it is yours: its end and its hours; the things are the buttons below.
    const when = limitsSaid({ until: a.until, hours: a.hours });
    box.innerHTML = `
      ${when ? `<p class="note">Jarvis is yours ${esc(when)}.</p>` : ""}
      ${(a.allow ?? [])
        .map(
          (x) => `<div class="fieldfoot"><b>${esc(x.label)}</b><div class="rowbtns">${x.actions
            .map((act) => `<button class="p-act" data-entity="${esc(x.entity)}" data-action="${esc(act)}">${esc(act[0]!.toUpperCase() + act.slice(1))}</button>`)
            .join("")}</div></div>`,
        )
        .join("")}
      <div class="res p-res"></div>`;
    for (const b of box.querySelectorAll<HTMLElement>(".p-act")) {
      b.addEventListener("click", async () => {
        const res = box.querySelector<HTMLElement>(".p-res")!;
        res.textContent = "…";
        try {
          const r = await this.api<{ text: string }>("/api/hub/pass", "POST", { entity: b.dataset.entity, action: b.dataset.action });
          res.textContent = r.text;
        } catch (e) {
          res.textContent = e instanceof Error ? e.message : String(e);
        }
      });
    }
  }

  /** Chore points (lib/relays.ts): earned by saying done to a chore a rota passed on. */
  private async renderPoints(admin: boolean): Promise<void> {
    const box = this.body.querySelector<HTMLElement>(".f-points");
    if (!box) return;
    try {
      const { points } = await this.api<{ points: { name: string; points: number }[] }>("/api/hub/points");
      const any = points.some((p) => p.points > 0);
      box.innerHTML =
        `<p class="note">Set up a rota by asking: “every Saturday at ten, remind Aisyah and Adam in turn to wash the car, 5 points”. ` +
        `Saying done earns the points.</p>` +
        (any ? points.map((p) => `<div class="fieldfoot"><span>${esc(p.name)}</span><b>${p.points}</b></div>`).join("") : `<p class="note">Nobody has points yet.</p>`) +
        (admin && any ? `<div class="rowbtns"><button class="p-reset">Start the tally again</button></div>` : "");
      const reset = box.querySelector<HTMLButtonElement>(".p-reset");
      if (reset) {
        arm(reset, "Start again?", async () => {
          const failed = await this.api("/api/hub/points", "DELETE").then(() => null, why);
          await this.renderPoints(admin);
          if (failed) this.msg(failed, true);
        });
      }
    } catch {
      box.innerHTML = `<p class="note">Chores need the family chat permission.</p>`;
    }
  }

  /** What the house has that a pass could work (routes/hub.ts), asked once per opening of the panel. */
  private things: Promise<{ entity: string; name: string }[]> | null = null;
  private houseThings(): Promise<{ entity: string; name: string }[]> {
    this.things ??= this.api<{ things: { entity: string; name: string }[] }>("/api/hub/house").then((r) => r.things);
    this.things.catch(() => (this.things = null));
    return this.things.then((t) => [...t]);
  }

  private async change(body: unknown, ok: string): Promise<void> {
    try {
      await this.api("/api/hub/members", "PATCH", body);
      this.msg(ok);
      await this.render();
    } catch (e) {
      this.msg(e instanceof Error ? e.message : String(e), true);
      await this.render();
    }
  }

  private renderInvites(invites: Invite[]): void {
    const box = this.body.querySelector<HTMLElement>(".f-invites")!;
    box.innerHTML = invites.length
      ? invites
          .map(
            (i) => `<div class="fieldfoot" data-id="${esc(i.id)}">
              <span class="help">${i.user ? "New passkey for" : "Invite for"} ${esc(i.name || "someone")} (${esc(i.role)}), until ${new Date(i.expiresAt).toLocaleDateString()}</span>
              <button class="i-cancel">Cancel</button></div>`,
          )
          .join("")
      : "";
    for (const row of box.querySelectorAll<HTMLElement>("[data-id]")) {
      row.querySelector(".i-cancel")!.addEventListener("click", async () => {
        const failed = await this.api("/api/hub/invites", "DELETE", { id: row.dataset.id }).then(() => null, why);
        await this.render();
        if (failed) this.msg(failed, true);
      });
    }
  }

  /** An invite link, shown once: to copy, or to scan from their phone. */
  private reveal(box: HTMLElement, url: string, title: string, note: string): void {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    box.innerHTML = `
      <div class="token">
        <strong>${esc(title)}</strong>
        <p>${esc(note)} It works once, for seven days. Send it only to them: whoever opens it first joins.</p>
        <div class="tok"><code>${esc(url)}</code><button class="copy">Copy</button></div>
        <div class="qr">${qr.createSvgTag({ cellSize: 4, margin: 2 })}</div>
      </div>`;
    box.querySelector(".copy")!.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(url);
        this.msg("Copied.");
      } catch {
        this.msg("Select the link and copy it.");
      }
    });
  }

  private wire(admin: boolean): void {
    const q = <T = HTMLElement>(c: string) => this.body.querySelector(c) as T | null;

    // From the owner key to a person: a code to approve on the phone (main.ts).
    q(".f-asme")?.addEventListener("click", () => {
      this.hide();
      this.onPairHere();
    });

    q(".f-rename")?.addEventListener("click", async () => {
      const name = prompt("Your name, as the family sees it:", this.me?.user?.name ?? "");
      if (!name?.trim()) return;
      try {
        await this.api("/api/hub/me", "PATCH", { name });
        await this.load();
      } catch (e) {
        this.msg(e instanceof Error ? e.message : String(e), true);
      }
    });

    const out = q<HTMLButtonElement>(".f-signout");
    if (out) {
      arm(out, "Sign out here?", async () => {
        // This browser's notifications go with it (as putAside in main.ts), before the key does.
        await releasePush(this.key);
        await this.api("/api/hub/signout", "POST", {}).catch(() => {});
        dropPerson(this.key);
        try {
          localStorage.removeItem("jarvis.key");
        } catch { /* private mode */ }
        location.reload();
      });
    }

    q(".f-addhere")?.addEventListener("click", () => {
      this.hide();
      this.onPairHere();
    });
    q(".f-switch")?.addEventListener("click", () => {
      this.hide();
      document.getElementById("title")?.click();
    });
    const setPin = async (pin: string | null) => {
      try {
        await this.api("/api/hub/pin", "POST", { pin });
        this.msg(pin ? "Your PIN is set. Nobody can switch into you on a shared screen without it." : "Your PIN is removed.");
        this.onChanged();
        await this.load();
      } catch (e) {
        this.msg(e instanceof Error ? e.message : String(e), true);
      }
    };
    q(".f-pinset")?.addEventListener("click", () => {
      const pin = q<HTMLInputElement>(".f-pin")!.value.trim();
      if (!/^\d{4,8}$/.test(pin)) return this.msg("A PIN is 4 to 8 digits.", true);
      void setPin(pin);
    });
    const off = q<HTMLButtonElement>(".f-pinoff");
    if (off) arm(off, "Remove it?", () => setPin(null));

    q(".f-pair")?.addEventListener("click", async () => {
      const code = q<HTMLInputElement>(".f-code")!.value;
      const user = q<HTMLSelectElement>(".f-for")?.value;
      try {
        const r = await this.api<{ label: string }>("/api/hub/pair", "POST", { code, ...(user ? { user } : {}) });
        q<HTMLInputElement>(".f-code")!.value = "";
        this.msg(`Done: ${r.label} signs itself in within a few seconds.`);
      } catch (e) {
        this.msg(e instanceof Error ? e.message : String(e), true);
      }
    });

    if (!admin) return;

    q(".f-invite")?.addEventListener("click", async () => {
      const name = q<HTMLInputElement>(".f-iname")!.value.trim();
      const role = q<HTMLSelectElement>(".f-irole")!.value;
      if (!name) return this.msg("Who is it for? A name helps you tell invites apart.", true);
      const lbox = q<HTMLElement>(".f-ilbox");
      // Read whether or not the section is open: limits set and folded away still count.
      const access = lbox ? readLimits(lbox.firstElementChild as HTMLElement) : null;
      try {
        const r = await this.api<{ url: string }>("/api/hub/invites", "POST", { name, role, ...(access ? { access } : {}) });
        q<HTMLInputElement>(".f-iname")!.value = "";
        this.reveal(q(".f-ireveal")!, r.url, `An invite for ${name}`, `They open it on their phone, and make a passkey.`);
        this.msg("");
      } catch (e) {
        this.msg(e instanceof Error ? e.message : String(e), true);
      }
    });

    q(".f-ssave")?.addEventListener("click", async () => {
      try {
        await this.api("/api/hub/space", "PATCH", { name: q<HTMLInputElement>(".f-sname")!.value, agentName: q<HTMLInputElement>(".f-aname")!.value });
        this.msg("Saved.");
        await this.load();
      } catch (e) {
        this.msg(e instanceof Error ? e.message : String(e), true);
      }
    });
  }

  private async renderKeys(): Promise<void> {
    const box = this.body.querySelector<HTMLElement>(".f-keys");
    if (!box) return;
    let passkeys: { id: string; label: string; createdAt: number; lastUsedAt?: number; synced: boolean }[];
    try {
      ({ passkeys } = await this.api<{ passkeys: typeof passkeys }>("/api/hub/passkeys"));
    } catch (e) {
      box.innerHTML = `<p class="note">Could not load your passkeys: ${esc(why(e))}</p>`;
      return;
    }
    box.innerHTML =
      passkeys
        .map(
          (k) => `<div class="fieldfoot" data-id="${esc(k.id)}">
            <span class="help">${esc(k.label)}${k.synced ? " · synced" : ""} · added ${ago(k.createdAt)} · used ${ago(k.lastUsedAt)}</span>
            <button class="k-del">Remove</button></div>`,
        )
        .join("") + (passkeysSupported() && isSession(this.key) ? `<button class="k-add">Add a passkey on this device</button>` : "");
    for (const row of box.querySelectorAll<HTMLElement>("[data-id]")) {
      arm(row.querySelector<HTMLButtonElement>(".k-del")!, "Remove it?", async () => {
        try {
          await this.api("/api/hub/passkeys", "DELETE", { id: row.dataset.id });
          await this.renderKeys();
        } catch (e) {
          this.msg(e instanceof Error ? e.message : String(e), true);
        }
      });
    }
    box.querySelector(".k-add")?.addEventListener("click", async () => {
      try {
        await addPasskeyHere(this.key);
        this.msg("Added.");
        await this.renderKeys();
      } catch (e) {
        this.msg(passkeyError(e), true);
      }
    });
  }

  private async renderSessions(): Promise<void> {
    const box = this.body.querySelector<HTMLElement>(".f-sessions");
    if (!box) return;
    let sessions: { id: string; label: string; via: string; lastSeenAt: number; current: boolean }[];
    try {
      ({ sessions } = await this.api<{ sessions: typeof sessions }>("/api/hub/sessions"));
    } catch (e) {
      box.innerHTML = `<p class="note">Could not load where you are signed in: ${esc(why(e))}</p>`;
      return;
    }
    box.innerHTML = sessions
      .map(
        (s) => `<div class="fieldfoot" data-id="${esc(s.id)}">
          <span class="help">${esc(s.label)}${s.current ? " (this screen)" : ""} · ${s.via === "pairing" ? "paired" : "passkey"} · ${ago(s.lastSeenAt)}</span>
          ${s.current ? "" : `<button class="s-end">Sign out</button>`}</div>`,
      )
      .join("");
    for (const row of box.querySelectorAll<HTMLElement>("[data-id]")) {
      row.querySelector(".s-end")?.addEventListener("click", async () => {
        const failed = await this.api("/api/hub/sessions", "DELETE", { id: row.dataset.id }).then(() => null, why);
        await this.renderSessions();
        if (failed) this.msg(failed, true);
      });
    }
  }
}
