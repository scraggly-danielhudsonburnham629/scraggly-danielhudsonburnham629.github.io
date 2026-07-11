// -------------------------------------------------------------
// Entry point: render content, boot scene, wire up interactions.
//
// v5 (Task 11.1) — renderers emit the structural layouts from
// design.md §Structural Layout Redesigns and the boot orchestration
// wires reveal + layoutMotion (interactions.js lands in Task 10.1).
//
// Requirements:
//   R9.1–R9.9  Structural per-section layouts
//   R10.4      Named reveal recipes per section
//   R11.5      Reduced-motion CSS-class fallback (renderers stay
//              structural — motion recipes collapse in reveal.js /
//              layoutMotion.js downstream)
// Design: §Structural Layout Redesigns, §Impact on main.js Renderers
// -------------------------------------------------------------

import {
  profile, principles, experience, projects, skills,
  recognition, vision, stats,
} from './data.js';
import { escapeHtml } from './util.js';
import { initScene } from './scene.js';
import { initCursor } from './cursor.js';
import { initScroll, initCardHover } from './scroll.js';
import { initInteractions } from './interactions.js';
import { initModal } from './modal.js';
import * as sfx from './sfx.js';
// NOTE: initReveal + initLayoutMotion moved into scene.js (Task 12.1) so
// scene.js can tear them down and rebuild them on `prefers-reduced-motion`
// change events (R11.2). main.js no longer imports them directly.

// HUD label text per section — matches the orchestrator's per-section mode.
const SENTINEL_LABELS = [
  'SYSTEM · READY',
  'ANALYZING · PRINCIPLES',
  'TRACING · TIMELINE',
  'INDEXING · CASE STUDIES',
  'PARSING · CAPABILITIES',
  'VERIFYING · CREDENTIALS',
  'MAPPING · FUTURE STATE',
  'AWAITING · INPUT',
];

// -------------------------------------------------------------
// Renderers
// -------------------------------------------------------------

/**
 * Approach — Manifesto rows.
 * Emits: <ol class="manifesto"> ▸ .manifesto__row ▸ .manifesto__num +
 *        .manifesto__body ▸ .manifesto__title / .manifesto__text
 * Reveal: `fan` (reveal.js seeds --fan-x / --fan-r per child index).
 * Requirements: R9.1, R10.4
 */
function renderPrinciples() {
  const root = document.getElementById('principles');
  if (!root) return;
  root.innerHTML = principles
    .map(
      (p) => `
      <li class="manifesto__row" data-reveal="fan">
        <div class="manifesto__num">${escapeHtml(p.num)}</div>
        <div class="manifesto__body">
          <h3 class="manifesto__title">${escapeHtml(p.title)}</h3>
          <p class="manifesto__text">${escapeHtml(p.body)}</p>
        </div>
      </li>`
    )
    .join('');
}

function renderStats() {
  const root = document.getElementById('stats');
  if (!root) return;
  root.innerHTML = stats
    .map(
      (s) => `
      <div class="stat" data-reveal>
        <div class="stat__num">${escapeHtml(s.num)}${s.sub ? `<span class="stat__sub">${escapeHtml(s.sub)}</span>` : ''}</div>
        <div class="stat__label">${escapeHtml(s.label)}</div>
      </div>`
    )
    .join('');
}

/**
 * Parse an experience `date` string into a leading year and the full range.
 *   'Jul 2025 — Present'  → { year: '2026', range: 'Jul 2025 — Present' }
 *                            (year auto-tracks current year for ongoing)
 *   'Graduated Sep 2025'  → { year: '2025', range: 'Graduated Sep 2025' }
 *   'Jul 2023 — Jan 2024' → { year: '2024', range: 'Jul 2023 — Jan 2024' }
 *                            (year prefers END year for ranges — the
 *                            most recent point of the entry)
 */
function parseTimelineWhen(dateStr) {
  const s = String(dateStr || '');
  // Ongoing entries show current year — "Present" auto-tracks time.
  if (/present/i.test(s)) {
    return { year: String(new Date().getFullYear()), range: s };
  }
  // Range: prefer end year (last 4-digit match) so a 2023–2024
  // internship reads as 2024 on the timeline pill.
  const matches = s.match(/\d{4}/g) || [];
  const year = matches.length ? matches[matches.length - 1] : '';
  return { year, range: s };
}

/**
 * Journey — Editorial timeline.
 * Emits: .tl-item ▸ .tl-when (.tl-year / .tl-range / .tl-loc) +
 *        .tl-what (.tl-title / .tl-desc / .tl-tags)
 * Requirements: R9.2
 */
