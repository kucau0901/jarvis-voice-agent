import { tidy, wellFormed } from "./quote.ts";

/**
 * A video a component returns from a tool call (docs/components.md, "Showing
 * a video"): MCP `resource_link` parts beside its text, which Jarvis plays on
 * the screen of whoever asked (tools/mcp.ts, ui/Stage.ts). The model never
 * sees the addresses: it is told only that the video is on the screen.
 *
 * Only addresses at the component's own approved origin are taken, so a
 * result cannot make the screen fetch from anywhere the admin did not add.
 */

export interface Video {
  /** Largest first, as the component listed them; the screen picks one by its width. */
  sources: string[];
  poster?: string;
  /** Its caption: the component's name and the first video's title, component text to be set with textContent. */
  label: string;
}

export const MAX_VIDEOS = 3;
const MAX_URI = 2048;
const CAPTION = 80;
const POSTERS = ["image/jpeg", "image/png", "image/webp"];

/** Told to the model after the quoted result, in code's words, when a video is on the screen. */
export const VIDEO_SHOWN = "Jarvis is now showing this video on the user's screen; do not show anything else for it.";

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const words = (v: unknown) => (typeof v === "string" ? tidy(v) : "");

/** The address as it will be fetched, or null unless it is https, carries no user or password, and is at `origin`. */
function atOrigin(uri: unknown, origin: string): string | null {
  if (typeof uri !== "string" || uri.length > MAX_URI) return null;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  return u.protocol === "https:" && !u.username && !u.password && u.origin === origin ? u.href : null;
}

/**
 * The video in a component's result, if one passes, and how many of its
 * video and poster links were dropped for their address. `url` is the
 * component's approved address, `name` the name it is shown under.
 */
export function videoOf(content: readonly unknown[], url: string, name: string): { video: Video | null; dropped: number } {
  const origin = new URL(url).origin;
  const sources: string[] = [];
  let poster: string | undefined;
  let title = "";
  let dropped = 0;
  for (const c of content) {
    if (!plain(c) || c.type !== "resource_link") continue;
    const isVideo = c.mimeType === "video/mp4";
    if (!isVideo && !POSTERS.includes(String(c.mimeType))) continue;
    const uri = atOrigin(c.uri, origin);
    if (!uri) {
      dropped++;
    } else if (isVideo && sources.length < MAX_VIDEOS) {
      if (!sources.length) title = words(c.title) || words(c.name);
      sources.push(uri);
    } else if (!isVideo && !poster) {
      poster = uri;
    }
  }
  if (!sources.length) return { video: null, dropped };
  // Cut where it leaves no half of a character: a lone high surrogate at the cut is dropped, not shown as �.
  const label = wellFormed(tidy(title ? `${name} — ${title}` : name).slice(0, CAPTION).replace(/[\uD800-\uDBFF]$/, "")).trim();
  return { video: { sources, ...(poster ? { poster } : {}), label }, dropped };
}
