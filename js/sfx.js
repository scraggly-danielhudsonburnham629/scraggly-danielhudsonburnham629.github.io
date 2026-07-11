// -------------------------------------------------------------
// sfx.js — Web Audio SFX + ambient music.
//
// v3 (2025-11) — "outer space" ambient + per-section SFX palette.
//
// Music design (space, not drone):
//   Removed the sawtooth pad (too warm/analog). New bed is:
//     • sub sine at 40 Hz with 12 s LFO on amplitude (breathing bass)
//     • wind-noise: filtered pink-ish noise, slow bandpass sweep
//     • sparse bell events: FM chimes at random intervals on a
//       minor pentatonic scale, panned to random positions with
//       long reverb tails
//   Music bus lowered to 0.022 (was 0.05) so it sits UNDER voices
//   and never fights the SFX layer.
//
// SFX palette (all filtered / FM synthesised, no pure sines):
//   Universal:
//     • blip()     — hover on interactive item
//     • click()    — click on any interactive element
//     • whoosh()   — section boundary crossing
//     • chime()    — trophy verify flip
//     • tick()     — cert stamp
//   Section-specific:
//     • analyze()  — trophy hold pulse (rhythmic soft ticks)
//     • laser()    — Skills scan-fan fire
//     • broadcast()— Vision item mapped
//     • hum(el)    — Contact meta hover (sustained; returns handle
//                    with .stop() to release)
//     • journey()  — Journey timeline item hover (chirp variant)
//     • verify()   — Recognition alt-blip (softer, warmer)
//
// Every section-specific SFX has its own filter / envelope so a
// visitor can hear what SENTINEL is doing without looking.
// -------------------------------------------------------------

const STORAGE_KEY = 'sfx-enabled';

let ctx = null;
let masterGain = null;
let sfxBus = null;
let musicBus = null;
let reverb = null;
let enabled = true;
let ambientHandles = null;
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

  sfxBus = ctx.createGain();
  sfxBus.gain.value = 0.14;
  sfxBus.connect(masterGain);

  // Music at 2.2 % — quiet enough to be atmosphere, not competition.
  musicBus = ctx.createGain();
  musicBus.gain.value = 0.022;
  musicBus.connect(masterGain);

  reverb = createSpace(ctx, sfxBus);

  return ctx;
}

// -------------------------------------------------------------
// Cheap "space" via a 2-tap dampened delay network. Attaches to
// the SFX bus — every SFX picks up ~100 ms of decorrelated tail.
// -------------------------------------------------------------
function createSpace(c, output) {
  const input = c.createGain();
  input.gain.value = 1;

  input.connect(output); // dry

  const wet = c.createGain();
  wet.gain.value = 0.3;
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

function toSfxBus() { return reverb ? reverb.input : sfxBus; }

// -------------------------------------------------------------
// Autoplay unlock
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
  try { fn(c, toSfxBus()); } catch (_e) { /* silent */ }
}

// -------------------------------------------------------------
// Shared FM voice helper — carrier + modulator envelope.
// -------------------------------------------------------------
function fmVoice(c, output, {
  carrierFreq, modFreq, modIndex,
  attack = 0.005, decay = 0.08, peak = 0.3,
  filterFreq = null, filterQ = 1, filterType = 'bandpass',
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
    filt.type = filterType;
    filt.frequency.value = filterFreq;
    filt.Q.value = filterQ;
    outGain.connect(filt);
    last = filt;
  }
  car.connect(outGain);
  last.connect(output);

  car.start(now); mod.start(now);
  car.stop(now + attack + decay + 0.05);
  mod.stop(now + attack + decay + 0.05);
}

// -------------------------------------------------------------
// Universal SFX
// -------------------------------------------------------------

