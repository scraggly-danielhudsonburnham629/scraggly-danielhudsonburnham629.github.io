// -------------------------------------------------------------
// Three.js scene v5 — SENTINEL alive.
//
// This is the final integration seam for the alive-portfolio revamp
// (Task 12.1). scene.js owns:
//
//   • Renderer, composer, main + overlay scenes.
//   • Reduced-motion source of truth — reads matchMedia at boot,
//     re-applies via `change` event, propagates to companion, scanner,
//     layoutMotion, reveal, (and interactions/modal via the returned
//     handle).                                        R11.1, R11.2, E6
//   • `textRegions` lifecycle (refresh on section change + resize).
//     Referenced by the orchestrator for text-safe placement.
//                                                     R4.9, R13.6
//   • Orchestrator + companion + shapeSystem + scanner + trail wiring
//     — the safe-position pipeline replaces the legacy
//     pickAdjacentPosition() call.                    R4.1, R7.*
//   • WebGL context loss / restore — preventDefault + dispose + fresh
//     boot on restore, no loader re-show.             R14.2, R14.3, E2
//   • Initial boot failure fallback — hides #bg-canvas, adds .no-webgl,
//     still calls finishLoader().                     R14.1, E1
//   • Mobile geometry drop + tight-viewport disables — orb uses
//     IcosahedronGeometry(R, 1) at < 900 px (via companion's
//     orbQuality); trail + scanner disabled at < 720 px; layoutMotion
//     parallax + skills wobble already gate themselves.
//                                                     R13.3, R13.4
//   • window.__alive dev harness handle (Task 15.1 depends on this).
//
// Design refs:
//   §Migration Plan (integration seams), §Error Handling E1/E2/E6,
//   §Performance Considerations, §Position Awareness.
// -------------------------------------------------------------

import * as THREE from 'three';
import { EffectComposer }   from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }       from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass }  from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass }       from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader }       from 'three/addons/shaders/FXAAShader.js';

import { scrollState } from './scroll.js';
import { centerpieceVert, centerpieceFrag, bgVert, bgFrag } from './shaders.js';
import { createCompanion } from './companion.js';
import { createOrchestrator } from './orchestrator.js';
import { createTrail } from './trail.js';
import { createScanner } from './scan.js';
import { createScanFan } from './scanFan.js';
import { createTextRegions } from './textRegions.js';
import { initReveal } from './reveal.js';
import { initLayoutMotion } from './layoutMotion.js';
import { SECTION_BEHAVIORS } from './data.js';
import * as sfx from './sfx.js';

// Section homes for buddy fallback when the orchestrator has no target
// element (Vision broadcast beats, etc). Kept as arrays of normalized
// {x, y} pulled from the SECTION_BEHAVIORS table so a data-only edit
// stays authoritative.
function homeFor(sectionIdx) {
  const b = SECTION_BEHAVIORS[Math.max(0, Math.min(SECTION_BEHAVIORS.length - 1, sectionIdx | 0))];
  return (b && b.home) || { x: 0.85, y: 0.5 };
}

/**
 * Boot the entire scene subsystem and return a handle the caller can
 * feed to `initInteractions` / `initModal` (see main.js).
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Object} [opts]
 * @param {(pct: number) => void} [opts.onProgress] — 0..100 loader callback.
 * @param {() => void}            [opts.onReady]    — fires once when the
 *   scene is ready to render, OR when boot fails via E1. Never fires twice.
 * @returns {{
 *   getCompanion: () => (object|null),
 *   getBuddyDomPos: () => ({x:number,y:number}|null),
 *   scanner: (object|null),
 *   textRegions: object,
 *   dispose: () => void,
 * }}
 */
