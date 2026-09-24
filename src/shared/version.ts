/**
 * Bump when the map styling changes.
 *
 * Map imagery is cached hard in the browser, so a style change is otherwise
 * invisible to anyone who has already loaded a tile — which is exactly what
 * happened when the roads were fixed: the server returned the corrected image
 * and the car kept showing the cached one. The client sends this as `sv`, so a
 * bump produces a new URL and the cache resolves itself.
 */
export const MAP_STYLE_VERSION = 3;