let lastBlipAt = 0;
export function blip() {
  const nowT = performance.now();
  if (nowT - lastBlipAt < 90) return;
  lastBlipAt = nowT;
  play((c, out) => {
    const t0 = c.currentTime;
    fmVoice(c, out, {
      carrierFreq: 3200, modFreq: 480, modIndex: 1.8,
      attack: 0.003, decay: 0.055, peak: 0.20,
    });
    // Air-layer noise burst at high frequency for texture.
    const buf = c.createBuffer(1, 512, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < 512; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource(); src.buffer = buf;
    const filt = c.createBiquadFilter(); filt.type = 'highpass';
    filt.frequency.value = 4200; filt.Q.value = 4;
    const g = c.createGain();
    g.gain.setValueAtTime(0.045, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
    src.connect(filt).connect(g).connect(out);
    src.start(t0); src.stop(t0 + 0.06);
  });
}

let lastClickAt = 0;
export function click() {
  const nowT = performance.now();
  if (nowT - lastClickAt < 60) return;
  lastClickAt = nowT;
  play((c, out) => {
    const now = c.currentTime;
    const nb = c.createBuffer(1, 512, c.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < 512; i++) nd[i] = Math.random() * 2 - 1;
    const nsrc = c.createBufferSource(); nsrc.buffer = nb;
    const nfilt = c.createBiquadFilter();
    nfilt.type = 'bandpass'; nfilt.frequency.value = 3400; nfilt.Q.value = 6;
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.4, now);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);
    nsrc.connect(nfilt).connect(ng).connect(out);
    nsrc.start(now); nsrc.stop(now + 0.04);

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
    const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const n = Math.random() * 2 - 1;
      last = (last + n * 0.15) * 0.94;
      d[i] = last;
    }
    const src = c.createBufferSource(); src.buffer = buf;

    const filt = c.createBiquadFilter();
    filt.type = 'bandpass'; filt.Q.value = 9;
    filt.frequency.setValueAtTime(180, now);
    filt.frequency.exponentialRampToValueAtTime(2400, now + dur);

    const g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.5, now + 0.08);
    g.gain.linearRampToValueAtTime(0.3, now + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(filt).connect(g).connect(out);
    src.start(now); src.stop(now + dur + 0.02);

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
// Section-specific SFX
// -------------------------------------------------------------

// Trophy hold pulse — soft rhythmic tick with rising pitch to
// signal "SENTINEL is analysing." Called by interactions.js during
// the 1s hold-to-verify sequence.
let analyzeCount = 0;
export function analyze() {
  play((c, out) => {
    const now = c.currentTime;
    const step = (analyzeCount++ % 4);
    const freq = 1600 + step * 200;
    fmVoice(c, out, {
      carrierFreq: freq, modFreq: freq * 0.5, modIndex: 1.2,
      attack: 0.002, decay: 0.09, peak: 0.14,
      filterFreq: freq * 1.2, filterQ: 3,
    });
  });
}

// Skills scan-fan — laser sweep sound. Rising resonant filter on
// filtered noise, plus a metallic FM tail. Rate-limited so the
// per-group cooldown isn't the only guard.
let lastLaserAt = 0;
export function laser() {
  const nowT = performance.now();
  if (nowT - lastLaserAt < 300) return;
  lastLaserAt = nowT;
  play((c, out) => {
    const now = c.currentTime;
    const dur = 0.55;

    // Noise sweep
    const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const n = Math.random() * 2 - 1;
      last = (last + n * 0.2) * 0.92;
      d[i] = last;
    }
    const src = c.createBufferSource(); src.buffer = buf;
    const filt = c.createBiquadFilter();
    filt.type = 'bandpass'; filt.Q.value = 14;
    filt.frequency.setValueAtTime(500, now);
    filt.frequency.exponentialRampToValueAtTime(3200, now + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.4, now + 0.04);
    g.gain.linearRampToValueAtTime(0.25, now + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(filt).connect(g).connect(out);
    src.start(now); src.stop(now + dur + 0.02);

    // FM whine on top
    fmVoice(c, out, {
      carrierFreq: 2400, modFreq: 3600, modIndex: 0.6,
      attack: 0.03, decay: dur - 0.05, peak: 0.10,
    });
  });
}

// Vision map — broadcast ping. Rising bell with echo tail so it
// reads as "SENTINEL surveyed and pinned this coordinate."
let lastBroadcastAt = 0;
export function broadcast() {
  const nowT = performance.now();
  if (nowT - lastBroadcastAt < 200) return;
  lastBroadcastAt = nowT;
  play((c, out) => {
    fmVoice(c, out, {
      carrierFreq: 1800, modFreq: 1200, modIndex: 2.2,
      attack: 0.005, decay: 0.55, peak: 0.18,
      filterFreq: 2400, filterQ: 6, filterType: 'lowpass',
    });
    // Second harmonic layer up a fifth
    setTimeout(() => {
      play((c2, out2) => {
        fmVoice(c2, out2, {
          carrierFreq: 2700, modFreq: 1600, modIndex: 1.8,
          attack: 0.005, decay: 0.4, peak: 0.10,
        });
      });
    }, 90);
  });
}

// Contact meta hover — sustained low hum that rises from silence
// when engaged, fades back when released. Returns { stop } handle.
export function hum() {
  if (!enabled) return { stop: () => {} };
  const c = ensureCtx();
  if (!c) return { stop: () => {} };
  if (c.state === 'suspended') c.resume();
  const now = c.currentTime;

  const out = toSfxBus();
  const osc1 = c.createOscillator();
  const osc2 = c.createOscillator();
  osc1.type = 'triangle'; osc2.type = 'triangle';
  osc1.frequency.value = 220;   // A3
  osc2.frequency.value = 330;   // E4 (perfect fifth)
  const filt = c.createBiquadFilter();
  filt.type = 'bandpass'; filt.frequency.value = 900; filt.Q.value = 3;
  const g = c.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(0.09, now + 0.25);
  osc1.connect(filt); osc2.connect(filt);
  filt.connect(g).connect(out);
  osc1.start(now); osc2.start(now);

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      const nowS = c.currentTime;
      g.gain.cancelScheduledValues(nowS);
      g.gain.setValueAtTime(g.gain.value, nowS);
      g.gain.linearRampToValueAtTime(0, nowS + 0.25);
      setTimeout(() => { try { osc1.stop(); osc2.stop(); } catch (_e) {} }, 300);
    },
  };
}

