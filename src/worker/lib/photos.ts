/**
 * Photos the user takes with their phone to ask about (src/app/camera.ts).
 * They arrive as data: URLs, already shrunk by the phone to about 1024
 * pixels, and go straight to the router beside the question. Never stored.
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
