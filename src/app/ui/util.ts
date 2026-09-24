/** Small pieces the panels share. */

export const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const ago = (t?: number) => {
  if (!t) return "never";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 2) return "just now";
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

/**
 * Two taps instead of a native confirm().
 *
 * confirm() halts the renderer until it is answered — it froze an automated
 * click outright — and a modal dialog is a poor thing to put in front of
 * someone sitting in a car. Arming the button in place asks the same question
 * without stopping everything, and it disarms itself after a few seconds so a
 * stray tap cannot sit there loaded.
 */
export function arm(btn: HTMLButtonElement, ask: string, go: () => Promise<void>): void {
  const label = btn.textContent ?? "";
  let armed = false;
  let timer = 0;
  const reset = () => {
    armed = false;
    btn.textContent = label;
    btn.classList.remove("armed");
  };
  btn.addEventListener("click", () => {
    if (armed) {
      clearTimeout(timer);
      reset();
      void go();
      return;
    }
    armed = true;
    btn.textContent = ask;
    btn.classList.add("armed");
    timer = setTimeout(reset, 4000) as unknown as number;
  });
}
