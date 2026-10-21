import * as THREE from "three";
import { frameDue, Governor } from "./governor";
import { SKY_FRAG, SKY_VERT } from "./shaders";

/**
 * The live sky behind the app (src/app/sky.ts feeds it): one full-screen
 * quad in Tesla's colours, its sun, clouds, rain and haze from where home is
 * and its weather. Drawn at a fraction of the screen's resolution and ten
 * frames a second, since everything over it is blurred glass that must be
 * redrawn with it; a screen that cannot afford even that gets a still sky.
 * Held still in the car's driving view.
 */

const FPS_MS = 100;
/** The fractions of the screen's resolution it steps down through, then stills. */
const SCALES = [0.5, 0.33, 0.25];

export class Sky {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private uniforms: Record<string, THREE.IUniform>;
  private governor = new Governor(12, 4);
  private level = 0;
  private still = false;
  /** Still for good: too costly even at the lowest scale (tick), whatever freeze(false) says later. */
  private tooCostly = false;
  private raf = 0;
  private last = 0;
  private started = performance.now();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "low-power" });
    this.uniforms = {
      uTime: { value: 0 },
      uSun: { value: 0.5 },
      uCloud: { value: 0 },
      uRain: { value: 0 },
      uHaze: { value: 0 },
      uTop: { value: new THREE.Color("#171A20") },
      uBottom: { value: new THREE.Color("#000000") },
    };
    const material = new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: this.uniforms, depthTest: false, depthWrite: false });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
    this.resize();
    addEventListener("resize", () => this.resize());
    canvas.addEventListener("webglcontextlost", () => {
      cancelAnimationFrame(this.raf);
      document.documentElement.classList.remove("sky");
    });
    canvas.addEventListener("webglcontextrestored", () => this.freeze(this.still));
  }

  private resize(): void {
    this.renderer.setPixelRatio(SCALES[this.level]!);
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.draw();
  }

  /** The palette of the theme in use, so what is over it stays readable: night #000 to #171A20, day #DDE3EA to #F4F4F4. */
  setTheme(light: boolean): void {
    (this.uniforms.uTop!.value as THREE.Color).set(light ? "#F4F4F4" : "#171A20");
    (this.uniforms.uBottom!.value as THREE.Color).set(light ? "#DDE3EA" : "#000000");
    this.draw();
  }

  set(s: { sun: number; cloud: number; rain: number; haze: number }): void {
    this.uniforms.uSun!.value = s.sun;
    this.uniforms.uCloud!.value = s.cloud;
    this.uniforms.uRain!.value = s.rain;
    this.uniforms.uHaze!.value = s.haze;
    this.draw();
  }

  /** Held still (one frame, drawn again only when something changes), or moving. */
  freeze(still: boolean): void {
    this.still = still || this.tooCostly;
    cancelAnimationFrame(this.raf);
    if (!this.still) this.raf = requestAnimationFrame((t) => this.tick(t));
    this.draw();
  }

  private draw(): void {
    // Lost (the GPU reset, or took it back): nothing over a blank canvas until it is restored.
    if (this.renderer.getContext().isContextLost()) return;
    this.uniforms.uTime!.value = (performance.now() - this.started) / 1000;
    this.renderer.render(this.scene, this.camera);
    document.documentElement.classList.add("sky");
  }

  private tick(t: number): void {
    if (this.still) return;
    this.raf = requestAnimationFrame((n) => this.tick(n));
    if (document.hidden) return;
    // The time between frames as well as the drawing: blurred glass over it costs the GPU, not this.
    const gap = frameDue(t, this.last, FPS_MS);
    if (gap === null) return;
    this.last = t;
    const t0 = performance.now();
    this.draw();
    const step = this.governor.push(Math.max(performance.now() - t0, gap));
    if (step < 0 && this.level === SCALES.length - 1) {
      this.tooCostly = true;
      this.freeze(true);
    } else if (step !== 0) {
      this.level = Math.min(SCALES.length - 1, Math.max(0, this.level - step));
      this.resize();
    }
  }
}
