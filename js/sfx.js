// -------------------------------------------------------------
// sfx.js — Web Audio SFX + ambient music.
//
// Design goal (2025-11 v2): move away from "8-bit game" tones
// (pure sine bleeps, triangle chimes) toward "HUD / Iron Man /
// Blade Runner 2049" — filtered noise, FM metallic timbres,
// short reverb tails, slight detune for movement.
//
// SFX palette:
//   • blip()   — FM chirp with filter sweep. Hovers.
//   • click()  — Layered noise transient + tonal thump. Clicks.
//   • whoosh() — Resonant filtered noise sweep. Section changes.
//   • chime()  — FM bell dyad with reverb tail. Verify complete.
//   • tick()   — Ultra-short broadband click. Cert stamp.
//
// Ambient music:
//   startAmbient() spins up a low-drone pad that plays quietly in
//   the background while enabled. Two detuned sawtooth oscillators
//   at A1 + A2, lowpass-filtered with a slow LFO, plus a bandpass
//   noise "atmosphere" bed. Master gain ~5% so it sits under the
//   SFX (~14%) without competing. Idle CPU cost is negligible.
//
// Autoplay policy:
//   All calls no-op silently until the user's first pointer/key
//   gesture unlocks the AudioContext. Ambient auto-starts on that
//   same gesture if enabled.
// -------------------------------------------------------------

const STORAGE_KEY = 'sfx-enabled';

let ctx = null;
let masterGain = null;
let sfxBus = null;       // busses so SFX and music can have independent levels
let musicBus = null;
let reverb = null;       // shared reverb send from a small delay network
let enabled = true;
let ambientHandles = null; // { oscA, oscB, noise, ... } once started
let unlocked = false;

try {
  enabled = window.localStorage.getItem(STORAGE_KEY) !== 'false';
} catch (_e) { /* localStorage unavailable */ }

// -------------------------------------------------------------
// Context + master graph. Built lazily on the first user gesture.
// -------------------------------------------------------------
function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();

  masterGain = ctx.createGain();
  masterGain.gain.value = 1.0;
  masterGain.connect(ctx.destination);

  // Independent busses — SFX at ~14 %, music at ~5 %. Both routed
  // through the master so a single volume knob would still work.
  sfxBus = ctx.createGain();
  sfxBus.gain.value = 0.14;
  sfxBus.connect(masterGain);

  musicBus = ctx.createGain();
  musicBus.gain.value = 0.05;
  musicBus.connect(masterGain);

  // A cheap "space" — 2 tap delay network with light lowpass on the
  // feedback path. Sounds passed through the returned `input` gain
  // will pick up a short, slightly darker spatial tail. Nothing fancy
  // but way less gamey than dry mono sines.
  reverb = createSpace(ctx, sfxBus);

  return ctx;
}

// -------------------------------------------------------------
// Small "space" via two dampened delay taps. Not a proper convolution
// reverb, but adds ~100 ms of decorrelated tail that gives sounds a
// place to exist rather than sitting stone dry in front of the ear.
// -------------------------------------------------------------
function createSpace(c, output) {
  const input = c.createGain();
  input.gain.value = 1;

  const dryTap = c.createGain();
  dryTap.gain.value = 1;
  input.connect(dryTap).connect(output);

  const wet = c.createGain();
  wet.gain.value = 0.28; // subtle
  const d1 = c.createDelay(0.5); d1.delayTime.value = 0.055;
  const d2 = c.createDelay(0.5); d2.delayTime.value = 0.093;
  const fb = c.createGain(); fb.gain.value = 0.35;
  const damp = c.createBiquadFilter(); damp.type = 'lowpass'; damp.frequency.value = 4200;

  input.connect(d1);
  input.connect(d2);
  d1.connect(damp).connect(fb).connect(d1);
  d1.connect(wet);
  d2.connect(wet);
  wet.connect(output);

  return { input };
}

