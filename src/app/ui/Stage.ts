import { authHeaders } from "../key";
import { MAP_STYLE_VERSION } from "../../shared/version";

export interface DisplayPayload {
  kind: "map" | "streetview" | "camera" | "close";
  /** camera only. */
  entity?: string;
  lat: number;
  lng: number;
  label?: string;
  maptype?: string;
  /** Present only when an embed key is configured; gives a pannable view. */
  embedUrl?: string;
}

/**
 * The screen, when something is worth looking at.
 *
 * Two ways to show a place. An interactive Google embed when a browser key is
 * configured — pannable, which a photograph of a street is not. Otherwise a
 * static image proxied through the Worker, which needs no browser-side key at
 * all. The static path is also the fallback if the embed fails to load, because
 * the Tesla browser is not somewhere to discover that an iframe was blocked.
 */
export class Stage {
  private el: HTMLElement;
  private img: HTMLImageElement;
  private frame: HTMLIFrameElement;
  private caption: HTMLElement;
  private objectUrl: string | null = null;
  private token = 0;
  private embedTimer = 0;
  private refreshTimer = 0;
  private dismissTimer = 0;
  private key: string;

  constructor(key: string) {
    this.key = key;
    this.el = document.createElement("div");
    this.el.id = "stage";
    this.el.innerHTML = `
      <div class="frame">
        <img alt="">
        <iframe title="Map" referrerpolicy="origin" loading="eager"
                allow="fullscreen" style="display:none"></iframe>
        <div class="cap"></div>
        <button class="close" aria-label="Close">Close</button>
      </div>`;
    document.body.appendChild(this.el);
    this.img = this.el.querySelector("img")!;
    this.frame = this.el.querySelector("iframe")!;
    this.caption = this.el.querySelector(".cap")!;
    this.el.querySelector(".close")!.addEventListener("click", () => this.hide());
    // Touching the panel means it is still wanted, so restart the fuse.
    this.el.addEventListener("pointerdown", () => {
      if (this.el.classList.contains("open")) this.armDismiss();
    });
  }

  async show(p: DisplayPayload): Promise<void> {
    if (p.kind === "close") {
      this.hide();
      return;
    }

    const mine = ++this.token;
    this.caption.textContent = p.label ?? "";
    document.body.classList.add("staged");
    this.el.classList.add("open");

    clearTimeout(this.refreshTimer);
    this.armDismiss();
    this.el.querySelector(".frame")!.classList.toggle("camera", p.kind === "camera");

    if (p.kind === "camera") {
      await this.showCamera(p, mine);
      return;
    }
    if (p.embedUrl) {
      this.showEmbed(p, mine);
      return;
    }
    await this.showStatic(p, mine);
  }

