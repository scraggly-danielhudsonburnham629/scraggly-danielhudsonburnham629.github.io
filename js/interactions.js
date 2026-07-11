// -------------------------------------------------------------
// Interaction Layer — DOM hover + click choreography for SENTINEL.
//
// Task 10.1 — wires hover/click on cards, skill tags, contact email,
// contact cards, project rows, and the "poke" (click within 55 px of
// SENTINEL) to the companion, shape system, and scanner. All bindings
// are delegated on `document` so re-rendered content picks up the
// interactions without re-init (R12.4).
//
// Cursor-pull bias: over "important" elements (cards, buttons,
// principles, contact email), we feed a synthetic 60×60 rect around
// the cursor into companion.setLookAt so SENTINEL leans toward the
// visitor's attention. On leave we clear the bias.
//
// Constellation SVG lines: on skill-tag hover we draw connective
// SVG lines between the active tag and its related tags using a
// stroke-dashoffset "draw-in" animation. The SVG overlay is mounted
// once on document.body and sized to the viewport so we can address
// tag positions in viewport pixel space.
//
// Reduced-motion contract (R11.5): under prefersReduced we still
// apply CSS class changes (so focus is visible) but skip shape
// nudges, particle emissions, look-at bias, setEmissionDir, and
// the poke's transient morph. The scanner is already gated at its
// own layer via setPrefersReduced.
//
// Graceful degradation: initInteractions accepts a null companion /
// shapeSystem / scanner / getBuddyPos. When those are null (main.js
// calls before scene.js is up — see boot ordering in main.js), the
// CSS class changes still fire and the poke/click paths simply skip
// their character-side effects.
//
// Requirements: R7.1–R7.8, R8.1–R8.4, R11.5, R12.4
// Design: §Interaction Layer, §CSS Hooks
// -------------------------------------------------------------

import * as sfx from './sfx.js';

// Selectors we listen for at the delegation level. Kept as constants
// so they're easy to audit against the task instructions.
const SEL_PROJECT   = '.work__spotlight, .work__row, .card[data-project-id]';
const SEL_SKILL_TAG = '.skill-group li[data-related], .mf-list li[data-related]';
const SEL_EMAIL     = '.contact__email, .contact-huge a';
const SEL_CONTACT   = '.contact-card';
// v5 contact meta strip — <li> items with .contact__k / .contact__v.
// Hovering fires the scan-fan from below the item pointing up, so
// SENTINEL visibly "highlights" the contact detail with a beam of
// light rising from underneath. Uses the same WebGL fan as Skills
// (see scanFan.js) with the `origin: 'below'` mode toggled on.
const SEL_CONTACT_META = '.contact__meta li';
// Generic content items across v5 layouts (2025-11 fix). Approach was
// silent because renderPrinciples emits `.manifesto__row`, not the old
// `.principle` class. Adding the v5 section-item classes here so
// SENTINEL reacts to hover in Approach / Journey / Recognition /
// Vision the same way it does to project cards — just without the
// heavier project choreography (no scanner retarget, no sibling dim).
const SEL_CONTENT   = '.manifesto__row, .tl-item, .trophy, .vision-int, .mf-group, .cert-row';
const SEL_PULL      = '.card, .contact-huge a, .contact__email, .btn--primary, .principle, .manifesto__row, .tl-item, .trophy, .vision-int, .mf-group, .cert-row';

// Cursor-pull magnet parameters. The synthetic rect we hand to
// companion.setLookAt is a 60×60 box centred on the cursor — the
// setLookAt bias resolves that into a rotational lean of up to 30%
// of the current mode's cursorTilt. The max-60-px directional bias
// in R7.8 becomes a small visual pull in the *rotation* of SENTINEL
// rather than a positional shift, matching the design's "leans
// toward the reader's attention" intent.
const PULL_SIZE = 60;

// Poke click radius (design §Interaction Layer · Click Behaviors, R8.1).
// Scaled with the 1.4× SENTINEL size bump (2025-11 polish).
const POKE_RADIUS = 75;

// Poke transient morph — bounces SENTINEL through `orb` and back to
// its section baseline. Duration ≤ 1.2 s per R8.1.
const POKE_MORPH_MS = 1200;

// Skill constellation animation — stroke-dashoffset draw-in over the
// full dash length, then hold. Match feel from design §Interaction
// Layer · Constellation.
const CONSTELLATION_STROKE_MS = 380;

// -------------------------------------------------------------
// Constellation SVG overlay — lives on document.body, sized to
// viewport, and hosts connective <line> elements while a skill tag
// is hovered. We create it lazily so the module has zero DOM impact
// on pages without skills (or before renderSkills has run).
// -------------------------------------------------------------
let constellationSvg = null;
function ensureConstellationOverlay() {
  if (constellationSvg && constellationSvg.isConnected) return constellationSvg;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'constellation-overlay');
  svg.setAttribute('aria-hidden', 'true');
  // Fixed to the viewport so we can address line endpoints in
  // window client-space directly (getBoundingClientRect() coords).
  svg.style.cssText = [
    'position: fixed',
    'inset: 0',
    'width: 100vw',
    'height: 100vh',
    'pointer-events: none',
    'z-index: 5',
  ].join(';');
  document.body.appendChild(svg);
  constellationSvg = svg;
  return svg;
}

