/**
 * "What am I looking at?" — a photo from the phone's camera, attached to the
 * next question, in push-to-talk or a live session.
 *
 * The phone's own camera app, through a file input, rather than a viewfinder
 * of our own: it is what people know, it focuses and exposes properly, and it
 * also lets them pick a photo they took earlier. The picture is shrunk here to
 * 1024 pixels before it goes anywhere — a 12-megapixel original is four
 * megabytes over mobile data, and the model sees no more in it.
 *
 * Not offered in the car: its browser cannot reach the car's cameras.
 */

const MAX_EDGE = 1024;
/** A photo not asked about within this long is dropped, so it cannot attach itself to an unrelated question. */
const KEEP_MS = 3 * 60_000;

export class Photo {
  private input: HTMLInputElement;
  private chip: HTMLElement;
  private pending: string | null = null;
  private timer = 0;
  private onTaken: () => void;

  constructor(button: HTMLElement, chip: HTMLElement, onTaken: () => void) {
    this.chip = chip;
    this.onTaken = onTaken;
    this.input = document.createElement("input");
    this.input.type = "file";
    this.input.accept = "image/*";
    // The rear camera straight away on a phone; a file picker on a desktop.
    this.input.setAttribute("capture", "environment");
    this.input.hidden = true;
    document.body.appendChild(this.input);
    this.input.addEventListener("change", () => void this.picked());
    button.addEventListener("click", () => this.input.click());
    /*
     * Offered only where there is a camera. The car's browser reports no
     * "Tesla" in its name and blocks the camera and local files alike ("Access
     * to local files on your machine is disabled by your administrator"), so
     * asking the device is the check that works; it also hides the button on a
     * desktop with no webcam. Device kinds are listed without any permission.
     */
    button.hidden = true;
    void navigator.mediaDevices
      ?.enumerateDevices?.()
      .then((devices) => {
        button.hidden = /Tesla/i.test(navigator.userAgent) || !devices.some((d) => d.kind === "videoinput");
      })
      .catch(() => {});
  }

  /** The photo waiting to be asked about, handed over once. */
  take(): string | null {
    const p = this.pending;
    this.clear();
    return p;
  }

  get waiting(): boolean {
    return !!this.pending;
  }

  private async picked(): Promise<void> {
    const file = this.input.files?.[0];
    this.input.value = "";
    if (!file) return;
    try {
      this.pending = await shrink(file);
    } catch {
      this.show("could not read that photo", true);
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.clear(), KEEP_MS) as unknown as number;
    this.show("photo ready — ask about it");
    this.onTaken();
  }

  private show(text: string, bad = false): void {
    this.chip.replaceChildren();
    if (this.pending) {
      const img = document.createElement("img");
      img.src = this.pending;
      img.alt = "";
      this.chip.appendChild(img);
    }
    const label = document.createElement("span");
    label.textContent = text;
    this.chip.appendChild(label);
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "✕";
    x.setAttribute("aria-label", "Discard the photo");
    x.addEventListener("click", () => this.clear());
    this.chip.appendChild(x);
    this.chip.classList.toggle("bad", bad);
    this.chip.hidden = false;
  }

  private clear(): void {
    clearTimeout(this.timer);
    this.pending = null;
    this.chip.hidden = true;
    this.chip.replaceChildren();
  }
}

/** A JPEG no more than MAX_EDGE on its longer side, turned the right way up. */
async function shrink(file: Blob): Promise<string> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.toDataURL("image/jpeg", 0.82);
}

/** For a multipart upload. */
export function photoBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(",", 2);
  const mime = /data:([^;]+)/.exec(head!)?.[1] ?? "image/jpeg";
  return new Blob([Uint8Array.from(atob(b64!), (c) => c.charCodeAt(0))], { type: mime });
}
