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

/**
 * Text with its links and bold made real — for answers that are read rather
 * than heard (typed chat, job results). Built from text nodes and elements,
 * never HTML, and only https links: the words may have come from web pages.
 * `[label](https://…)`, a bare https address and `**bold**` are recognised;
 * everything else stays as written, line breaks included.
 */
export function richText(text: string, cls = "txt"): HTMLElement {
  const box = document.createElement("span");
  box.className = cls;
  const re = /\(?\[([^\]\n]{1,160})\]\((https:\/\/[^\s)]{1,2000})\)\)?|(https:\/\/[^\s<>()]{3,2000})|\*\*([^*\n]{1,200})\*\*/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    box.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[4] !== undefined) {
      const b = document.createElement("strong");
      b.textContent = m[4];
      box.appendChild(b);
    } else {
      const a = document.createElement("a");
      const href = m[2] ?? m[3]!;
      a.textContent = m[1] ?? href.replace(/^https:\/\//, "").replace(/[?#].*$/, "");
      try {
        const u = new URL(href);
        u.searchParams.delete("utm_source");
        a.href = u.toString();
      } catch {
        a.href = "about:blank";
      }
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      const bracketed = m[0].startsWith("(") && m[1] !== undefined;
      if (bracketed) box.appendChild(document.createTextNode("("));
      box.appendChild(a);
      if (bracketed) box.appendChild(document.createTextNode(")"));
    }
    last = m.index! + m[0].length;
  }
  box.appendChild(document.createTextNode(text.slice(last)));
  return box;
}