function toSfxBus() {
  // Route through the reverb space so every SFX picks up the tail.
  return reverb ? reverb.input : sfxBus;
}

// -------------------------------------------------------------
// Autoplay unlock — Web Audio needs a user gesture first. We wait
// for pointerdown or keydown, then resume + start ambient if
// enabled.
// -------------------------------------------------------------
function unlock() {
  if (unlocked) return;
  const c = ensureCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume();
  unlocked = true;
  if (enabled) startAmbient();
}
window.addEventListener('pointerdown', unlock, { once: true, passive: true });
window.addEventListener('keydown', unlock, { once: true });

function play(fn) {
  if (!enabled) return;
  const c = ensureCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume();
  try { fn(c, toSfxBus()); } catch (_e) { /* silent failure */ }
}

// -------------------------------------------------------------
// SFX
// -------------------------------------------------------------

// FM chirp helper — carrier + modulator with independent envelopes.
// Returns nodes so callers can chain their own envelopes if needed.
function fmVoice(c, output, {
  carrierFreq, modFreq, modIndex,
  attack = 0.005, decay = 0.08, peak = 0.3,
  filterFreq = null, filterQ = 1,
}) {
  const now = c.currentTime;
  const car = c.createOscillator();
  const mod = c.createOscillator();
  const modGain = c.createGain();
  const outGain = c.createGain();

  car.type = 'sine';
  mod.type = 'sine';
  car.frequency.value = carrierFreq;
  mod.frequency.value = modFreq;
  modGain.gain.value = modFreq * modIndex;

  mod.connect(modGain).connect(car.frequency);

  outGain.gain.setValueAtTime(0, now);
  outGain.gain.linearRampToValueAtTime(peak, now + attack);
  outGain.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);

  let last = outGain;
  if (filterFreq != null) {
    const filt = c.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = filterFreq;
    filt.Q.value = filterQ;
    outGain.connect(filt);
    last = filt;
  }
  car.connect(outGain);
  last.connect(output);

  car.start(now);
  mod.start(now);
  car.stop(now + attack + decay + 0.05);
  mod.stop(now + attack + decay + 0.05);
}

// Rate-limits blip — hovering across many items would machine-gun.
let lastBlipAt = 0;
export function blip() {
  const now = performance.now();
  if (now - lastBlipAt < 90) return;
  lastBlipAt = now;
  play((c, out) => {
    // High-register FM chirp with a downward filter sweep.
    // Carrier 3200 Hz modulated by 480 Hz creates a bright metallic
    // ping without pure-sine cleanliness.
    const t0 = c.currentTime;
    fmVoice(c, out, {
      carrierFreq: 3200, modFreq: 480, modIndex: 1.8,
      attack: 0.003, decay: 0.06, peak: 0.22,
    });
    // Filter tail — bandpass on a short noise sweep, gives it
    // "air" instead of a bare tone.
    const buf = c.createBuffer(1, 512, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < 512; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource(); src.buffer = buf;
    const filt = c.createBiquadFilter(); filt.type = 'highpass';
    filt.frequency.value = 4000; filt.Q.value = 4;
    const g = c.createGain();
    g.gain.setValueAtTime(0.05, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
    src.connect(filt).connect(g).connect(out);
    src.start(t0);
    src.stop(t0 + 0.06);
  });
}

let lastClickAt = 0;
export function click() {
  const nowT = performance.now();
  if (nowT - lastClickAt < 60) return;
  lastClickAt = nowT;
  play((c, out) => {
    const now = c.currentTime;
    // (a) Sharp transient — 3 ms bandpass noise burst high in the
    // spectrum. Reads as the "attack" of the click.
    const nb = c.createBuffer(1, 512, c.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < 512; i++) nd[i] = Math.random() * 2 - 1;
    const nsrc = c.createBufferSource(); nsrc.buffer = nb;
    const nfilt = c.createBiquadFilter();
    nfilt.type = 'bandpass'; nfilt.frequency.value = 3400; nfilt.Q.value = 6;
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.45, now);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);
    nsrc.connect(nfilt).connect(ng).connect(out);
    nsrc.start(now); nsrc.stop(now + 0.04);

    // (b) Tonal body — 750 → 320 Hz FM component gives it weight.
    fmVoice(c, out, {
      carrierFreq: 750, modFreq: 320, modIndex: 2.4,
      attack: 0.001, decay: 0.09, peak: 0.28,
    });
  });
}