function clearConstellationLines() {
  if (!constellationSvg) return;
  while (constellationSvg.firstChild) constellationSvg.removeChild(constellationSvg.firstChild);
}

/**
 * Draw connective lines from `anchor` to each element in `related`.
 *
 * DISABLED (2025-11 polish): the SVG lines fanning out to every peer
 * in a skill group visually clobbered the manifest text — a cyan
 * spider-web on hover. The relationship signal survives via the
 * `.tag-active` / `.tag-related` CSS classes (accent color + text-
 * shadow + scale on the active tag, dim brighten on related tags),
 * so we no-op the line drawing.
 *
 * The `ensureConstellationOverlay` / `clearConstellationLines` helpers
 * stay defined but the overlay is never created because this function
 * short-circuits before the ensure call.
 */
function drawConstellationLines(_anchor, _related) {
  /* no-op */
}

// -------------------------------------------------------------
// Delegated hover — mouseover / mouseout with relatedTarget checks.
// This mirrors mouseenter / mouseleave semantics but survives content
// re-renders because listeners are on document.
// -------------------------------------------------------------

/**
 * Genuine-enter test — cursor moved from OUTSIDE `el` into `el`.
 * Ignores movements between children of the same delegated target.
 */
function isGenuineEnter(el, e) {
  if (!el) return false;
  const rel = e.relatedTarget;
  return !(rel && el.contains(rel));
}

/**
 * Symmetric of isGenuineEnter for mouseout.
 */
function isGenuineLeave(el, e) {
  if (!el) return false;
  const rel = e.relatedTarget;
  return !(rel && el.contains(rel));
}

// -------------------------------------------------------------
// Public API
// -------------------------------------------------------------

/**
 * Wire hover + click choreography from DOM to SENTINEL.
 *
 * All dependencies are optional — passing `null` for any of them
 * disables the corresponding character-side effect without breaking
 * the CSS class hooks. This matches the deferred-boot pattern in
 * main.js where scene.js hasn't yet built the companion at boot.
 *
 * @param {Object}       opts
 * @param {Object|null}  [opts.companion]      — from createCompanion(); exposes
 *   setLookAt / reachTowards / setHovered / setEmissionDir / emit /
 *   triggerBigPulse. May be null before scene is up.
 * @param {Object|null}  [opts.shapeSystem]    — from createShapeSystem(); exposes
 *   setPreset / nudge / current. Falls back to `companion.shapeSystem`
 *   when omitted. May be null.
 * @param {Object|null}  [opts.scanner]        — from createScanner(); exposes
 *   setTarget / setEnabled. May be null (skips row-hover retarget).
 * @param {boolean}      [opts.prefersReduced] — R11.5 gate.
 * @param {() => ({x:number,y:number}|null) | null} [opts.getBuddyPos]
 *   — returns SENTINEL's current DOM-pixel overlay position (Y-down,
 *   from top). Used for the "poke" click distance check and the
 *   documents_out particle direction. May be null.
 * @returns {{ dispose: () => void }} — teardown hook that removes
 *   listeners and the constellation SVG.
 */
