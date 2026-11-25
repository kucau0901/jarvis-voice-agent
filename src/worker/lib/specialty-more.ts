import type { Storage } from "./state-host.ts";
import { Specialties, type Specialty } from "./specialties.ts";
import { formatSkill, parseSkill, seen, slugOf, textIn } from "./skill-md.ts";
import { ZipError, readZip, writeZip, type ZipFile } from "./zip.ts";
import { b64u, fromB64u } from "./webauthn.ts";
import { fileName } from "./workshop.ts";
import { wellFormed } from "./quote.ts";

/**
 * What a specialty holds besides its record (lib/specialties.ts): notes at
 * length (pitfalls, examples, another agent's whole skill), small files, where
 * it came from, and what it was before it was changed. Read by background jobs
 * alone (lib/job-specialties.ts): a question in the conversation is given its
 * steps, as before.
 *
 * Kept only by its person's own hand: typed in Memory → Specialties, chosen
 * from a file there, or a tap on a card (tools/specialties.ts
 * specialty_keep). So what it says is theirs to say, instructions included;
 * what nobody can see is taken out of it, since nobody approved that.
 */

/** An answer's steps, what a job was told, typed, or chosen from a file. */
export type Source = "answer" | "learned" | "written" | "imported";

export interface MoreFile {
  n: number;
  name: string;
  size: number;
}

/** As it was, until it was changed. */
export interface Before extends Pick<Specialty, "name" | "when" | "steps" | "why"> {
  at: number;
  text?: string;
  files: MoreFile[];
}

export interface More {
  source: Source;
  text?: string;
  files: MoreFile[];
  before: Before[];
  /** The next file's number: never one used before, so what it was before keeps its own. */
  next: number;
}

/** As the list shows one. */
export interface Way extends Specialty {
  source: Source;
  /** Whether it has notes at length. */
  more: boolean;
  files: MoreFile[];
  before: number;
}

export interface MoreInput {
  id?: unknown;
  name?: unknown;
  when?: unknown;
  steps?: unknown;
  why?: unknown;
  text?: unknown;
  /** One kept already, by its number; or a new one, its bytes. */
  files?: unknown;
}

export const MAX_TEXT = 12_000;
export const MAX_FILES = 10;
export const MAX_FILE = 200_000;
/** Of one specialty's files, and of all a person's. */
export const MAX_OF_ONE = 600_000;
export const MAX_OF_ALL = 4_000_000;
export const MAX_BEFORE = 5;
const MAX_NAME = 60;
const MAX_WHEN = 8;
/** As long as another agent's may be. */
const MAX_WHEN_TEXT = 1_024;
export const MAX_STEPS = 20;
/** As long as a person may tell a job at once (lib/jobs.ts). */
export const MAX_STEP = 1_000;
const MAX_WHY = 300;
/** What an import may be before it is opened, and its SKILL.md before it is read. */
export const MAX_ZIP = 2_000_000;
const MAX_MD = 100_000;

const asWas = (s: Specialty, m: More, now: number): Before => ({ at: now, name: s.name, when: s.when, steps: s.steps, ...(s.why ? { why: s.why } : {}), ...(m.text ? { text: m.text } : {}), files: m.files });

const textKey = (person: string, id: string) => `specialtytext:${person}:${id}`;
const fileKey = (person: string, id: string, n: number) => `specialtyfile:${person}:${id}:${n}`;

const line = (v: unknown): string => (typeof v === "string" ? seen(v).text.replace(/\s+/g, " ").trim() : "");
const lines = (v: unknown): string[] => (Array.isArray(v) ? v : []).map(line).filter(Boolean);
/** Cut where an import's is longer than one may be, and that is said: nothing a person typed is. */
const cut = (s: string, max: number) => wellFormed(s.slice(0, max)).trim();
const many = (n: number) => n.toLocaleString("en-US");

/** A file as it is kept: what nobody can see is taken out of one that is text, since nobody approved that. */
function fileSeen(bytes: Uint8Array): { bytes: Uint8Array; hidden: number } {
  const text = textIn(bytes);
  if (text === null) return { bytes, hidden: 0 };
  const s = seen(text);
  return s.hidden ? { bytes: new TextEncoder().encode(s.text), hidden: s.hidden } : { bytes, hidden: 0 };
}

