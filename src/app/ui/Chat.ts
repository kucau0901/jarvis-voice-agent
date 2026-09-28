import { authHeaders } from "../key";
import { relayActions } from "../relay";
import { ago, esc, richText } from "./util";

/**
 * The family talking (src/worker/lib/chat.ts): the family room everyone
 * shares, and a conversation with each person. In the room, naming the
 * assistant ("Jarvis, add rice to the list") asks it, and it answers there.
 * What the assistant passed on from someone (lib/relays.ts) appears in your
 * conversation with them, with Done or a reply while it waits.
 *
 * Checked every few seconds while it is open; alerts tell you otherwise.
 */

interface Message {
  id: string;
  at: number;
  from: string;
  name: string;
  text: string;
  relay?: { id: string; kind: string; to: string };
}

interface Convo {
  id: string;
  title: string;
  last: Message | null;
  unread: number;
}

interface Relay {
  id: string;
  status: string;
}

const POLL_MS = 4000;

export class Chat {
  private el: HTMLElement;
  private key: string;
  private agentName: string;
  private me = "";
  private open: string | null = null;
  private last = 0;
  private timer = 0;
  /** Relays sent to this person that still wait for their answer, by id. */
  private waiting = new Set<string>();

  constructor(key: string, agentName: string) {
    this.key = key;
    this.agentName = agentName || "Jarvis";
    this.el = document.createElement("div");
    this.el.id = "chat";
    this.el.className = "panel";
    this.el.innerHTML = `
      <div class="sheet chatsheet">
        <header>
          <button class="back" type="button">‹ Chats</button>
          <h2>Chat</h2>
          <button class="close" aria-label="Close">Done</button>
        </header>
        <div class="chatwrap">
          <nav class="convos"></nav>
          <section class="thread">
            <div class="msgs"></div>
            <div class="compose">
              <input type="text" class="say" maxlength="2000" autocomplete="off">
              <button class="send primary" type="button">Send</button>
            </div>
          </section>
        </div>
        <div class="msg"></div>
      </div>`;
    document.body.appendChild(this.el);
    this.el.querySelector(".close")!.addEventListener("click", () => this.hide());
    this.el.querySelector(".back")!.addEventListener("click", () => this.el.querySelector(".sheet")!.classList.remove("detail"));
    this.el.addEventListener("click", (e) => {
      if (e.target === this.el) this.hide();
    });
    this.el.querySelector(".send")!.addEventListener("click", () => void this.send());
    this.$<HTMLInputElement>(".say").addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.send();
    });
  }

  private $<T = HTMLElement>(sel: string): T {
    return this.el.querySelector(sel) as T;
  }

  private note(text: string, bad = false): void {
    const m = this.$(".msg");
    m.textContent = text;
    m.classList.toggle("bad", bad);
  }

  /** Open it, on a conversation if one is named (a tapped chat alert). */
  async show(convo?: string): Promise<void> {
    this.el.classList.add("open");
    this.note("");
    await this.loadConvos();
    await this.openConvo(convo ?? this.open ?? "family");
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  hide(): void {
    this.el.classList.remove("open");
    clearInterval(this.timer);
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(path, { ...init, headers: authHeaders(this.key) });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `the server said ${res.status}`);
    return data;
  }

  private async loadConvos(): Promise<void> {
    try {
      const { you, convos } = await this.api<{ you: string; convos: Convo[] }>("/api/hub/chat");
      this.me = you;
      const nav = this.$(".convos");
      nav.innerHTML = convos
        .map(
          (c) => `<button class="convo${c.id === this.open ? " on" : ""}" data-id="${esc(c.id)}" type="button">
            <b>${esc(c.title)}</b>${c.unread ? `<span class="unread">${c.unread}</span>` : ""}
            <small>${c.last ? `${esc(c.last.name)}: ${esc(c.last.text.slice(0, 40))}` : "nothing yet"}</small>
          </button>`,
        )
        .join("");
      for (const b of nav.querySelectorAll<HTMLElement>(".convo")) {
        b.addEventListener("click", () => void this.openConvo(b.dataset.id!));
      }
    } catch (e) {
      this.note(`Could not load the chat: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  private async openConvo(id: string): Promise<void> {
    this.open = id;
    this.last = 0;
    this.$(".msgs").innerHTML = "";
    this.el.querySelector(".sheet")!.classList.add("detail");
    for (const b of this.el.querySelectorAll<HTMLElement>(".convo")) b.classList.toggle("on", b.dataset.id === id);
    this.$<HTMLInputElement>(".say").placeholder =
      id === "family" ? `Message the family, or say “${this.agentName}, …” to ask it` : "Message";
    await this.loadWaiting();
    await this.poll();
  }

  /** What was passed on to me and still waits for my answer, so its buttons show. */
  private async loadWaiting(): Promise<void> {
    try {
      const { received } = await this.api<{ received: Relay[] }>("/api/hub/relays");
      this.waiting = new Set(received.filter((r) => r.status === "sent").map((r) => r.id));
    } catch {
      this.waiting.clear();
    }
  }

  private async poll(): Promise<void> {
    if (!this.open) return;
    const convo = this.open;
    try {
      const { messages } = await this.api<{ messages: Message[] }>(`/api/hub/chat/messages?c=${encodeURIComponent(convo)}&since=${this.last}`);
      if (convo !== this.open || !messages.length) return;
      const box = this.$(".msgs");
      const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      for (const m of messages) box.appendChild(this.row(m));
      this.last = messages[messages.length - 1]!.at;
      if (atEnd || messages.some((m) => m.from === this.me)) box.scrollTop = box.scrollHeight;
    } catch {
      // A missed poll is caught up by the next.
    }
  }

  private row(m: Message): HTMLElement {
    const div = document.createElement("div");
    div.className = `cmsg${m.from === this.me ? " mine" : ""}${m.from === "agent" ? " agent" : ""}`;
    const head = document.createElement("div");
    head.className = "cwho";
    head.textContent = `${m.from === this.me ? "You" : m.name} · ${ago(m.at)}`;
    div.appendChild(head);
    div.appendChild(richText(m.text, "ctext"));
    if (m.relay && m.relay.to === this.me && this.waiting.has(m.relay.id)) {
      const acts = relayActions(this.key, m.relay, (said) => {
        this.waiting.delete(m.relay!.id);
        acts.replaceWith(Object.assign(document.createElement("div"), { className: "cdone", textContent: said }));
      });
      div.appendChild(acts);
    }
    return div;
  }

  private async send(): Promise<void> {
    const input = this.$<HTMLInputElement>(".say");
    const text = input.value.trim();
    if (!text || !this.open) return;
    input.value = "";
    try {
      await this.api("/api/hub/chat/messages", { method: "POST", body: JSON.stringify({ c: this.open, text }) });
      await this.poll();
      void this.loadConvos();
    } catch (e) {
      input.value = text;
      this.note(e instanceof Error ? e.message : String(e), true);
    }
  }
}
