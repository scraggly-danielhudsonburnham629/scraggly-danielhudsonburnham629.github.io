// -------------------------------------------------------------
// sfx.js — Web Audio synthesizer for interaction sound effects.
//
// Every sound is generated live from oscillators + filtered noise
// buffers. No audio files are shipped — the module is ~4 KB and
// covers the whole sonic palette:
//
//   • blip()   — 60 ms sine tick with a downward pitch sweep.
//                Fires on hover-in over interactive elements. Very
//                subtle; barely register when used sparingly.
//   • click()  — 50 ms bandpass-filtered noise burst. Fires on
//                click for a satisfying "thunk" without being loud.
//   • whoosh() — 350 ms rising bandpass noise sweep. Section
//                change transitions. Reads as a radar sweep pass.
//   • chime()  — Two stacked triangle-wave notes (A5 + E6, a
//                perfect fifth) spaced 60 ms apart with slow decay.
//                Fires on trophy verify flip completion.
//   • tick()   — 40 ms high sine ping. Fires on cert row scan
//                completion.
//
// Autoplay policy:
//   Browsers refuse to start an AudioContext until a user gesture.
//   `ensureCtx()` is a no-op until the first interaction; on any
//   subsequent click/keydown we resume the suspended context.
//
// Enabled state persists in localStorage under `sfx-enabled`.
// Default is ON — visitors get the full experience but can mute
// with the toolbar button any time.
// -------------------------------------------------------------

const STORAGE_KEY = 'sfx-enabled';

let ctx = null;
let masterGain = null;
let enabled = true;

try {
  // Default to enabled unless the user explicitly muted before.
  enabled = window.localStorage.getItem(STORAGE_KEY) !== 'false';
} catch (_e) {
  // localStorage unavailable (private mode / disabled) — default ON.
}

function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  masterGain = ctx.createGain();
  masterGain.gain.value = 0.14; // subtle overall volume — user cannot startle
  masterGain.connect(ctx.destination);
  return ctx;
}

// Unlock the context on first user gesture — required by
// autoplay policy in Chrome/Safari/Firefox. Once unlocked, all
// subsequent `play()` calls fire without gating.
function attachUnlockListener() {
  const unlock = () => {
    const c = ensureCtx();
    if (c && c.state === 'suspended') c.resume();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock, { once: true, passive: true });
  window.addEventListener('keydown', unlock, { once: true });
}
attachUnlockListener();

// Shared helper — gates on enabled state + ensures context, then
// hands the AudioContext + master gain to the caller. All sound
// bodies stay tiny and side-effect-free by using this wrapper.
function play(fn) {
  if (!enabled) return;
  const c = ensureCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume();
  try { fn(c, masterGain); } catch (_e) { /* audio failure = silent, not fatal */ }
}

// -------------------------------------------------------------
// Individual sounds
// -------------------------------------------------------------

// Rate-limits `blip` — hovering across many items in a row (e.g.
// scrolling through the project list) would otherwise machine-gun
// the tick. 80 ms feels responsive without stacking.
let lastBlipAt = 0;
export function blip() {
  const now = performance.now();
  if (now - lastBlipAt < 80) return;
  lastBlipAt = now;
  play((c, master) => {
    const now = c.currentTime;
    const osc = c.createOscillator();
    const g   = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, now);
    osc.frequency.exponentialRampToValueAtTime(600, now + 0.06);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.28, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
    osc.connect(g).connect(master);
    osc.start(now);
    osc.stop(now + 0.09);
  });
}

export function click() {
  play((c, master) => {
    const now = c.currentTime;
    const buf = c.createBuffer(1, 512, c.sampleRate);
    const d   = buf.getChannelData(0);
    for (let i = 0; i < 512; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const filt = c.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = 2400;
    filt.Q.value = 6;
    const g = c.createGain();
    g.gain.setValueAtTime(0.45, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    src.connect(filt).connect(g).connect(master);
    src.start(now);
    src.stop(now + 0.06);
  });
}

export function whoosh() {
  play((c, master) => {
    const now = c.currentTime;
    const dur = 0.35;
    const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.35;
    const src = c.createBufferSource();
    src.buffer = buf;
    const filt = c.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.setValueAtTime(220, now);
    filt.frequency.exponentialRampToValueAtTime(1800, now + dur);
    filt.Q.value = 3.5;
    const g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.22, now + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(filt).connect(g).connect(master);
    src.start(now);
    src.stop(now + dur + 0.02);
  });
}

export function chime() {
  play((c, master) => {
    const now = c.currentTime;
    // A5 + E6 (perfect fifth) — sparse, "verified" feel.
    const notes = [880, 1318.51];
    notes.forEach((freq, i) => {
      const osc = c.createOscillator();
      const g   = c.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const start = now + i * 0.06;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(0.14, start + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.55);
      osc.connect(g).connect(master);
      osc.start(start);
      osc.stop(start + 0.6);
    });
  });
}

export function tick() {
  play((c, master) => {
    const now = c.currentTime;
    const osc = c.createOscillator();
    const g   = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = 1800;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.2, now + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);
    osc.connect(g).connect(master);
    osc.start(now);
    osc.stop(now + 0.05);
  });
}

// -------------------------------------------------------------
// Enabled state controls
// -------------------------------------------------------------

export function setEnabled(v) {
  enabled = !!v;
  try { window.localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false'); }
  catch (_e) { /* ignore storage failures */ }
  if (enabled) ensureCtx();
}

export function toggle() {
  setEnabled(!enabled);
  return enabled;
}

export function isEnabled() {
  return enabled;
}