// Journey timeline — quick dropping chirp for timeline item hovers.
export function journey() {
  play((c, out) => {
    fmVoice(c, out, {
      carrierFreq: 1400, modFreq: 900, modIndex: 1.6,
      attack: 0.004, decay: 0.14, peak: 0.16,
    });
  });
}

// Recognition alt-blip — softer, warmer variant used when the
// user hovers a recognition item (trophies specifically).
export function verify() {
  play((c, out) => {
    fmVoice(c, out, {
      carrierFreq: 1800, modFreq: 900, modIndex: 1.2,
      attack: 0.005, decay: 0.1, peak: 0.15,
    });
  });
}

// -------------------------------------------------------------
// Ambient — "outer space" bed
//
// Three layers, no drone:
//   (1) Sub sine at 40 Hz with 12 s LFO on amplitude (breathing).
//   (2) Wind — pink-ish noise through slowly-sweeping bandpass.
//   (3) Sparse random bells — FM chimes on a minor pentatonic
//       scale, fire on random intervals (4-14 s), each with a
//       long reverb tail via the SFX space send.
// -------------------------------------------------------------
function startAmbient() {
  if (ambientHandles) return;
  const c = ensureCtx();
  if (!c || !musicBus) return;

  const now = c.currentTime;

  // (1) Sub bass — 40 Hz sine with amplitude LFO.
  const sub = c.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = 40;
  const subGain = c.createGain();
  subGain.gain.value = 0;
  const subLfo = c.createOscillator();
  subLfo.type = 'sine';
  subLfo.frequency.value = 1 / 12; // one cycle per 12 s
  const subLfoGain = c.createGain();
  subLfoGain.gain.value = 0.55;
  subLfo.connect(subLfoGain).connect(subGain.gain);
  // Bias the LFO up so gain oscillates around 0.55, not around 0.
  subGain.gain.setValueAtTime(0, now);
  subGain.gain.linearRampToValueAtTime(0.55, now + 6);
  sub.connect(subGain).connect(musicBus);

  // (2) Wind — filtered noise with slow bandpass sweep.
  const noiseBuf = c.createBuffer(1, c.sampleRate * 6, c.sampleRate);
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
  nfilt.Q.value = 2;
  const nlfo = c.createOscillator();
  nlfo.type = 'sine';
  nlfo.frequency.value = 1 / 17; // 17 s cycle
  const nlfoGain = c.createGain();
  nlfoGain.gain.value = 600;
  nlfo.connect(nlfoGain).connect(nfilt.frequency);
  nfilt.frequency.value = 1200;

  const ng = c.createGain();
  ng.gain.setValueAtTime(0, now);
  ng.gain.linearRampToValueAtTime(0.4, now + 6);
  noise.connect(nfilt).connect(ng).connect(musicBus);

  sub.start(now); subLfo.start(now);
  noise.start(now); nlfo.start(now);

  // (3) Sparse bell events — random intervals, minor pentatonic
  // frequencies (A minor: A E G B C -> pick some notes 3 octaves up).
  const bellNotes = [880, 1046.5, 1174.7, 1318.5, 1568.0, 1760.0];
  let bellTimerId = null;

  function scheduleNextBell() {
    const delayMs = 4000 + Math.random() * 10000; // 4-14 s
    bellTimerId = setTimeout(() => {
      if (!ambientHandles) return; // stopped mid-schedule
      // Bell hits the SFX space send so it echoes long.
      const nowB = c.currentTime;
      const freq = bellNotes[Math.floor(Math.random() * bellNotes.length)];
      const car = c.createOscillator();
      const mod = c.createOscillator();
      const modGain = c.createGain();
      const outGain = c.createGain();
      car.type = 'sine'; mod.type = 'sine';
      car.frequency.value = freq;
      mod.frequency.value = freq * 0.68;
      modGain.gain.value = freq * 0.68 * 2.4;
      mod.connect(modGain).connect(car.frequency);
      outGain.gain.setValueAtTime(0, nowB);
      outGain.gain.linearRampToValueAtTime(0.09, nowB + 0.02);
      outGain.gain.exponentialRampToValueAtTime(0.0001, nowB + 1.8);
      car.connect(outGain).connect(toSfxBus()); // route to reverb
      car.start(nowB); mod.start(nowB);
      car.stop(nowB + 2.0); mod.stop(nowB + 2.0);
      scheduleNextBell();
    }, delayMs);
  }
  scheduleNextBell();

  ambientHandles = {
    sub, subLfo, subGain, noise, nlfo, ng,
    getBellTimerId: () => bellTimerId,
    clearBellTimer: () => { if (bellTimerId) clearTimeout(bellTimerId); },
  };
}

function stopAmbient() {
  if (!ambientHandles || !ctx) return;
  const now = ctx.currentTime;
  const { sub, subLfo, subGain, noise, nlfo, ng, clearBellTimer } = ambientHandles;
  clearBellTimer();
  subGain.gain.cancelScheduledValues(now);
  subGain.gain.setValueAtTime(subGain.gain.value, now);
  subGain.gain.linearRampToValueAtTime(0, now + 0.4);
  ng.gain.cancelScheduledValues(now);
  ng.gain.setValueAtTime(ng.gain.value, now);
  ng.gain.linearRampToValueAtTime(0, now + 0.4);
  setTimeout(() => {
    try { sub.stop(); subLfo.stop(); noise.stop(); nlfo.stop(); } catch (_e) {}
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