/** A file's name as it is kept, its folders with it: nothing a disk would stumble on, and no way out. */
export const moreName = (v: unknown): string =>
  typeof v === "string" ? seen(v).text.split(/[\\/]+/).filter((p) => p && p !== "." && p !== "..").slice(-3).map(fileName).join("/").slice(0, 120) : "";

/** A draft for the form: what an import would be, nothing kept. */
export interface Draft {
  name: string;
  when: string[];
  steps: string[];
  why?: string;
  text: string;
  files: { name: string; data: string }[];
  notes: string[];
}

/** A SKILL.md, or a zip of a folder with one, as a draft to be read over; why not, in words. */
export async function importedDraft(name: string, bytes: Uint8Array): Promise<Draft | string> {
  if (bytes.length > MAX_ZIP) return `that file is over ${MAX_ZIP / 1_000_000} MB`;
  let files: ZipFile[] = [];
  let md: Uint8Array | undefined = bytes;
  // A zip says so itself: what it is called does not matter.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    try {
      const all = await readZip(bytes, { files: 40, each: MAX_FILE, total: MAX_OF_ONE });
      const at = all.filter((f) => /(^|\/)skill\.md$/i.test(f.name)).sort((a, b) => a.name.length - b.name.length)[0];
      if (!at) return "there is no SKILL.md in that zip";
      const root = at.name.slice(0, at.name.length - "SKILL.md".length);
      md = at.bytes;
      files = all.filter((f) => f !== at && f.name.startsWith(root)).map((f) => ({ name: f.name.slice(root.length), bytes: f.bytes }));
    } catch (e) {
      if (e instanceof ZipError) return e.message;
      throw e;
    }
  }
  if (md.length > MAX_MD) return `its words come to over ${MAX_MD / 1000} KB`;
  const raw = textIn(md);
  if (raw === null) return "its SKILL.md is not text";
  const skill = parseSkill(raw, name.replace(/\.[^.]*$/, ""));
  if (typeof skill === "string") return skill;
  const notes = [...skill.notes];
  if (skill.body.length > MAX_TEXT) return `it is ${many(skill.body.length)} characters, and one may be ${many(MAX_TEXT)}`;
  if (files.length > MAX_FILES) notes.push(`It has ${files.length} files besides, and one may have ${MAX_FILES}: the first ${MAX_FILES} are here.`);
  if (skill.name.length > MAX_NAME) notes.push(`Its name is long: the first ${MAX_NAME} characters are here.`);
  if (skill.description.length > MAX_WHEN_TEXT) notes.push(`What it says of when to use it is long: the first ${many(MAX_WHEN_TEXT)} characters are here.`);
  const own = files.slice(0, MAX_FILES).map((f) => ({ name: moreName(f.name), ...fileSeen(f.bytes) }));
  for (const f of own) if (f.hidden) notes.push(`${f.hidden} hidden ${f.hidden === 1 ? "character was" : "characters were"} taken out of ${f.name}.`);
  return {
    name: cut(line(skill.name), MAX_NAME),
    when: skill.description ? [cut(line(skill.description), MAX_WHEN_TEXT)] : [],
    steps: [],
    text: skill.body,
    files: own.map((f) => ({ name: f.name, data: b64u(f.bytes) })),
    notes,
  };
}

export class SpecialtyMore {
  private storage: Storage;
  private records: Specialties;
  constructor(storage: Storage) {
    this.storage = storage;
    this.records = new Specialties(storage);
  }

  private async get(person: string, id: string): Promise<More> {
    return (await this.storage.get<More>(textKey(person, id))) ?? { source: "answer", files: [], before: [], next: 1 };
  }

  /** Every one of a person's, as the list shows it. */
  async all(person: string): Promise<Way[]> {
    const more = await this.storage.list<More>({ prefix: `specialtytext:${person}:` });
    return (await this.records.of(person)).map((s) => {
      const m = more.get(textKey(person, s.id));
      return { ...s, source: m?.source ?? "answer", more: !!m?.text, files: m?.files ?? [], before: m?.before.length ?? 0 };
    });
  }

