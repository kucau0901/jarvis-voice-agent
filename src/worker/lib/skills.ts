import type { Storage } from "./state-host.ts";
import { sanitise } from "./memory.ts";
import { pageUrl } from "./page-look.ts";
import { redact } from "./http.ts";
import { asQuotedData, tidy } from "./quote.ts";
import { makeAlert, type Alert } from "./alerts.ts";
import { OWNER } from "./context.ts";

/**
 * Skills: outside services the owner or an admin added in chat ("add a skill:
 * Nova, my Grok bot, for the house and the car, at https://…"), which Jarvis
 * then sends requests to (tools/skills.ts ask_skill). Added only in the
 * person's own words, the address in them, so a page or a mail cannot add one.
 *
 * Each one's key is set in Settings → Skills (routes/skills.ts), never in
 * chat, and never leaves the Worker again: not to the panel, not to the
 * model. A skill given a new address loses its key, as settings.ts guarded()
 * withholds one whose address changed. The model never names an address: it
 * picks a skill by name, and only skills with a key are offered.
 *
 * A request carries an address to answer it at (replyUrl): one made for it,
 * kept here only as its digest, which takes a few answers for a day and goes
 * to the person who asked, under the skill's name (POST /api/v1/bot/<token>,
 * routes/skills.ts handleBot). So any bot answers later with no token of its
 * own, and its answer shows as its own, under the question it answers.
 *
 * One list for the family, under one key; the requests sent, under another.
 */

export const MAX_SKILLS = 20;
const KEY = "skills";
const MAX_NAME = 40;
const MAX_FIELDS = 8;
const MAX_FIELD = 500;
/** How long a service has to say it took the request. */
const WAIT_MS = 30_000;
/** What of a reply is read, and what of a failure's is quoted. */
const MAX_REPLY = 4000;
const MAX_FAILURE = 200;
/** A reply address's token (lib/devices.ts mintToken): one per request, kept only as its digest. */
export const REPLY_PREFIX = "jrp1_";
const ASKED_KEY = "skill:asked";
/** How long a request's reply address takes answers, and how many: a bot may say it is working, then answer. */
export const ANSWER_MS = 24 * 3_600_000;
export const MAX_ANSWERS = 5;
/** Requests remembered, the newest, across the family. */
const MAX_ASKED = 200;
/**
 * Requests one skill is sent in an hour, whoever asks: where a loop between
 * Jarvis and a bot, or a routine gone wrong, stops.
 */
export const SENDS_PER_HOUR = 20;
const HOUR = 3_600_000;
/** What of a request is kept, to show under its answer. */
const MAX_ABOUT = 200;
/**
 * A quick answer waits this long at most for Jarvis's own reply to the
 * question, so it shows after it, not above it (state.ts conversationAdd
 * lets it go as soon as the reply is kept).
 */
export const SETTLE_MS = 30_000;

export interface Skill {
  id: string;
  name: string;
  url: string;
  /** When to use it, in the words of whoever added it: what the router is told. Empty: only when named. */
  when: string;
  /** Its answer comes later, as a message (POST /api/v1/notify), not in the reply. */
  later: boolean;
  /** A header that carries the key as well as Authorization (X-Automation-Key). */
  keyHeader?: string;
  /** Sent as they are in every request's body. */
  fields: Record<string, string>;
  key?: string;
  /** Jarvis's own public address, as the key was saved from it: where its reply addresses point. */
  origin?: string;
  createdAt: number;
  updatedAt: number;
}

/** A skill as the panel sees it: whether it has a key, never the key. */
export type SkillView = Omit<Skill, "key"> & { hasKey: boolean };

/** A request sent to a skill, while its answers are taken: who asked, and what. */
export interface Asked {
  /** As the request carried it. */
  id: string;
  /** Of its reply address's token, which is kept nowhere. */
  digest: string;
  skill: string;
  /** Who its answers go to: whoever asked (lib/context.ts OWNER for the first person). */
  person: string;
  about: string;
  at: number;
  /** Answers taken so far. */
  uses: number;
}

