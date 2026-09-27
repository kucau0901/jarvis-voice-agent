import { esc } from "./util";

/**
 * An admin's limits on one member (src/worker/lib/access.ts), as a small
 * form: until when, which hours, and for a pass, which things in the house.
 * Used on a member's card and when inviting a guest.
 */

export interface Access {
  until?: number;
  hours?: { days?: number[]; from: string; to: string };
  allow?: { entity: string; label: string }[];
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The end of a date in the browser's day: a pass "until Friday" lasts all of Friday. */
const endOf = (date: string) => new Date(`${date}T23:59:59`).getTime();
const dateOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function limitsForm(a: Access | null | undefined): HTMLElement {
  const box = document.createElement("div");
  box.className = "limits";
  box.innerHTML = `
    <label class="on"><input type="checkbox" class="l-until-on"${a?.until ? " checked" : ""}> Until</label>
    <input type="date" class="l-until" value="${a?.until ? dateOf(a.until) : ""}">
    <label class="on"><input type="checkbox" class="l-hours-on"${a?.hours ? " checked" : ""}> Only between</label>
    <div class="l-hours">
      <input type="time" class="l-from" value="${esc(a?.hours?.from ?? "08:00")}"> and
      <input type="time" class="l-to" value="${esc(a?.hours?.to ?? "17:00")}">
      <div class="checks">${DAYS.map((d, i) => `<label class="on"><input type="checkbox" class="l-day" value="${i}"${!a?.hours?.days || a.hours.days.includes(i) ? " checked" : ""}> ${d}</label>`).join("")}</div>
    </div>
    <label class="on"><input type="checkbox" class="l-pass-on"${a?.allow?.length ? " checked" : ""}> A pass: only these things in the house</label>
    <div class="l-pass">
      ${[...(a?.allow ?? []), { entity: "", label: "" }]
        .map(
          (x) => `<div class="fieldfoot"><input type="text" class="l-label" placeholder="Name, e.g. Main gate" value="${esc(x.label)}">
            <input type="text" class="l-entity" placeholder="cover.main_gate" value="${esc(x.entity)}"></div>`,
        )
        .join("")}
      <button type="button" class="l-more">Another</button>
    </div>`;
  box.querySelector(".l-more")!.addEventListener("click", () => {
    const row = document.createElement("div");
    row.className = "fieldfoot";
    row.innerHTML = `<input type="text" class="l-label" placeholder="Name"><input type="text" class="l-entity" placeholder="switch.garden_lights">`;
    const more = box.querySelector(".l-more")!;
    more.parentElement!.insertBefore(row, more);
  });
  return box;
}

/** What the form says, as the server takes it; null for no limits. */
export function readLimits(box: HTMLElement): Access | null {
  const q = <T,>(c: string) => box.querySelector(c) as unknown as T;
  const out: Access = {};
  if (q<HTMLInputElement>(".l-until-on").checked && q<HTMLInputElement>(".l-until").value) out.until = endOf(q<HTMLInputElement>(".l-until").value);
  if (q<HTMLInputElement>(".l-hours-on").checked) {
    const days = [...box.querySelectorAll(".l-day")].filter((d) => (d as unknown as HTMLInputElement).checked).map((d) => Number((d as unknown as HTMLInputElement).value));
    out.hours = { from: q<HTMLInputElement>(".l-from").value, to: q<HTMLInputElement>(".l-to").value, ...(days.length < 7 ? { days } : {}) };
  }
  if (q<HTMLInputElement>(".l-pass-on").checked) {
    const rows = [...box.querySelectorAll(".l-pass .fieldfoot")].map((r) => ({
      label: (r.querySelector(".l-label") as unknown as HTMLInputElement).value.trim(),
      entity: (r.querySelector(".l-entity") as unknown as HTMLInputElement).value.trim(),
    }));
    const allow = rows.filter((r) => r.entity);
    if (allow.length) out.allow = allow;
  }
  return Object.keys(out).length ? out : null;
}

/** Limits, said in a line on a member's card. */
export function limitsSaid(a: Access | null | undefined): string {
  if (!a) return "";
  const parts: string[] = [];
  if (a.until) parts.push(`until ${new Date(a.until).toLocaleDateString()}`);
  if (a.hours) parts.push(`${a.hours.from}–${a.hours.to}${a.hours.days ? ` on ${a.hours.days.map((d) => DAYS[d]).join(", ")}` : ""}`);
  if (a.allow?.length) parts.push(`pass: ${a.allow.map((x) => x.label).join(", ")}`);
  return parts.join(" · ");
}
