/**
 * A rolling transcript, kept so a dropped session can be replaced by a new one
 * that carries the conversation forward.
 *
 * GPT-Live has no renegotiation or resume endpoint — live.create is the only way
 * in — so recovery means starting a fresh session seeded with `input`. The API
 * caps that at 128 messages and 8,192 rendered tokens.
 */
export type Turn = { role: "user" | "assistant"; text: string };

const MAX_TURNS = 100;
// ~4 chars per token, well under the 8,192-token ceiling so the seed can never
// be the thing that makes a reconnect fail.
const MAX_CHARS = 20_000;

export class History {
  private turns: Turn[] = [];

  /** Append to the open turn for this role, or start a new one. */
  add(role: Turn["role"], delta: string): void {
    const last = this.turns[this.turns.length - 1];
    if (last && last.role === role) last.text += delta;
    else this.turns.push({ role, text: delta });
  }

  /** Close the current turn so the next utterance starts a new one. */
  break(): void {
    const last = this.turns[this.turns.length - 1];
    if (last && last.text.trim()) this.turns.push({ role: last.role, text: "" });
  }

  get length(): number {
    return this.turns.filter((t) => t.text.trim()).length;
  }

  /** Newest-first trim, then restored to chronological order. */
  snapshot(): Turn[] {
    const kept: Turn[] = [];
    let chars = 0;
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i]!;
      const text = t.text.trim();
      if (!text) continue;
      if (kept.length >= MAX_TURNS || chars + text.length > MAX_CHARS) break;
      chars += text.length;
      kept.push({ role: t.role, text });
    }
    return kept.reverse();
  }

  clear(): void {
    this.turns = [];
  }
}