/** Every request's body has these; a fixed field of one of these names is left out, as Jarvis sets it. */
const ENVELOPE = new Set(["id", "utterance", "source", "replyUrl"]);
/** Headers the request sets itself. */
const OWN_HEADERS = new Set(["authorization", "content-type", "content-length", "host", "cookie", "connection", "transfer-encoding"]);
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const random = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => ALPHABET[b % 32]).join("");
/** A name as compared: its letters and digits, in any script. */
export const nameOf = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const view = ({ key, ...s }: Skill): SkillView => ({ ...s, hasKey: !!key });

/** The fixed fields as given ([{name, value}]), or why not. */
function fieldsOf(raw: unknown): Record<string, string> | string {
  if (raw === null || raw === undefined) return {};
  if (!Array.isArray(raw)) return "fields must be a list";
  if (raw.length > MAX_FIELDS) return `at most ${MAX_FIELDS} fields`;
  const out: Record<string, string> = {};
  for (const f of raw) {
    const { name, value } = (f ?? {}) as { name?: unknown; value?: unknown };
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(name)) return `a field's name must be letters, digits and _ (${String(name)})`;
    // Given anyway, copied from a description of the request ("source": "jarvis"): Jarvis's own stands.
    if (ENVELOPE.has(name)) continue;
    if (typeof value !== "string" || value.length > MAX_FIELD) return `the field "${name}" must be text under ${MAX_FIELD} characters`;
    out[name] = value.replace(/[\u0000-\u001F\u007F]/g, " ").trim();
  }
  return out;
}

export class Skills {
  private storage: Storage;
  constructor(storage: Storage) {
    this.storage = storage;
  }

  private async all(): Promise<Skill[]> {
    return (await this.storage.get<Skill[]>(KEY)) ?? [];
  }

  async list(): Promise<SkillView[]> {
    return (await this.all()).map(view);
  }

  /** What the router may offer: the skills with a key. */
  async ready(): Promise<Skill[]> {
    return (await this.all()).filter((s) => s.key);
  }

  /**
   * Added, or changed if one of that name is kept already; why not, in words.
   * A new address drops its key: it is entered again for the new one.
   */
  async add(input: { name: unknown; url: unknown; when: unknown; later: unknown; keyHeader: unknown; fields: unknown }, now: number): Promise<SkillView | string> {
    const name = sanitise(input.name);
    if (!name.ok) return `its name: ${name.why}`;
    const named = name.text.slice(0, MAX_NAME);
    if (!nameOf(named)) return "its name needs a letter or a digit";
    // Its answers show under its name: never as Jarvis's own.
    if (nameOf(named) === "jarvis") return "a skill cannot be called Jarvis";
    const url = typeof input.url === "string" ? pageUrl(input.url) : null;
    if (!url) return "its address must be https, and not one on the home network";
    // Without one ("add a skill: Friday, at https://…"), it is used only when named (tools/skills.ts askSkill).
    const when = typeof input.when === "string" && input.when.trim() ? sanitise(input.when) : { ok: true as const, text: "" };
    if (!when.ok) return `when to use it: ${when.why}`;
    let keyHeader: string | undefined;
    if (input.keyHeader !== null && input.keyHeader !== undefined && input.keyHeader !== "") {
      if (typeof input.keyHeader !== "string" || !/^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(input.keyHeader)) return "the key's header must be a header name, like X-Api-Key";
      if (OWN_HEADERS.has(input.keyHeader.toLowerCase())) return `${input.keyHeader} is set by Jarvis itself`;
      keyHeader = input.keyHeader;
    }
    const fields = fieldsOf(input.fields);
    if (typeof fields === "string") return fields;
    const all = await this.all();
    const same = all.find((s) => nameOf(s.name) === nameOf(named));
    if (!same && all.length >= MAX_SKILLS) return `that is ${MAX_SKILLS} skills already: remove one first`;
    const s: Skill = {
      id: same?.id ?? "k" + random(8),
      name: named,
      url: url.href,
      when: when.text,
      later: input.later === true,
      ...(keyHeader ? { keyHeader } : {}),
      fields,
      ...(same?.key && same.url === url.href ? { key: same.key } : {}),
      createdAt: same?.createdAt ?? now,
      updatedAt: now,
    };
    await this.storage.put(KEY, same ? all.map((x) => (x.id === same.id ? s : x)) : [...all, s]);
    return view(s);
  }