  /**
   * A camera view, refreshed on a timer.
   *
   * Snapshots rather than an MJPEG stream, because a stream would have to be an
   * <img src> and an img cannot send the auth header — which would mean putting
   * a credential in the URL and undoing the proxying. At roughly one frame a
   * second this is plenty for "who is at the gate", and it stops the moment the
   * panel closes rather than quietly pulling frames for the rest of the drive.
   */
  private async showCamera(p: DisplayPayload, mine: number): Promise<void> {
    this.frame.style.display = "none";
    this.frame.src = "about:blank";
    this.img.style.display = "block";

    const GIVE_UP = 3;
    let failures = 0;
    /** True while the camera is answering; a failure pauses the refreshing. */
    const draw = async (): Promise<boolean> => {
      if (mine !== this.token) return false;
      if (document.hidden) return true;
      try {
        // 540p (960×540): sharp enough on any screen here, and a third of a full
        // frame over a slow link home, so it refreshes several times as often.
        const res = await fetch(`/api/camera?entity=${encodeURIComponent(p.entity!)}&h=540`, {
          headers: authHeaders(this.key),
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`camera ${res.status}`);
        const blob = await res.blob();
        if (mine !== this.token) return false;
        this.revoke();
        this.objectUrl = URL.createObjectURL(blob);
        this.img.src = this.objectUrl;
        this.caption.textContent = p.label ?? "";
        failures = 0;
        return true;
      } catch (e) {
        if (mine !== this.token) return false;
        failures++;
        this.caption.textContent =
          failures < GIVE_UP
            ? `${p.label ?? "Camera"} — slow to answer, trying again…`
            : `Camera unavailable: ${e instanceof Error ? e.message : String(e)}`;
        return false;
      }
    };

    // One frame at a time: the next is asked for only once the last has come.
    // A fixed interval stacked requests up behind a slow camera — measured at
    // 2–5 s a frame — until Jarvis looking at the same camera timed out.
    // A camera that stalls on one frame usually answers the next, so a failure
    // waits a little and tries again; only a camera that keeps failing is given up on.
    const loop = async () => {
      if (mine !== this.token) return;
      const started = Date.now();
      const ok = await draw();
      if (mine !== this.token || failures >= GIVE_UP) return;
      const wait = ok ? Math.max(500, 1100 - (Date.now() - started)) : 3000;
      this.refreshTimer = setTimeout(loop, wait) as unknown as number;
    };
    await loop();
  }

  /**
   * Clear the screen on its own after a while.
   *
   * A panel that stays until someone reaches for a button is the problem this is
   * meant to solve, not a feature. The narrow viewport is the driving split, so
   * it gets a much shorter fuse than the parked one — the driver is not going to
   * study a map at speed, and anything still up is a distraction rather than
   * information.
   */
  private armDismiss(): void {
    clearTimeout(this.dismissTimer);
    const driving = window.innerWidth < 900;
    this.dismissTimer = setTimeout(
      () => this.hide(),
      driving ? 45_000 : 180_000,
    ) as unknown as number;
  }

  private showEmbed(p: DisplayPayload, mine: number): void {
    clearTimeout(this.embedTimer);
    this.img.style.display = "none";
    this.frame.style.display = "block";
    this.frame.onload = () => clearTimeout(this.embedTimer);
    this.frame.src = p.embedUrl!;

    // An iframe that is blocked fires no error, so fall back on a deadline.
    // Better a static picture than an empty rectangle on a dashboard.
    this.embedTimer = setTimeout(() => {
      if (mine !== this.token) return;
      void this.showStatic(p, mine);
    }, 6000) as unknown as number;
  }

  private async showStatic(p: DisplayPayload, mine: number): Promise<void> {
    this.frame.style.display = "none";
    this.frame.src = "about:blank";
    this.img.style.display = "block";

    // Static Maps honours at most 640 per side, doubled by scale=2. Asking for
    // more is silently clamped and the aspect ratio comes back wrong.
    const q = new URLSearchParams({
      kind: p.kind,
      lat: String(p.lat),
      lng: String(p.lng),
      // Part of the URL purely so a styling change invalidates cached imagery.
      sv: String(MAP_STYLE_VERSION),
      w: "640",
      h: String(Math.max(240, Math.min(440, Math.round((window.innerHeight * 0.5) / 2) * 2))),
    });
    if (p.maptype) q.set("maptype", p.maptype);

    try {
      // Fetched with the auth header rather than set as an <img src>, because an
      // img cannot send one and a credential in the URL would undo the proxying.
      const res = await fetch(`/api/map?${q}`, { headers: authHeaders(this.key) });
      if (!res.ok) throw new Error(`imagery ${res.status}`);
      const blob = await res.blob();
      if (mine !== this.token) return;
      this.revoke();
      this.objectUrl = URL.createObjectURL(blob);
      this.img.src = this.objectUrl;
    } catch (e) {
      if (mine !== this.token) return;
      this.caption.textContent = `Could not load that view: ${
        e instanceof Error ? e.message : String(e)
      }`;
    }
  }

  hide(): void {
    this.token++;
    clearTimeout(this.embedTimer);
    clearTimeout(this.dismissTimer);
    clearTimeout(this.refreshTimer);
    this.el.classList.remove("open");
    document.body.classList.remove("staged");
    // Stop the embed doing work behind a closed panel.
    this.frame.src = "about:blank";
    this.frame.style.display = "none";
    this.revoke();
  }

  private revoke(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}
