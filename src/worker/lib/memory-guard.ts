import { tokenise } from "./memory.ts";

/**
 * What Jarvis may keep when it saves a fact by itself (tools/memory.ts
 * remember). Kept apart from sanitise(), which every read of the memory
 * document goes through (lib/memory.ts sane): a rule there would silently drop
 * facts people already have. The Memory panel is the person's own hand, and
 * is not held to these.
 */

/** A card's first digits, as the networks give them out. */
const CARD = /^(?:4|5[1-5]|2[2-7]|3[457]|6)/;

/** The check digit every payment card's number passes; one number in ten does by chance. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d > 4 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * A secret no memory should hold, saved by mistake or because something Jarvis
 * read asked for it: why not, or null. A door's code and the Wi-Fi's password
 * are the household's to keep.
 */
export function secretShaped(text: string): string | null {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY|\b(?:sk|rk|pk)-[\w-]{16,}|\b(?:gh[posu]_|github_pat_)\w{16,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[\w-]{10,}|\bAIza[\w-]{30,}|\bjdv1_\w{10,}|\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/.test(text)) {
    return "it looks like a key or a token, which memory does not keep";
  }
  if (/\b(?:otp|tac|one[- ]time (?:code|password|pin)|verification code|kod pengesahan)\b[^.]{0,40}?\b\d{4,8}\b|\b\d{4,8}\b[^.]{0,30}?\b(?:otp|tac|one[- ]time (?:code|password|pin)|verification code|kod pengesahan)\b/i.test(text)) {
    return "it looks like a one-time code, which memory does not keep";
  }
  for (const [run] of text.matchAll(/\b\d(?:[ -]?\d){12,18}\b/g)) {
    const digits = run.replace(/\D/g, "");
    if (CARD.test(digits) && luhn(digits)) return "it looks like a payment card's number, which memory does not keep";
  }
  return null;
}

/** Asking for something to be kept, in their words, English or Malay. */
const KEEP = /\b(?:save|remember|store|simpan(?:kan)?|ingat(?:kan)?|catat(?:kan)?)\b|\bnote (?:that|this|it|down)\b|\bkeep (?:this|that|it|these|those)\b/i;

/**
 * Whether a fact is the person's own: their latest message asks for something
 * to be kept, or says at least half of what the fact does. Asked only in a
 * turn that read what someone else wrote (ToolContext.outside), where a fact
 * they never said may be a mail or a page asking to be remembered.
 */
export function saidByThem(said: string | undefined, fact: string): boolean {
  if (!said) return false;
  if (KEEP.test(said)) return true;
  const words = new Set(tokenise(fact));
  words.delete("user");
  const theirs = new Set(tokenise(said));
  return words.size > 0 && [...words].filter((w) => theirs.has(w)).length * 2 >= words.size;
}
