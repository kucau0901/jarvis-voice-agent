import { inCar } from "./client";
import { button, el } from "./ui/util";

/**
 * Photos and files attached to a typed question, as Hark's chat has them:
 * "+" in the message box, then Upload file or Take photo. A photo is shrunk
 * here to 1600 pixels as a JPEG, enough to read a page in it; a PDF goes as
 * it is, up to 10 MB, for the model to read; a text file as its words. Any
 * other file (a spreadsheet, a document, a text too long to read with a
 * question), up to 10 MB, for whoever may have a job use the workshop, which
 * is all that can open it. They go with that one
 * question to the router (routes/delegate.ts, lib/photos.ts, which holds the
 * same limits) and are kept nowhere but in the folder of a job that was given
 * them: what stays in the conversation is their names.
 *
 * Take photo opens the camera here, in the page, so it is the same on a
 * computer, a phone and the car, where the car allows its cabin camera in
 * Park only.
 */

export interface Attached {
  name: string;
  kind: "image" | "pdf" | "text" | "file";
  /** A data: URL, or a text file's words. */
  data: string;
}

/** As the server takes them (lib/photos.ts). */
const MAX_PHOTOS = 2;
const MAX_FILES = 2;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;
/** A photo's longer side, shrunk to: enough for the model to read a page in it. */
const EDGE = 1600;
const TEXT = /\.(txt|md|markdown|csv|tsv|json|log|xml|ya?ml)$/i;

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A picture as a JPEG data: URL, its longer side at most EDGE. */
function jpeg(source: CanvasImageSource, w: number, h: number): string {
  const scale = Math.min(1, EDGE / Math.max(w, h));
  const canvas = el("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

const asDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("it could not be read"));
    r.readAsDataURL(file);
  });

/**
 * The camera, in a sheet over the page: what it sees, and Take photo. The
 * picture, or null when it was closed; the camera is let go either way.
 */
