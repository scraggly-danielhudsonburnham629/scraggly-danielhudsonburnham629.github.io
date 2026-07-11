// -------------------------------------------------------------
// SENTINEL — the AI orchestrator drone.
//
// Visual language matches the hero centerpiece: an icosahedron whose
// vertices are displaced by 3D simplex noise in a custom vertex shader.
// Distortion amount + noise speed vary per mode, so the drone visibly
// "thinks harder" (writhes more, faster) when indexing vs idle.
//
// Composition:
//   root
//   ├── halo         — soft radial sprite behind (always-visible glow)
//   ├── shell (spins)
//   │   ├── body     — noise-displaced icosahedron (ShaderMaterial)
//   │   ├── wire     — same geometry rendered as wireframe (shared uniforms)
//   │   └── beacon   — small emissive sphere orbiting on the surface
//   ├── core         — bright center point (still while shell spins)
//   ├── scanRing     — torus (fades in during "analyze" modes)
//   ├── pulseRings   — pool of expanding torii
//   └── particles    — pool of directed particles
//
// The scanner (js/scan.js) is a SEPARATE overlay managed by scene.js.
// The old 2D cone beam is gone.
// -------------------------------------------------------------

import * as THREE from 'three';
import { centerpieceVert, centerpieceFrag } from './shaders.js';
import { createShapeSystem } from './shapeSystem.js';

// Viewport breakpoints — used at construction to pick the orb preset's
// triangle budget (design §Performance Considerations · Mobile fallbacks).
// Tight-viewport preset pinning (< 720 px → only `orb`) is intentionally
// owned by the orchestrator, not here — see TODO(7.1) on the exposed
// `shapeSystem` in the returned API.
function isMobile() { return window.innerWidth < 900; }

// Palette
const CYAN   = new THREE.Color(0x6ee7f9);
const VIOLET = new THREE.Color(0xa78bfa);
const GREEN  = new THREE.Color(0x22c55e);
const AMBER  = new THREE.Color(0xfbbf24);
const WHITE  = new THREE.Color(0xffffff);
const DEEP   = new THREE.Color(0x08111c);

// -------------------------------------------------------------
// Mode presets — director's notes. All numeric fields lerp smoothly.
// distortion + noiseSpeed give each mode a visibly different "thinking pace."
// -------------------------------------------------------------
export const MODES = {
  idle: {
    rotSpeed: 0.40, pulseAmp: 0.04, pulseFreq: 1.5,
    distortion: 0.18, noiseSpeed: 0.45,
    scanOpacity: 0.0, ambientParticles: 0.0,
    scale: 1.00, hue: 0.00, cursorTilt: 0.22,
    beacon: GREEN, beaconFreq: 1.4,
  },
  analyze: {
    rotSpeed: 1.20, pulseAmp: 0.05, pulseFreq: 2.8,
    distortion: 0.32, noiseSpeed: 1.60,
    scanOpacity: 0.55, ambientParticles: 0.15,
    scale: 1.00, hue: 0.10, cursorTilt: 0.20,
    beacon: CYAN, beaconFreq: 3.5,
  },
  trace: {
    // Base rotSpeed matches other reading modes. The Journey fast
    // spin (~5.5) is now hover-driven — interactions.js calls
    // companion.setSpeedBoost() when a .tl-item is hovered.
    rotSpeed: 1.20, pulseAmp: 0.03, pulseFreq: 1.3,
    distortion: 0.22, noiseSpeed: 0.80,
    scanOpacity: 0.65, ambientParticles: 0.10,
    scale: 1.00, hue: 0.25, cursorTilt: 0.20,
    beacon: CYAN, beaconFreq: 2.0,
  },
  index: {
    rotSpeed: 1.80, pulseAmp: 0.07, pulseFreq: 3.5,
    distortion: 0.50, noiseSpeed: 2.60,
    scanOpacity: 0.50, ambientParticles: 0.22,
    scale: 1.00, hue: 0.50, cursorTilt: 0.18,
    beacon: VIOLET, beaconFreq: 5.0,
  },
  parse: {
    rotSpeed: 0.75, pulseAmp: 0.05, pulseFreq: 1.9,
    distortion: 0.30, noiseSpeed: 1.30,
    scanOpacity: 0.55, ambientParticles: 0.12,
    scale: 1.00, hue: 0.65, cursorTilt: 0.20,
    beacon: VIOLET, beaconFreq: 2.5,
  },
  verify: {
    rotSpeed: 0.45, pulseAmp: 0.05, pulseFreq: 1.4,
    distortion: 0.22, noiseSpeed: 0.90,
    scanOpacity: 0.15, ambientParticles: 0.08,
    scale: 1.00, hue: 0.80, cursorTilt: 0.20,
    beacon: AMBER, beaconFreq: 1.2,
  },
  broadcast: {
    rotSpeed: 0.65, pulseAmp: 0.12, pulseFreq: 1.0,
    distortion: 0.42, noiseSpeed: 1.10,
    scanOpacity: 0.15, ambientParticles: 0.30,
    scale: 1.20, hue: 1.00, cursorTilt: 0.15,
    beacon: VIOLET, beaconFreq: 1.6,
  },
  await: {
    rotSpeed: 0.30, pulseAmp: 0.09, pulseFreq: 2.4,
    distortion: 0.20, noiseSpeed: 0.70,
    scanOpacity: 0.0, ambientParticles: 0.0,
    scale: 1.00, hue: 0.15, cursorTilt: 0.50,
    beacon: CYAN, beaconFreq: 5.0,
  },
};

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
// Standard smoothstep — works for edge0 > edge1 too (produces reversed ramp,
// which is what design §Algorithms · 4 wants: smoothstep(220, 60, d) → 0 far, 1 close).
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
const NUMERIC_KEYS = [
  'rotSpeed', 'pulseAmp', 'pulseFreq',
  'distortion', 'noiseSpeed',
  'scanOpacity', 'ambientParticles',
  'scale', 'hue', 'cursorTilt', 'beaconFreq',
];

