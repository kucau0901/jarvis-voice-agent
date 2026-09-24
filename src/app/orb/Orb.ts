import * as THREE from "three";
import { CORE_VERT, CORE_FRAG, SHELL_VERT, SHELL_FRAG, HALO_VERT, HALO_FRAG } from "./shaders";

export interface OrbInputs {
  user: number;   // driver's voice, 0..1
  agent: number;  // Jarvis's voice, 0..1
  think: number;  // delegation in flight, 0..1
  error: number;
}

/** Depth of the halo quad, behind the orb. */
const HALO_Z = -0.9;

const PALETTE = {
  idle: new THREE.Color("#3fb8d4"),
  listen: new THREE.Color("#5fe3f0"),
  speak: new THREE.Color("#ffc46b"),
};

/**
 * The orb.
 *
 * Three layers, cheapest first: a soft radial halo quad, a displaced icosahedron
 * core, and an additive point shell for the energy haze. No post-processing —
 * the bloom is faked in-shader, because a real bloom pass costs a full-screen
 * blur the in-car GPU cannot spare.
 *
 * Quality adapts at runtime rather than being guessed from the user agent: the
 * real frame budget in the car is unknown, so the orb measures itself and steps
 * down if it cannot hold the target.
 */
export class Orb {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private core!: THREE.Mesh;
  private shell!: THREE.Points;
  private halo!: THREE.Mesh;
  private uniforms: Record<string, THREE.IUniform>;
  private raf = 0;
  private clock = new THREE.Clock();
  private frames: number[] = [];
  private detail: number;
  private lastTune = 0;
  private running = false;
  private observer: ResizeObserver | null = null;
  private resizePending = 0;