  /** One, whole; null when it is not kept. */
  async whole(person: string, id: string): Promise<{ specialty: Specialty; more: More } | null> {
    const specialty = (await this.records.of(person)).find((s) => s.id === id);
    return specialty ? { specialty, more: await this.get(person, id) } : null;
  }

  async file(person: string, id: string, n: number): Promise<{ name: string; bytes: Uint8Array } | null> {
    const f = (await this.get(person, id)).files.find((x) => x.n === n);
    const data = f ? await this.storage.get<string>(fileKey(person, id, n)) : undefined;
    return f && data !== undefined ? { name: f.name, bytes: fromB64u(data) } : null;
  }

  /**
   * Kept as its person has it, new, or by its id changed: its record, its notes
   * and its files. What it was before is kept with it, the last few times. `mayFiles`:
   * whether they may have files with one, which are for the workshop. Why not,
   * in words.
   */
  async save(person: string, input: MoreInput, source: Source, mayFiles: boolean, now: number): Promise<Specialty | string> {
    const name = line(input.name);
    if (!name) return "it needs a name";
    if (name.length > MAX_NAME) return `its name is ${name.length} characters, and one may be ${MAX_NAME}`;
    const steps = lines(input.steps);
    if (steps.length > MAX_STEPS) return `it has ${steps.length} steps, and it may have ${MAX_STEPS}`;
    const long = steps.findIndex((s) => s.length > MAX_STEP);
    if (long >= 0) return `step ${long + 1} is ${many(steps[long]!.length)} characters, and one may be ${many(MAX_STEP)}`;
    const text = typeof input.text === "string" ? seen(input.text).text.trim() : "";
    if (text.length > MAX_TEXT) return `its notes are ${many(text.length)} characters, and they may be ${many(MAX_TEXT)}`;
    if (!steps.length && !text) return "it needs its steps, or notes";
    const when = lines(input.when);
    if (when.length > MAX_WHEN) return `it has ${when.length} lines of when to use it, and it may have ${MAX_WHEN}`;
    if (when.some((w) => w.length > MAX_WHEN_TEXT)) return `when to use it: a line may be ${many(MAX_WHEN_TEXT)} characters`;
    const why = line(input.why);
    if (why.length > MAX_WHY) return `why is ${why.length} characters, and it may be ${MAX_WHY}`;
    const id = typeof input.id === "string" && input.id ? input.id : undefined;
    const was = id ? (await this.records.of(person)).find((s) => s.id === id) : undefined;
    if (id && !was) return "it is not kept any more";
    const had = was ? await this.get(person, was.id) : null;

    // Which files it has now: those kept already, and new ones, each by its name.
    const files: MoreFile[] = [];
    const fresh: { file: MoreFile; data: string }[] = [];
    let next = had?.next ?? 1;
    for (const f of (Array.isArray(input.files) ? input.files : (had?.files ?? [])) as { n?: unknown; name?: unknown; data?: unknown }[]) {
      const kept = had?.files.find((x) => x.n === f?.n);
      if (kept) {
        files.push(kept);
        continue;
      }
      const called = moreName(f?.name);
      if (!called || typeof f?.data !== "string") return "a file needs a name and what is in it";
      let bytes: Uint8Array;
      try {
        ({ bytes } = fileSeen(fromB64u(f.data)));
      } catch {
        return `${called} could not be read`;
      }
      if (bytes.length > MAX_FILE) return `${called} is over ${MAX_FILE / 1000} KB`;
      if (files.some((x) => x.name === called)) return `two files are called ${called}`;
      const file = { n: next++, name: called, size: bytes.length };
      files.push(file);
      fresh.push({ file, data: b64u(bytes) });
    }
    if (fresh.length && !mayFiles) return "files are for whoever may have a job use the workshop";
    if (files.length > MAX_FILES) return `it has ${files.length} files, and it may have ${MAX_FILES}`;
    if (files.reduce((n, f) => n + f.size, 0) > MAX_OF_ONE) return `its files come to more than ${MAX_OF_ONE / 1000} KB`;
    if (fresh.length) {
      const held = new Map<string, number>();
      for (const [k, m] of await this.storage.list<More>({ prefix: `specialtytext:${person}:` })) for (const f of [...m.files, ...m.before.flatMap((b) => b.files)]) held.set(`${k} ${f.n}`, f.size);
      const total = [...held.values(), ...fresh.map((f) => f.file.size)].reduce((n, x) => n + x, 0);
      if (total > MAX_OF_ALL) return `all your specialties' files come to more than ${MAX_OF_ALL / 1_000_000} MB`;
    }

    // Where it came from stays, whoever changes it since: an import changed by hand is still someone else's at heart.
    const from = had && was ? had.source : source;
    const s = await this.records.keep(person, { ...(was ? { id: was.id } : { fresh: true }), name, when, steps, ...(why ? { why } : {}), byName: from === "imported" }, now);
    if (typeof s === "string") return s;
    const before = was && had ? [asWas(was, had, now), ...had.before].slice(0, MAX_BEFORE) : [];
    for (const f of fresh) await this.storage.put(fileKey(person, s.id, f.file.n), f.data);
    await this.put(person, s.id, { source: from, ...(text ? { text } : {}), files, before, next });
    return s;
  }

