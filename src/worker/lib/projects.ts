import type { Storage } from "./state-host.ts";
import { seen } from "./skill-md.ts";
import { fromB64u } from "./webauthn.ts";
import { moreName } from "./specialty-more.ts";
import { nameOf, names } from "./specialties.ts";
import { apart } from "./workshop.ts";

/**
 * A person's projects: a name, a few rules they typed, and files, for jobs that
 * belong together (lib/job-project.ts, src/app/ui/Projects.ts). A job in one is
 * given its rules, its files and what its earlier jobs came back with, and
 * nothing of any other's.
 *
 * Only its person changes one, by hand: its rules are their words, followed as
 * such. Its files may be anyone's, and are read as data.
 */

export interface ProjectFile {
  n: number;
  name: string;
  size: number;
  at: number;
}

export interface Project {
  id: string;
  name: string;
  rules: string[];
  files: ProjectFile[];
  /** The next file's number, never one used before. */
  next: number;
  createdAt: number;
  updatedAt: number;
}

export const MAX_PROJECTS = 20;
const MAX_NAME = 60;
const MAX_RULES = 10;
const MAX_RULE = 300;
export const MAX_FILES = 20;
export const MAX_FILE = 1_000_000;
export const MAX_OF_ONE = 5_000_000;
export const MAX_OF_ALL = 20_000_000;

const ALPHABET = "abcdefghjkmnpqrstvwxyz0123456789";
const key = (person: string) => `projects:${person}`;
const fileKey = (person: string, id: string, n: number) => `projectfile:${person}:${id}:${n}`;
const line = (v: unknown): string => (typeof v === "string" ? seen(v).text.replace(/\s+/g, " ").trim() : "");

export class Projects {
  private storage: Storage;
  constructor(storage: Storage) {
    this.storage = storage;
  }

  async of(person: string): Promise<Project[]> {
    return (await this.storage.get<Project[]>(key(person))) ?? [];
  }

  async get(person: string, id: string): Promise<Project | null> {
    return (await this.of(person)).find((p) => p.id === id) ?? null;
  }

  /** New, or by its id changed: its name and rules. Why not, in words. */
  async save(person: string, input: { id?: unknown; name?: unknown; rules?: unknown }, now: number): Promise<Project | string> {
    const name = line(input.name);
    if (!nameOf(name)) return "it needs a name";
    if (name.length > MAX_NAME) return `its name is ${name.length} characters, and one may be ${MAX_NAME}`;
    const all = await this.of(person);
    const id = typeof input.id === "string" && input.id ? input.id : undefined;
    const was = id ? all.find((p) => p.id === id) : undefined;
    if (id && !was) return "that project is not kept any more";
    if (all.some((p) => p !== was && nameOf(p.name) === nameOf(name))) return `another is called "${name}" already`;
    if (!was && all.length >= MAX_PROJECTS) return `that is ${MAX_PROJECTS} already: remove one first`;
    const rules = (Array.isArray(input.rules) ? input.rules : []).map(line).filter(Boolean);
    if (rules.length > MAX_RULES) return `it has ${rules.length} rules, and it may have ${MAX_RULES}`;
    const long = rules.findIndex((r) => r.length > MAX_RULE);
    if (long >= 0) return `rule ${long + 1} is ${rules[long]!.length} characters, and one may be ${MAX_RULE}`;
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const p: Project = was
      ? { ...was, name, rules, updatedAt: now }
      : { id: "p" + [...bytes].map((b) => ALPHABET[b % 32]).join(""), name, rules, files: [], next: 1, createdAt: now, updatedAt: now };
    await this.storage.put(key(person), was ? all.map((x) => (x === was ? p : x)) : [...all, p]);
    return p;
  }

  /** A file of one, new or in place of the one of that name; `beside`, what a job made, which takes no one's place: its name is made its own. Why not, in words. */
  async put(person: string, id: string, rawName: unknown, bytes: Uint8Array, now: number, beside = false): Promise<Project | string> {
    const called = moreName(rawName);
    if (!called) return "a file needs a name";
    let name = called;
    if (bytes.length > MAX_FILE) return `${called} is over ${MAX_FILE / 1_000_000} MB`;
    // Its bytes first, under a number of their own: a project never lists a file that is not there. Nothing is waited on between reading the list and writing it.
    const all = await this.of(person);
    const was = all.find((p) => p.id === id);
    if (!was) return "that project is not kept any more";
    if (beside) {
      const own = apart();
      for (const f of was.files) own(f.name);
      name = own(called);
    }
    const old = was.files.find((f) => f.name === name);
    const files = was.files.filter((f) => f !== old);
    if (files.length >= MAX_FILES) return `it has ${MAX_FILES} files: remove one first`;
    const sum = (fs: readonly ProjectFile[]) => fs.reduce((n, f) => n + f.size, 0);
    if (sum(files) + bytes.length > MAX_OF_ONE) return `its files come to more than ${MAX_OF_ONE / 1_000_000} MB`;
    if (all.reduce((n, p) => n + (p === was ? sum(files) : sum(p.files)), 0) + bytes.length > MAX_OF_ALL) return `all your projects' files come to more than ${MAX_OF_ALL / 1_000_000} MB`;
    const p: Project = { ...was, files: [...files, { n: was.next, name, size: bytes.length, at: now }], next: was.next + 1, updatedAt: now };
    const write = [this.storage.put(fileKey(person, id, was.next), bytes), this.storage.put(key(person), all.map((x) => (x === was ? p : x)))];
    await Promise.all(write);
    if (old) await this.storage.delete(fileKey(person, id, old.n));
    return p;
  }

  async drop(person: string, id: string, n: number, now: number): Promise<Project | string> {
    const all = await this.of(person);
    const was = all.find((p) => p.id === id);
    if (!was?.files.some((f) => f.n === n)) return "it has no such file";
    const p: Project = { ...was, files: was.files.filter((f) => f.n !== n), updatedAt: now };
    await this.storage.put(key(person), all.map((x) => (x === was ? p : x)));
    await this.storage.delete(fileKey(person, id, n));
    return p;
  }

  async file(person: string, id: string, n: number): Promise<{ name: string; bytes: Uint8Array } | null> {
    const f = (await this.get(person, id))?.files.find((x) => x.n === n);
    const bytes = f ? await this.storage.get<Uint8Array>(fileKey(person, id, n)) : undefined;
    return f && bytes ? { name: f.name, bytes } : null;
  }

  /** The one named in one of `texts`, in quotes or beside the word where its name is one word: the longest, where one name is in another. */
  async named(person: string, texts: readonly string[]): Promise<Project | null> {
    const is = (t: string, n: string) => names(t, n) || new RegExp(` (?:${n} (?:project|projek)|(?:project|projek) ${n}) `, "u").test(` ${nameOf(t)} `);
    return (await this.of(person)).filter((p) => texts.some((t) => is(t, nameOf(p.name)))).sort((a, b) => b.name.length - a.name.length)[0] ?? null;
  }

  async forget(person: string, id: string): Promise<boolean> {
    const all = await this.of(person);
    const was = all.find((p) => p.id === id);
    if (!was) return false;
    await this.storage.put(key(person), all.filter((p) => p !== was));
    for (const f of was.files) await this.storage.delete(fileKey(person, id, f.n));
    return true;
  }

  async clear(person: string): Promise<void> {
    for (const p of await this.of(person)) await this.forget(person, p.id);
    await this.storage.delete(key(person));
  }
}

export const bytesOf = (v: unknown): Uint8Array | null => {
  if (typeof v !== "string") return null;
  try {
    return fromB64u(v);
  } catch {
    return null;
  }
};