function renderTimeline() {
  const root = document.getElementById('timeline');
  if (!root) return;
  root.innerHTML = experience
    .map((item) => {
      const when = parseTimelineWhen(item.date);
      return `
      <li class="tl-item" data-reveal>
        <div class="tl-when">
          <div class="tl-year">${escapeHtml(when.year)}</div>
          <div class="tl-range">${escapeHtml(when.range)}</div>
          ${item.location ? `<div class="tl-loc">${escapeHtml(item.location)}</div>` : ''}
        </div>
        <div class="tl-what">
          <h3 class="tl-title">${escapeHtml(item.title)} <span class="tl-company">· ${escapeHtml(item.company)}</span></h3>
          <p class="tl-desc">${escapeHtml(item.desc)}</p>
          <div class="tl-tags">
            ${item.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
          </div>
        </div>
      </li>`;
    })
    .join('');
}

/**
 * Work — Editorial spotlight + reading list.
 * Emits: .work__spotlight (projects[0]) with
 *          .work__spotlight-eyebrow (.work__spotlight-badge + -year) /
 *          -title / -subtitle / -summary / -stack / -foot
 *        <ol class="work__list"> of .work__row (projects[1..]) with
 *          .work__row-index / -title / -subtitle / -stack / -arrow
 * Both keep data-project-id and data-cursor="hover".
 * Rows get data-reveal="slide-from=right" with 80 ms stagger via --i +
 * data-reveal-delay so reveal.js honors it regardless of CSS state.
 * Requirements: R9.3, R9.8, R10.4
 */
function renderWork() {
  const root = document.getElementById('work-grid');
  if (!root) return;
  if (projects.length === 0) {
    root.innerHTML = '';
    return;
  }

  const [spotlight, ...rows] = projects;

  const spotlightHtml = `
    <article class="work__spotlight card"
             data-project-id="${escapeHtml(spotlight.id)}"
             data-cursor="hover"
             data-reveal
             role="button"
             tabindex="0"
             aria-label="Open case study: ${escapeHtml(spotlight.title)}">
      <div class="work__spotlight-eyebrow">
        <span class="work__spotlight-badge">${escapeHtml(spotlight.badge)}</span>
        <span class="work__spotlight-year">${escapeHtml(spotlight.year)}</span>
      </div>
      <h3 class="work__spotlight-title">${escapeHtml(spotlight.title)}</h3>
      <p class="work__spotlight-subtitle">${escapeHtml(spotlight.subtitle)}</p>
      <p class="work__spotlight-summary">${escapeHtml(spotlight.summary)}</p>
      <ul class="work__spotlight-stack">
        ${spotlight.stack.slice(0, 8).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}
      </ul>
      <div class="work__spotlight-foot">
        <span class="work__spotlight-role">${escapeHtml(spotlight.role)} · ${escapeHtml(spotlight.company || 'Rackspace')}</span>
        <span class="card__arrow">Open case study →</span>
      </div>
    </article>`;

  const rowsHtml = rows
    .map((p, i) => {
      const index = String(i + 2).padStart(2, '0'); // 02, 03, 04, 05
      const stack = p.stack.slice(0, 3).join(' · ');
      return `
      <li class="work__row card"
          data-project-id="${escapeHtml(p.id)}"
          data-cursor="hover"
          data-reveal="slide-from=right"
          data-reveal-delay="${i * 80}"
          style="--i: ${i}"
          role="button"
          tabindex="0"
          aria-label="Open case study: ${escapeHtml(p.title)}">
        <div class="work__row-index">${index}</div>
        <div class="work__row-body">
          <h4 class="work__row-title">${escapeHtml(p.title)}</h4>
          <p class="work__row-subtitle">${escapeHtml(p.subtitle)} · ${escapeHtml(p.badge)} · ${escapeHtml(p.year)}</p>
          <div class="work__row-stack">${escapeHtml(stack)}</div>
        </div>
        <span class="work__row-arrow" aria-hidden="true">→</span>
      </li>`;
    })
    .join('');

  root.innerHTML = `${spotlightHtml}
    <ol class="work__list">${rowsHtml}</ol>`;
}

/**
 * Skills — Terminal manifest.
 * Emits: .mf-group blocks (rendered as text lines inside the existing
 *        <code> element) with .mf-key label + <ul class="mf-list"> of
 *        <li data-related="{group}">.
 * Populates the inner <code> of #skills-grid so the outer <pre> stays
 * as authored in index.html.
 * Requirements: R9.4
 */