export function whoosh() {
  play((c, out) => {
    const now = c.currentTime;
    const dur = 0.42;
    // Pink-ish noise (not perfect pink but low-tilted white).
    const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const n = Math.random() * 2 - 1;
      last = (last + n * 0.15) * 0.94; // simple lowpass to warm it up
      d[i] = last;
    }
    const src = c.createBufferSource(); src.buffer = buf;

    // Resonant filter sweep — the sound of a scanning bar rising.
    const filt = c.createBiquadFilter();
    filt.type = 'bandpass';
    filt.Q.value = 9;
    filt.frequency.setValueAtTime(180, now);
    filt.frequency.exponentialRampToValueAtTime(2400, now + dur);

    const g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.55, now + 0.08);
    g.gain.linearRampToValueAtTime(0.35, now + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(filt).connect(g).connect(out);
    src.start(now); src.stop(now + dur + 0.02);

    // Sub tonal glissando (sine, filter-highpassed) — subtle
    // "target locked" tail.
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(220, now + 0.05);
    osc.frequency.exponentialRampToValueAtTime(1400, now + dur);
    const og = c.createGain();
    og.gain.setValueAtTime(0, now + 0.05);
    og.gain.linearRampToValueAtTime(0.05, now + 0.15);
    og.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(og).connect(out);
    osc.start(now + 0.05); osc.stop(now + dur + 0.02);
  });
}

export function chime() {
  play((c, out) => {
    // Two-note FM bell, 60 ms stagger. Carrier / modulator ratio
    // creates inharmonic partials → metallic rather than "musical."
    const dyad = [
      { car: 1400, mod: 700, idx: 3.0 },
      { car: 2100, mod: 900, idx: 2.4 },
    ];
    dyad.forEach((v, i) => {
      const c2 = c.createOscillator();
      const m2 = c.createOscillator();
      const modGain = c.createGain();
      const outGain = c.createGain();
      c2.type = 'sine'; m2.type = 'sine';
      c2.frequency.value = v.car;
      m2.frequency.value = v.mod;
      modGain.gain.value = v.mod * v.idx;
      m2.connect(modGain).connect(c2.frequency);

      const start = c.currentTime + i * 0.06;
      outGain.gain.setValueAtTime(0, start);
      outGain.gain.linearRampToValueAtTime(0.16, start + 0.01);
      // Longer decay + reverb tail via `out` (which routes through space).
      outGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.7);
      c2.connect(outGain).connect(out);
      c2.start(start); m2.start(start);
      c2.stop(start + 0.8); m2.stop(start + 0.8);
    });
  });
}