export function initInteractions({
  companion    = null,
  shapeSystem  = null,
  scanner      = null,
  orchestrator = null,
  scanFan      = null,
  prefersReduced = false,
  getBuddyPos  = null,
} = {}) {
  // Prefer explicit shapeSystem; fall back to companion.shapeSystem
  // (companion.js Task 6.2 exposes it there for convenience).
  const shapes = shapeSystem || (companion && companion.shapeSystem) || null;

  // Track the currently-hovered pull-magnet element so we can drive
  // the setLookAt(cursorRect) override on mousemove. When null, no
  // cursor-pull is active and the character falls back to whatever
  // the orchestrator or specific hover handlers set.
  let pullMagnetEl = null;

  // For contact-card hover we need to compute an emission direction
  // to the card centre each frame — track the active card so
  // mousemove can update the direction if the card moves (rare, but
  // guards against reveal animations completing under the cursor).
  let activeContactCard = null;

  // Content item currently under the cursor. Kept so onContentLeave
  // can null out its state cleanly.
  let activeContentEl = null;

  // Preferred sub-anchor selectors per content item — reading-target
  // regions inside wide section rows. Manifesto rows and timeline
  // items span the full section width, so hovering the row and using
  // its whole rect parks SENTINEL at the row's far edge (feels
  // detached). Anchoring to the meaningful reading block (title +
  // body) gives SENTINEL a stable, autonomous position next to the
  // actual content instead of following the cursor. Falls back to the
  // item itself if no sub-anchor matches.
  function contentAnchor(el) {
    return el.querySelector(
      '.manifesto__title, .tl-title, .trophy__name, .vision-int__title, .mf-key, .cert-name'
    ) || el;
  }

  // -----------------------------------------------------------
  // Hover — projects (spotlight + rows + generic .card[data-project-id])
  // -----------------------------------------------------------
  function onProjectEnter(el) {
    el.classList.add('is-hover', 'card--focus-veil');
    sfx.blip();

    // Dim sibling projects in the same list. Siblings are the other
    // .work__row items inside the same <ol class="work__list">, plus
    // any .work__spotlight in the same #work-grid.
    getSiblingProjects(el).forEach((s) => s.classList.add('is-dimmed'));

    if (prefersReduced) return;

    const rect = el.getBoundingClientRect();
    if (companion) {
      companion.setLookAt(rect);
      companion.setHovered(true);
      // Direct particles TOWARD the project element (documents_in
      // travel FROM emissionDir TO buddy; we want the opposite feel
      // here — SENTINEL delivering context — so use a small offset
      // toward the card for the outbound arc).
      const bp = getBuddyPos && getBuddyPos();
      if (bp) {
        const cx = rect.left + rect.width  / 2;
        const cy = rect.top  + rect.height / 2;
        // emissionDir uses overlay-Y-up; flip Y sign.
        companion.setEmissionDir(cx - bp.x, -(cy - bp.y));
      }
      companion.emit('documents_in');
    }
    if (shapes) shapes.nudge('shard', { transient: true, duration: 1.4 });

    // Retarget scanner on ANY Work-section project hover (spotlight or
    // row). The scanner is section-gated by orchestrator.setEnabled, so
    // this is a no-op outside Work.
    if (scanner
        && (el.classList.contains('work__row')
            || el.classList.contains('work__spotlight'))) {
      scanner.setTarget(rect);
    }

    // Reactive-mode positioning — surface the hover target through the
    // orchestrator so scene.js moves SENTINEL, aims particles, and
    // (in Work) drives the scanner via its normal pipes.
    if (orchestrator) orchestrator.setHoverTarget(el);
  }

  function onProjectLeave(el) {
    el.classList.remove('is-hover', 'card--focus-veil');
    getSiblingProjects(el).forEach((s) => s.classList.remove('is-dimmed'));

    if (prefersReduced) return;
    if (companion) {
      companion.setLookAt(null);
      companion.setHovered(false);
    }
    if (orchestrator) orchestrator.setHoverTarget(null);
    // Shape returns to section baseline via the transient nudge's
    // own decay — no explicit setPreset call needed.
  }

  /**
   * Sibling projects — every peer .work__row inside the same
   * <ol class="work__list"> plus the .work__spotlight in the same
   * #work-grid. Falls back to querySelectorAll for stand-alone cards.
   */
  function getSiblingProjects(el) {
    const list = el.closest('.work__list');
    const grid = el.closest('#work-grid, .work--editorial');
    const out = new Set();
    if (list) {
      list.querySelectorAll('.work__row').forEach((s) => { if (s !== el) out.add(s); });
    }
    if (grid) {
      grid.querySelectorAll('.work__spotlight, .work__row').forEach((s) => {
        if (s !== el) out.add(s);
      });
    }
    if (out.size === 0) {
      // Stand-alone cards elsewhere (e.g., recognition list) —
      // dim other project cards on the page as a fallback.
      document.querySelectorAll('.card[data-project-id]').forEach((s) => {
        if (s !== el) out.add(s);
      });
    }
    return Array.from(out);
  }

  // -----------------------------------------------------------
  // Hover — skill tags (constellation crosstalk)
  // -----------------------------------------------------------
  let activeSkillTag = null;
  function onSkillEnter(el) {
    el.classList.add('tag-active');
    const group = el.getAttribute('data-related');
    let related = [];
    if (group) {
      // CSS.escape guards against group keys containing special
      // characters (unlikely, but keeps the querySelector safe).
      const groupKey = window.CSS && CSS.escape ? CSS.escape(group) : group;
      related = Array.from(
        document.querySelectorAll(`[data-related="${groupKey}"]`)
      );
      related.forEach((r) => {
        if (r !== el) r.classList.add('tag-related');
      });
    }
    activeSkillTag = el;

    if (prefersReduced) return;

    // Draw connective lines. Under tight viewports we still draw
    // them (they're cheap SVG); if we ever want to gate this, wrap
    // in an isTight() check.
    if (related.length > 1) drawConstellationLines(el, related);
    if (companion) companion.emit('pulse');
  }

  function onSkillLeave(el) {
    el.classList.remove('tag-active');
    document.querySelectorAll('.tag-related').forEach((r) => r.classList.remove('tag-related'));
    if (activeSkillTag === el) activeSkillTag = null;
    clearConstellationLines();
  }

  // -----------------------------------------------------------
  // Hover — contact email (huge CTA / email hero)
  // -----------------------------------------------------------
  function onEmailEnter(el) {
    el.classList.add('is-pulled');
    sfx.blip();
    if (prefersReduced) return;
    const rect = el.getBoundingClientRect();
    if (companion) {
      companion.reachTowards(rect);
      companion.setHovered(true);
    }
    if (shapes) shapes.nudge('arrow', { transient: true, duration: 2.0 });
    if (orchestrator) orchestrator.setHoverTarget(el);
  }

  function onEmailLeave(el) {
    el.classList.remove('is-pulled');
    if (prefersReduced) return;
    if (companion) {
      companion.reachTowards(null);
      companion.setHovered(false);
    }
    if (orchestrator) orchestrator.setHoverTarget(null);
  }

  // -----------------------------------------------------------
  // Hover — legacy contact-card grid (kept for R12.4 delegation
  // even though the new Contact layout uses a meta strip instead;
  // ensures data-only re-adds pick up the interaction).
  // -----------------------------------------------------------
  function onContactCardEnter(el) {
    el.classList.add('is-active');
    activeContactCard = el;
    if (prefersReduced) return;
    updateContactCardEmission(el);
    if (companion) companion.emit('pulse');
    if (orchestrator) orchestrator.setHoverTarget(el);
  }

  function onContactCardLeave(el) {
    el.classList.remove('is-active');
    if (activeContactCard === el) activeContactCard = null;
    if (prefersReduced) return;
    if (companion) companion.setEmissionDir(null, null);
    if (orchestrator) orchestrator.setHoverTarget(null);
  }

  // -----------------------------------------------------------
  // Hover — contact meta strip items. Fires the scan-fan FROM
  // SENTINEL toward the hovered item so the beam visibly connects
  // them. The fan's length is clipped each frame to end exactly at
  // the item (see scene.js `scanFan.setReach`). `persist: true`
  // holds the fan lit for as long as the cursor stays on the item;
  // clearTarget() on leave retracts it.
  // -----------------------------------------------------------
  function onContactMetaEnter(el) {
    el.classList.add('is-hover');
    sfx.blip();
    if (prefersReduced) return;

    // `anchor: 'below'` forces SENTINEL to park directly under the
    // hovered item — the scan-fan then visibly rises from SENTINEL
    // up into the item, matching the "beam from below" intent.
    if (orchestrator) orchestrator.setHoverTarget(el, { anchor: 'below' });
    if (companion) companion.emit('pulse');
    if (scanFan && scanFan.setTarget) {
      scanFan.setTarget(el, { persist: true });
    }
    // Hide the SENTINEL HUD pill — it tracks 60 px above SENTINEL, so
    // when SENTINEL parks below a contact item the pill lands right on
    // top of the item's text. `.hud-hidden` fades it out via CSS
    // transition, restored on leave.
    const hud = document.querySelector('.companion-hud');
    if (hud) hud.classList.add('hud-hidden');
  }

  function onContactMetaLeave(el) {
    el.classList.remove('is-hover');
    if (prefersReduced) return;
    if (orchestrator) orchestrator.setHoverTarget(null);
    if (scanFan && scanFan.clearTarget) scanFan.clearTarget();
    const hud = document.querySelector('.companion-hud');
    if (hud) hud.classList.remove('hud-hidden');
  }

  // -----------------------------------------------------------
  // Hover — generic v5 content items (2025-11 fix).
  // Manifesto rows (Approach), timeline items (Journey), trophies
  // (Recognition), vision interests (Vision). Lightweight hover
  // response: physically move SENTINEL toward the hovered element
  // via the orchestrator, rotate toward it, emit a pulse. No
  // scanner retarget or sibling dimming (those are project-only).
  // -----------------------------------------------------------
  function onContentEnter(el) {
    el.classList.add('is-hover');
    activeContentEl = el;
    sfx.blip();

    // Trophy hold-to-verify. Hovering for TROPHY_HOLD_MS runs the two
    // green scan lines up the card border; when they meet at the top,
    // the seal flips and reveals the laurel-wreathed medallion. Early
    // un-hover cancels via onContentLeave. Only runs once per trophy
    // (guarded by `.verified`). SENTINEL pulses green throughout the
    // hold via the checkmark emit (which is already green in
    // companion.js — 0x22c55e).
    if (el.classList.contains('trophy') && !el.classList.contains('verified')) {
      startTrophyHold(el);
    }

    if (prefersReduced) return;

    const anchor = contentAnchor(el);
    const rect   = anchor.getBoundingClientRect();

    if (companion) {
      companion.setLookAt(rect);
      companion.setHovered(true);
    }
    // Anchor SENTINEL to the reading sub-block (title / key) so it
    // parks next to the actual content, not the row's far edge.
    if (orchestrator) orchestrator.setHoverTarget(anchor);

    // Branch on element kind. Skills groups get the raycast sweep
    // (rotating beam that hits key + every item in angular order).
    // Other content items keep the documents_in + pulse beat.
    if (el.classList.contains('mf-group')) {
      drawSkillGroupRaycast(el);
    } else if (companion) {
      const bp = getBuddyPos && getBuddyPos();
      if (bp) {
        const cx = rect.left + rect.width  / 2;
        const cy = rect.top  + rect.height / 2;
        // emissionDir is overlay-Y-up; flip Y sign.
        companion.setEmissionDir(cx - bp.x, -(cy - bp.y));
      }
      companion.emit('documents_in');
      companion.emit('pulse');
    }
  }

  function onContentLeave(el) {
    el.classList.remove('is-hover');
    if (activeContentEl === el) activeContentEl = null;

    // Cancel a trophy hold if the user drags off before 1 s. Removes
    // the analyzing ring, stops the green pulse train. If already
    // verified, nothing to cancel.
    if (el.classList.contains('trophy')) {
      cancelTrophyHold(el);
    }

    if (prefersReduced) return;
    if (companion) {
      companion.setLookAt(null);
      companion.setHovered(false);
      companion.setEmissionDir(null, null);
    }
    if (orchestrator) orchestrator.setHoverTarget(null);
    // Clear the scan-fan so it fades out when leaving a .mf-group.
    if (scanFan && scanFan.clearTarget) scanFan.clearTarget();
  }

  // -----------------------------------------------------------
  // Trophy hold-to-verify state machine.
  //   • startTrophyHold  — on enter: add `.analyzing`, schedule the
  //                        verify at TROPHY_HOLD_MS, start a green
  //                        pulse train from SENTINEL (~every 280 ms
  //                        via `checkmark` emit, which is 0x22c55e).
  //   • cancelTrophyHold — on early leave: clear timeouts, remove
  //                        `.analyzing`. If already `.verified`, no-op.
  //   • finishTrophyHold — at the 1 s mark: remove `.analyzing`, add
  //                        `.verifying` + `.verified`, clear the flip
  //                        transient class after the animation lands.
  // A WeakMap holds the active timers per trophy so leaving one
  // trophy for another doesn't clobber the other's state.
  // -----------------------------------------------------------
  const TROPHY_HOLD_MS   = 1000;
  const TROPHY_FLIP_MS   = 720;
  const TROPHY_PULSE_MS  = 280;
  const trophyHolds = new WeakMap();

  function startTrophyHold(el) {
    if (trophyHolds.has(el) || el.classList.contains('verified')) return;
    el.classList.add('analyzing');

    // Point SENTINEL at the trophy centre for the pulse train, so the
    // green checkmark rings visibly emanate toward the card.
    const aimAtTrophy = () => {
      if (!companion) return;
      const rect = el.getBoundingClientRect();
      const bp = getBuddyPos && getBuddyPos();
      if (!bp) return;
      const cx = rect.left + rect.width  / 2;
      const cy = rect.top  + rect.height / 2;
      companion.setEmissionDir(cx - bp.x, -(cy - bp.y));
    };
    aimAtTrophy();
    if (companion && !prefersReduced) companion.emit('checkmark');

    const pulseId = setInterval(() => {
      aimAtTrophy();
      if (companion && !prefersReduced) companion.emit('checkmark');
    }, TROPHY_PULSE_MS);

    const verifyId = setTimeout(() => finishTrophyHold(el), TROPHY_HOLD_MS);

    trophyHolds.set(el, { pulseId, verifyId });
  }

  function cancelTrophyHold(el) {
    const state = trophyHolds.get(el);
    if (!state) return;
    clearTimeout(state.verifyId);
    clearInterval(state.pulseId);
    trophyHolds.delete(el);
    // Only strip `.analyzing` if we didn't already promote to verified.
    if (!el.classList.contains('verified')) el.classList.remove('analyzing');
  }

  function finishTrophyHold(el) {
    const state = trophyHolds.get(el);
    if (state) clearInterval(state.pulseId);
    trophyHolds.delete(el);
    el.classList.remove('analyzing');
    el.classList.add('verifying', 'verified');
    // Final green pulse coinciding with the flip.
    if (companion && !prefersReduced) companion.emit('checkmark');
    sfx.chime();
    setTimeout(() => el.classList.remove('verifying'), TROPHY_FLIP_MS);
  }

  function updateContactCardEmission(el) {
    if (!companion) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width  / 2;
    const cy = rect.top  + rect.height / 2;
    const bp = getBuddyPos && getBuddyPos();
    if (!bp) return;
    // Overlay space is Y-up; DOM rects are Y-down; flip the Y sign
    // so the emission arc travels toward the card in screen space.
    companion.setEmissionDir(cx - bp.x, -(cy - bp.y));
  }

  // -----------------------------------------------------------
  // Cursor-pull bias — feed setLookAt(cursorRect) on mousemove
  // while a pull-magnet is hovered. See PULL_SIZE constant.
  // -----------------------------------------------------------
  function onPullMagnetEnter(el) {
    pullMagnetEl = el;
  }

  function onPullMagnetLeave(el) {
    if (pullMagnetEl === el) {
      pullMagnetEl = null;
      // Only clear the look-at bias if no more-specific handler
      // is holding it. Project / email handlers set their own
      // rect on enter and clear it on leave — the leave order
      // is: pull-magnet leave → element-specific leave, so we
      // can safely null out here. If a project-hover leave
      // hasn't fired (edge case: element removed from DOM under
      // cursor), setLookAt(null) is a no-op that keeps the
      // character honest.
      if (companion && !prefersReduced) companion.setLookAt(null);
    }
  }

  // -----------------------------------------------------------
  // Delegated mouseover / mouseout dispatcher
  // -----------------------------------------------------------
  const onMouseOver = (e) => {
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;

    const proj = t.closest(SEL_PROJECT);
    if (proj && isGenuineEnter(proj, e)) onProjectEnter(proj);

    const tag = t.closest(SEL_SKILL_TAG);
    if (tag && isGenuineEnter(tag, e)) onSkillEnter(tag);

    const mail = t.closest(SEL_EMAIL);
    if (mail && isGenuineEnter(mail, e)) onEmailEnter(mail);

    const contact = t.closest(SEL_CONTACT);
    if (contact && isGenuineEnter(contact, e)) onContactCardEnter(contact);

    // Contact meta strip — only when NOT hovering the email hero
    // (email has its own reach-toward beat and shouldn't fire the
    // fan-from-below).
    const cmeta = (mail) ? null : t.closest(SEL_CONTACT_META);
    if (cmeta && isGenuineEnter(cmeta, e)) onContactMetaEnter(cmeta);

    // Generic content items — only fire if we didn't already claim
    // this hover under a more specific selector. Projects live inside
    // .card, so a project card would double-fire content + project.
    // Skill tags (.mf-list li) live inside .mf-group — same problem,
    // so we skip content when a tag matched (tag hover has its own
    // constellation-crosstalk beat).
    const content = (proj || tag || cmeta) ? null : t.closest(SEL_CONTENT);
    if (content && isGenuineEnter(content, e)) onContentEnter(content);

    const pull = t.closest(SEL_PULL);
    if (pull && isGenuineEnter(pull, e)) onPullMagnetEnter(pull);
  };

  const onMouseOut = (e) => {
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;

    const proj = t.closest(SEL_PROJECT);
    if (proj && isGenuineLeave(proj, e)) onProjectLeave(proj);

    const tag = t.closest(SEL_SKILL_TAG);
    if (tag && isGenuineLeave(tag, e)) onSkillLeave(tag);

    const mail = t.closest(SEL_EMAIL);
    if (mail && isGenuineLeave(mail, e)) onEmailLeave(mail);

    const contact = t.closest(SEL_CONTACT);
    if (contact && isGenuineLeave(contact, e)) onContactCardLeave(contact);

    const cmeta = (mail) ? null : t.closest(SEL_CONTACT_META);
    if (cmeta && isGenuineLeave(cmeta, e)) onContactMetaLeave(cmeta);

    const content = (proj || tag || cmeta) ? null : t.closest(SEL_CONTENT);
    if (content && isGenuineLeave(content, e)) onContentLeave(content);

    const pull = t.closest(SEL_PULL);
    if (pull && isGenuineLeave(pull, e)) onPullMagnetLeave(pull);
  };

  // -----------------------------------------------------------
  // Cursor tracking — drives the pull-magnet bias and lets the
  // constellation redraw itself if the anchor moves.
  // -----------------------------------------------------------
  const onMouseMove = (e) => {
    // Cursor-pull bias (R7.8, design §Interaction Layer · Cursor Pull).
    // Fed via a small synthetic 60×60 rect around the cursor so the
    // existing setLookAt bias path handles the rotational lean.
    if (pullMagnetEl && companion && !prefersReduced) {
      companion.setLookAt({
        left:   e.clientX - PULL_SIZE / 2,
        top:    e.clientY - PULL_SIZE / 2,
        width:  PULL_SIZE,
        height: PULL_SIZE,
        right:  e.clientX + PULL_SIZE / 2,
        bottom: e.clientY + PULL_SIZE / 2,
      });
    }

    // Contact-card emission direction stays fresh while the card
    // is being hovered (rare but cheap to compute).
    if (activeContactCard && !prefersReduced) {
      updateContactCardEmission(activeContactCard);
    }

  };

  // Rebuild constellation lines on viewport changes so the SVG
  // overlay tracks page scroll / resize while a skill tag is held.
  const onViewportChange = () => {
    if (activeSkillTag) {
      const group = activeSkillTag.getAttribute('data-related');
      if (group) {
        const groupKey = window.CSS && CSS.escape ? CSS.escape(group) : group;
        const related = Array.from(
          document.querySelectorAll(`[data-related="${groupKey}"]`)
        );
        drawConstellationLines(activeSkillTag, related);
      }
    }
  };

  // -----------------------------------------------------------
  // Click — poke SENTINEL + project card handoff
  // -----------------------------------------------------------
  const onClick = (e) => {
    // Poke — click within POKE_RADIUS of SENTINEL fires the big
    // pulse + transient morph. Note: scene.js currently owns its
    // own capture-phase poke handler (fires triggerBigPulse); the
    // handler here adds the shape morph. Once Task 12.1 wires scene
    // to defer to this module, the pulse call here becomes the sole
    // source. For now, coexisting is safe — triggerBigPulse is
    // idempotent-per-frame at the visual level (particles overlap).
    if (companion && getBuddyPos) {
      const bp = getBuddyPos();
      if (bp) {
        const d = Math.hypot(e.clientX - bp.x, e.clientY - bp.y);
        if (d < POKE_RADIUS) {
          companion.triggerBigPulse();
          if (shapes && !prefersReduced) {
            shapes.nudge('orb', { transient: true, duration: POKE_MORPH_MS / 1000 });
          }
          sfx.click();
          return;
        }
      }
    }

    // Project card click — fire documents_out toward the card and
    // trigger a big pulse. Let modal.js handle the actual open (it
    // registers its own delegated click listener and will run in
    // the same event dispatch).
    const proj = e.target && typeof e.target.closest === 'function'
      ? e.target.closest('[data-project-id]')
      : null;
    if (proj && companion && !prefersReduced) {
      const rect = proj.getBoundingClientRect();
      const bp = getBuddyPos && getBuddyPos();
      if (bp) {
        const cx = rect.left + rect.width  / 2;
        const cy = rect.top  + rect.height / 2;
        companion.setEmissionDir(cx - bp.x, -(cy - bp.y));
        companion.emit('documents_out');
      }
      companion.triggerBigPulse();
      sfx.click();
    }
  };

  // -----------------------------------------------------------
  // Skills raycast (2025-11 polish).
  //
  // On `.mf-group` hover, SENTINEL fires a WebGL laser fan (see
  // scanFan.js — adapted from prisoner849/mdxQjeW) aimed at the
  // group's centre. The fan renders in the overlay scene next to
  // SENTINEL. In parallel, each of the group's children (`.mf-key`
  // + `.mf-list li`) receives a `.scanning` class in staggered
  // sequence across the fan's active window, so items visibly
  // register as the beam sweeps past — corner reticle + sweep bar
  // + text pop for the key, brief highlight for list items.
  //
  // Per-group cooldown (700 ms) prevents flicker when the cursor
  // re-enters the same group in quick succession.
  // -----------------------------------------------------------
  const RAYCAST_MS       = 1400;
  const RAYCAST_COOLDOWN = 700;
  const lastGroupScanAt  = new WeakMap();

  function drawSkillGroupRaycast(groupEl) {
    if (prefersReduced || !groupEl) return;
    const now = performance.now();
    const last = lastGroupScanAt.get(groupEl) || 0;
    if (now - last < RAYCAST_COOLDOWN) return;
    lastGroupScanAt.set(groupEl, now);

    // Gather scannable children in this group — the key label plus
    // every `.mf-list li` item. Sort by angle from SENTINEL so the
    // flash cascade reads left-to-right / near-to-far as the fan
    // visually sweeps across.
    const key = groupEl.querySelector('.mf-key');
    const items = Array.from(groupEl.querySelectorAll('.mf-list li'));
    const targets = key ? [key, ...items] : items;

    const bp = getBuddyPos && getBuddyPos();
    const bx = bp ? bp.x : 0;
    const by = bp ? bp.y : 0;

    const rays = targets.map((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      const cx = r.left + r.width  / 2;
      const cy = r.top  + r.height / 2;
      return {
        el,
        angle: Math.atan2(cy - by, cx - bx),
        isKey: el === key,
      };
    }).filter(Boolean).sort((a, b) => a.angle - b.angle);

    if (rays.length === 0) return;

    // Fire the WebGL scan-fan (adapted from prisoner849/mdxQjeW).
    // scanFan lives in the overlay scene with SENTINEL and follows
    // SENTINEL's overlay position each frame (see scene.js tick).
    // setTarget tells the fan which DOM element to track — scene.js
    // reads its rect every frame and re-aims the fan so it stays
    // locked on the group even as SENTINEL drifts.
    if (scanFan && scanFan.setTarget) {
      scanFan.setTarget(groupEl, { duration: RAYCAST_MS });
    }

    // Stagger the per-item `.scanning` flashes across the fan's sweep
    // so each row / key visibly reacts as the beam passes. We
    // distribute times evenly across [0, RAYCAST_MS − 200] regardless
    // of geometric angle — feels cleaner than tying flash timing to
    // exact atan2 order, and avoids weird jumps if two items share
    // an angle.
    const flashWindow = Math.max(200, RAYCAST_MS - 200);
    rays.forEach((r, i) => {
      const at = (rays.length === 1)
        ? 0
        : (i * flashWindow) / (rays.length - 1);
      setTimeout(() => {
        r.el.classList.add('scanning');
        const hold = r.isKey ? 940 : 520;
        setTimeout(() => r.el.classList.remove('scanning'), hold);
      }, at);
    });

    // SENTINEL-side beat — a single pulse ring at scan start, and a
    // checkmark aimed at the group centre when the sweep completes.
    if (companion) {
      companion.emit('pulse');
      setTimeout(() => {
        if (!companion) return;
        const gr = groupEl.getBoundingClientRect();
        const gcx = gr.left + gr.width  / 2;
        const gcy = gr.top  + gr.height / 2;
        const bp2 = getBuddyPos && getBuddyPos();
        if (bp2) companion.setEmissionDir(gcx - bp2.x, -(gcy - bp2.y));
        companion.emit('checkmark');
      }, RAYCAST_MS - 120);
    }
  }

  // -----------------------------------------------------------
  // Attention observer — SENTINEL emits a `checkmark` pulse toward
  // each recognition item as it first enters the viewport. Restores
  // the "SENTINEL acknowledges each credential" beat that the old
  // auto-loop program provided, without resurrecting the loop itself.
  // Fires ONCE per element (unobserve after the first hit).
  //
  // Cert rows also run a scan-sweep animation on first view: cyan
  // bar sweeps L→R (`.scanning` class, one-shot 720 ms), then the
  // `.cert-code` chip flips from hollow cyan to filled magenta
  // (`.scanned` class, permanent). See `.cert-row` in style.css.
  //
  // Trophies used to flip colour here too, but the payoff was easy
  // to miss on scroll. Trophy verify is now hover-triggered — see
  // onContentEnter for `.trophy`.
  // -----------------------------------------------------------
  const CERT_SWEEP_MS   = 720;
  const VISION_SWEEP_MS = 900;
  let attentionObserver = null;
  if (!prefersReduced && typeof IntersectionObserver !== 'undefined') {
    attentionObserver = new IntersectionObserver((entries, obs) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        obs.unobserve(el);
        const isVision = el.classList.contains('vision-int');

        if (companion) {
          const rect = el.getBoundingClientRect();
          const bp = getBuddyPos && getBuddyPos();
          if (bp) {
            const cx = rect.left + rect.width  / 2;
            const cy = rect.top  + rect.height / 2;
            companion.setEmissionDir(cx - bp.x, -(cy - bp.y));
          }
          // Vision items get a broadcast beat (pulse + outbound
          // particles) matching the section's `broadcast` mode.
          // Everything else keeps the compact green checkmark ping.
          if (isVision) {
            companion.emit('pulse');
            companion.emit('documents_out');
          } else {
            companion.emit('checkmark');
          }
        }

        // Cert row sweep + stamp. Add `.scanning` for the sweep
        // animation, then `.scanned` for the permanent code stamp
        // once the sweep has cleared the row. A soft tick lands with
        // the stamp so the moment reads audibly.
        if (el.classList.contains('cert-row')) {
          el.classList.add('scanning');
          setTimeout(() => {
            el.classList.remove('scanning');
            el.classList.add('scanned');
            sfx.tick();
          }, CERT_SWEEP_MS);
        }

        // Vision item — violet sweep bar draws L→R while SENTINEL
        // broadcasts, then the item settles into the persistent
        // `.is-mapped` state: corner reticles + number-chip accent.
        // Reads as "SENTINEL surveyed this coordinate."
        if (isVision) {
          el.classList.add('mapping');
          setTimeout(() => {
            el.classList.remove('mapping');
            el.classList.add('is-mapped');
          }, VISION_SWEEP_MS);
        }
      });
    }, { threshold: 0.35, rootMargin: '0px 0px -20px 0px' });

    // Observe recognition + vision items on next tick so their render
    // has completed. Includes the legacy `.cert-table tr` and the v5
    // `.cert-row` renderer output.
    Promise.resolve().then(() => {
      document.querySelectorAll('.trophy, .cert-table tr, .cert-row, .vision-int')
        .forEach((el) => attentionObserver.observe(el));
    });
  }

  // -----------------------------------------------------------
  // Wire it up
  // -----------------------------------------------------------
  document.addEventListener('mouseover', onMouseOver);
  document.addEventListener('mouseout',  onMouseOut);
  document.addEventListener('mousemove', onMouseMove, { passive: true });
  document.addEventListener('click',     onClick);
  window.addEventListener('scroll', onViewportChange, { passive: true });
  window.addEventListener('resize', onViewportChange);

  return {
    dispose() {
      document.removeEventListener('mouseover', onMouseOver);
      document.removeEventListener('mouseout',  onMouseOut);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('click',     onClick);
      window.removeEventListener('scroll', onViewportChange);
      window.removeEventListener('resize', onViewportChange);
      if (attentionObserver) attentionObserver.disconnect();
      clearConstellationLines();
      if (constellationSvg && constellationSvg.parentNode) {
        constellationSvg.parentNode.removeChild(constellationSvg);
      }
      constellationSvg = null;
    },
  };
}
