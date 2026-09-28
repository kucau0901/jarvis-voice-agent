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

/**
 * `loadThings` lists what the house has that a pass can work (GET
 * /api/hub/house): chosen from a list, by name, rather than typed.
 */
export function limitsForm(a: Access | null | undefined, loadThings: () => Promise<{ entity: string; name: string }[]>): HTMLElement {
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
      <input type="text" class="l-filter" placeholder="Find: gate, garage, porch…" hidden>
      <div class="l-things"></div>
      <details class="l-typed"><summary>Or type one</summary>
        <div class="fieldfoot"><input type="text" class="l-label" placeholder="Name, e.g. Main gate">
          <input type="text" class="l-entity" placeholder="cover.main_gate"></div>
        <button type="button" class="l-more">Another</button>
      </details>
    </div>`;
  // What is on the pass now, ticked in the list (or kept as typed, if the house does not list it).
  const chosen = new Map((a?.allow ?? []).map((x) => [x.entity, x.label]));
  const things = box.querySelector<HTMLElement>(".l-things")!;
  const filter = box.querySelector<HTMLInputElement>(".l-filter")!;
  const draw = (list: { entity: string; name: string }[]) => {
    const want = filter.value.trim().toLowerCase();
    const shown = list.filter((t) => !want || t.name.toLowerCase().includes(want) || t.entity.includes(want) || chosen.has(t.entity));
    things.innerHTML = shown
      .slice(0, 60)
      .map(
        (t) => `<label class="on l-thing"><input type="checkbox" value="${esc(t.entity)}" data-name="${esc(t.name)}"${chosen.has(t.entity) ? " checked" : ""}>
          ${esc(t.name)} <small>${esc(t.entity)}</small></label>`,
      )
      .join("") || `<p class="note">Nothing in the house matches.</p>`;
    for (const c of things.querySelectorAll("input")) {
      const box2 = c as unknown as HTMLInputElement;
      box2.addEventListener("change", () => {
        if (box2.checked) chosen.set(box2.value, box2.dataset.name ?? box2.value);
        else chosen.delete(box2.value);
      });
    }
  };
  things.innerHTML = `<p class="note">Asking the house what there is…</p>`;
  void loadThings()
    .then((list) => {
      filter.hidden = false;
      // Anything already on the pass that the house no longer lists stays, as typed.
      for (const [entity, label] of chosen) if (!list.some((t) => t.entity === entity)) list.unshift({ entity, name: label });
      draw(list);
      filter.addEventListener("input", () => draw(list));
    })
    .catch((e) => {
      things.innerHTML = `<p class="note">The house could not list its things (${esc(e instanceof Error ? e.message : String(e))}). Type them below.</p>`;
      for (const [entity, label] of chosen) addTyped(entity, label);
    });
  function addTyped(entity = "", label = "") {
    const row = document.createElement("div");
    row.className = "fieldfoot";
    row.innerHTML = `<input type="text" class="l-label" placeholder="Name" value="${esc(label)}"><input type="text" class="l-entity" placeholder="switch.garden_lights" value="${esc(entity)}">`;
    const more = box.querySelector(".l-more")!;
    more.parentElement!.insertBefore(row, more);
  }
  box.querySelector(".l-more")!.addEventListener("click", () => addTyped());
  // The ticked list is read when saving.
  (box as HTMLElement & { chosen?: Map<string, string> }).chosen = chosen;
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
    // Ticked in the house's list, and any typed.
    const ticked = [...((box as HTMLElement & { chosen?: Map<string, string> }).chosen ?? new Map<string, string>())].map(([entity, label]) => ({ entity, label }));
    const typed = [...box.querySelectorAll(".l-typed .fieldfoot")].map((r) => ({
      label: (r.querySelector(".l-label") as unknown as HTMLInputElement).value.trim(),
      entity: (r.querySelector(".l-entity") as unknown as HTMLInputElement).value.trim(),
    }));
    const allow = [...ticked, ...typed.filter((r) => r.entity && !ticked.some((t) => t.entity === r.entity))].map((r) => ({ ...r, label: r.label || r.entity }));
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