function renderSkills() {
  const root = document.getElementById('skills-grid');
  if (!root) return;
  const code = root.querySelector('code') || root;

  // 2025-11 fix — dropped typewriter reveal from `.mf-key`. Inside a
  // `<pre><code>` context the per-character span-wrap + trailing caret
  // read as broken (caret has physical width even at opacity 0), and
  // the typing pattern felt over-applied for a compact label. Plain
  // fade-up is enough; the laser-scan hook in interactions.js is what
  // now gives each key its beat.
  code.innerHTML = skills
    .map(
      (s, gi) => `
      <span class="mf-group">
        <span class="mf-key"
              data-reveal
              data-reveal-delay="${gi * 120}">${escapeHtml(toManifestKey(s.group))}:</span>
        <ul class="mf-list">
          ${s.items
            .map(
              (i) => `<li data-related="${escapeHtml(i.related || s.key)}">${escapeHtml(i.label)}</li>`
            )
            .join('')}
        </ul>
      </span>`
    )
    .join('');
}

/**
 * Rewrite a human group name into the YAML-style manifest key so the
 * pre/code reads like a capabilities.yaml source file.
 *   'AI & Agents'          → 'ai_and_agents'
 *   'Ways of working'      → 'ways_of_working'
 */
function toManifestKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Recognition — Trophy case + cert list.
 * Trophies use `data-reveal="flip"` (restored — overflow: hidden removed
 * from .trophy so the 3D rotation is no longer clipped).
 * Certs use a <ul> of <li> divs instead of a <table> so CSS transforms
 * work reliably (table-row has inconsistent transform support).
 * Cert name is highlighted; issuer is secondary. Links open the cert.
 */