// Floors that keep SENTINEL from ever reading as gray/lifeless
// (design §SENTINEL Character System · Never Gray, R2.5, R2.6)
const HALO_OPACITY_FLOOR   = 0.28;
const BEACON_OPACITY_FLOOR = 0.35;
const BEACON_FREQ_FLOOR    = 1.2;   // Hz — R2.6

// -------------------------------------------------------------
// Halo texture — soft radial gradient for the always-on background glow
// -------------------------------------------------------------
function makeHaloTexture() {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.00, 'rgba(255,255,255,1)');
  g.addColorStop(0.30, 'rgba(255,255,255,0.45)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.05)');
  g.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

export function createCompanion() {
  const root  = new THREE.Group();
  // 2025-11 polish — SENTINEL was reading too small next to editorial
  // typography. Scale the whole root group by 1.4 so halo, shell, core,
  // scan-ring, and pulse-rings all grow proportionally. Position is set
  // externally by scene.js and remains in pixel space.
  root.scale.setScalar(1.4);

  // -----------------------------------------------------------
  // Halo — always-visible soft glow behind the shell so SENTINEL
  // stays legible against any background.
  // -----------------------------------------------------------
  const haloTex = makeHaloTexture();
  const haloMat = new THREE.SpriteMaterial({
    map: haloTex,
    color: CYAN.clone(),
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  });
  const halo = new THREE.Sprite(haloMat);
  halo.scale.setScalar(110);
  halo.renderOrder = -1;
  root.add(halo);

  const shell = new THREE.Group();
  root.add(shell);

  // -----------------------------------------------------------
  // Body — the icosahedron + wire pair was replaced (task 6.2) by the
  // shape pool in shapeSystem.js. The two ShaderMaterials below still
  // exist as *templates* — shapeSystem clones them per preset with a
  // per-preset `uOpacity` uniform (for independent cross-fade) while
  // sharing every other uniform BY REFERENCE. That's what keeps noise
  // animation and mode-color lerps in sync across all preset meshes
  // once companion writes them here each frame.
  //
  // The templates are never rendered — they're not added to the scene
  // graph. `shapeSystem.root` is mounted on `shell` (below) and owns
  // the visible meshes. All presets share BODY_RADIUS = 26 so halo,
  // core, beacon, scan-ring, and pulse-ring geometry never need to
  // resize between morphs (design §Shape Morphing).
  // -----------------------------------------------------------
  const BODY_RADIUS = 26;

  const shaderUniforms = {
    uTime:       { value: 0 },
    uDistortion: { value: 0.18 },
    uHover:      { value: 0 },
    uOpacity:    { value: 1 },
    uColorA:     { value: DEEP.clone()   }, // dark base
    uColorB:     { value: CYAN.clone()   }, // mid (shifts with hue)
    uColorC:     { value: VIOLET.clone() }, // rim
    // Never-gray + cursor-proximity uniforms (task 6.1 / R2.7, R3.2).
    // `uIdleGlow` is consumed by the current centerpiece fragment (see
    // shaders.js) — 1.0 in idle so idle-glow floor mixes in, lerps to 0
    // in active modes so bloom-driven emission takes over cleanly.
    // `uCursorPull` is exposed here for downstream shader work (e.g. a
    // rim-glow term modulated by proximity) — writes update it every
    // frame; readers can pick it up without any companion.js change.
    uIdleGlow:   { value: 1 },
    uCursorPull: { value: 0 },
  };

  const bodyMat = new THREE.ShaderMaterial({
    uniforms: shaderUniforms,      // shared with wireMat + all preset clones
    vertexShader:   centerpieceVert,
    fragmentShader: centerpieceFrag,
    // 2025-11 polish — NormalBlending so the body actually occludes
    // what's behind it. AdditiveBlending was making SENTINEL read as
    // translucent glow through nothing (source + dest without
    // occlusion), especially in sparse presets (ring / shard / lattice).
    // Wire twins still use AdditiveBlending below so the wireframe
    // overlay stays a glowing outline on top of the solid body.
    //
    // depthWrite stays FALSE — during the 0.55 s cross-fade both
    // incoming and outgoing presets are simultaneously semi-transparent,
    // and writing depth would produce order-of-render artifacts. At
    // alpha=1 (post-transition) NormalBlending fully occludes anyway,
    // so we don't need depth write.
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
  });

  const wireMat = new THREE.ShaderMaterial({
    uniforms: shaderUniforms,      // shared → distortion stays in sync
    vertexShader:   centerpieceVert,
    fragmentShader: centerpieceFrag,
    wireframe: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  // -----------------------------------------------------------
  // Shape system — owns the 8 preset meshes (orb / prism / ring /
  // shard / lattice / seal / halo / arrow) and the cross-fade state
  // machine. Mounted on `shell` so the shape group inherits shell
  // rotation + scale (breathing, hover pulse, squash & stretch), and
  // its own anticipation scale-pump composes multiplicatively.
  //
  // On mobile (viewport < 900 px) the orb preset drops to
  // subdivision 1 (80 tris) per design §Performance Considerations.
  // -----------------------------------------------------------
  const shapeSystem = createShapeSystem({
    radius:       BODY_RADIUS,
    material:     bodyMat,
    wireMaterial: wireMat,
    prefersReduced: false, // updated at runtime via setPrefersReduced() below
    orbQuality:   isMobile() ? 'low' : 'high',
  });
  shell.add(shapeSystem.root);

  // -----------------------------------------------------------
  // Beacon — small emissive orbiting light
  // -----------------------------------------------------------
  const beaconMat = new THREE.MeshBasicMaterial({
    color: GREEN.clone(),
    transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(2.8, 14, 14), beaconMat);
  beacon.position.set(0, 18, 20);
  shell.add(beacon);

  // -----------------------------------------------------------
  // Core — bright center dot (does NOT spin with shell)
  // -----------------------------------------------------------
  const coreMat = new THREE.MeshBasicMaterial({
    color: WHITE.clone(),
    transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const core = new THREE.Mesh(new THREE.SphereGeometry(2.6, 14, 14), coreMat);
  root.add(core);

  // -----------------------------------------------------------
  // Scan ring — orbits, opacity per mode
  // -----------------------------------------------------------
  const scanMat = new THREE.MeshBasicMaterial({
    color: CYAN.clone(),
    transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const scanRing = new THREE.Mesh(new THREE.TorusGeometry(36, 0.45, 8, 64), scanMat);
  scanRing.rotation.x = Math.PI / 2;
  root.add(scanRing);

  // -----------------------------------------------------------
  // Pulse ring pool — for emit('pulse'|'checkmark') + big pulse
  // -----------------------------------------------------------
  const pulseRings = [];
  for (let i = 0; i < 4; i++) {
    const g = new THREE.TorusGeometry(24, 0.5, 8, 48);
    const m = new THREE.MeshBasicMaterial({
      color: CYAN.clone(), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const r = new THREE.Mesh(g, m);
    // 2025-11 polish — default rotation faces the camera (torus's axis
    // of symmetry along Z, which is the ortho camera's view axis). The
    // old `rotation.x = Math.PI/2` laid rings flat, so the ortho view
    // read them edge-on as thin lines. Per-emit random tilt is applied
    // in the `emit('pulse')` case below.
    r.rotation.set(0, 0, 0);
    r.userData = { alive: false, t: 0, big: 1 };
    root.add(r);
    pulseRings.push(r);
  }

  // -----------------------------------------------------------
  // Particles pool — for documents_in/out + ambient + big pulse burst
  // -----------------------------------------------------------
  const PCOUNT = 56;
  const pPos  = new Float32Array(PCOUNT * 3);
  const pCol  = new Float32Array(PCOUNT * 3);
  const pVel  = new Float32Array(PCOUNT * 3);
  const pLife = new Float32Array(PCOUNT);
  for (let i = 0; i < PCOUNT; i++) {
    pLife[i] = 1;
    pPos[i * 3] = -10000;
  }
  const pGeom = new THREE.BufferGeometry();
  pGeom.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeom.setAttribute('color',    new THREE.BufferAttribute(pCol, 3));
  const pMat = new THREE.PointsMaterial({
    size: 3.2, transparent: true, opacity: 1,
    vertexColors: true,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: false,
  });
  const particles = new THREE.Points(pGeom, pMat);
  root.add(particles);

  function findDeadParticle() {
    for (let i = 0; i < PCOUNT; i++) if (pLife[i] >= 1) return i;
    return -1;
  }
  function spawnParticle(x, y, vx, vy) {
    const i = findDeadParticle();
    if (i < 0) return;
    pPos[i * 3]     = x;
    pPos[i * 3 + 1] = y;
    pPos[i * 3 + 2] = 0;
    pVel[i * 3]     = vx;
    pVel[i * 3 + 1] = vy;
    pVel[i * 3 + 2] = 0;
    pLife[i] = 0;
  }

  // -----------------------------------------------------------
  // State
  // -----------------------------------------------------------
  const cur = { ...MODES.idle };
  cur.beaconColor = MODES.idle.beacon.clone();
  let target = MODES.idle;
  let hovered = 0;
  let noiseTime = 0;   // accumulated time * noiseSpeed for shader
  let twitchTimer = 3 + Math.random() * 4;
  let twitchZ = 0;
  // Direction for directed emissions (documents_in/out) — set by scene.js
  // via setEmissionDir({dx, dy}) when firing emits toward specific targets.
  let emissionDir = null;

  // Look-at bias — a DOM rect the character softly leans toward.
  // Set via setLookAt(rect) (30% pull) or reachTowards(rect) (60% pull).
  // Cleared by passing null. Composes additively with the cursor tilt.
  let lookAtRect = null;
  let lookAtPull = 0;

  // Reduced-motion gate — when true, motion oscillators freeze while
  // presence floors (halo/beacon/idle-glow) stay lit. Wired from
  // scene.js on boot and re-applied on media-query change (R11.1/11.2).
  let prefersReduced = false;

  // Proximity signal (recomputed every frame inside update). Cached
  // here so getters/consumers can read the last-known pull without a
  // separate closure. Range 0..1 — 1 when cursor sits on the buddy.
  let proximityPull = 0;

  function setMode(name) {
    const m = MODES[name];
    if (m) target = m;
  }
  function setHovered(b) {
    hovered = b ? 1 : 0;
  }
  // Multiplier applied on top of the current mode's rotSpeed. 1 = no
  // boost. Interactions.js sets this to ~4-5 while hovering timeline
  // items so SENTINEL's ring visibly accelerates on hover in Journey.
  // Smooth-lerped in the update loop so the change reads as a
  // spool-up / spool-down rather than a snap.
  let speedBoostTarget = 1;
  let speedBoost = 1;
  function setSpeedBoost(f) {
    speedBoostTarget = Math.max(0.25, Math.min(8, Number(f) || 1));
  }
  function setEmissionDir(dx, dy) {
    if (dx == null || dy == null) { emissionDir = null; return; }
    emissionDir = { x: dx, y: dy };
  }
  // Soft look-at bias toward a DOM rect (up to 30% of cursorTilt).
  // Called by interactions.js on card/row hover, cleared on leave.
  function setLookAt(rect) {
    if (!rect) { lookAtRect = null; lookAtPull = 0; return; }
    lookAtRect = rect;
    lookAtPull = 0.30;
  }
  // Stronger reach toward a target (up to 60%) — the contact-email hover
  // case where SENTINEL actively lunges at the CTA.
  function reachTowards(rect) {
    if (!rect) { lookAtRect = null; lookAtPull = 0; return; }
    lookAtRect = rect;
    lookAtPull = 0.60;
  }
  // Reduced-motion toggle — flipped from scene.js at boot and on the
  // media-query change event so the character adapts within one frame.
  // Also forwarded to shapeSystem so cross-fades collapse to teleport
  // swaps (R11.4, design §Accessibility & Reduced Motion).
  function setPrefersReduced(b) {
    prefersReduced = !!b;
    shapeSystem.setPrefersReduced(prefersReduced);
  }
  function getHue() { return cur.hue; }

  // -----------------------------------------------------------
  // Testability hooks — read-only accessors consumed by dev-only
  // property tests. Not part of the acceptance-criteria surface.
  //
  // • `getUniforms()`   — the shared uniforms block (`uIdleGlow`,
  //   `uCursorPull`, `uHover`, palette colors, etc). Property tests
  //   read `.value` directly; they never write. Companion + every
  //   shape-system preset share this by reference, so the values
  //   reflect what the visible material would sample.
  // • `getMaterials()`  — references to the halo / beacon / scan-ring
  //   / core materials so tests can assert opacity floors (R2.5, R2.6).
  // • `hasActiveEmission()` — true when SENTINEL is emitting light
  //   from any source: idle-glow uniform > 0, scan-ring active, or
  //   any pulse ring alive. Captures the P5 "never gray" clause
  //   `uIdleGlow > 0 OR any active pulse/scan is emitting` in a
  //   single call so tests don't need to know internal layout.
  //
  // Consumers: dev/p4-p5-companion.js (Task 6.3, P4 + P5).
  // -----------------------------------------------------------
  function getUniforms() { return shaderUniforms; }
  function getMaterials() {
    return {
      halo: haloMat,
      beacon: beaconMat,
      scanRing: scanMat,
      core: coreMat,
    };
  }
  function hasActiveEmission() {
    if (shaderUniforms.uIdleGlow.value > 0) return true;
    if (scanMat.opacity > 0.01) return true;
    for (const r of pulseRings) if (r.userData.alive) return true;
    return false;
  }

  function emit(type) {
    switch (type) {
      case 'pulse': {
        // 2025-11 polish — radar-echo style: three concentric rings
        // staggered ~130 ms apart instead of a single expanding torus.
        // Reads as an active "scan/analyze" beat rather than a lone ping.
        // Each ring gets a small random tilt (up to ±25° on X and Y)
        // and a full random spin on Z, so the trio doesn't stack as one
        // flat plate — reads as varied angles of interest rather than
        // parallel lines.
        const ringColor = CYAN.clone().lerp(VIOLET, cur.hue);
        const MAX_TILT = 0.44; // radians (~25°)
        let staggered = 0;
        for (const r of pulseRings) {
          if (r.userData.alive) continue;
          r.userData.alive = true;
          r.userData.t     = -staggered * 0.13; // negative t = pre-roll delay
          r.userData.big   = 1;
          r.material.color.copy(ringColor);
          r.rotation.set(
            (Math.random() - 0.5) * 2 * MAX_TILT,
            (Math.random() - 0.5) * 2 * MAX_TILT,
            Math.random() * Math.PI * 2,
          );
          staggered += 1;
          if (staggered >= 3) break;
        }
        break;
      }
      case 'checkmark': {
        const r = pulseRings.find((r) => !r.userData.alive);
        if (r) {
          r.userData.alive = true;
          r.userData.t = 0;
          const MAX_TILT = 0.44;
          r.rotation.set(
            (Math.random() - 0.5) * 2 * MAX_TILT,
            (Math.random() - 0.5) * 2 * MAX_TILT,
            Math.random() * Math.PI * 2,
          );
          r.userData.big = 0.8;
          r.material.color.set(0x22c55e);
        }
        break;
      }
      case 'documents_out': {
        const angle = emissionDir
          ? Math.atan2(emissionDir.y, emissionDir.x)
          : Math.random() * Math.PI * 2;
        for (let i = 0; i < 12; i++) {
          const a = angle + (Math.random() - 0.5) * 0.55;
          const speed = 70 + Math.random() * 35;
          spawnParticle(0, 0, Math.cos(a) * speed, Math.sin(a) * speed);
        }
        break;
      }
      case 'documents_in': {
        if (!emissionDir) break;
        const angle = Math.atan2(emissionDir.y, emissionDir.x);
        const dist = Math.hypot(emissionDir.x, emissionDir.y);
        for (let i = 0; i < 12; i++) {
          const a = angle + (Math.random() - 0.5) * 0.4;
          const startX = Math.cos(a) * dist;
          const startY = Math.sin(a) * dist;
          const speed = 80 + Math.random() * 30;
          spawnParticle(startX, startY, -Math.cos(a) * speed, -Math.sin(a) * speed);
        }
        break;
      }
    }
  }

  function triggerBigPulse() {
    const MAX_TILT = 0.44;
    for (let k = 0; k < 2; k++) {
      const r = pulseRings.find((r) => !r.userData.alive);
      if (r) {
        r.userData.alive = true;
        r.userData.t = k * 0.15;
        r.userData.big = 1.5;
        r.material.color.copy(CYAN).lerp(VIOLET, cur.hue);
        r.rotation.set(
          (Math.random() - 0.5) * 2 * MAX_TILT,
          (Math.random() - 0.5) * 2 * MAX_TILT,
          Math.random() * Math.PI * 2,
        );
      }
    }
    // Kick distortion so it visibly "reacts" to being poked
    shaderUniforms.uHover.value = Math.min(1.5, shaderUniforms.uHover.value + 1.2);
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + Math.random() * 0.15;
      const speed = 70 + Math.random() * 40;
      spawnParticle(0, 0, Math.cos(a) * speed, Math.sin(a) * speed);
    }
  }

  // -----------------------------------------------------------
  // Per-frame update
  // -----------------------------------------------------------
  const s = 0.06;
  function update(dt, t, cursorNdc, buddyScreenPos) {
    // Lerp mode params
    for (const key of NUMERIC_KEYS) {
      cur[key] = lerp(cur[key], target[key], s);
    }
    cur.beaconColor.lerp(target.beacon, s);

    // Reduced-motion baseline (R11.4) — pin the animated parameters to
    // zero every frame while the mode-color lerp above still runs, so
    // color transitions land but nothing wobbles. Halo/beacon floors
    // and idle-glow stay on below, so the character reads as a static
    // presence rather than disappearing.
    if (prefersReduced) {
      cur.rotSpeed  = 0;
      cur.noiseSpeed = 0;
      cur.pulseAmp  = 0;
    }

    // -----------------------------------------------------------------
    // Proximity signal (design §Algorithms · 4) — computed in overlay
    // pixel space. `buddyScreenPos` arrives DOM-Y-down; convert the NDC
    // cursor into the same space and take the plain hypot.
    // -----------------------------------------------------------------
    let cursorPx = null;
    if (cursorNdc && buddyScreenPos) {
      const w = window.innerWidth, h = window.innerHeight;
      cursorPx = {
        x: (cursorNdc.x + 1) * 0.5 * w,
        y: (1 - cursorNdc.y) * 0.5 * h,
      };
      const d = Math.hypot(cursorPx.x - buddyScreenPos.x, cursorPx.y - buddyScreenPos.y);
      // smoothstep(220, 60, d) → 0 when d≥220, 1 when d≤60. Reverse ramp
      // is intentional: the second edge is the "close" edge.
      proximityPull = smoothstep(220, 60, d);
    } else {
      proximityPull = 0;
    }
    // Expose to downstream shader work (rim-glow, etc.)
    shaderUniforms.uCursorPull.value = proximityPull;

    // Combine the two hover signals: mesh raycast (binary via
    // setHovered) OR proximity smoothstep — take the max (R3.6).
    // Threshold 0.15 corresponds to d ≈ 120 px, per §Algorithms · 4.
    const combinedHover = Math.max(hovered, proximityPull);
    const hoveredForConsumers = combinedHover > 0.15 ? 1 : 0;

    // -----------------------------------------------------------------
    // Shape system tick (R1.6, design §Algorithms · 2). Drives the
    // cross-fade timer + anticipation `1.18×` scale-pump on the shape
    // group's own root. Called BEFORE the shell rotation + scale
    // writes below so the anticipation kick composes multiplicatively
    // with breathing (uPulse from Math.sin) and squash & stretch.
    // -----------------------------------------------------------------
    shapeSystem.update(dt);

    // Shell rotation (hover boost)
    const boost = 1 + hoveredForConsumers * 0.75;
    shell.rotation.y += dt * cur.rotSpeed * 2   * boost;
    shell.rotation.x += dt * cur.rotSpeed * 0.9 * boost;

    // Cursor tilt on the whole root — nudges toward cursor direction
    // (curious, not shy). The `1 + proximityPull * 0.6` multiplier is
    // the SENTINEL · Cursor Interactivity "recoil" — bigger lean when
    // the cursor is closer.
    if (cursorNdc && buddyScreenPos && cursorPx) {
      const dx = cursorPx.x - buddyScreenPos.x;
      const dy = cursorPx.y - buddyScreenPos.y;
      const range = 350;
      const dirX = clamp(dx / range, -1, 1);
      const dirY = clamp(dy / range, -1, 1);
      const tilt = cur.cursorTilt * (1 + proximityPull * 0.6);
      root.rotation.x += (dirY * tilt - root.rotation.x) * 0.07;
      root.rotation.y += (dirX * tilt - root.rotation.y) * 0.07;
    }

    // Look-at / reach bias — additional rotational nudge toward a DOM
    // rect (setLookAt / reachTowards). Composes ON TOP of the cursor
    // tilt above; both use the same 350-px normalizing range so the
    // bias reads as consistent with the cursor lean.
    if (lookAtRect && buddyScreenPos && lookAtPull > 0) {
      const targetX = lookAtRect.left + lookAtRect.width  / 2;
      const targetY = lookAtRect.top  + lookAtRect.height / 2;
      const dx = targetX - buddyScreenPos.x;
      const dy = targetY - buddyScreenPos.y;
      const range = 350;
      const dirX = clamp(dx / range, -1, 1);
      const dirY = clamp(dy / range, -1, 1);
      const bias = cur.cursorTilt * lookAtPull;
      root.rotation.x += (dirY * bias - root.rotation.x) * 0.05;
      root.rotation.y += (dirX * bias - root.rotation.y) * 0.05;
    }

    // Z-axis twitches — occasional random flicks that spring back.
    // Suppressed under reduced motion (R11.4 — static presence).
    if (!prefersReduced) {
      twitchTimer -= dt;
      if (twitchTimer <= 0) {
        twitchTimer = 3 + Math.random() * 5;
        twitchZ += (Math.random() - 0.5) * 0.45;
      }
      twitchZ *= 0.93; // spring back
      root.rotation.z = twitchZ + Math.sin(t * 0.3) * 0.04;
    } else {
      twitchZ = 0;
      root.rotation.z = 0;
    }

    // Pulse scale (shell only — halo has its own)
    const pulseBonus = hoveredForConsumers * 0.03;
    const pulse = 1 + Math.sin(t * cur.pulseFreq) * (cur.pulseAmp + pulseBonus);
    shell.scale.setScalar(cur.scale * pulse);

    // -----------------------------------------------------------------
    // Emissive drift (R2.4) — hue oscillates ±0.05 on a 30 s period
    // regardless of mode. Clamped to [0,1] so palette lerp stays sane
    // for hues that already sit near 1.0 (broadcast).
    // -----------------------------------------------------------------
    const hueDrift = 0.05 * Math.sin(t * (2 * Math.PI / 30));
    const effectiveHue = clamp(cur.hue + hueDrift, 0, 1);
    const bodyColor = CYAN.clone().lerp(VIOLET, effectiveHue);
    const rimColor  = VIOLET.clone().lerp(CYAN, effectiveHue);
    shaderUniforms.uColorB.value.copy(bodyColor);
    shaderUniforms.uColorC.value.copy(rimColor);

    // Noise animation — accumulate time × per-mode speed so shape morphs
    // faster when SENTINEL is "thinking harder"
    noiseTime += dt * cur.noiseSpeed;
    shaderUniforms.uTime.value = noiseTime;
    shaderUniforms.uDistortion.value = cur.distortion;
    // uHover controls extra distortion + rim glow when cursor is near.
    // Sources: (1) combined hover (mesh + proximity), (2) proximity
    // recoil `0.5 * pull` from §SENTINEL · Cursor Interactivity, (3)
    // decayed prior value from triggerBigPulse / shape-morph handoff.
    const targetHover = Math.max(
      combinedHover,
      0.5 * proximityPull,
      shaderUniforms.uHover.value * 0.94,
    );
    shaderUniforms.uHover.value = lerp(shaderUniforms.uHover.value, targetHover, 0.15);

    // Idle-glow uniform (R2.7, R2.8) — 1.0 when idle so the shader's
    // 2025-11 polish — hold idle-glow at 1.0 across all modes. The
    // original spec lerped it to 0 in active modes so bloom-driven
    // emission took over, but that let the body read gray/washed-out
    // in non-idle sections. Keeping the floor at 1 preserves the
    // cyan/violet color signature everywhere; halo + beacon + scan
    // still communicate mode changes through their own channels.
    const idleGlowTarget = 1.0;
    shaderUniforms.uIdleGlow.value = lerp(shaderUniforms.uIdleGlow.value, idleGlowTarget, 0.05);

    // Halo — matches body color, pulses subtly, glows more when hovered.
    // Under reduced motion, freeze the pulse so the halo stays a still
    // ring of presence rather than a breathing one.
    haloMat.color.copy(bodyColor);
    const haloPulse = prefersReduced ? 1 : (1 + 0.10 * Math.sin(t * cur.pulseFreq));
    halo.scale.setScalar((100 + hoveredForConsumers * 20) * cur.scale * haloPulse);
    const haloOpacityRaw = 0.35 + hoveredForConsumers * 0.20 + cur.ambientParticles * 0.15;
    haloMat.opacity = Math.max(HALO_OPACITY_FLOOR, haloOpacityRaw);

    // Beacon — proximity-boosted freq per §SENTINEL · Cursor
    // Interactivity: `beaconFreq ← base × (1 + pull × 0.8)`. Floor at
    // 1.2 Hz so idle still visibly pulses (R2.6).
    beaconMat.color.copy(cur.beaconColor);
    const beaconFreqBoosted = Math.max(BEACON_FREQ_FLOOR, cur.beaconFreq * (1 + proximityPull * 0.8));
    if (prefersReduced) {
      // Static presence — no pulsing, but keep the floor visible.
      beaconMat.opacity = Math.max(BEACON_OPACITY_FLOOR, 0.55);
    } else {
      const beaconRaw = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * beaconFreqBoosted));
      beaconMat.opacity = Math.max(BEACON_OPACITY_FLOOR, beaconRaw);
    }

    // Core
    coreMat.color.copy(bodyColor).lerp(WHITE, 0.55);
    coreMat.opacity = prefersReduced ? 0.85 : (0.7 + 0.3 * Math.sin(t * 2.2));
    core.scale.setScalar(prefersReduced ? 1 : (1 + 0.18 * Math.sin(t * 3)));

    // Scan ring — continuous multi-axis spin (2025-11 v3). Previously
    // the ring oscillated on Y and X via sin/cos, which read as
    // wobbling rather than spinning. Accumulating rotation on all
    // three axes at incommensurate rates gives a proper gyroscope
    // feel — the ring presents different faces to the camera over
    // time without ever "settling" back to a previous orientation.
    //
    // Speed boost is smoothly lerped so hover-in / hover-out reads
    // as a spool-up / spool-down, not a snap. The base rotSpeed
    // stays modest in every mode; interactions.js dials the boost
    // up while hovering timeline items in Journey.
    speedBoost += (speedBoostTarget - speedBoost) * Math.min(1, dt * 3);
    const effRotSpeed = cur.rotSpeed * speedBoost;
    scanMat.opacity = cur.scanOpacity;
    scanMat.color.copy(bodyColor);
    scanRing.rotation.z += dt * (1.6 + effRotSpeed);
    scanRing.rotation.y += dt * (0.95 + effRotSpeed * 0.45);
    scanRing.rotation.x += dt * (0.42 + effRotSpeed * 0.20);

    // Pulse rings — expand + fade. Negative userData.t is the
    // pre-roll delay used by the radar-echo emit path (2025-11 polish);
    // rings hold at scale 0 / opacity 0 until t crosses zero, then
    // expand + fade normally.
    for (const r of pulseRings) {
      if (r.userData.alive) {
        r.userData.t += dt / 1.2;   // was /1.5 — a touch snappier
        if (r.userData.t < 0) {
          // Pre-roll — keep the ring invisible until its stagger hits.
          r.material.opacity = 0;
          r.scale.setScalar(0.001);
        } else if (r.userData.t >= 1) {
          r.userData.alive = false;
          r.material.opacity = 0;
        } else {
          const p = r.userData.t;
          const big = r.userData.big || 1;
          // Wider expansion range so the outermost ring reads far from
          // SENTINEL's body — clearer radar-sweep feel.
          r.scale.setScalar((0.35 + p * 4.2) * big);
          // Ease-out opacity — sharp entry, slow fade. Peak lifted from
          // 0.55 to 0.85 so the ring registers against bright canvases.
          const eased = 1 - Math.pow(1 - p, 2);
          r.material.opacity = (1 - eased) * 0.85;
        }
      }
    }

    // Ambient particles — occasional gentle emission
    if (cur.ambientParticles > 0.03) {
      if (Math.random() < cur.ambientParticles * 0.4) {
        const a = Math.random() * Math.PI * 2;
        const speed = 22 + Math.random() * 30;
        spawnParticle(0, 0, Math.cos(a) * speed, Math.sin(a) * speed);
      }
    }

    // Integrate + fade particles
    for (let i = 0; i < PCOUNT; i++) {
      if (pLife[i] < 1) {
        pLife[i] += dt * 0.85;
        pPos[i * 3]     += pVel[i * 3]     * dt;
        pPos[i * 3 + 1] += pVel[i * 3 + 1] * dt;
        const life = Math.min(1, pLife[i]);
        const b = (1 - life) * (1 - life) * 0.9;
        pCol[i * 3]     = bodyColor.r * b;
        pCol[i * 3 + 1] = bodyColor.g * b;
        pCol[i * 3 + 2] = bodyColor.b * b;
      } else {
        pPos[i * 3] = -10000;
        pCol[i * 3] = 0;
        pCol[i * 3 + 1] = 0;
        pCol[i * 3 + 2] = 0;
      }
    }
    pGeom.attributes.position.needsUpdate = true;
    pGeom.attributes.color.needsUpdate = true;
  }

  function dispose() {
    // Tear down the shape pool first — its meshes are children of `shell`
    // and would also be caught by the traversal below, but calling the
    // system's own dispose ensures the internal preset map is cleared.
    shapeSystem.dispose();
    root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    // Templates aren't in the scene graph, so traversal misses them.
    bodyMat.dispose();
    wireMat.dispose();
    haloTex.dispose();
  }

  return {
    root,
    // The shape pool is exposed so orchestrator + interactions can call
    // `setPreset` / `nudge` without reaching through companion internals.
    // TODO(7.1): the orchestrator is responsible for pinning the preset
    // to 'orb' on tight viewports (< 720 px) and skipping setPreset calls
    // there — companion intentionally does not gate those from here.
    shapeSystem,
    setMode, setHovered, setSpeedBoost, setEmissionDir,
    setLookAt, reachTowards, setPrefersReduced,
    emit, triggerBigPulse, getHue, update, dispose,
    // Testability hooks — Task 6.3 property tests (P4 + P5).
    getUniforms, getMaterials, hasActiveEmission,
  };
}
