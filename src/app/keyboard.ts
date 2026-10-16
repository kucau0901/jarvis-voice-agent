import { inCar } from "./client";

/*
 * The on-screen keyboard. By default a phone's browser does not shrink the
 * page for it: it slides the view down to the box, which is pinned to the
 * bottom of the full-height page, so the chat vanished above and the box sat
 * half under the keyboard. Chrome is told to shrink the page instead
 * (interactive-widget in the viewport meta). Safari ignores that, so there
 * the space the keyboard takes is measured (--kb) and the box and the chat
 * are lifted above it.
 *
 * The car's keyboard is neither. The car draws it over the browser without
 * telling it: the page keeps its size and so does the visual viewport, so
 * nothing can measure it, and the message box stayed under it, out of sight
 * while typing (the owner's Model 3, 16 Oct 2026). There, while a box has
 * the focus and no keyboard was measured, the page is marked `kbover` and
 * the box goes where the car puts its own, at the top: the chat's message
 * box moves up under the tabs, the newest messages just under it
 * (index.html), and any other box is scrolled to the top of what scrolls it.
 */

const vv = window.visualViewport;

/** Where the browser says how much the keyboard takes: the box and the chat are lifted by it. */
export function keyboardSpace(): void {
  if (!vv) return;
  const kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
  document.documentElement.style.setProperty("--kb", `${kb}px`);
  // A keyboard the browser does measure is lifted for by --kb, not guessed at.
  if (kb > 0) document.body.classList.remove("kbover");
}

/** A box the keyboard is for: words typed, not a slider, a tick or a button. */
const typedInto = (t: EventTarget | null): t is HTMLInputElement | HTMLTextAreaElement =>
  t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !["range", "checkbox", "radio", "button", "submit", "file", "color"].includes(t.type));

export function watchKeyboard(): void {
  vv?.addEventListener("resize", keyboardSpace);
  vv?.addEventListener("scroll", keyboardSpace);
  if (!inCar()) return;
  document.addEventListener("focusin", (e) => {
    if (!typedInto(e.target)) return;
    document.body.classList.add("kbover");
    // The chat's box is moved by the page's style; any other is brought up to the top of what scrolls it.
    if (e.target.id !== "typed") e.target.scrollIntoView({ block: "start" });
  });
  document.addEventListener("focusout", (e) => {
    if (typedInto(e.target)) document.body.classList.remove("kbover");
  });
}