export function initScene(canvas, { onProgress, onReady } = {}) {
  const bump = (v) => onProgress && onProgress(v);

  // -----------------------------------------------------------
  // Reduced-motion — the canonical source. Companion + scanner get
  // runtime setters; layoutMotion + reveal are torn down and rebuilt.
  // R11.1, R11.2, E6.
  // -----------------------------------------------------------
  const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let prefersReduced = mediaQuery.matches;

  // -----------------------------------------------------------
  // textRegions — created once. Survives WebGL context loss + restore.
  // Refreshed on section change (via orchestrator) and on resize.
  // -----------------------------------------------------------
  const textRegions = createTextRegions({
    getSectionIndex: () => scrollState.section,
  });
  // Prime the cache after the microtask queue clears so renderers have
  // finished emitting their DOM.
  Promise.resolve().then(() => textRegions.refresh());

  function onResizeTextRegions() { textRegions.refresh(); }
  window.addEventListener('resize', onResizeTextRegions, { passive: true });

  // -----------------------------------------------------------
  // DOM-side subsystems — layoutMotion + reveal. Owned here so they
  // can be torn down and rebuilt on prefers-reduced-motion changes.
  // These are DOM-only and survive WebGL failure.
  // -----------------------------------------------------------
  let layoutMotion = initLayoutMotion({ prefersReduced });
  let reveal       = initReveal({ prefersReduced });

  // Proxy passed to orchestrator so a rebuild of layoutMotion is
  // transparent to consumers holding the reference.
  const layoutMotionProxy = {
    activate: (key) => { if (layoutMotion) layoutMotion.activate(key); },
  };

  // -----------------------------------------------------------
  // Persistent state across context loss/restore
  // -----------------------------------------------------------
  let ctx = null;         // The scene "context" — null after WebGL loss.
  let readyCalled = false;
  let disposed = false;

  const isTight  = () => window.innerWidth < 720;
  const isMobile = () => window.innerWidth < 900;

  function callReadyOnce() {
    if (readyCalled) return;
    readyCalled = true;
    if (onReady) onReady();
  }

  // -----------------------------------------------------------
  // Reduced-motion change — re-apply within one frame (R11.2).
  // -----------------------------------------------------------
  function onMediaChange(e) {
    prefersReduced = !!e.matches;
    if (ctx) {
      if (ctx.companion) ctx.companion.setPrefersReduced(prefersReduced);
      if (ctx.scanner)   ctx.scanner.setPrefersReduced(prefersReduced);
    }
    // Teardown + rebuild layoutMotion and reveal — cleanest way to flip
    // their init-only prefersReduced flag without touching those modules.
    if (layoutMotion) layoutMotion.dispose();
    if (reveal)       reveal.destroy();
    layoutMotion = initLayoutMotion({ prefersReduced });
    reveal       = initReveal({ prefersReduced });
  }
  // Support both modern addEventListener and legacy addListener.
  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', onMediaChange);
  } else if (typeof mediaQuery.addListener === 'function') {
    mediaQuery.addListener(onMediaChange);
  }

  // -----------------------------------------------------------
  // WebGL context loss / restore (E2, R14.2, R14.3)
  // -----------------------------------------------------------
  function onContextLost(e) {
    e.preventDefault();
    if (!ctx) return;
    if (ctx.rafId) cancelAnimationFrame(ctx.rafId);
    try { ctx.dispose(); } catch (_e) { /* ignore during context loss */ }
    ctx = null;
  }
  function onContextRestored() {
    if (disposed || ctx) return;
    ctx = bootScene(true);
  }
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);

  // -----------------------------------------------------------
  // Boot — wrapped in try/catch for E1 (WebGL failure)
  // -----------------------------------------------------------
  function bootScene(isRestore) {
    try {
      const scene = _createSceneContext(!!isRestore);
      // On successful boot (initial or restore) mark ready if not
      // already; loader stays hidden on subsequent restores.
      callReadyOnce();
      return scene;
    } catch (err) {
      // E1 — WebGL initialization failed. Hide canvas, add .no-webgl,
      // still fire onReady so the loader finishes.
      // eslint-disable-next-line no-console
      console.warn('[scene] initialization failed:', err);
      try { document.documentElement.classList.add('no-webgl'); } catch (_e) { /* noop */ }
      try { canvas.style.display = 'none'; } catch (_e) { /* noop */ }
      callReadyOnce();
      return null;
    }
  }

  // Kick things off.
  ctx = bootScene(false);

  // Expose the dev harness handle. Property tests (Task 15.1) read
  // this map to drive shape / section / cursor programmatically.
  try {
    const prev = (typeof window !== 'undefined' && window.__alive) || {};
    window.__alive = {
      ...prev,
      companion: ctx ? ctx.companion : null,
      shapeSystem: ctx && ctx.companion ? ctx.companion.shapeSystem : null,
      scanner: ctx ? ctx.scanner : null,
      textRegions,
      scrollState,
      // Live reference to the mutable SECTION_BEHAVIORS array — property
      // tests (P3, P9) read baselines and, for P9, temporarily push a
      // 9th entry to exercise data-driven scalability.
      SECTION_BEHAVIORS,
      // Layout motion proxy — thin wrapper so tests can spy on `.activate`
      // even when the underlying `layoutMotion` is rebuilt on a
      // reduced-motion media-query flip.
      layoutMotion: layoutMotionProxy,
      setSection: (i) => { scrollState.section = i | 0; if (ctx) ctx.textRegionsRefresh(); },
      setCursor: (x, y) => { if (ctx && ctx.setCursorNdc) ctx.setCursorNdc(x, y); },
      // Testability hook — property test P6 (Task 15.2) invokes the same
      // code path the browser triggers on a `matchMedia` change event, so
      // the whole reduced-motion pipeline (companion + scanner +
      // layoutMotion rebuild + reveal rebuild) can be exercised from the
      // harness without OS-level media-query support. Pass `false` to
      // restore normal motion after a test finishes. See
      // `dev/p6-reduced-motion.js`.
      setReducedMotion: (matches) => { onMediaChange({ matches: !!matches }); },
      propertyTests: prev.propertyTests || [],
    };
  } catch (_e) { /* dev harness is best-effort */ }

  // -----------------------------------------------------------
  // Public handle
  // -----------------------------------------------------------
  return {
    getCompanion:    () => (ctx ? ctx.companion : null),
    getOrchestrator: () => (ctx ? ctx.orchestrator : null),
    getScanFan:      () => (ctx ? ctx.scanFan : null),
    getBuddyDomPos: () => (ctx && ctx.getBuddyDomPos ? ctx.getBuddyDomPos() : null),
    // scanner is a getter-like property but declared as a value here so
    // callers can read it once and hold on. Post-restore, callers that
    // held the old reference will hit a disposed object — they should
    // re-read via getCompanion()?.shapeSystem style getters if they need
    // hot-swap behaviour. Interactions.js is expected to re-read.
    get scanner() { return ctx ? ctx.scanner : null; },
    get scanFan() { return ctx ? ctx.scanFan : null; },
    textRegions,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', onMediaChange);
      } else if (typeof mediaQuery.removeListener === 'function') {
        mediaQuery.removeListener(onMediaChange);
      }
      canvas.removeEventListener('webglcontextlost', onContextLost, false);
      canvas.removeEventListener('webglcontextrestored', onContextRestored, false);
      window.removeEventListener('resize', onResizeTextRegions);
      if (layoutMotion) { try { layoutMotion.dispose(); } catch (_e) {} }
      if (reveal)       { try { reveal.destroy();  } catch (_e) {} }
      if (textRegions)  { try { textRegions.dispose(); } catch (_e) {} }
      if (ctx)          { try { ctx.dispose();     } catch (_e) {} }
      ctx = null;
    },
  };

  // -------------------------------------------------------------
  //                _createSceneContext — the core
  // -------------------------------------------------------------
  // Everything inside is torn down and rebuilt on WebGL context loss.
  // Returns an object with `.dispose()` + accessor helpers, or throws
  // to trigger the E1 fallback path.
  // -------------------------------------------------------------
  function _createSceneContext(isRestore) {
    const dpr = Math.min(window.devicePixelRatio, isMobile() ? 1.5 : 2);

    // -------- renderer --------
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(dpr);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.setClearColor(0x06060b, 1);
    renderer.autoClear = false;

    // -------- overlay renderer (separate canvas above section content) --------
    const overlayCanvas = document.getElementById('overlay-canvas');
    const overlayRenderer = new THREE.WebGLRenderer({
      canvas: overlayCanvas,
      antialias: false,
      alpha: true,    // transparent background — only overlay objects draw
      powerPreference: 'high-performance',
    });
    overlayRenderer.setPixelRatio(dpr);
    overlayRenderer.setSize(window.innerWidth, window.innerHeight, false);
    overlayRenderer.setClearColor(0x000000, 0); // fully transparent
    overlayRenderer.autoClear = true;

    // Undo any prior .no-webgl / display:none if this is a restore.
    if (isRestore) {
      try { document.documentElement.classList.remove('no-webgl'); } catch (_e) {}
      try { canvas.style.display = ''; } catch (_e) {}
      try { overlayCanvas.style.display = ''; } catch (_e) {}
    }
    bump(isRestore ? 100 : 15);

    // -------- main scene + camera --------
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      45, window.innerWidth / window.innerHeight, 0.1, 100,
    );
    camera.position.set(0, 0, 6);

    // -------- background quad --------
    const bgUniforms = {
      uTime:       { value: 0 },
      uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
      uMouse:      { value: new THREE.Vector2(0.5, 0.5) },
      uScroll:     { value: 0 },
    };
    const bgMat = new THREE.ShaderMaterial({
      uniforms: bgUniforms,
      vertexShader: bgVert,
      fragmentShader: bgFrag,
      depthTest: false,
      depthWrite: false,
    });
    const bgQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat);
    bgQuad.frustumCulled = false;
    bgQuad.renderOrder = -100;
    scene.add(bgQuad);
    bump(isRestore ? 100 : 35);

    // -------- hero centerpiece (unchanged from v4) --------
    const group = new THREE.Group();
    scene.add(group);
    const detail = isMobile() ? 2 : 3;
    const geom = new THREE.IcosahedronGeometry(1, detail);
    const uniforms = {
      uTime:       { value: 0 },
      uDistortion: { value: 0.32 },
      uHover:      { value: 0 },
      uOpacity:    { value: 1 },
      uColorA:     { value: new THREE.Color(0x08111c) },
      uColorB:     { value: new THREE.Color(0x6ee7f9) },
      uColorC:     { value: new THREE.Color(0xa78bfa) },
      // Silence any "uniform not found" warning on shaders that gained
      // uIdleGlow — the hero centerpiece never wants it lit.
      uIdleGlow:   { value: 0 },
      uCursorPull: { value: 0 },
    };
    const solidMat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader:   centerpieceVert,
      fragmentShader: centerpieceFrag,
      transparent: true,
      depthWrite: false,
    });
    const solid = new THREE.Mesh(geom, solidMat);
    solid.scale.setScalar(0.985);
    group.add(solid);

    const wireMat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader:   centerpieceVert,
      fragmentShader: centerpieceFrag,
      wireframe: true,
      transparent: true,
      depthWrite: false,
    });
    const wire = new THREE.Mesh(geom, wireMat);
    wire.scale.setScalar(1.0);
    group.add(wire);

    const centerpieceHome = new THREE.Vector3();
    function updateCenterpieceHome() {
      const tightHero = isMobile();
      centerpieceHome.set(
        tightHero ? 0    : 2.2,
        tightHero ? 1.6  : 0.2,
        0,
      );
      group.scale.setScalar(tightHero ? 1.05 : 1.55);
    }
    updateCenterpieceHome();
    group.position.copy(centerpieceHome);
    bump(isRestore ? 100 : 60);

    // -------- post-processing (unchanged from v4) --------
    const usePost = !prefersReduced;
    let composer  = null;
    let fxaaPass  = null;
    let bloomPass = null;
    if (usePost) {
      composer = new EffectComposer(renderer);
      composer.setPixelRatio(dpr);
      composer.setSize(window.innerWidth, window.innerHeight);
      composer.addPass(new RenderPass(scene, camera));
      bloomPass = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        isMobile() ? 0.25 : 0.4,
        0.55,
        0.55,
      );
      composer.addPass(bloomPass);
      fxaaPass = new ShaderPass(FXAAShader);
      fxaaPass.material.uniforms['resolution'].value.set(
        1 / (window.innerWidth * dpr),
        1 / (window.innerHeight * dpr),
      );
      fxaaPass.renderToScreen = true;
      composer.addPass(fxaaPass);
    }
    bump(isRestore ? 100 : 80);

    // -------- overlay scene + camera --------
    const overlayScene = new THREE.Scene();
    const overlayCam = new THREE.OrthographicCamera(
      0, window.innerWidth, window.innerHeight, 0, 0.1, 1000,
    );
    overlayCam.position.z = 500;

    // -------- companion (SENTINEL) --------
    const companion = createCompanion();
    // companion.js reads viewport at init; the < 900 px orb geometry
    // drop (R13.3) is applied there via orbQuality. Ensure the
    // reduced-motion baseline lands before the first tick.
    companion.setPrefersReduced(prefersReduced);
    overlayScene.add(companion.root);

    // -------- trail --------
    const trail = createTrail();
    overlayScene.add(trail.mesh);

    // -------- scanner --------
    const scanner = createScanner();
    scanner.setPrefersReduced(prefersReduced);
    overlayScene.add(scanner.mesh);

    // -------- scan fan --------
    // Emissive laser fan SENTINEL emits toward a target during the
    // Skills item-scan. Adapted from prisoner849/mdxQjeW. Mounted in
    // the overlay scene so it shares SENTINEL's pixel-space camera;
    // scanFan.setPosition follows SENTINEL each frame (see the render
    // tick below); scanFan.fireAt is called by interactions.js on
    // .mf-group hover to aim and pulse it.
    const scanFan = createScanFan(THREE);
    overlayScene.add(scanFan.mesh);

    // -------- orchestrator --------
    // Wired with every subsystem it can drive. layoutMotion is passed
    // via the proxy so a media-query rebuild is transparent.
    const orchestrator = createOrchestrator({
      companion,
      shapeSystem:  companion.shapeSystem,
      scanner,
      layoutMotion: layoutMotionProxy,
      textRegions,
    });

    // -------- companion positioning --------
    const companionPos    = new THREE.Vector2();
    const companionTarget = new THREE.Vector2();

    function setCompanionScale() {
      companion.root.scale.setScalar(isTight() ? 0.7 : 1.0);
    }

    // Fallback anchor for sections with no orchestrator target
    // (Vision broadcast) or tight-viewport pin (R4.8, R13.4).
    function fallbackTarget(sectionIdx) {
      const w = window.innerWidth, h = window.innerHeight;
      if (isTight()) {
        // Pin bottom-right — matches textRegions mobile bypass.
        companionTarget.set(w - 90, 110);
        return;
      }
      const home = homeFor(sectionIdx);
      companionTarget.set(home.x * w, (1 - home.y) * h);
    }
    fallbackTarget(scrollState.section);
    companionPos.copy(companionTarget);
    setCompanionScale();

    const hudPos = new THREE.Vector2().copy(companionPos);
    const hudEl  = document.querySelector('.companion-hud');

    // -------- cursor --------
    const ndc = new THREE.Vector2(0, 0);
    const ndcTarget = new THREE.Vector2(0, 0);
    const raycaster = new THREE.Raycaster();

    function onMouseMove(e) {
      ndcTarget.x = (e.clientX / window.innerWidth) * 2 - 1;
      ndcTarget.y = -(e.clientY / window.innerHeight) * 2 + 1;
      bgUniforms.uMouse.value.set(
        e.clientX / window.innerWidth,
        1 - e.clientY / window.innerHeight,
      );
    }
    function onTouchMove(e) {
      if (e.touches.length) {
        ndcTarget.x = (e.touches[0].clientX / window.innerWidth) * 2 - 1;
        ndcTarget.y = -(e.touches[0].clientY / window.innerHeight) * 2 + 1;
      }
    }
    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });

    function onResize() {
      const w = window.innerWidth, h = window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      overlayRenderer.setSize(w, h, false);
      bgUniforms.uResolution.value.set(w, h);
      updateCenterpieceHome();
      if (composer) composer.setSize(w, h);
      if (fxaaPass) {
        fxaaPass.material.uniforms['resolution'].value.set(1 / (w * dpr), 1 / (h * dpr));
      }
      overlayCam.left = 0;
      overlayCam.right = w;
      overlayCam.top = h;
      overlayCam.bottom = 0;
      overlayCam.updateProjectionMatrix();
      setCompanionScale();
      fallbackTarget(scrollState.section);
    }
    window.addEventListener('resize', onResize);
    bump(isRestore ? 100 : 95);

    // -------------------------------------------------------------
    // Poke — click within 55 px of SENTINEL fires the big pulse +
    // transient orb morph (R8.1). Runs in capture phase so it can
    // intercept before card clicks fire.
    // -------------------------------------------------------------
    function onDocClick(e) {
      if (isTight()) return;
      const h = window.innerHeight;
      const buddyDomX = companionPos.x;
      const buddyDomY = h - companionPos.y;
      const d = Math.hypot(e.clientX - buddyDomX, e.clientY - buddyDomY);
      if (d < 55) {
        companion.triggerBigPulse();
        // R8.1 — transient morph to `orb` regardless of section baseline,
        // decay ≤ 1.2 s. Skipped under reduced-motion.
        if (!prefersReduced && companion.shapeSystem) {
          try {
            companion.shapeSystem.nudge('orb', { transient: true, duration: 1.2 });
          } catch (_e) { /* nudge is best-effort */ }
        }
        // Poke SFX — SENTINEL's own resonance sound. Must fire here
        // (not in interactions.js) because we call stopPropagation
        // below to prevent card-click leakage, which also cuts off
        // the delegated onClick handler in interactions.js.
        sfx.poke();
        e.stopPropagation();
        e.preventDefault();
      }
    }
    document.addEventListener('click', onDocClick, true);

    // -------- ready --------
    const start = performance.now();
    let last = start;
    bump(isRestore ? 100 : 100);

    let rafId = 0;
    let stopped = false;

    // -------------------------------------------------------------
    // Frame loop
    // -------------------------------------------------------------
    function tick() {
      if (stopped) return;
      // -----------------------------------------------------------
      // Frame budget instrumentation (Task 15.3, R13.1/R13.2).
      // `tick:start` here + `tick:end` before the render block below
      // gives us the tick-body duration excluding `composer.render()` /
      // `renderer.render()` — that is exactly what R13.2 constrains
      // (median ≤ 4 ms, p95 ≤ 8 ms). The `tick` measure name is
      // consumed by dev/p10-frame-budget.js via
      // `performance.getEntriesByName('tick')`. Marks are cleared each
      // frame so the mark buffer stays bounded; the measures buffer is
      // left for the test to sample + reset.
      // -----------------------------------------------------------
      try { performance.mark('tick:start'); } catch (_e) { /* noop */ }
      const now = performance.now();
      const t = (now - start) / 1000;
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      ndc.x += (ndcTarget.x - ndc.x) * 0.08;
      ndc.y += (ndcTarget.y - ndc.y) * 0.08;

      bgUniforms.uTime.value   = t;
      bgUniforms.uScroll.value = scrollState.progress;

      uniforms.uTime.value = t;

      // Hover detection on the hero centerpiece (perspective raycast).
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObject(wire, false);
      const hoverTarget = hits.length > 0 ? 1 : 0;
      uniforms.uHover.value += (hoverTarget - uniforms.uHover.value) * 0.08;

      // Autonomous rotation + subtle mouse tilt on the hero centerpiece.
      group.rotation.y += 0.003;
      group.rotation.x = ndc.y * 0.32;
      group.rotation.z = ndc.x * 0.12;

      // Fade the hero centerpiece as we scroll past it.
      const heroProgress = Math.min(1, scrollState.scrollY / (window.innerHeight * 0.85));
      uniforms.uOpacity.value = Math.max(0, 1 - heroProgress);
      group.position.x = centerpieceHome.x + heroProgress * 1.8 + ndc.x * 0.15;
      group.position.y = centerpieceHome.y + heroProgress * 1.2 + ndc.y * 0.10;

      // -----------------------------------------------------------
      // Orchestrator — decides mode, shape, target, and returns a
      // text-safe position. On section change it also drives
      // companion.setMode, shapeSystem.setPreset, scanner.setEnabled,
      // layoutMotion.activate, and textRegions.refresh (Task 7.1).
      // -----------------------------------------------------------
      const orderly = orchestrator.update(dt);

      // -----------------------------------------------------------
      // Companion target + emission direction. Tight viewport pins
      // bottom-right regardless of what the orchestrator computed.
      // -----------------------------------------------------------
      if (isTight()) {
        fallbackTarget(scrollState.section);
        companion.setEmissionDir(null, null);
      } else if (orderly.safePosition) {
        const adj = orderly.safePosition;
        const wH = window.innerHeight;
        // Convert DOM top-down safePosition (from textRegions /
        // orchestrator) into overlay Y-up space.
        companionTarget.set(adj.x, wH - adj.y);

        // Emission direction — toward the focused element's centre
        // (particles fly TO/FROM the target). Only when there's an
        // actual rect; broadcast beats leave emissionDir null.
        if (orderly.targetRect) {
          const rect = orderly.targetRect;
          const elemCX = rect.left + rect.width  / 2;
          const elemCY = rect.top  + rect.height / 2;
          companion.setEmissionDir(
            elemCX - companionPos.x,
            (wH - elemCY) - companionPos.y,
          );
        } else {
          companion.setEmissionDir(null, null);
        }
      } else {
        fallbackTarget(scrollState.section);
        companion.setEmissionDir(null, null);
      }

      // Fire orchestrator's scheduled emit AFTER emissionDir is set so
      // documents_in/out particles use the fresh direction.
      if (orderly.emit) companion.emit(orderly.emit);

      // -----------------------------------------------------------
      // Scanner — the orchestrator gates section-driven enable via
      // scanner.setEnabled(behavior.scanner === true). Tight viewport
      // forces the target to null so the scanner fades out (R13.4).
      // -----------------------------------------------------------
      if (isTight()) {
        scanner.setTarget(null);
      } else if (orderly.targetRect) {
        // Explicit hover only (2025-11 polish). The earlier ambient
        // spotlight fallback made the first project card look "always
        // scanning" once the user had ever hovered a row — reads as
        // stuck rather than reactive. Scanner now targets ONLY when
        // there's a real hover, and interactions.js clears it on leave.
        scanner.setTarget(orderly.targetRect);
        const hueColor = new THREE.Color(0x6ee7f9)
          .lerp(new THREE.Color(0xa78bfa), companion.getHue());
        scanner.setColor(hueColor);
      } else {
        scanner.setTarget(null);
      }
      scanner.update(dt);

      // Glide toward target. 0.08 gives ~12-frame settle at 60 fps —
      // fast enough to track hover changes without feeling teleporty,
      // slow enough to read as a deliberate glide rather than a snap.
      // (Was 0.05 which felt janky in Skills where groups are stacked
      // tight — SENTINEL couldn't keep up and lagged behind the cursor.)
      companionPos.x += (companionTarget.x - companionPos.x) * 0.08;
      companionPos.y += (companionTarget.y - companionPos.y) * 0.08;

      // Bob — "in space" floating idle motion. Two sine components
      // at incommensurate frequencies on each axis so the path
      // traces a Lissajous-like curve rather than a mechanical
      // oscillation. Total amplitude capped at ~14 px on each axis
      // so it never pushes SENTINEL into content: pickSafePosition
      // guarantees ~40 px clearance from text, leaving 26 px+ of
      // safe zone even at the bob's extreme excursion.
      const bobX = Math.sin(t * 0.42)           * 8
                 + Math.sin(t * 0.29 + 1.3)     * 5;
      const bobY = Math.cos(t * 0.31 + 0.6)     * 7
                 + Math.cos(t * 0.51 + 2.1)     * 4;
      const finalX = companionPos.x + bobX + ndc.x * 8;
      const finalY = companionPos.y + bobY + ndc.y * 6;
      companion.root.position.set(finalX, finalY, 0);

      // Keep the scan-fan anchored each frame, then tick shader
      // time + fade. When tracking a DOM element:
      //   • origin: 'sentinel' (default) — emitter locked to SENTINEL,
      //     fan aims at target centre AND its reach is clipped each
      //     frame so the tip lands exactly on the target (no
      //     over-shoot past the item).
      //   • origin: 'below'    — emitter positioned below the target
      //     with a small offset, fan aims straight up into the target.
      //     (Currently unused; kept for future patterns.)
      // DOM Y-down → overlay Y-up conversion happens here once.
      const trackEl = scanFan.getTrackingEl && scanFan.getTrackingEl();
      const originMode = trackEl && scanFan.getOriginMode
        ? scanFan.getOriginMode()
        : 'sentinel';

      if (trackEl && originMode === 'below') {
        const tr = trackEl.getBoundingClientRect();
        if (tr.width > 0 && tr.height > 0) {
          const txCenter  = tr.left + tr.width / 2;
          const targetTop = window.innerHeight - tr.top;
          const targetBot = window.innerHeight - tr.bottom;
          const originY   = targetBot - 40;
          scanFan.setPosition(txCenter, originY);
          scanFan.aimAt(txCenter, targetTop);
          if (scanFan.setReach) scanFan.setReach(Math.abs(targetTop - originY));
        }
      } else {
        // Default: emitter tracks SENTINEL. Reach clipped to distance.
        scanFan.setPosition(finalX, finalY);
        if (trackEl) {
          const tr = trackEl.getBoundingClientRect();
          if (tr.width > 0 && tr.height > 0) {
            const txOverlay = tr.left + tr.width  / 2;
            const tyOverlay = window.innerHeight - (tr.top + tr.height / 2);
            scanFan.aimAt(txOverlay, tyOverlay);
            if (scanFan.setReach) {
              const dist = Math.hypot(txOverlay - finalX, tyOverlay - finalY);
              scanFan.setReach(dist);
            }
          }
        }
      }
      scanFan.update(dt);

      // -----------------------------------------------------------
      // Companion update — cursor proximity + shape system tick.
      // -----------------------------------------------------------
      if (!isTight()) {
        const wV = window.innerWidth, hV = window.innerHeight;
        const cursorSX = (ndc.x + 1) * 0.5 * wV;
        const cursorSY = (1 - ndc.y) * 0.5 * hV;
        const buddyDomX = finalX;
        const buddyDomY = hV - finalY;
        // Scaled with the 1.4× SENTINEL size bump (see companion.js
        // root.scale). ~85 px in DOM space matches the new visible halo
        // radius so the hover reaction fires when the cursor is genuinely
        // over SENTINEL, not when it's a body-width away.
        const near = Math.hypot(cursorSX - buddyDomX, cursorSY - buddyDomY) < 85;
        companion.setHovered(near);
        companion.update(dt, t, ndc, { x: buddyDomX, y: buddyDomY });
      } else {
        companion.setHovered(false);
        companion.update(dt, t, ndc, null);
      }

      // -----------------------------------------------------------
      // Trail — disabled on tight viewport (R13.4).
      // -----------------------------------------------------------
      if (isTight()) {
        trail.mesh.visible = false;
      } else {
        trail.mesh.visible = true;
        trail.update(dt, finalX, finalY, companion.getHue());
      }

      // HUD label tracks buddy.
      if (hudEl && !isTight()) {
        const hV = window.innerHeight;
        hudPos.x += (companionPos.x - hudPos.x) * 0.10;
        hudPos.y += (companionPos.y - hudPos.y) * 0.10;
        const domX = hudPos.x;
        const domY = hV - hudPos.y - 60;
        hudEl.style.transform = `translate3d(${domX}px, ${domY}px, 0) translate(-50%, -50%)`;
      }

      // -----------------------------------------------------------
      // Frame budget: close the tick-body measure BEFORE the render
      // calls (R13.2 explicitly excludes `renderer.render`). Marks are
      // cleared to keep the entry buffer bounded during long sessions;
      // the measures buffer is left in place so p10-frame-budget.js
      // can read + `clearMeasures('tick')` at will.
      // -----------------------------------------------------------
      try {
        performance.mark('tick:end');
        performance.measure('tick', 'tick:start', 'tick:end');
        performance.clearMarks('tick:start');
        performance.clearMarks('tick:end');
      } catch (_e) { /* noop */ }

      // -----------------------------------------------------------
      // Render — main scene to bg-canvas, overlay to overlay-canvas.
      // -----------------------------------------------------------
      if (composer) {
        composer.render();
      } else {
        renderer.clear();
        renderer.render(scene, camera);
      }
      // Overlay scene (SENTINEL, trail, scanner, scan fan) renders to
      // the separate overlay canvas which sits above section content
      // via z-index. Transparent clear so only the objects show.
      overlayRenderer.render(overlayScene, overlayCam);

      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

    // -------------------------------------------------------------
    // Dispose — release all WebGL resources for context loss / final
    // teardown. Called by both the outer initScene.dispose() and by
    // the webglcontextlost handler.
    // -------------------------------------------------------------
    function dispose() {
      stopped = true;
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('click', onDocClick, true);
      try { orchestrator.dispose(); } catch (_e) {}
      try { companion.dispose();    } catch (_e) {}
      try { trail.dispose();        } catch (_e) {}
      try { scanner.dispose();      } catch (_e) {}
      try { scanFan.dispose();      } catch (_e) {}
      try { renderer.dispose();     } catch (_e) {}
      try { overlayRenderer.dispose(); } catch (_e) {}
      try { geom.dispose();         } catch (_e) {}
      try { solidMat.dispose();     } catch (_e) {}
      try { wireMat.dispose();      } catch (_e) {}
      try { bgMat.dispose();        } catch (_e) {}
      try { bgQuad.geometry.dispose(); } catch (_e) {}
    }

    return {
      companion,
      scanner,
      scanFan,
      orchestrator,
      // Buddy DOM position in overlay pixel space, DOM Y-down (from top).
      // interactions.js and modal.js consume this to place particles /
      // measure click distance.
      getBuddyDomPos() {
        const hV = window.innerHeight;
        return { x: companionPos.x, y: hV - companionPos.y };
      },
      // Refresh callback used by the __alive dev harness setSection helper.
      textRegionsRefresh() { textRegions.refresh(); },
      // Dev-harness cursor setter: writes NDC directly and pushes to the
      // smoothed value so property tests see the effect within one frame.
      setCursorNdc(x, y) {
        ndcTarget.x = x;
        ndcTarget.y = y;
        ndc.x = x;
        ndc.y = y;
      },
      get rafId() { return rafId; },
      dispose,
    };
  }
}