  /** Kept, and the files nothing of it refers to any more let go. */
  private async put(person: string, id: string, more: More): Promise<void> {
    await this.storage.put(textKey(person, id), more);
    const used = new Set([...more.files, ...more.before.flatMap((b) => b.files)].map((f) => fileKey(person, id, f.n)));
    for (const k of (await this.storage.list({ prefix: `specialtyfile:${person}:${id}:` })).keys()) if (!used.has(k)) await this.storage.delete(k);
  }

  /** As it was before a change of it (`at`): what it is now takes that one's place, so this too can be put back. */
  async putBack(person: string, id: string, at: number, now: number): Promise<Specialty | string> {
    const w = await this.whole(person, id);
    const b = w?.more.before.find((x) => x.at === at);
    if (!w || !b) return "that is not kept any more";
    const s = await this.records.keep(person, { id, name: b.name, when: b.when, steps: b.steps, ...(b.why ? { why: b.why } : {}), byName: w.more.source === "imported" }, now);
    if (typeof s === "string") return s;
    await this.put(person, id, { source: w.more.source, ...(b.text ? { text: b.text } : {}), files: b.files, before: [asWas(w.specialty, w.more, now), ...w.more.before.filter((x) => x !== b)], next: w.more.next });
    return s;
  }

  /** Changed by asking, by its name (Specialties.save): what it was is kept here too. */
  async changed(person: string, was: Specialty, now: number): Promise<void> {
    const had = await this.get(person, was.id);
    await this.put(person, was.id, { ...had, before: [asWas(was, had, now), ...had.before].slice(0, MAX_BEFORE) });
  }

  /** As a zip other agents take (agentskills.io). */
  async exported(person: string, id: string): Promise<{ name: string; bytes: Uint8Array } | null> {
    const w = await this.whole(person, id);
    if (!w) return null;
    const slug = slugOf(w.specialty.name);
    const files: ZipFile[] = [{ name: `${slug}/SKILL.md`, bytes: new TextEncoder().encode(formatSkill({ ...w.specialty, ...(w.more.text ? { text: w.more.text } : {}) })) }];
    for (const f of w.more.files) {
      const got = await this.file(person, id, f.n);
      if (got) files.push({ name: `${slug}/${got.name}`, bytes: got.bytes });
    }
    return { name: `${slug}.zip`, bytes: writeZip(files) };
  }

  /** With its record (Specialties.forget): nothing of it is left. */
  async forget(person: string, id: string): Promise<void> {
    await this.storage.delete(textKey(person, id));
    for (const k of (await this.storage.list({ prefix: `specialtyfile:${person}:${id}:` })).keys()) await this.storage.delete(k);
  }

  async clear(person: string): Promise<void> {
    for (const prefix of [`specialtytext:${person}:`, `specialtyfile:${person}:`]) for (const k of (await this.storage.list({ prefix })).keys()) await this.storage.delete(k);
  }
}
