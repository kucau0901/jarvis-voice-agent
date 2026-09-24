/**
 * Ashima's 3D simplex noise (MIT). Used for surface displacement; cheap enough
 * to run per-vertex on a 20k-triangle sphere in an in-car GPU budget.
 */
export const SIMPLEX = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(
      i.z+vec4(0.0,i1.z,i2.z,1.0))
    + i.y+vec4(0.0,i1.y,i2.y,1.0))
    + i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m; return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

/** Shared displacement so the core and the shell ripple as one object. */
const FIELD = /* glsl */ `
uniform float uTime, uUser, uAgent, uThink, uDetail;

float field(vec3 p, out float ridge) {
  // Three octaves, each drifting at its own rate: the surface never repeats and
  // never sits still, even in silence.
  float slow = snoise(p * 1.1 + vec3(0.0, uTime * 0.13, 0.0));
  float mid  = snoise(p * 2.6 - vec3(uTime * 0.21, 0.0, uTime * 0.11));
  float fine = snoise(p * 5.4 + vec3(uTime * 0.37));

  // The driver's voice puts sharp ripples across the surface; Jarvis's own
  // voice swells it more smoothly, so the two read differently at a glance.
  float speech = mid * uUser * 1.5 + fine * uUser * 0.9;
  float reply  = slow * uAgent * 1.3 + mid * uAgent * 0.5;

  // Thinking pulls the surface inward and churns it slowly.
  float churn  = snoise(p * 1.7 + vec3(uTime * 0.55)) * uThink * 0.10;

  /*
   * Amplitudes are deliberately small. Noise returns roughly -1..1, so the
   * speech and reply terms can each reach ~2 before scaling; an earlier version
   * multiplied them by 0.26 and 0.22, which at a loud moment displaced the
   * surface by most of its own radius and turned the orb into a crumpled mass.
   * Capped here at roughly a tenth of the radius: clearly alive, still a sphere.
   */
  /*
   * Ridged noise for the energy filaments: it peaks where the noise crosses
   * zero, so it draws thin veins rather than broad patches. Plain abs(noise)
   * sits near zero most of the time, which made every threshold miss.
   *
   * This assignment is not optional: ridge is an out parameter, and leaving
   * it unwritten is undefined behaviour in GLSL. It went missing in an earlier
   * edit and the veins and the point halo both silently disappeared.
   */
  float f1 = pow(1.0 - abs(fine), 6.0);
  float f2 = pow(1.0 - abs(mid), 4.0);
  ridge = clamp(f1 * 0.8 + f2 * 0.4, 0.0, 1.0);

  return slow * 0.030 + mid * 0.016 + fine * 0.009 + speech * 0.050 + reply * 0.055 - churn;
}`;

export const CORE_VERT = /* glsl */ `
${SIMPLEX}
${FIELD}
varying vec3 vNormal, vView, vPos;
varying float vRidge, vDisp;

void main() {
  vec3 dir = normalize(position);
  float ridge;
  float d = field(dir, ridge);
  vRidge = ridge; vDisp = d;

  vec3 displaced = dir * (1.0 + d);
  vec4 mv = modelViewMatrix * vec4(displaced, 1.0);

  vNormal = normalize(normalMatrix * dir);
  vView = normalize(-mv.xyz);
  vPos = displaced;
  gl_Position = projectionMatrix * mv;
}`;