function renderRecognition() {
  const root = document.getElementById('recog-grid');
  if (!root) return;

  const awards = recognition.filter((r) => r.kind === 'award');
  const certs  = recognition.filter((r) => r.kind === 'cert');

  // Trophy DOM has three animation-driven pieces:
  //   • `.trophy-scan` SVG — two paths tracing from bottom-middle up
  //     each side of the card in green, drawn via stroke-dashoffset
  //     over the 1s hold. `pathLength="1"` normalises the dash math
  //     regardless of the actual perimeter of the rounded rect.
  //   • `.trophy__seal` two-face container — a Celtic knot medallion
  //     (analyzing side) flips 180° on the Y axis to reveal a
  //     labyrinth wheel medallion (verified side). Both SVGs use
  //     `currentColor` so they inherit the cyan → magenta transition.
  //   • Two hand-crafted medallion SVGs.
  // interactions.js triggers the sequence: hover-1s → verify flip.
  //
  // Celtic Knot — 6-petal rosette formed by three ellipses at 60°
  //   increments, wrapped in a circle boundary with a small centre
  //   accent. Reads as a stylised Celtic/interlace pattern.
  const MEDAL_KNOT_SVG = `
    <svg viewBox="0 0 40 40" class="trophy__medal trophy__medal--knot" aria-hidden="true">
      <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="20" cy="20" r="14.5" stroke-width="1.4"/>
        <g transform="translate(20 20)" stroke-width="1.3">
          <ellipse rx="6.5" ry="12" transform="rotate(0)"/>
          <ellipse rx="6.5" ry="12" transform="rotate(60)"/>
          <ellipse rx="6.5" ry="12" transform="rotate(120)"/>
        </g>
      </g>
      <circle cx="20" cy="20" r="1.6" fill="currentColor"/>
    </svg>`;

  // Labyrinth Wheel — concentric notched rings with four cardinal
  //   teeth and an inner ring around a solid centre dot. Two outer
  //   arcs (top-left / bottom-right pair, top-right / bottom-left
  //   pair) frame the wheel. Reads as an ancient geometric seal.
  const MEDAL_WHEEL_SVG = `
    <svg viewBox="0 0 40 40" class="trophy__medal trophy__medal--wheel" aria-hidden="true">
      <g fill="currentColor" fill-rule="evenodd">
        <path d="M 5 20 A 15 15 0 0 1 16 5.5 L 16 7.5 A 13 13 0 0 0 7 20 Z"/>
        <path d="M 24 5.5 A 15 15 0 0 1 35 20 L 33 20 A 13 13 0 0 0 24 7.5 Z"/>
        <path d="M 35 20 A 15 15 0 0 1 24 34.5 L 24 32.5 A 13 13 0 0 0 33 20 Z"/>
        <path d="M 16 34.5 A 15 15 0 0 1 5 20 L 7 20 A 13 13 0 0 0 16 32.5 Z"/>
        <path d="M 20 11 A 9 9 0 0 1 29 20 L 26 20 A 6 6 0 0 0 20 14 Z"/>
        <path d="M 29 20 A 9 9 0 0 1 20 29 L 20 26 A 6 6 0 0 0 26 20 Z"/>
        <path d="M 20 29 A 9 9 0 0 1 11 20 L 14 20 A 6 6 0 0 0 20 26 Z"/>
        <path d="M 11 20 A 9 9 0 0 1 20 11 L 20 14 A 6 6 0 0 0 14 20 Z"/>
        <rect x="19" y="3.5"  width="2" height="7.5"/>
        <rect x="19" y="29"   width="2" height="7.5"/>
        <rect x="3.5" y="19"  width="7.5" height="2"/>
        <rect x="29" y="19"   width="7.5" height="2"/>
        <path d="M 20 16.5 A 3.5 3.5 0 0 1 23.5 20 L 22 20 A 2 2 0 0 0 20 18 Z"/>
        <path d="M 23.5 20 A 3.5 3.5 0 0 1 20 23.5 L 20 22 A 2 2 0 0 0 22 20 Z"/>
        <path d="M 20 23.5 A 3.5 3.5 0 0 1 16.5 20 L 18 20 A 2 2 0 0 0 20 22 Z"/>
        <path d="M 16.5 20 A 3.5 3.5 0 0 1 20 16.5 L 20 18 A 2 2 0 0 0 18 20 Z"/>
        <circle cx="20" cy="20" r="1.4"/>
      </g>
    </svg>`;

  const trophiesHtml = awards
    .map(
      (a, i) => `
      <article class="trophy" data-reveal="flip" data-reveal-delay="${i * 130}">
        <svg class="trophy-scan" viewBox="0 0 300 400" preserveAspectRatio="none" aria-hidden="true">
          <path class="trophy-scan__left"  pathLength="1" d="M 150 400 L 16 400 Q 0 400 0 384 L 0 16 Q 0 0 16 0 L 150 0"/>
          <path class="trophy-scan__right" pathLength="1" d="M 150 400 L 284 400 Q 300 400 300 384 L 300 16 Q 300 0 284 0 L 150 0"/>
        </svg>
        <div class="trophy__seal" aria-hidden="true">
          <span class="trophy__seal-face trophy__seal-face--front">${MEDAL_WHEEL_SVG}</span>
          <span class="trophy__seal-face trophy__seal-face--back">${MEDAL_KNOT_SVG}</span>
        </div>
        <div class="trophy__issuer">${escapeHtml(a.issuer)}</div>
        <h4 class="trophy__name">${escapeHtml(a.name)}</h4>
        ${a.note ? `<p class="trophy__note">${escapeHtml(a.note)}</p>` : ''}
      </article>`
    )
    .join('');

  // Cert list — <div> items so slide-from=right transforms apply.
  // Name is primary (accent); issuer is secondary (dim).
  // Links render as the name itself when a URL is provided.
  //
  // Stamp target: certs with a `note` (code like AI-102) stamp the
  // code chip on scan. Certs without a code stamp the issuer instead,
  // so every row gets a visible "verified" moment. The `cert-row--
  // stamp-issuer` class marks the fallback path for CSS.
  const certListHtml = certs
    .map(
      (c, i) => {
        const nameEl = c.link
          ? `<a class="cert-name" href="${escapeHtml(c.link)}" target="_blank" rel="noopener">${escapeHtml(c.name)}</a>`
          : `<span class="cert-name">${escapeHtml(c.name)}</span>`;
        const stampsIssuer = !c.note;
        const rowClass = stampsIssuer ? 'cert-row cert-row--stamp-issuer' : 'cert-row';
        return `
      <div class="${rowClass}" data-reveal="slide-from=right" data-reveal-delay="${i * 60}" style="--i:${i}">
        ${nameEl}
        <span class="cert-issuer">${escapeHtml(c.issuer)}</span>
        ${c.note ? `<span class="cert-code">${escapeHtml(c.note)}</span>` : ''}
      </div>`;
      }
    )
    .join('');

  root.innerHTML = `
    <div class="recog__awards">
      <h3 class="recog__subhead">Awards &amp; Distinctions</h3>
      <div class="recog__trophies">${trophiesHtml}</div>
    </div>
    <div class="recog__certs">
      <h3 class="recog__subhead">Certifications</h3>
      <div class="cert-list">${certListHtml}</div>
    </div>`;
}

