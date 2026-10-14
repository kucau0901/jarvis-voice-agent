import { setThemeChoice, themeChoice, THEMES, type ThemeChoice } from "../theme";
import { button, el } from "./util";

/**
 * Light or dark on this screen (theme.ts). Offered to everyone, even before
 * anyone has signed in: it needs no key and changes nothing but this screen.
 */
const LABELS: Record<ThemeChoice, [name: string, help: string]> = {
  auto: ["Auto", "Light by day, dark at night, by this screen's clock"],
  system: ["System", "As this device is set"],
  dark: ["Dark", ""],
  light: ["Light", ""],
};

export class ThemePanel {
  private el: HTMLElement;
  private list: HTMLElement;

  constructor() {
    this.el = el("div", "panel");
    this.el.id = "theme";
    const sheet = el("div", "sheet");
    const head = el("header", "");
    head.appendChild(el("h2", "", "Theme"));
    head.appendChild(button("Done", () => this.hide(), "close"));
    sheet.appendChild(head);
    sheet.appendChild(el("p", "note", "Kept on this screen only, so the car and a phone can differ."));
    this.list = el("div", "navcard");
    this.list.setAttribute("role", "radiogroup");
    this.list.setAttribute("aria-label", "Theme");
    for (const choice of THEMES) {
      const [name, help] = LABELS[choice];
      const b = button("", () => {
        setThemeChoice(choice);
        this.render();
      });
      b.dataset.theme = choice;
      b.setAttribute("role", "radio");
      b.appendChild(el("span", "", name));
      if (help) b.appendChild(el("small", "", help));
      this.list.appendChild(b);
    }
    sheet.appendChild(this.list);
    this.el.appendChild(sheet);
    document.body.appendChild(this.el);
    this.el.addEventListener("click", (e) => {
      if (e.target === this.el) this.hide();
    });
  }

  private render() {
    const now = themeChoice();
    for (const b of this.list.querySelectorAll<HTMLElement>("[role=radio]")) {
      b.setAttribute("aria-checked", String(b.dataset.theme === now));
    }
  }

  show() {
    this.render();
    this.el.classList.add("open");
  }

  hide() {
    this.el.classList.remove("open");
  }
}