export const CORE_FRAG = /* glsl */ `
precision highp float;
${SIMPLEX}
uniform float uTime, uUser, uAgent, uThink, uError, uVeinQuality;
uniform vec3 uIdle, uSpeak, uListen;
varying vec3 vNormal, vView, vPos;
varying float vRidge, vDisp;

void main() {
  vec3 V = normalize(vView);

  /*
   * The analytic sphere normal, deliberately unperturbed.
   *
   * An earlier version added the screen-space gradient of the displacement to
   * fake surface relief. dFdx/dFdy are constant across a triangle, so that
   * shaded every facet flat and made the mesh's polygons glaringly obvious —
   * far worse than the smoothness it was trying to add. Surface interest comes
   * from the veins and the displaced silhouette instead, which cost nothing and
   * cannot facet.
   */
  vec3 n = normalize(vNormal);

  float facing = clamp(dot(n, V), 0.0, 1.0);
  float fres = pow(1.0 - facing, 3.0);

  vec3 base = uIdle;
  base = mix(base, uListen, clamp(uUser * 1.7, 0.0, 1.0));
  base = mix(base, uSpeak, clamp(uAgent * 1.7, 0.0, 1.0));
  base = mix(base, vec3(1.0, 0.32, 0.36), uError);
  float act = clamp(uUser + uAgent, 0.0, 1.0);

  // A key light from the upper left. This is what makes it read as a sphere
  // rather than a disc: a symmetric rim alone gives the eye no shape cue.
  vec3 L = normalize(vec3(-0.55, 0.72, 0.62));
  float ndl = dot(n, L);
  float diff = clamp(ndl, 0.0, 1.0);
  // Wrapped a little so the terminator curves softly instead of cutting hard.
  float wrap = clamp((ndl + 0.45) / 1.45, 0.0, 1.0);

  // Specular: a small, definite highlight, the strongest single cue for a
  // curved glossy surface.
  vec3 H = normalize(L + V);
  float spec = pow(clamp(dot(n, H), 0.0, 1.0), 64.0);

  // Back rim from the opposite side lifts the dark limb off the background.
  vec3 Lb = normalize(vec3(0.7, -0.35, -0.5));
  float back = pow(clamp(dot(n, Lb), 0.0, 1.0), 2.5) * fres;

  // Enough diffuse to keep the terminator and the sense of volume, but well
  // short of matte: this is a light source, not a painted ball.
  vec3 lit   = base * (0.04 + wrap * 0.20 + diff * 0.14);
  vec3 hi    = mix(vec3(1.0), base + 0.5, 0.3) * spec * (1.0 + act * 0.8);

  // The emissive half. A hot limb plus a deep inner glow is what reads as
  // contained energy rather than a surface.
  vec3 rim   = base * pow(fres, 1.1) * (1.1 + uAgent * 1.1 + uUser * 1.0);
  vec3 bloom = base * back * (1.5 + act * 1.2);
  float deep = pow(facing, 3.0) * (0.18 + act * 0.30) * (0.85 + 0.15 * sin(uTime * 1.7));
  vec3 inner = mix(base, vec3(1.0), 0.25) * deep;

  /*
   * Energy veins.
   *
   * Evaluated per pixel when there is budget for it: the per-vertex ridge is
   * interpolated across triangles and undersamples noise at this frequency, so
   * it renders as soft polygonal patches rather than filaments. uVeinQuality is
   * driven by the same adaptive tier as the geometry, so a slow GPU falls back
   * to the cheap interpolated version rather than dropping frames.
   */
  float ridgeF = vRidge;
  if (uVeinQuality > 0.5) {
    vec3 q = vPos * 5.6 + vec3(uTime * 0.37);
    float nf = snoise(q);
    float nm = snoise(vPos * 2.7 - vec3(uTime * 0.21, 0.0, uTime * 0.11));
    ridgeF = clamp(pow(1.0 - abs(nf), 7.0) * 0.9 + pow(1.0 - abs(nm), 5.0) * 0.35, 0.0, 1.0);
  }
  float veins = smoothstep(0.12, 0.78, ridgeF) * (1.0 + abs(vDisp) * 5.0);
  float travel = 0.5 + 0.5 * sin(uTime * 2.4 + vPos.y * 5.0 + vPos.x * 3.0);
  vec3 vein = mix(base, vec3(1.0), 0.4) * veins * (0.4 + travel * 0.5) * (0.5 + act * 1.5);

  vec3 col = lit + rim + bloom + hi + vein + inner;
  col = col / (col + vec3(0.7));
  gl_FragColor = vec4(col, 1.0);
}`;

/** Outer point shell — the "energy" halo. Additive, depth-write off. */
export const SHELL_VERT = /* glsl */ `
${SIMPLEX}
${FIELD}
uniform float uSize, uPixelRatio;
varying float vGlow;

void main() {
  vec3 dir = normalize(position);
  float ridge;
  float d = field(dir, ridge);

  // Sits just outside the core and breathes with it, so the halo belongs to the
  // orb rather than floating around it.
  float lift = 1.06 + d * 1.3 + (uUser + uAgent) * 0.10;
  vec3 p = dir * lift;

  vGlow = smoothstep(0.08, 0.7, ridge) * (0.3 + uUser * 0.9 + uAgent * 0.8) + uThink * 0.25;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uSize * uPixelRatio * (1.0 + vGlow * 1.2) * (7.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

export const SHELL_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uIdle, uSpeak, uListen;
uniform float uUser, uAgent;
varying float vGlow;

void main() {
  // Round, soft-edged sprite without a texture fetch.
  vec2 uv = gl_PointCoord - 0.5;
  float r = length(uv);
  if (r > 0.5) discard;
  float a = pow(1.0 - r * 2.0, 2.0) * vGlow;

  vec3 c = mix(uIdle, uListen, clamp(uUser * 1.8, 0.0, 1.0));
  c = mix(c, uSpeak, clamp(uAgent * 1.8, 0.0, 1.0));
  gl_FragColor = vec4(c * (1.0 + vGlow), a);
}`;

/** A single quad behind everything: a soft radial bloom for almost no cost. */
export const HALO_VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;

export const HALO_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uIdle, uSpeak, uListen;
uniform float uUser, uAgent, uThink, uTime, uAspect;
varying vec2 vUv;

void main() {
  /*
   * Radius is measured so that r = 1 sits exactly on the top and bottom edges
   * of the quad, which resize() keeps matched to the camera frustum.
   *
   * The previous version used a fixed 5.2-unit plane that was larger than the
   * frustum, so its alpha never reached zero on screen and the canvas edge cut
   * it into a visible rectangle — obvious as soon as a voice pushed the energy
   * up. Correcting x by the aspect ratio also keeps the glow circular instead
   * of stretching it into an ellipse on a wide display.
   */
  vec2 d = (vUv - 0.5) * 2.0;
  float r = length(vec2(d.x * uAspect, d.y));

  float energy = 0.26 + uUser * 0.5 + uAgent * 0.45 + uThink * 0.2;
  float a = (exp(-r * 3.6) * 0.7 + exp(-r * 1.7) * 0.3) * energy;
  // Hard guarantee: nothing is drawn at or beyond the quad's own edge.
  a *= smoothstep(1.0, 0.35, r);
  a *= 0.92 + 0.08 * sin(uTime * 1.4);
  if (a <= 0.002) discard;

  vec3 c = mix(uIdle, uListen, clamp(uUser * 1.6, 0.0, 1.0));
  c = mix(c, uSpeak, clamp(uAgent * 1.6, 0.0, 1.0));
  gl_FragColor = vec4(c, clamp(a, 0.0, 1.0));
}`;