  /** Its key, from Settings → Skills, and Jarvis's public address as it was saved from (routes/skills.ts); why not, in words. */
  async setKey(id: string, key: unknown, now: number, origin?: string): Promise<SkillView | string> {
    if (typeof key !== "string" || key.length < 8 || key.length > 512 || /\s/.test(key)) return "a key is 8 to 512 characters, without spaces";
    const all = await this.all();
    const s = all.find((x) => x.id === id);
    if (!s) return "no such skill";
    const next = { ...s, key, ...(origin ? { origin } : {}), updatedAt: now };
    await this.storage.put(KEY, all.map((x) => (x.id === id ? next : x)));
    return view(next);
  }

  /** Removed, by its id or its name: the one removed, if there was one. Its reply addresses go with it. */
  async remove(which: string): Promise<SkillView | null> {
    const all = await this.all();
    const name = nameOf(which);
    const gone = all.find((s) => s.id === which || (!!name && nameOf(s.name) === name));
    if (!gone) return null;
    await this.storage.put(KEY, all.filter((s) => s.id !== gone.id));
    const asked = (await this.storage.get<Asked[]>(ASKED_KEY)) ?? [];
    if (asked.some((a) => a.skill === gone.id)) await this.storage.put(ASKED_KEY, asked.filter((a) => a.skill !== gone.id));
    return view(gone);
  }

  /**
   * A request about to be sent to a skill, for `person`, its reply address's
   * digest kept: its id, or why not (SENDS_PER_HOUR). Those past ANSWER_MS go.
   */
  async asked(input: { skill: string; person: string; about: string; digest: string }, now: number): Promise<{ id: string } | string> {
    const s = (await this.all()).find((x) => x.id === input.skill);
    if (!s) return "no such skill";
    const live = ((await this.storage.get<Asked[]>(ASKED_KEY)) ?? []).filter((a) => now - a.at < ANSWER_MS);
    if (live.filter((a) => a.skill === s.id && now - a.at < HOUR).length >= SENDS_PER_HOUR) {
      return `${s.name} has been sent ${SENDS_PER_HOUR} requests in the past hour; ask again later`;
    }
    const id = `jarvis-${Math.floor(now / 1000)}-${random(6)}`;
    const a: Asked = { id, digest: input.digest, skill: s.id, person: input.person, about: tidy(input.about).slice(0, MAX_ABOUT), at: now, uses: 0 };
    await this.storage.put(ASKED_KEY, [...live, a].slice(-MAX_ASKED));
    return { id };
  }

  /**
   * An answer posted to a request's reply address (by its token's digest):
   * the alert for whoever asked, under the skill's name, or why not, with the
   * status to say it with. A refused one is not counted. `answered` says
   * whether Jarvis has replied to them since the request: one that comes
   * before that is held until then (holdUntil), SETTLE_MS at most.
   */
  async answer(
    digest: string,
    body: Record<string, unknown>,
    now: number,
    answered?: (person: string, since: number) => Promise<boolean>,
  ): Promise<{ alert: Alert; at: number; holdUntil?: number } | { refused: 400 | 404 | 429; why: string }> {
    const asked = (await this.storage.get<Asked[]>(ASKED_KEY)) ?? [];
    const i = asked.findIndex((a) => a.digest === digest && now - a.at < ANSWER_MS);
    const a = asked[i];
    const s = a && (await this.all()).find((x) => x.id === a.skill);
    if (!a || !s) return { refused: 404, why: "no such address" };
    if (a.uses >= MAX_ANSWERS) return { refused: 429, why: `that request has had its ${MAX_ANSWERS} answers` };
    const alert = skillAlert(s, body, now, a.person, a.about);
    if (!alert) return { refused: 400, why: "text is required" };
    asked[i] = { ...a, uses: a.uses + 1 };
    await this.storage.put(ASKED_KEY, asked);
    const early = !!answered && now < a.at + SETTLE_MS && !(await answered(a.person, a.at));
    return { alert, at: a.at, ...(early ? { holdUntil: a.at + SETTLE_MS } : {}) };
  }
}

/**
 * The held answers Jarvis's reply to `person` lets go: those held for it
 * (`reply`), not one held for quiet hours. Due now, and said now, so each
 * sorts after the reply on every screen.
 */
export function heldToRelease(
  held: Map<string, { alert: Alert; until: number; reply?: boolean }>,
  person: string,
  now: number,
): [string, { alert: Alert; until: number }][] {
  return [...held]
    .filter(([, h]) => h.reply && (h.alert.for ?? OWNER) === person)
    .map(([k, h]) => [k, { alert: { ...h.alert, at: now }, until: now }]);
}