export function tick() {
  play((c, out) => {
    const now = c.currentTime;
    // Ultra-short broadband noise burst — data-write indicator.
    const buf = c.createBuffer(1, 256, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < 256; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource(); src.buffer = buf;
    const filt = c.createBiquadFilter();
    filt.type = 'bandpass'; filt.frequency.value = 4200; filt.Q.value = 5;
    const g = c.createGain();
    g.gain.setValueAtTime(0.35, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.025);
    src.connect(filt).connect(g).connect(out);
    src.start(now); src.stop(now + 0.03);
  });
}

// -------------------------------------------------------------
// Ambient background music. Two detuned sawtooth voices at low
// register plus a filtered noise atmosphere, all under a slow LFO.
// Starts on first user gesture (via `unlock`), stops on toggle-off.
// -------------------------------------------------------------
function startAmbient() {
  if (ambientHandles) return;
  const c = ensureCtx();
  if (!c || !musicBus) return;

  const now = c.currentTime;

  // Two saws detuned by ~7 cents → slow beating that reads as
  // "atmosphere breathing." Root at A1 (55 Hz).
  const oscA = c.createOscillator();
  const oscB = c.createOscillator();
  oscA.type = 'sawtooth';
  oscB.type = 'sawtooth';
  oscA.frequency.value = 55;
  oscB.frequency.value = 55.24;

  // Adding a fifth up for harmonic body.
  const oscC = c.createOscillator();
  oscC.type = 'triangle';
  oscC.frequency.value = 82.5;

  // Lowpass filter with a very slow LFO so the pad "breathes."
  const filt = c.createBiquadFilter();
  filt.type = 'lowpass';
  filt.Q.value = 4;
  filt.frequency.value = 400;

  const lfo = c.createOscillator();
  const lfoGain = c.createGain();
  lfo.type = 'sine';
  lfo.frequency.value = 0.05; // one cycle every 20 s
  lfoGain.gain.value = 220;
  lfo.connect(lfoGain).connect(filt.frequency);

  // Voice bus — fades in over 4 s to avoid a jolt at unlock.
  const voices = c.createGain();
  voices.gain.value = 0;
  voices.gain.setValueAtTime(0, now);
  voices.gain.linearRampToValueAtTime(0.55, now + 4.0);

  oscA.connect(voices);
  oscB.connect(voices);
  oscC.connect(voices);
  voices.connect(filt).connect(musicBus);

  // Very quiet noise bed for "air / room tone" texture.
  const noiseBuf = c.createBuffer(1, c.sampleRate * 4, c.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  let x = 0;
  for (let i = 0; i < nd.length; i++) {
    x = (x + (Math.random() * 2 - 1) * 0.1) * 0.98;
    nd[i] = x;
  }
  const noise = c.createBufferSource();
  noise.buffer = noiseBuf;
  noise.loop = true;

  const nfilt = c.createBiquadFilter();
  nfilt.type = 'bandpass';
  nfilt.frequency.value = 1200;
  nfilt.Q.value = 0.8;
  const ng = c.createGain();
  ng.gain.value = 0;
  ng.gain.setValueAtTime(0, now);
  ng.gain.linearRampToValueAtTime(0.35, now + 4.0);
  noise.connect(nfilt).connect(ng).connect(musicBus);

  oscA.start(now); oscB.start(now); oscC.start(now);
  lfo.start(now); noise.start(now);

  ambientHandles = { oscA, oscB, oscC, lfo, noise, voices, ng };
}

function stopAmbient() {
  if (!ambientHandles || !ctx) return;
  const now = ctx.currentTime;
  const { oscA, oscB, oscC, lfo, noise, voices, ng } = ambientHandles;
  // Quick fade-out to avoid a click.
  voices.gain.cancelScheduledValues(now);
  voices.gain.setValueAtTime(voices.gain.value, now);
  voices.gain.linearRampToValueAtTime(0, now + 0.4);
  ng.gain.cancelScheduledValues(now);
  ng.gain.setValueAtTime(ng.gain.value, now);
  ng.gain.linearRampToValueAtTime(0, now + 0.4);
  setTimeout(() => {
    try { oscA.stop(); oscB.stop(); oscC.stop(); lfo.stop(); noise.stop(); } catch (_e) {}
    ambientHandles = null;
  }, 500);
}

// -------------------------------------------------------------
// Enabled state controls
// -------------------------------------------------------------

export function setEnabled(v) {
  const wasEnabled = enabled;
  enabled = !!v;
  try { window.localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false'); }
  catch (_e) { /* ignore */ }

  if (enabled) {
    ensureCtx();
    if (unlocked) startAmbient();
  } else if (wasEnabled) {
    stopAmbient();
  }
}

export function toggle() {
  setEnabled(!enabled);
  return enabled;
}

export function isEnabled() {
  return enabled;
}