/**
 * Vision — Editorial column.
 * Populates existing IDs authored in index.html:
 *   #vision-lead   (pull-quote)
 *   #vision-body   (prose paragraph)
 *   #vision-grid   (<ol class="vision__interests"> of .vision-int)
 *   #vision-next   (blockquote)
 * Requirements: R9.6
 */
function renderVision() {
  const lead = document.getElementById('vision-lead');
  const body = document.getElementById('vision-body');
  const grid = document.getElementById('vision-grid');
  const next = document.getElementById('vision-next');
  if (lead) lead.textContent = vision.headline;
  if (body) body.textContent = vision.body;
  if (next) next.textContent = vision.nextStep;
  if (grid) {
    grid.innerHTML = vision.interests
      .map(
        (v, i) => `
        <li class="vision-int" data-reveal>
          <span class="vision-int__num">${String(i + 1).padStart(2, '0')}</span>
          <div class="vision-int__body">
            <h4 class="vision-int__title">${escapeHtml(v.title)}</h4>
            <p class="vision-int__text">${escapeHtml(v.body)}</p>
          </div>
        </li>`
      )
      .join('');
  }
}

/**
 * Contact — Meta strip.
 * The .contact__email anchor is authored directly in index.html; this
 * renderer only populates the sibling <ul class="contact__meta"> with
 * four key-value items (Location, GitHub, Phone, Response). Each item
 * gets data-reveal="slide-from=bottom" with an 80 ms stagger.
 * Requirements: R9.7, R10.4
 */