/**
 * What a skill said, as an alert for `person`: under its own name, whatever
 * title it gave put before its words, and `about`, the request it answers.
 * Never urgent: an address that leaked must not reach every channel.
 */
export function skillAlert(s: Pick<Skill, "id" | "name">, b: Record<string, unknown>, now: number, person: string, about?: string): Alert | null {
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text) return null;
  const title = typeof b.title === "string" ? tidy(b.title).slice(0, 80) : "";
  const a = makeAlert({ title: s.name, text: redact(title && nameOf(title) !== nameOf(s.name) ? `${title}: ${text}` : text), speak: b.speak, expiresAt: b.expiresAt }, "api", now, person);
  return a && { ...a, skill: { id: s.id, name: s.name, ...(about ? { about } : {}) } };
}

/* ---------- calling one ---------------------------------------------------- */

/** A request as sent (Skills.asked): its id, its reply address's token, and that address, when Jarvis knows its own. */
export interface Sent {
  id: string;
  token?: string;
  url?: string;
}

/**
 * The request a skill is sent: a POST of JSON, the key as a Bearer
 * credential and in its own header if the skill names one, and a body of
 * the request, an id the service can answer to, who sent it, where to
 * answer it later, and the skill's fixed fields.
 */
export function skillRequest(s: Skill, request: string, sent: Sent): RequestInit & { headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (s.key) {
    headers.Authorization = `Bearer ${s.key}`;
    if (s.keyHeader) headers[s.keyHeader] = s.key;
  }
  return { method: "POST", headers, body: JSON.stringify({ id: sent.id, utterance: request, source: "jarvis", ...(sent.url ? { replyUrl: sent.url } : {}), ...s.fields }) };
}

/** A reply's words: `text` of the JSON many bots answer with, else the reply as it is. */
function wordsOf(reply: string): string {
  try {
    const j = JSON.parse(reply) as unknown;
    if (j && typeof j === "object" && typeof (j as { text?: unknown }).text === "string") return (j as { text: string }).text.trim();
  } catch {
    // not JSON: as it is
  }
  return reply;
}

/**
 * Send a skill a request; what happened, for the model. Never the key or the
 * reply token: a service's error page or a transport error can quote them
 * back, so anything it said has them taken out, then redact(). A redirect is
 * not followed: the key would go along with it. Answered later (a 202, or
 * nothing said, or a skill that always does): said so, and that the answer
 * comes into the conversation under its name, so it is never asked again to
 * find out.
 */
export async function callSkill(s: Skill, request: string, signal: AbortSignal, sent: Sent): Promise<string> {
  if (!s.key) return `${s.name} has no key yet: it goes in Settings → Skills.`;
  const hide = (t: string) => redact([s.key!, sent.token ?? ""].filter(Boolean).reduce((x, secret) => x.split(secret).join("***"), t));
  const id = sent.id;
  const init = skillRequest(s, request, sent);
  let res: Response;
  try {
    res = await fetch(s.url, { ...init, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(WAIT_MS)]) });
  } catch (e) {
    return `Not sent: ${s.name} could not be reached (${hide(e instanceof Error ? e.message : String(e)).slice(0, MAX_FAILURE)}).`;
  }
  const text = (await res.text().catch(() => "")).slice(0, MAX_REPLY).trim();
  if (res.status >= 300 && res.status < 400) return `Not sent: ${s.name} answered with a redirect, which is not followed with its key. Its address may have moved: add the skill again with the new one.`;
  if (!res.ok) {
    const why = text ? `\n${asQuotedData(`${s.name} answer`, hide(text).slice(0, MAX_FAILURE), s.name.toUpperCase())}` : "";
    return `Not sent: ${s.name} answered ${res.status}.${why}`;
  }
  const said = wordsOf(text);
  if (s.later || res.status === 202 || !said) {
    return (
      `Sent to ${s.name} (request ${id}). Its answer comes into this conversation as a message from ${s.name}, after your reply: ` +
      "say so in a few words; do not wait for it, guess it, or send it again to check."
    );
  }
  return asQuotedData(`${s.name} answer`, hide(said), s.name.toUpperCase());
}
