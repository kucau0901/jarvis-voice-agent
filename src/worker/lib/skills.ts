import type { Storage } from "./state-host.ts";
import { sanitise } from "./memory.ts";
import { pageUrl } from "./page-look.ts";
import { redact } from "./http.ts";
import { asQuotedData } from "./quote.ts";

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
 * One list for the family, under one key.
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

export interface Skill {
  id: string;
  name: string;
  url: string;
  /** When to use it, in the words of whoever added it: what the router is told. */
  when: string;
  /** Its answer comes later, as a message (POST /api/v1/notify), not in the reply. */
  later: boolean;
  /** A header that carries the key as well as Authorization (X-Automation-Key). */
  keyHeader?: string;
  /** Sent as they are in every request's body. */
  fields: Record<string, string>;
  key?: string;
  createdAt: number;
  updatedAt: number;
}

/** A skill as the panel sees it: whether it has a key, never the key. */
export type SkillView = Omit<Skill, "key"> & { hasKey: boolean };

/** Every request's body has these; a fixed field cannot take their place. */
const ENVELOPE = new Set(["id", "utterance", "source"]);
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
    if (ENVELOPE.has(name)) return `"${name}" is set by Jarvis in every request`;
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
    const url = typeof input.url === "string" ? pageUrl(input.url) : null;
    if (!url) return "its address must be https, and not one on the home network";
    const when = sanitise(input.when);
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

  /** Its key, from Settings → Skills; why not, in words. */
  async setKey(id: string, key: unknown, now: number): Promise<SkillView | string> {
    if (typeof key !== "string" || key.length < 8 || key.length > 512 || /\s/.test(key)) return "a key is 8 to 512 characters, without spaces";
    const all = await this.all();
    const s = all.find((x) => x.id === id);
    if (!s) return "no such skill";
    const next = { ...s, key, updatedAt: now };
    await this.storage.put(KEY, all.map((x) => (x.id === id ? next : x)));
    return view(next);
  }

  /** Removed, by its id or its name: the one removed, if there was one. */
  async remove(which: string): Promise<SkillView | null> {
    const all = await this.all();
    const name = nameOf(which);
    const gone = all.find((s) => s.id === which || (!!name && nameOf(s.name) === name));
    if (!gone) return null;
    await this.storage.put(KEY, all.filter((s) => s.id !== gone.id));
    return view(gone);
  }
}

/* ---------- calling one ---------------------------------------------------- */

/**
 * The request a skill is sent: a POST of JSON, the key as a Bearer
 * credential and in its own header if the skill names one, and a body of
 * the request, an id the service can answer to, who sent it, and the
 * skill's fixed fields.
 */
export function skillRequest(s: Skill, request: string, now: number): { id: string; init: RequestInit & { headers: Record<string, string>; body: string } } {
  const id = `jarvis-${Math.floor(now / 1000)}-${random(6)}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (s.key) {
    headers.Authorization = `Bearer ${s.key}`;
    if (s.keyHeader) headers[s.keyHeader] = s.key;
  }
  return { id, init: { method: "POST", headers, body: JSON.stringify({ id, utterance: request, source: "jarvis", ...s.fields }) } };
}

/**
 * Send a skill a request; what happened, for the model. Never the key: a
 * service's error page or a transport error can quote it back, so anything
 * it said has the key taken out, then redact(). A redirect is not followed:
 * the key would go along with it.
 */
export async function callSkill(s: Skill, request: string, signal: AbortSignal, now = Date.now()): Promise<string> {
  if (!s.key) return `${s.name} has no key yet: it goes in Settings → Skills.`;
  const hide = (t: string) => redact(t.split(s.key!).join("***"));
  const { id, init } = skillRequest(s, request, now);
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
  if (s.later) {
    return `Sent to ${s.name} (request ${id}). Its answer will reach the user as a message when it is ready: tell them so, briefly, and do not wait for it or guess it.`;
  }
  return text ? asQuotedData(`${s.name} answer`, hide(text), s.name.toUpperCase()) : `Sent to ${s.name}; it answered nothing back.`;
}