function renderContact() {
  const root = document.getElementById('contact-grid');
  if (!root) return;

  const githubDisplay = String(profile.github || '').replace(/^https?:\/\//, '');
  const items = [
    { k: 'Location', v: escapeHtml(profile.location), href: null },
    { k: 'GitHub',   v: escapeHtml(githubDisplay),    href: escapeHtml(profile.github) },
    { k: 'Phone',    v: escapeHtml(profile.phone),    href: `tel:${escapeHtml(String(profile.phone).replace(/\s/g, ''))}` },
    { k: 'Response', v: 'Within 48 hours',            href: null },
  ];

  root.innerHTML = items
    .map((item, i) => {
      const value = item.href
        ? `<a class="contact__v" href="${item.href}" data-cursor="hover" rel="noopener">${item.v}</a>`
        : `<span class="contact__v">${item.v}</span>`;
      return `
        <li data-reveal="slide-from=bottom" data-reveal-delay="${i * 80}" style="--i: ${i}">
          <span class="contact__k">${escapeHtml(item.k)}</span>
          ${value}
        </li>`;
    })
    .join('');
}

// -------------------------------------------------------------
// Local clock
// -------------------------------------------------------------
function initClock() {
  const el = document.getElementById('local-time');
  if (!el) return;
  const update = () => {
    const now = new Date();
    // Force GMT+7 for Ho Chi Minh — displays user's actual time in that timezone
    const options = { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' };
    el.textContent = now.toLocaleTimeString('en-GB', options) + ' ICT';
  };
  update();
  setInterval(update, 30 * 1000);
}

// -------------------------------------------------------------
// Loader
// -------------------------------------------------------------
function updateLoader(pct) {
  const fill = document.getElementById('loader-fill');
  const label = document.getElementById('loader-pct');
  if (fill) fill.style.width = pct + '%';
  if (label) label.textContent = Math.round(pct) + '%';
}
function finishLoader() {
  const loader = document.getElementById('loader');
  if (loader) {
    setTimeout(() => loader.classList.add('done'), 400);
    setTimeout(() => loader.remove(), 1200);
  }
}

// -------------------------------------------------------------
// Boot
// -------------------------------------------------------------

function boot() {
  document.getElementById('year').textContent = new Date().getFullYear();

  // Render all content
  renderPrinciples();
  renderStats();
  renderTimeline();
  renderWork();
  renderSkills();
  renderRecognition();
  renderVision();
  renderContact();
  initClock();

  // Wire the placeholder resume + linkedin links so they're easy to find later
  const resumeBtn = document.getElementById('resume-btn');
  const footerResume = document.getElementById('footer-resume');
  const footerLinkedIn = document.getElementById('footer-linkedin');
  if (resumeBtn) resumeBtn.href = profile.resume;
  if (footerResume) footerResume.href = profile.resume;
  if (footerLinkedIn) footerLinkedIn.href = profile.linkedin;

  // Reduced-motion source. scene.js (Task 12.1) owns the canonical
  // matchMedia change subscription and re-applies it to layoutMotion +
  // reveal + companion + scanner internally. main.js reads it here only
  // to pass into interactions + modal (which are wired below through the
  // scene handle so their character-side effects reach the live
  // companion / scanner references).
  const prefersReduced = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const labelEl  = document.getElementById('companion-label');
  const statusEl = document.querySelector('.status');

  // SFX toggle wiring. Reflect the current mute state on the button
  // via `.is-muted` and `aria-pressed`, sync both on every toggle.
  const sfxBtn = document.getElementById('sfx-toggle');
  function syncSfxBtn() {
    if (!sfxBtn) return;
    const on = sfx.isEnabled();
    sfxBtn.classList.toggle('is-muted', !on);
    sfxBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    sfxBtn.setAttribute('aria-label', on ? 'Mute sound effects' : 'Enable sound effects');
  }
  if (sfxBtn) {
    syncSfxBtn();
    sfxBtn.addEventListener('click', () => {
      sfx.toggle();
      syncSfxBtn();
      if (sfx.isEnabled()) sfx.blip(); // audible confirmation when unmuting
    });
  }

  initScroll({
    onSectionChange: (idx) => {
      const label = SENTINEL_LABELS[Math.min(idx, SENTINEL_LABELS.length - 1)];
      if (labelEl && label) {
        labelEl.style.opacity = '0.35';
        setTimeout(() => {
          labelEl.textContent = label;
          labelEl.style.opacity = '1';
        }, 140);
      }
      // Corner status widget (SYS / LOC / TIME) is a hero-only piece
      // of chrome — it sets the "computer terminal" mood alongside the
      // hero copy, but competes with content in later sections. Hide
      // as soon as SENTINEL crosses out of hero (section index > 0).
      if (statusEl) statusEl.classList.toggle('is-hidden', idx > 0);
      // Radar-sweep sound on section change. Cheap way to reinforce
      // the "SENTINEL is now looking at this" moment.
      sfx.whoosh();
    },
  });
  initCardHover();
  initCursor();

  // Loader hard fallback — registered FIRST so any synchronous
  // throw in the sections below can't strand the loading screen.
  // (2025-11 fix: user reported the loader hanging when a scene
  // init error propagated out of boot before the fallback could
  // be scheduled.)
  setTimeout(finishLoader, 4000);

  // Boot Three.js scene. It owns reveal + layoutMotion internally, so
  // main.js no longer instantiates them here — see the import block.
  //
  // Interactions + modal are wired AFTER initScene returns so they
  // pick up the live companion / shapeSystem / scanner references via
  // closure getters on the scene handle (Task 12.1). initScene runs
  // synchronously enough to return a handle before we call them; on
  // E1 (WebGL failure) the getters return null and both modules
  // degrade to their CSS-only paths.
  //
  // Wrapped in try/catch — any synchronous throw here would otherwise
  // reach the module boundary uncaught and skip the rest of boot.
  const canvas = document.getElementById('bg-canvas');
  let sceneHandle = null;
  try {
    if (canvas) {
      sceneHandle = initScene(canvas, {
        onProgress: (pct) => updateLoader(pct),
        onReady: () => finishLoader(),
      });
    } else {
      finishLoader();
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[boot] initScene threw:', err);
    document.documentElement.classList.add('no-webgl');
    if (canvas) canvas.style.display = 'none';
    finishLoader();
  }

  const safeHandle = sceneHandle || {
    getCompanion:    () => null,
    getOrchestrator: () => null,
    getScanFan:      () => null,
    getBuddyDomPos:  () => null,
    scanner:         null,
  };

  try {
    initInteractions({
      companion:    safeHandle.getCompanion(),
      shapeSystem:  safeHandle.getCompanion() && safeHandle.getCompanion().shapeSystem,
      scanner:      safeHandle.scanner,
      orchestrator: safeHandle.getOrchestrator ? safeHandle.getOrchestrator() : null,
      scanFan:      safeHandle.getScanFan ? safeHandle.getScanFan() : null,
      prefersReduced,
      getBuddyPos:  () => safeHandle.getBuddyDomPos(),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[boot] initInteractions threw:', err);
  }

  try {
    initModal({
      getCompanion: () => safeHandle.getCompanion(),
      getBuddyPos:  () => safeHandle.getBuddyDomPos(),
      prefersReduced,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[boot] initModal threw:', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