function snap(): Promise<string | null> {
  const sheet = el("div", "camsheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", "Take a photo");
  const video = el("video");
  video.playsInline = true;
  video.muted = true;
  const said = el("p", "camsaid");
  const row = el("div", "camrow");
  let stream: MediaStream | null = null;
  return new Promise((resolve) => {
    const done = (picture: string | null) => {
      for (const t of stream?.getTracks() ?? []) t.stop();
      document.removeEventListener("keydown", onKey);
      sheet.remove();
      resolve(picture);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && done(null);
    const shoot = button("Take photo", () => video.videoWidth && done(jpeg(video, video.videoWidth, video.videoHeight)), "primary");
    shoot.disabled = true;
    row.append(button("Cancel", () => done(null)), shoot);
    sheet.append(video, said, row);
    document.body.appendChild(sheet);
    document.addEventListener("keydown", onKey);
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then((s) => {
        // Closed while the browser was asking: let it go at once.
        if (!sheet.isConnected) return void s.getTracks().forEach((t) => t.stop());
        stream = s;
        video.srcObject = s;
        void video.play();
        shoot.disabled = false;
      })
      .catch((e) => {
        said.textContent = `The camera could not be opened: ${why(e)}.${inCar() ? " The car lets the browser use its camera only in Park." : ""}`;
      });
  });
}

export class Attachments {
  readonly list: Attached[] = [];
  /** Any file at all, not only what Jarvis reads: for whoever may have a job open it (main.ts whoAmI). */
  set any(on: boolean) {
    this.anyFile = on;
    this.input.accept = on ? "" : this.reads;
    this.told();
  }
  private anyFile = false;
  private reads: string;
  private told = () => {};
  /** Whether that is known yet: a file may be shared into the app as it opens (share.ts). */
  private known = new Promise<void>((ok) => {
    this.told = ok;
    setTimeout(ok, 4000);
  });
  private chips = new Map<Attached, HTMLElement>();

  /**
   * Wired to the message box's "+" (`button`), its menu and its file input;
   * chips go in `tray`, which shows while it holds any; `say` tells why one
   * was not taken.
   */
  constructor(
    private tray: HTMLElement,
    plus: HTMLButtonElement,
    menu: HTMLElement,
    private input: HTMLInputElement,
    private say: (text: string) => void,
  ) {
    this.reads = input.accept;
    const close = () => {
      menu.hidden = true;
      plus.setAttribute("aria-expanded", "false");
    };
    plus.addEventListener("click", () => {
      menu.hidden = !menu.hidden;
      plus.setAttribute("aria-expanded", String(!menu.hidden));
    });
    document.addEventListener("click", (e) => {
      if (!menu.hidden && !(e.target instanceof Node && (menu.contains(e.target) || plus.contains(e.target)))) close();
    });
    menu.querySelector('[data-pick="file"]')!.addEventListener("click", () => {
      close();
      input.click();
    });
    menu.querySelector('[data-pick="photo"]')!.addEventListener("click", () => {
      close();
      void this.photo();
    });
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      input.value = "";
      void this.add(files);
    });
    // Files dropped anywhere on the page are attached, not opened in its place. Other drags are left alone.
    const carriesFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    document.addEventListener("dragover", (e) => carriesFiles(e) && e.preventDefault());
    document.addEventListener("drop", (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      void this.add([...(e.dataTransfer?.files ?? [])]);
    });
  }

  /** Files picked: each taken as a photo, a PDF, text or a file, or said why not. */
  async add(files: File[]): Promise<void> {
    for (const f of files) {
      let kind: Attached["kind"] = f.type.startsWith("image/") ? "image" : f.type === "application/pdf" || /\.pdf$/i.test(f.name) ? "pdf" : f.type.startsWith("text/") || TEXT.test(f.name) ? "text" : "file";
      if (!f.size || (kind !== "image" && f.size > MAX_BYTES)) {
        this.say(f.size ? `${f.name} is over 10 MB.` : `${f.name} is empty.`);
        continue;
      }
      try {
        const text = kind === "text" ? await f.text() : "";
        const picture = kind === "image" ? await createImageBitmap(f).catch(() => null) : null;
        // What Jarvis cannot read here, a job may: a text too long for a question, a picture this browser cannot open.
        const other = kind === "file" || (kind === "text" && text.length > MAX_TEXT_CHARS) || (kind === "image" && !picture);
        if (other) await this.known;
        if (other && !this.anyFile) {
          this.say(kind === "text" ? `${f.name} is too long to read with a question.` : kind === "image" ? `${f.name} could not be opened.` : `Jarvis reads photos, PDFs and text files, so not ${f.name}.`);
          continue;
        }
        if (other) kind = "file";
        if (!this.room(kind)) {
          picture?.close();
          continue;
        }
        if (picture) {
          this.keep({ name: f.name, kind, data: jpeg(picture, picture.width, picture.height) });
          picture.close();
        } else if (kind === "text") this.keep({ name: f.name, kind, data: text });
        // A picture it could not open may be bigger.
        else if (f.size > MAX_BYTES) this.say(`${f.name} is over 10 MB.`);
        // Of no type of its own: whatever it is called, only the workshop opens it.
        else this.keep({ name: f.name, kind, data: await asDataUrl(kind === "pdf" ? f : new Blob([f], { type: "application/octet-stream" })) });
      } catch (e) {
        this.say(`${f.name} could not be read: ${why(e)}.`);
      }
    }
  }

  /** A photo from the camera. */
  async photo(): Promise<void> {
    if (!this.room("image")) return;
    const picture = await snap();
    if (picture) this.keep({ name: `Photo ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.jpg`, kind: "image", data: picture });
  }

  /** What goes with the question being sent; the box is emptied of them. */
  take(): Attached[] {
    const out = [...this.list];
    this.clear();
    return out;
  }

  clear(): void {
    this.list.length = 0;
    for (const chip of this.chips.values()) chip.remove();
    this.chips.clear();
    this.tray.hidden = !this.tray.childElementCount;
  }

  /** What a sent question carried, shown above its words. */
  static shown(list: Attached[]): HTMLElement {
    const box = el("div", "att");
    for (const a of list) box.appendChild(a.kind === "image" ? Object.assign(el("img", "attimg"), { src: a.data, alt: a.name }) : fileChip(a));
    return box;
  }

  /** What a kept question carried, by name only: the files were never kept (conversation.ts). */
  static named(names: string[]): HTMLElement {
    const box = el("div", "att");
    for (const name of names) box.appendChild(fileChip({ name, kind: /\.(jpe?g|png|gif|webp|heic)$/i.test(name) ? "image" : /\.pdf$/i.test(name) ? "pdf" : TEXT.test(name) ? "text" : "file", data: "" }));
    return box;
  }

  private room(kind: Attached["kind"]): boolean {
    const photos = kind === "image";
    if (this.list.filter((a) => (a.kind === "image") === photos).length < (photos ? MAX_PHOTOS : MAX_FILES)) return true;
    this.say(`At most ${photos ? MAX_PHOTOS : MAX_FILES} ${photos ? "photos" : "files"} a message.`);
    return false;
  }

  private keep(a: Attached): void {
    this.list.push(a);
    const chip = a.kind === "image" ? el("span", "tchip img") : fileChip(a);
    if (a.kind === "image") chip.appendChild(Object.assign(el("img"), { src: a.data, alt: "" }));
    const off = button("", () => {
      this.list.splice(this.list.indexOf(a), 1);
      chip.remove();
      this.chips.delete(a);
      this.tray.hidden = !this.tray.childElementCount;
    }, "tremove");
    off.setAttribute("aria-label", `Remove ${a.name}`);
    chip.appendChild(off);
    this.chips.set(a, chip);
    this.tray.appendChild(chip);
    this.tray.hidden = false;
  }
}

/** A file as its kind and its name. */
function fileChip(a: Attached): HTMLElement {
  const chip = el("span", "tchip file");
  chip.dataset.kind = a.kind;
  chip.append(el("span", "ticon"), el("span", "tname", a.name));
  return chip;
}
