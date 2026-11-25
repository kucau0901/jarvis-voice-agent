/**
 * A specialty as other agents write one (agentskills.io): a folder with a
 * SKILL.md, whose first lines say its name and when it is for, and the rest
 * how it is done. Read from a file an admin chose, and written for one to
 * take elsewhere (lib/specialty-more.ts). Someone else's text: shown whole
 * before it is kept, with what could not be seen taken out, and what it says
 * of tools it may use is not followed. What a job may do is by what it is
 * handed.
 */

export interface SkillMd {
  name: string;
  description: string;
  body: string;
  /** What the reader should know of it before keeping it. */
  notes: string[];
}

/** Characters nobody sees: controls, joiners, direction marks, tag letters, spare variation selectors. A line's end and a tab stay. */
const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B\u200E\u200F\u2028-\u202E\u2060-\u206F\u3164\uFE00-\uFE0E\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E0FFF}]/gu;

/** Text as a person can see it, and how much was taken out to make it so. Lines end one way. */
export function seen(text: string): { text: string; hidden: number } {
  const whole = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const out = whole.replace(HIDDEN, "");
  return { text: out, hidden: [...whole].length - [...out].length };
}

const unquoted = (v: string): string => {
  const t = v.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  if (/^'.*'$/s.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  const note = t.search(/\s#/);
  return note < 0 ? t : t.slice(0, note).trimEnd();
};

/** Bytes as text; null when they are not: no text holds a NUL. */
export function textIn(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** The first lines' values that stand at the top: a word or a quoted one on its line, or a block below it. What is nested is passed over. */
function front(lines: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z][\w-]*):(?:\s+(.*)|\s*)$/.exec(lines[i]!);
    if (!m) continue;
    const under: string[] = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || !lines[i + 1]!.trim())) under.push(lines[++i]!.trim());
    const v = (m[2] ?? "").trim();
    const block = /^([|>])[+-]?\d?$/.exec(v);
    // Quoted over several lines, or bare: its lines are one.
    const value = block ? under.join(block[1] === "|" ? "\n" : " ") : v ? unquoted([v, ...under].join(" ")) : "";
    out.set(m[1]!.toLowerCase(), value.replace(/[ \t]+/g, " ").trim());
  }
  return out;
}

/** What a SKILL.md says; why it is not one, in words. */
export function parseSkill(raw: string, fallback = ""): SkillMd | string {
  const { text, hidden } = seen(raw);
  if (!text.trim()) return "that file is empty";
  const notes: string[] = [];
  if (hidden) notes.push(`${hidden} hidden ${hidden === 1 ? "character was" : "characters were"} taken out of it.`);
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  const head = m ? front(m[1]!.split("\n")) : new Map<string, string>();
  const body = (m ? text.slice(m[0].length) : text).trim();
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? "";
  const name = head.get("name") || title || fallback;
  if (!name) return "it has no name: a SKILL.md begins with one";
  const tools = head.get("allowed-tools");
  if (tools !== undefined) notes.push(`It names tools it may use (${tools.slice(0, 120) || "a list"}): that is not followed. What a job may do stays as it is.`);
  const comment = body.indexOf("<!--");
  if (comment >= 0 && body.includes("-->", comment)) notes.push("It holds comments that would not show on a page: they are shown below.");
  if (!m) notes.push("It has no header, so its name is its first heading, and when to use it is yours to say.");
  return { name, description: head.get("description") ?? "", body, notes };
}

/** A name as the format has it: small letters, digits and single hyphens. */
export const slugOf = (name: string): string =>
  name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "") || "specialty";

/** A specialty as a SKILL.md: its name and when it is for, then its steps, its notes and why. */
export function formatSkill(s: { name: string; when: readonly string[]; steps: readonly string[]; why?: string; text?: string }): string {
  const description = s.when.length ? s.when.join("; ") : `How the user wants "${s.name}" done.`;
  const parts = [
    s.steps.length ? `## Steps\n\n${s.steps.map((x, i) => `${i + 1}. ${x}`).join("\n")}` : "",
    s.text?.trim() ?? "",
    s.why ? `## Why\n\n${s.why}` : "",
  ].filter(Boolean);
  const titled = /^#\s/.test(parts[0] ?? "");
  return `---\nname: ${slugOf(s.name)}\ndescription: ${JSON.stringify(description.replace(/\s+/g, " ").slice(0, 1024))}\n---\n\n${titled ? "" : `# ${s.name}\n\n`}${parts.join("\n\n")}\n`;
}
