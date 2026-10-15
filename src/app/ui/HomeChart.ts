import { authHeaders } from "../key";
import { MAP_STYLE_VERSION } from "../../shared/version";
import { el } from "./util";

/**
 * What a tile on the Home tab draws beyond words (src/app/ui/Home.ts): a
 * trend as a line — a sensor's last day from Home Assistant, or a trend
 * Jarvis looked up — and a place as a map, through the Worker's map proxy
 * (routes/map.ts) as the stage draws one, so the Maps key never reaches the
 * browser. Built with DOM calls throughout, never markup from text.
 */

const SVG = "http://www.w3.org/2000/svg";
const W = 300;
const H = 90;
const PAD = 6;

const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

/** A number as a chart labels it: whole when it is large, to a tenth or two when it is small. */
const fmt = (v: number) => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 100) / 100));

/**
 * A line through `points`, oldest first, with the latest value large and the
 * day's low and high beside it; `from` and `to` label its two ends.
 */
export function lineChart(points: number[], unit: string, title: string, from: string, to: string): HTMLElement {
  const box = el("figure", "hchart");
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const span = hi - lo || 1;
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / Math.max(1, points.length - 1);
  const y = (v: number) => H - PAD - ((v - lo) * (H - 2 * PAD)) / span;
  const path = points.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const drawing = svg("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img", "aria-label": `${title}: from ${fmt(points[0]!)} to ${fmt(points.at(-1)!)}${unit}` });
  drawing.append(
    svg("path", { d: `${path} L${x(points.length - 1).toFixed(1)},${H} L${x(0)},${H} Z`, class: "harea" }),
    svg("path", { d: path, class: "hline" }),
  );
  const head = el("figcaption", "");
  head.append(el("small", "", title), el("b", "", `${fmt(points.at(-1)!)}${unit}`), el("small", "", `low ${fmt(lo)} · high ${fmt(hi)}`));
  const ends = el("div", "hends");
  ends.append(el("small", "", from), el("small", "", to));
  box.append(head, drawing, ends);
  return box;
}

/** Maps already fetched, by place: a tile drawn again every twenty seconds does not fetch its map again. */
const fetched = new Map<string, string>();

/** Where something is, as a map from the Worker's proxy; it removes itself if none can be drawn. */
export function mapImage(key: string, lat: number, lng: number): HTMLImageElement {
  const img = el("img", "hmap");
  img.alt = "";
  const q = new URLSearchParams({ kind: "map", lat: lat.toFixed(5), lng: lng.toFixed(5), sv: String(MAP_STYLE_VERSION), w: "640", h: "300", zoom: "15" });
  const at = q.toString();
  const had = fetched.get(at);
  if (had) {
    img.src = had;
    return img;
  }
  // Fetched with the auth header: an <img src> cannot send one.
  void fetch(`/api/map?${at}`, { headers: authHeaders(key) })
    .then(async (r) => {
      if (!r.ok) throw new Error(`map ${r.status}`);
      const url = URL.createObjectURL(await r.blob());
      fetched.set(at, url);
      img.src = url;
    })
    .catch(() => img.remove());
  return img;
}
