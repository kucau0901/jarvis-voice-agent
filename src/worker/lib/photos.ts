import { fromB64u } from "./webauthn.ts";
import { apart, fileName } from "./workshop.ts";

/**
 * Photos to ask about: taken with a phone or glasses (routes/voice.ts), or
 * attached in the app's chat (src/app/attach.ts). They arrive as data: URLs,
 * already shrunk on the device, and go straight to the router beside the
 * question. Never stored. Files attached in the chat likewise: a PDF, which
 * the model reads page by page, or a text file, which reaches it as quoted
 * data — someone else's words, not the user's instructions. Any other file
 * (a spreadsheet, a document) it cannot read: only its name is said. All of
 * them can be put in the folder of a job that makes files (tools/jobs.ts).
 */

export const MAX_PHOTOS = 2;
/** A 1024-pixel JPEG is ~200 KB; this allows for a PNG or a larger phone without allowing a video. */
export const MAX_PHOTO_CHARS = 3_000_000;
const PHOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;

/** The photos in a request that are photos; anything else is dropped. */
export function photosFrom(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list
    .filter((p): p is string => typeof p === "string" && p.length <= MAX_PHOTO_CHARS && PHOTO.test(p))
    .slice(0, MAX_PHOTOS);
}

export const MAX_FILES = 2;
/** A PDF of about 10 MB, as base64. */
export const MAX_PDF_CHARS = 14_000_000;
/** A text file of about 200 KB: a long document, not a database. */
export const MAX_TEXT_CHARS = 200_000;
const PDF = /^data:application\/pdf;base64,[A-Za-z0-9+/]+=*$/;

const OTHER = /^data:application\/octet-stream;base64,[A-Za-z0-9+/]+=*$/;

export interface AttachedFile {
  /** Its name, as the user's device had it: for the model, and for what it is said to be. */
  name: string;
  kind: "pdf" | "text" | "file";
  /** A text file's words, or a data: URL. */
  data: string;
}

/** What came with a message. */
export interface Attached {
  images?: readonly string[];
  files?: readonly AttachedFile[];
}

/** The files in a request, named and within size; anything else is dropped. */
export function filesFrom(raw: unknown): AttachedFile[] {
  const out: AttachedFile[] = [];
  for (const f of Array.isArray(raw) ? raw : []) {
    if (!f || typeof f !== "object") continue;
    const { name, kind, data } = f as Record<string, unknown>;
    if (typeof name !== "string" || typeof data !== "string") continue;
    const named = name.replace(/[\u0000-\u001f\u007f"]/g, " ").trim().slice(0, 120) || "file";
    if (kind === "pdf" && data.length <= MAX_PDF_CHARS && PDF.test(data)) out.push({ name: named, kind, data });
    else if (kind === "text" && data.length <= MAX_TEXT_CHARS) out.push({ name: named, kind, data });
    else if (kind === "file" && data.length <= MAX_PDF_CHARS && OTHER.test(data)) out.push({ name: named, kind, data });
  }
  return out.slice(0, MAX_FILES);
}

/** What came with a message, as files on a disk: each under a name of its own. */
export function asFiles(a: Attached | undefined): { name: string; bytes: Uint8Array }[] {
  const bytes = (url: string) => fromB64u(url.slice(url.indexOf(",") + 1).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  const named = apart();
  return [
    ...(a?.images ?? []).map((url, i) => ({ name: named(`photo ${i + 1}.${/^data:image\/(\w+)/.exec(url)?.[1]?.replace("jpeg", "jpg") ?? "jpg"}`), bytes: bytes(url) })),
    ...(a?.files ?? []).map((f) => ({ name: named(fileName(f.name)), bytes: f.kind === "text" ? new TextEncoder().encode(f.data) : bytes(f.data) })),
  ];
}
