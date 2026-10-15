import type { PanelMore, PanelRow } from "../../shared/panels";
import { button, el } from "./util";

/**
 * What a tile on the Home tab shows when it is opened (src/app/ui/Home.ts):
 * a room's lights each with its own button, an aircond's temperature, modes
 * and fan, or an alarm's arming and disarming with its code. Every press goes
 * through `press`, which the server checks against the thing's state now
 * (src/worker/lib/panel-controls.ts), and whose answer shows in `said`.
 */

export type Press = (
  action: string,
  b: HTMLButtonElement | HTMLInputElement,
  said: HTMLElement,
  extra?: { member?: string; code?: string; value?: string },
) => Promise<void>;

type Level = NonNullable<PanelMore["level"]>;

/** A slider: its name, the value shown as it moves, and `send` once it is let go — not at every step of a drag. */
export function slider(name: string, level: Omit<Level, "name">, send: (n: number, input: HTMLInputElement) => void): HTMLElement {
  const row = el("label", "hlevel");
  const input = el("input");
  input.type = "range";
  input.min = String(level.min);
  input.max = String(level.max);
  input.step = String(level.step);
  input.value = String(level.value);
  const shown = el("b", "", `${level.value}${level.unit}`);
  input.addEventListener("input", () => (shown.textContent = `${input.value}${level.unit}`));
  input.addEventListener("change", () => send(Number(input.value), input));
  row.append(el("small", "", name), input, shown);
  return row;
}

/** Words typed for a button that takes them, and the button that sends them. */
export function typed(label: string, hint: string, send: (text: string, b: HTMLButtonElement) => void): HTMLElement {
  const form = el("form", "htyped");
  const input = el("input");
  input.placeholder = hint || label;
  input.maxLength = 500;
  input.setAttribute("aria-label", label);
  const go = el("button", "", label);
  go.type = "submit";
  form.append(input, go);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return input.focus();
    input.value = "";
    send(text, go);
  });
  return form;
}

/** "fan_only" as "Fan only". */
const words = (s: string) => (s.charAt(0).toUpperCase() + s.slice(1)).replace(/_/g, " ");

export function moreBody(more: PanelMore, said: HTMLElement, press: Press): HTMLElement {
  const body = el("div", "hbody");
  if (more.members) body.appendChild(members(more.members, press));
  if (more.level) body.appendChild(slider(more.level.name, more.level, (n, input) => void press(`level:${n}`, input, said)));
  if (more.climate) body.appendChild(climate(more.climate, said, press));
  if (more.actions?.length) body.appendChild(alarm(more, said, press));
  return body;
}

/** A room's lights, each a small row with its own state and button. */
function members(rows: PanelRow[], press: Press): HTMLElement {
  const list = el("div", "hmembers");
  for (const m of rows) {
    const row = el("div", `hmember${m.active ? " active" : ""}`);
    row.dataset.icon = m.icon;
    const text = el("div", "htext");
    const said = el("small", m.note ? "hstate hwhy" : "hstate", m.note ?? m.value);
    text.append(el("b", "hname", m.label), said);
    row.append(el("span", "hic"), text);
    for (const a of m.actions) {
      const b = button(a.label, () => void press(a.action, b, said, { member: m.key }));
      row.appendChild(b);
    }
    // A dimmable light in the room dims on its own, under its row.
    const level = m.more?.level;
    if (level) row.appendChild(slider(level.name, level, (n, input) => void press(`level:${n}`, input, said, { member: m.key })));
    list.appendChild(row);
  }
  return list;
}

/** An aircond: its temperature up and down, its modes and its fan, as chips. */
function climate(c: NonNullable<PanelMore["climate"]>, said: HTMLElement, press: Press): HTMLElement {
  const box = el("div", "hclimate");
  if (c.target !== undefined && c.mode !== "off") {
    let target = c.target;
    const dial = el("div", "hdial");
    const shown = el("b", "", `${target}°`);
    const at = el("div", "");
    at.append(shown, el("small", "", c.now === undefined ? "Set to" : `Room ${c.now}°`));
    const step = (by: number) => {
      const next = Math.round(Math.min(c.max, Math.max(c.min, target + by)) * 10) / 10;
      if (next === target) return;
      target = next;
      shown.textContent = `${target}°`;
      void press(`temp:${target}`, by < 0 ? down : up, said);
    };
    const down = button("−", () => step(-c.step));
    const up = button("+", () => step(c.step));
    down.setAttribute("aria-label", "Cooler");
    up.setAttribute("aria-label", "Warmer");
    dial.append(down, at, up);
    box.appendChild(dial);
  }
  const chips = (title: string, options: string[], now: string | undefined, act: (o: string) => string) => {
    if (!options.length) return;
    const row = el("div", "hchips");
    row.appendChild(el("small", "", title));
    for (const o of options) {
      const b = button(words(o), () => void press(act(o), b, said));
      b.setAttribute("aria-pressed", String(o === now));
      row.appendChild(b);
    }
    box.appendChild(row);
  };
  chips("Mode", c.modes, c.mode, (o) => `mode:${o}`);
  chips("Fan", c.fans, c.fan, (o) => `fan:${o}`);
  return box;
}

/** An alarm: its buttons, and the code it wants for them, typed here and sent once. */
function alarm(more: PanelMore, said: HTMLElement, press: Press): HTMLElement {
  const box = el("div", "halarm");
  let code: HTMLInputElement | null = null;
  if (more.code) {
    code = el("input", "hcode");
    code.type = "password";
    code.autocomplete = "off";
    code.placeholder = "Code";
    code.setAttribute("aria-label", "Alarm code");
    if (more.code.digits) code.inputMode = "numeric";
    box.appendChild(code);
  }
  for (const a of more.actions ?? []) {
    const b = button(a.label, () => {
      const wants = more.code?.for.includes(a.action);
      const given = code?.value.trim() ?? "";
      if (wants && !given) {
        said.textContent = "Type the alarm's code first.";
        code?.focus();
        return;
      }
      if (code) code.value = "";
      void press(a.action, b, said, wants ? { code: given } : {});
    });
    box.appendChild(b);
  }
  return box;
}