  /** 0 = lowest, 2 = highest. Starts in the middle and settles by measurement. */
  tier = 1;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: true,
      powerPreference: "high-performance",
    });
    // Never honour the car's 1.53 device pixel ratio: it costs ~2.3x the
    // fragment work for no visible gain on a dashboard at arm's length.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
    this.renderer.setClearColor(0x000000, 0);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.camera.position.z = 3.1;

    this.uniforms = {
      uTime: { value: 0 },
      uUser: { value: 0 },
      uAgent: { value: 0 },
      uThink: { value: 0 },
      uError: { value: 0 },
      uDetail: { value: 1 },
      uIdle: { value: PALETTE.idle },
      uListen: { value: PALETTE.listen },
      uSpeak: { value: PALETTE.speak },
      uSize: { value: 1.5 },
      uVeinQuality: { value: 1 },
      uAspect: { value: 1 },
      uPixelRatio: { value: this.renderer.getPixelRatio() },
    };

    this.detail = 5;
    this.build();
    this.resize();

    /*
     * Watch the canvas itself, not just the window.
     *
     * The orb shrinks into the corner when something is on screen and grows back
     * when it closes — a CSS size change with no window resize behind it. The
     * drawing buffer stayed at the small size and got stretched over the large
     * element, so the orb came back visibly pixelated. Coalesced to one resize
     * per frame, because this fires continuously through the 0.55s transition
     * and reallocating the buffer is not free.
     */
    if (typeof ResizeObserver === "function") {
      this.observer = new ResizeObserver(() => {
        if (this.resizePending) return;
        this.resizePending = requestAnimationFrame(() => {
          this.resizePending = 0;
          this.resize();
        });
      });
      this.observer.observe(canvas);
    }
  }

  private build() {
    // Halo first so it renders behind everything else.
    // A unit quad, scaled in resize() to exactly cover the frustum at its depth.
    const haloGeo = new THREE.PlaneGeometry(1, 1);
    this.halo = new THREE.Mesh(
      haloGeo,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: HALO_VERT,
        fragmentShader: HALO_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      }),
    );
    this.halo.position.z = HALO_Z;
    this.scene.add(this.halo);

    this.rebuildGeometry();
  }

  /** Detail is the one knob worth changing at runtime; everything else is fixed. */
  private rebuildGeometry() {
    this.core?.geometry.dispose();
    this.shell?.geometry.dispose();
    if (this.core) this.scene.remove(this.core);
    if (this.shell) this.scene.remove(this.shell);

    const geo = new THREE.IcosahedronGeometry(1, this.detail);

    this.core = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: CORE_VERT,
        fragmentShader: CORE_FRAG,
      }),
    );
    this.scene.add(this.core);

    // The shell gets its own sparse geometry rather than a clone of the core.
    // At detail 6 the core is ~245k vertices, and one point per vertex produced
    // a dense wall of bokeh instead of sparks — and a lot of needless fill.
    this.shell = new THREE.Points(
      new THREE.IcosahedronGeometry(1, 3),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: SHELL_VERT,
        fragmentShader: SHELL_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.scene.add(this.shell);
  }

  resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    // Nothing to do mid-transition if the element has not actually changed.
    const px = this.renderer.getPixelRatio();
    if (
      Math.abs(this.canvas.width - Math.round(w * px)) < 2 &&
      Math.abs(this.canvas.height - Math.round(h * px)) < 2
    ) {
      return;
    }
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.uniforms.uPixelRatio!.value = this.renderer.getPixelRatio();

    // Match the halo quad to the frustum at its own depth, so its falloff always
    // completes on screen and its edge can never show.
    const dist = this.camera.position.z - HALO_Z;
    const height = 2 * dist * Math.tan((this.camera.fov * Math.PI) / 360);
    this.halo?.scale.set(height * aspect, height, 1);
    this.uniforms.uAspect!.value = aspect;
  }

  private inputs: OrbInputs = { user: 0, agent: 0, think: 0, error: 0 };
  set(inputs: Partial<OrbInputs>) {
    Object.assign(this.inputs, inputs);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private frame() {
    const t0 = performance.now();
    const dt = Math.min(this.clock.getDelta(), 0.05);

    const u = this.uniforms;
    u.uTime!.value += dt;
    // Ease toward the targets so a dropped frame never shows as a jump.
    u.uUser!.value += (this.inputs.user - (u.uUser!.value as number)) * 0.25;
    u.uAgent!.value += (this.inputs.agent - (u.uAgent!.value as number)) * 0.25;
    u.uThink!.value += (this.inputs.think - (u.uThink!.value as number)) * 0.08;
    u.uError!.value += (this.inputs.error - (u.uError!.value as number)) * 0.15;

    const spin = 0.05 + (u.uThink!.value as number) * 0.35;
    this.core.rotation.y += dt * spin;
    this.core.rotation.x += dt * spin * 0.35;
    this.shell.rotation.copy(this.core.rotation);
    this.shell.rotation.y -= dt * spin * 1.6;   // counter-rotate for depth

    this.renderer.render(this.scene, this.camera);
    this.tune(performance.now() - t0);
  }

  /**
   * Step quality down if the frame cost is too high, and back up if there is
   * clearly headroom. Hysteresis is wide so it settles instead of oscillating.
   */
  private tune(cost: number) {
    this.frames.push(cost);
    if (this.frames.length < 90) return;

    const now = performance.now();
    if (now - this.lastTune < 4000) { this.frames.length = 0; return; }
    this.lastTune = now;

    const sorted = this.frames.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    this.frames.length = 0;

    // Budget is generous: at 30fps a frame has 33ms, and the browser needs some
    // of that for audio and the data channel.
    if (median > 20) {
      // Shed the per-pixel veins before the geometry: they are pure fragment
      // cost, and losing them is less visible than a coarser silhouette.
      if (this.uniforms.uVeinQuality!.value === 1) {
        this.uniforms.uVeinQuality!.value = 0;
        this.tier = Math.max(0, this.tier - 1);
      } else if (this.detail > 4) {
        this.detail--; this.tier = Math.max(0, this.tier - 1); this.rebuildGeometry();
      }
    } else if (median < 7) {
      if (this.detail < 6) {
        this.detail++; this.tier = Math.min(2, this.tier + 1); this.rebuildGeometry();
      } else if (this.uniforms.uVeinQuality!.value === 0) {
        this.uniforms.uVeinQuality!.value = 1;
        this.tier = Math.min(2, this.tier + 1);
      }
    }
  }

  get quality() {
    return { tier: this.tier, detail: this.detail, veins: this.uniforms.uVeinQuality!.value };
  }

  dispose() {
    this.stop();
    this.observer?.disconnect();
    cancelAnimationFrame(this.resizePending);
    this.core?.geometry.dispose();
    this.shell?.geometry.dispose();
    this.halo?.geometry.dispose();
    this.renderer.dispose();
  }
}
