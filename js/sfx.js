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
  sfxBus.gain.value = 0.20; // SFX audible — compressor catches peaks
  // Soft compressor as a safety limiter — catches any transient
  // peaks so multiple sounds firing at once never hard-clip the
  // destination. Threshold -10 dB, gentle 4:1 ratio, fast attack,
  // moderate release. Doesn't colour normal-level content.
  const sfxComp = ctx.createDynamicsCompressor();
  sfxComp.threshold.value = -10;
  sfxComp.knee.value = 6;
  sfxComp.ratio.value = 4;
  sfxComp.attack.value = 0.003;
  sfxComp.release.value = 0.15;
  sfxBus.connect(sfxComp).connect(masterGain);

  // Music at 0.5 % — very faint atmosphere, sits well under SFX.
  musicBus = ctx.createGain();
  musicBus.gain.value = 0.005;
  musicBus.connect(masterGain);

  reverb = createSpace(ctx, sfxBus);

  return ctx;
}

// -------------------------------------------------------------
// Cheap "space" via a 2-tap dampened delay network. Attaches to
// the SFX bus — every SFX picks up ~100 ms of decorrelated tail.
// -------------------------------------------------------------
function createSpace(c, output) {
  // Convolution reverb with a synthetic impulse response — the
  // proper way to do reverb in Web Audio. The previous 4-tap
  // feedback network had a shared feedback loop across all taps,
  // so total gain was fb * 4 ≈ 2.2 per iteration — runaway
  // amplification that clipped as energy accumulated.
  //
  // Here we generate a 2-second exponentially-decaying stereo
  // noise IR (dark, roomy) and run the wet path through a
  // ConvolverNode. Stable by construction — no feedback loop.
  const input = c.createGain();
  input.gain.value = 1;

  // Dry passthrough
  const dry = c.createGain(); dry.gain.value = 1;
  input.connect(dry).connect(output);

  // Impulse response — 2 s exponential decay, filtered to sit dark.
  const durS = 2.0;
  const irLen = Math.floor(c.sampleRate * durS);
  const ir = c.createBuffer(2, irLen, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < irLen; i++) {
      // Exponential decay curve (cube gives a natural fall-off)
      const env = Math.pow(1 - i / irLen, 3);
      d[i] = (Math.random() * 2 - 1) * env;
    }
  }
  const conv = c.createConvolver();
  conv.buffer = ir;
  conv.normalize = true;

  // Small pre-delay so early reflections are decorrelated from
  // the dry hit — reads as spatial distance.
  const pre = c.createDelay(0.2);
  pre.delayTime.value = 0.03;

  // Lowpass on the wet path so the tail is dark (cathedral, not tin can).
  const damp = c.createBiquadFilter();
  damp.type = 'lowpass';
  damp.frequency.value = 3000;
  damp.Q.value = 0.5;

  const wet = c.createGain();
  wet.gain.value = 0.32;

  input.connect(pre).connect(conv).connect(damp).connect(wet).connect(output);

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
// Rotation helper — the sound of a spinning object in space.
// Base tone + tremolo (amp LFO) + vibrato (pitch LFO) at the same
// rate. Rate can ramp from startRate to endRate over the duration,
// which produces the accelerating "wuh-wuh-wuh" of a disc spooling
// up. Filter is lowpass so the tone stays warm; no harsh edges.
// -------------------------------------------------------------
function rotate(c, out, {
  baseFreq = 130,
  startRate = 1.5,
  endRate = 6,
  duration = 0.8,
  peak = 0.28,
  filterFreq = 800,
  filterQ = 2.5,
}) {
  const now = c.currentTime;
  const stopAt = now + duration + 0.15;

  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = baseFreq;

  const filt = c.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = filterFreq;
  filt.Q.value = filterQ;

  // Amp LFO — the "wuh" tremolo. Base 0 with LFO adding on top so
  // the tremolo depth is fully controllable and never dips below 0.
  const lfo = c.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.setValueAtTime(startRate, now);
  lfo.frequency.exponentialRampToValueAtTime(endRate, now + duration);
  const lfoDepth = c.createGain();
  lfoDepth.gain.value = peak * 0.5;
  lfo.connect(lfoDepth);

  const outGain = c.createGain();
  outGain.gain.setValueAtTime(0, now);
  outGain.gain.linearRampToValueAtTime(peak * 0.55, now + 0.1);
  outGain.gain.linearRampToValueAtTime(peak * 0.45, now + duration - 0.1);
  outGain.gain.exponentialRampToValueAtTime(0.0001, now + duration + 0.1);
  lfoDepth.connect(outGain.gain);

  // Vibrato — subtle pitch modulation at the same rate keeps the
  // wobble coherent. Depth is 3 % of base freq, tiny but audible.
  const vib = c.createOscillator();
  vib.type = 'sine';
  vib.frequency.setValueAtTime(startRate, now);
  vib.frequency.exponentialRampToValueAtTime(endRate, now + duration);
  const vibDepth = c.createGain();
  vibDepth.gain.value = baseFreq * 0.03;
  vib.connect(vibDepth).connect(osc.frequency);

  osc.connect(filt).connect(outGain).connect(out);

  osc.start(now); lfo.start(now); vib.start(now);
  osc.stop(stopAt); lfo.stop(stopAt); vib.stop(stopAt);
}

// -------------------------------------------------------------
// Universal SFX — ambient / space language, no game bleeps.
// -------------------------------------------------------------

let lastBlipAt = 0;
export function blip() {
  // "Shimmer" — very short high-frequency wash. No tone. Reads as
  // "SENTINEL noticed" without ever sounding like a game menu.
  const nowT = performance.now();
  if (nowT - lastBlipAt < 90) return;
  lastBlipAt = nowT;
  play((c, out) => {
    const t0 = c.currentTime;
    const buf = c.createBuffer(1, 1024, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1);
    const src = c.createBufferSource(); src.buffer = buf;
    const filt = c.createBiquadFilter();
    filt.type = 'highpass';
    filt.frequency.value = 5000;
    filt.Q.value = 0.7;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.08, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11);
    src.connect(filt).connect(g).connect(out);
    src.start(t0); src.stop(t0 + 0.13);
  });
}

let lastClickAt = 0;
export function click() {
  // "Thud" — deep short pulse in the sub-low range with a slow
  // decay. Sits under everything and picks up the reverb send for
  // an ambient tail. No noise burst, no bright transient.
  const nowT = performance.now();
  if (nowT - lastClickAt < 80) return;
  lastClickAt = nowT;
  play((c, out) => {
    const now = c.currentTime;
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(60, now + 0.2);
    const g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.35, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc.connect(g).connect(out);
    osc.start(now); osc.stop(now + 0.25);
  });
}

// Poking SENTINEL — bigger than a click, more resonant. Reads as
// SENTINEL reacting to being touched: sub-thump + mid impact +
// harmonic ring + a brief airy shimmer. Every layer sits in a
// different frequency band so all playback systems catch some of
// it. Everything routes through the reverb send.
let lastPokeAt = 0;
export function poke() {
  const nowT = performance.now();
  if (nowT - lastPokeAt < 120) return;
  lastPokeAt = nowT;
  play((c, out) => {
    const now = c.currentTime;

    // (1) Sub thump — sine sweep 120 → 55 Hz. Weight (may be
    // inaudible on tiny laptop speakers, that's fine — layers 2+3
    // cover them).
    const sub = c.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(120, now);
    sub.frequency.exponentialRampToValueAtTime(55, now + 0.4);
    const subG = c.createGain();
    subG.gain.setValueAtTime(0, now);
    subG.gain.linearRampToValueAtTime(0.55, now + 0.008);
    subG.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    sub.connect(subG).connect(out);
    sub.start(now); sub.stop(now + 0.55);

    // (2) Mid impact — 320 Hz triangle sweeping to 180 Hz. Sits in
    // the vocal range so every device reproduces it clearly.
    const mid = c.createOscillator();
    mid.type = 'triangle';
    mid.frequency.setValueAtTime(320, now);
    mid.frequency.exponentialRampToValueAtTime(180, now + 0.35);
    const midFilt = c.createBiquadFilter();
    midFilt.type = 'lowpass'; midFilt.frequency.value = 2000; midFilt.Q.value = 0.7;
    const midG = c.createGain();
    midG.gain.setValueAtTime(0, now);
    midG.gain.linearRampToValueAtTime(0.32, now + 0.008);
    midG.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
    mid.connect(midFilt).connect(midG).connect(out);
    mid.start(now); mid.stop(now + 0.45);

    // (3) Harmonic ring — E3 triangle with a long tail. Reverb
    // picks this up and lingers ~1 s. Sentinel's body resonating.
    const harm = c.createOscillator();
    harm.type = 'triangle';
    harm.frequency.value = 165;
    const harmFilt = c.createBiquadFilter();
    harmFilt.type = 'lowpass'; harmFilt.frequency.value = 1200; harmFilt.Q.value = 0.8;
    const harmG = c.createGain();
    harmG.gain.setValueAtTime(0, now);
    harmG.gain.linearRampToValueAtTime(0.22, now + 0.04);
    harmG.gain.exponentialRampToValueAtTime(0.0001, now + 1.0);
    harm.connect(harmFilt).connect(harmG).connect(out);
    harm.start(now); harm.stop(now + 1.1);

    // (4) Airy shimmer — highpass noise burst at contact.
    const buf = c.createBuffer(1, 512, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < 512; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource(); src.buffer = buf;
    const filt = c.createBiquadFilter();
    filt.type = 'highpass'; filt.frequency.value = 4500; filt.Q.value = 0.7;
    const g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.15, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
    src.connect(filt).connect(g).connect(out);
    src.start(now); src.stop(now + 0.1);
  });
}

export function whoosh() {
  // Cinematic swell — sustained low tone that rises briefly then
  // fades back into the reverb. No noise, no bandpass sharpness.
  play((c, out) => {
    const now = c.currentTime;
    const dur = 0.9;
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.exponentialRampToValueAtTime(280, now + dur * 0.5);
    osc.frequency.exponentialRampToValueAtTime(180, now + dur);
    const filt = c.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 900;
    filt.Q.value = 1;
    const g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.28, now + 0.18);
    g.gain.linearRampToValueAtTime(0.18, now + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(filt).connect(g).connect(out);
    osc.start(now); osc.stop(now + dur + 0.05);
  });
}

export function chime() {
  // Deep sustained triad, slow attack. Reverb does most of the work.
  play((c, out) => {
    const notes = [220, 330, 440]; // A3 + E4 + A4 — open fifth into octave
    notes.forEach((freq, i) => {
      const osc = c.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const filt = c.createBiquadFilter();
      filt.type = 'lowpass'; filt.frequency.value = 1600; filt.Q.value = 0.7;
      const g = c.createGain();
      const start = c.currentTime + i * 0.02;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(0.13, start + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 1.4);
      osc.connect(filt).connect(g).connect(out);
      osc.start(start); osc.stop(start + 1.5);
    });
  });
}

export function tick() {
  // Distant water-drop — soft sine chime, no noise. Long tail comes
  // from the reverb bus.
  play((c, out) => {
    const now = c.currentTime;
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1400, now);
    osc.frequency.exponentialRampToValueAtTime(900, now + 0.25);
    const g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.09, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    osc.connect(g).connect(out);
    osc.start(now); osc.stop(now + 0.32);
  });
}

// -------------------------------------------------------------
// Section entry cues — one distinct sound per section, matching the
// mode SENTINEL switches into. Called from main.js onSectionChange
// in place of the generic whoosh. Each is 300-600 ms.
//
//   0 hero       — soft wake pad
//   1 approach   — analyze arpeggio + rising bandpass
//   2 journey    — spool-up whine (SENTINEL's spin accelerates)
//   3 work       — targeting lock click
//   4 skills     — buffer-load tick cascade
//   5 recognition— stamp thunk + bell tail
//   6 vision     — bloom triad (perfect fifth open)
//   7 contact    — descending listen pad + hum onset
// -------------------------------------------------------------

// Cinematic pad helper — sustained tone with slow attack + long
// decay. Optional filter sweep for movement without pitch change.
function pad(c, out, {
  freq, wave = 'triangle',
  attack = 0.15, decay = 1.0, peak = 0.16,
  filterStart = null, filterEnd = null, filterQ = 0.8,
}) {
  const now = c.currentTime;
  const stopAt = now + attack + decay + 0.15;

  const osc = c.createOscillator();
  osc.type = wave;
  osc.frequency.value = freq;

  const filt = c.createBiquadFilter();
  filt.type = 'lowpass';
  filt.Q.value = filterQ;
  const fStart = filterStart != null ? filterStart : Math.max(400, freq * 3);
  const fEnd   = filterEnd   != null ? filterEnd   : fStart;
  filt.frequency.setValueAtTime(fStart, now);
  filt.frequency.linearRampToValueAtTime(fEnd, now + attack + decay);

  const g = c.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(peak, now + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);

  osc.connect(filt).connect(g).connect(out);
  osc.start(now); osc.stop(stopAt);
}

export function enterHero() {
  // Warm pad — root + fifth, sustained.
  play((c, out) => {
    pad(c, out, { freq: 110, attack: 0.4, decay: 1.4, peak: 0.10 });
    pad(c, out, { freq: 165, attack: 0.5, decay: 1.4, peak: 0.08, wave: 'sine' });
  });
}

export function enterApproach() {
  // Analytical — sustained pad opens its filter over ~1 s. Reads
  // as SENTINEL focusing / narrowing attention. No arpeggio.
  play((c, out) => {
    pad(c, out, {
      freq: 165, attack: 0.15, decay: 1.1, peak: 0.14,
      filterStart: 300, filterEnd: 1400, filterQ: 2,
    });
    pad(c, out, {
      freq: 220, attack: 0.25, decay: 1.0, peak: 0.09,
      filterStart: 400, filterEnd: 1600, filterQ: 1.4,
    });
  });
}

export function enterJourney() {
  // Subtle spin-up cue — a short soft swell that hands off to the
  // sustained `droneJourney` (which plays for the whole section).
  // Very brief and quiet so it doesn't dominate the entry.
  play((c, out) => {
    const now = c.currentTime;
    const dur = 0.9;
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(147, now);
    osc.frequency.linearRampToValueAtTime(220, now + dur);
    const filt = c.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 600; filt.Q.value = 1.2;
    const g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.12, now + 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(filt).connect(g).connect(out);
    osc.start(now); osc.stop(now + dur + 0.05);
  });
}

export function enterWork() {
  // Scanning drift — one sustained tone with slow filter sweep.
  // No servo click, no confirmation tick. Just SENTINEL settling
  // into "index" mode.
  play((c, out) => {
    pad(c, out, {
      freq: 147, attack: 0.2, decay: 1.0, peak: 0.15,
      filterStart: 500, filterEnd: 1100, filterQ: 2.2,
    });
    pad(c, out, {
      freq: 220, attack: 0.28, decay: 0.9, peak: 0.08,
      filterStart: 700, filterEnd: 1400, filterQ: 1.4,
    });
  });
}

export function enterSkills() {
  // Dense sustained texture — five close-tuned sines forming a
  // shimmering cluster. Reads as "SENTINEL parsing" through a
  // wall of soft harmonics, not a cascade of clicks.
  play((c, out) => {
    const roots = [220, 233.08, 247, 261.63, 277.18]; // A3-C#4 cluster
    const now = c.currentTime;
    roots.forEach((freq) => {
      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const filt = c.createBiquadFilter();
      filt.type = 'lowpass'; filt.frequency.value = 1400; filt.Q.value = 0.8;
      const g = c.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.06, now + 0.2);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
      osc.connect(filt).connect(g).connect(out);
      osc.start(now); osc.stop(now + 1.2);
    });
  });
}

export function enterRecognition() {
  // Metal bell — single deep sustained struck tone with LONG
  // decay. No snap, no broadband transient. The reverb send does
  // the rest.
  play((c, out) => {
    const now = c.currentTime;
    // Fundamental
    const oscA = c.createOscillator();
    oscA.type = 'triangle';
    oscA.frequency.value = 165; // E3
    // Inharmonic partial for metallic colour (no FM, just added tone)
    const oscB = c.createOscillator();
    oscB.type = 'sine';
    oscB.frequency.value = 165 * 2.76; // ~455 Hz — inharmonic
    const g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.16, now + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 1.6);
    const gB = c.createGain();
    gB.gain.setValueAtTime(0, now);
    gB.gain.linearRampToValueAtTime(0.06, now + 0.05);
    gB.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
    const filt = c.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 2000; filt.Q.value = 0.7;
    oscA.connect(g);
    oscB.connect(gB);
    g.connect(filt); gB.connect(filt);
    filt.connect(out);
    oscA.start(now); oscB.start(now);
    oscA.stop(now + 1.7); oscB.stop(now + 1.3);
  });
}

export function enterVision() {
  // Bloom chord — three notes SIMULTANEOUSLY (not staggered) with
  // slow attack + long decay. Reads as pure expansion.
  play((c, out) => {
    const notes = [220, 330, 440]; // A3 + E4 + A4
    notes.forEach((freq) => {
      pad(c, out, {
        freq, wave: 'triangle',
        attack: 0.2, decay: 1.4, peak: 0.11,
        filterStart: 1200, filterEnd: 1600, filterQ: 0.7,
      });
    });
  });
}

export function enterContact() {
  // Descending settle — one sustained tone that glides down and
  // fades. "SENTINEL entering await mode."
  play((c, out) => {
    const now = c.currentTime;
    const dur = 1.1;
    const osc = c.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(440, now);
    osc.frequency.exponentialRampToValueAtTime(220, now + dur);
    const filt = c.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 1200; filt.Q.value = 0.8;
    const g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.14, now + 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(filt).connect(g).connect(out);
    osc.start(now); osc.stop(now + dur + 0.05);
  });
}

// Dispatcher — main.js calls this on section change instead of
// generic whoosh. Falls back to whoosh for unknown indices.
const SECTION_ENTER = [
  enterHero, enterApproach, enterJourney, enterWork,
  enterSkills, enterRecognition, enterVision, enterContact,
];
export function enterSection(idx) {
  const fn = SECTION_ENTER[idx | 0];
  if (fn) fn(); else whoosh();
}

// -------------------------------------------------------------
// Section drones — a subtle sustained layer per section that plays
// the entire time SENTINEL is in that mode. Fades in over 2 s on
// section enter, out over 1.5 s on leave. All very quiet (peak
// gain ≤ 0.05) so they read as atmosphere, not events.
//
// Each drone is a single running audio graph the module owns
// (`currentDrone.stop()` fades + tears it down). Only one drone
// active at a time; changing sections cross-fades cleanly.
// -------------------------------------------------------------

let currentDrone = null;

function makeDrone(builder) {
  return (c, dest) => {
    const g = c.createGain();
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(1, c.currentTime + 2.0);
    const nodes = builder(c, g);
    g.connect(dest);

    let stopped = false;
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        const n = c.currentTime;
        g.gain.cancelScheduledValues(n);
        g.gain.setValueAtTime(g.gain.value, n);
        g.gain.linearRampToValueAtTime(0, n + 1.5);
        setTimeout(() => {
          nodes.forEach((node) => { try { node.stop && node.stop(); } catch (_e) {} });
        }, 1700);
      },
    };
  };
}

// Approach — soft analyzing pad. Two low sustained tones (A2 + E3)
// with slight filter movement. Reads as "SENTINEL focusing."
const droneApproach = makeDrone((c, g) => {
  const osc1 = c.createOscillator();
  const osc2 = c.createOscillator();
  osc1.type = 'sine'; osc2.type = 'sine';
  osc1.frequency.value = 110; // A2
  osc2.frequency.value = 164.81; // E3
  const filt = c.createBiquadFilter();
  filt.type = 'lowpass'; filt.frequency.value = 500; filt.Q.value = 1.2;
  const lfo = c.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 1 / 30;
  const lfoDepth = c.createGain(); lfoDepth.gain.value = 180;
  lfo.connect(lfoDepth).connect(filt.frequency);
  const level = c.createGain(); level.gain.value = 0.045;
  osc1.connect(filt); osc2.connect(filt);
  filt.connect(level).connect(g);
  const now = c.currentTime;
  osc1.start(now); osc2.start(now); lfo.start(now);
  return [osc1, osc2, lfo];
});

// Journey — quiet section presence. Just a low sustained tone with
// slow filter drift, matching the other section drones. The
// spinning "wuh-wuh" now fires only while the user hovers a
// timeline item (see `startSpin` below), so this drone is just
// atmosphere for the section, not the spin itself.
const droneJourney = makeDrone((c, g) => {
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 110; // A2
  const filt = c.createBiquadFilter();
  filt.type = 'lowpass'; filt.frequency.value = 520; filt.Q.value = 1.2;
  const lfo = c.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 1 / 26;
  const lfoDepth = c.createGain(); lfoDepth.gain.value = 200;
  lfo.connect(lfoDepth).connect(filt.frequency);
  const level = c.createGain(); level.gain.value = 0.035;
  osc.connect(filt).connect(level).connect(g);
  const now = c.currentTime;
  osc.start(now); lfo.start(now);
  return [osc, lfo];
});

// Work — steady scanning drone. Low sustained tone with a slow
// filter open/close. "SENTINEL indexing."
const droneWork = makeDrone((c, g) => {
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 147; // D3
  const filt = c.createBiquadFilter();
  filt.type = 'lowpass'; filt.frequency.value = 600; filt.Q.value = 1;
  const lfo = c.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 1 / 24;
  const lfoDepth = c.createGain(); lfoDepth.gain.value = 240;
  lfo.connect(lfoDepth).connect(filt.frequency);
  const level = c.createGain(); level.gain.value = 0.04;
  osc.connect(filt).connect(level).connect(g);
  const now = c.currentTime;
  osc.start(now); lfo.start(now);
  return [osc, lfo];
});

// Skills — low sustained presence. The previous version used a
// beating 660 Hz dyad which sat in the "annoying" band. Now: a
// single low sine (A2 = 110 Hz) with very slow filter drift, plus
// a distant highpass whisper. Reads as parsing atmosphere without
// having a pitch centre to fight with the ambient bed. Item-level
// "click" sounds fire per element during the fan sweep (see the
// interactions.js skill raycast handler).
const droneSkills = makeDrone((c, g) => {
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 110;
  const filt = c.createBiquadFilter();
  filt.type = 'lowpass'; filt.frequency.value = 500; filt.Q.value = 1;
  const lfo = c.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 1 / 22;
  const lfoDepth = c.createGain(); lfoDepth.gain.value = 200;
  lfo.connect(lfoDepth).connect(filt.frequency);
  const level = c.createGain(); level.gain.value = 0.035;
  osc.connect(filt).connect(level).connect(g);

  // Distant whisper — very quiet highpass noise for the "data
  // flowing" texture. Not pitched.
  const buf = c.createBuffer(1, c.sampleRate * 4, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.3;
  const noise = c.createBufferSource();
  noise.buffer = buf; noise.loop = true;
  const nFilt = c.createBiquadFilter();
  nFilt.type = 'highpass'; nFilt.frequency.value = 3200; nFilt.Q.value = 0.7;
  const nLevel = c.createGain(); nLevel.gain.value = 0.014;
  noise.connect(nFilt).connect(nLevel).connect(g);

  const now = c.currentTime;
  osc.start(now); lfo.start(now); noise.start(now);
  return [osc, lfo, noise];
});

// Recognition — verify tone. Sustained metallic note (E3 + inharmonic
// partial). Reads as "SENTINEL evaluating."
const droneRecognition = makeDrone((c, g) => {
  const osc = c.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = 165; // E3
  const oscP = c.createOscillator();
  oscP.type = 'sine';
  oscP.frequency.value = 165 * 2.76; // ~455 Hz (inharmonic for metal colour)
  const filt = c.createBiquadFilter();
  filt.type = 'lowpass'; filt.frequency.value = 1400; filt.Q.value = 0.7;
  const level = c.createGain(); level.gain.value = 0.04;
  const pLevel = c.createGain(); pLevel.gain.value = 0.015;
  osc.connect(filt);
  oscP.connect(pLevel).connect(filt);
  filt.connect(level).connect(g);
  const now = c.currentTime;
  osc.start(now); oscP.start(now);
  return [osc, oscP];
});

// Vision — expansive void. The previous version had a full triad
// playing constantly which read as an intrusive chord looping.
// Now: a single very low sustained sub tone + a slow noise wash
// (like distant wind on a wide plain). No pitched chord to fight
// with the ambient bed's Am9. Reads as SENTINEL broadcasting into
// wide open space.
const droneVision = makeDrone((c, g) => {
  // Sub grounding tone — A1, barely audible.
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 55; // A1
  const oLevel = c.createGain(); oLevel.gain.value = 0.03;
  osc.connect(oLevel).connect(g);

  // Wide airy noise wash — bandpass around 2 kHz with a very slow
  // filter LFO. Reads as open space.
  const buf = c.createBuffer(1, c.sampleRate * 6, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.4;
  const noise = c.createBufferSource();
  noise.buffer = buf; noise.loop = true;
  const nFilt = c.createBiquadFilter();
  nFilt.type = 'bandpass'; nFilt.frequency.value = 2000; nFilt.Q.value = 1;
  const nLfo = c.createOscillator();
  nLfo.type = 'sine';
  nLfo.frequency.value = 1 / 25;
  const nLfoDepth = c.createGain(); nLfoDepth.gain.value = 800;
  nLfo.connect(nLfoDepth).connect(nFilt.frequency);
  const nLevel = c.createGain(); nLevel.gain.value = 0.022;
  noise.connect(nFilt).connect(nLevel).connect(g);

  const now = c.currentTime;
  osc.start(now); nLfo.start(now); noise.start(now);
  return [osc, nLfo, noise];
});

// Contact — sci-fi listening bed. Low sustained sine sitting
// under a slow high-shimmer noise wash + occasional soft "search
// ping" chirps that fire at random long intervals. Reads as
// SENTINEL scanning the void for signals. Peak gain kept tiny so
// it stays atmospheric.
const droneContact = makeDrone((c, g) => {
  // Sub tone (A2) — grounding.
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 110;
  const oFilt = c.createBiquadFilter();
  oFilt.type = 'lowpass'; oFilt.frequency.value = 500; oFilt.Q.value = 1;
  const oLevel = c.createGain(); oLevel.gain.value = 0.028;
  osc.connect(oFilt).connect(oLevel).connect(g);

  // Slow shimmer wash — highpass filtered noise, slow amp LFO.
  const nBuf = c.createBuffer(1, c.sampleRate * 4, c.sampleRate);
  const nd = nBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * 0.3;
  const noise = c.createBufferSource();
  noise.buffer = nBuf; noise.loop = true;
  const nFilt = c.createBiquadFilter();
  nFilt.type = 'bandpass'; nFilt.frequency.value = 2200; nFilt.Q.value = 1.5;
  const nLfo = c.createOscillator();
  nLfo.type = 'sine';
  nLfo.frequency.value = 1 / 18;
  const nLfoDepth = c.createGain(); nLfoDepth.gain.value = 900;
  nLfo.connect(nLfoDepth).connect(nFilt.frequency);
  const nLevel = c.createGain(); nLevel.gain.value = 0.02;
  noise.connect(nFilt).connect(nLevel).connect(g);

  // Sparse "search pings" — one short soft high tone every
  // 6-14 s at a random frequency in the E5/A5 region. Reads as
  // SENTINEL periodically sampling the channel. Timer clears
  // itself when the drone is stopped (via nodes cleanup below).
  let stopped = false;
  const pingFreqs = [660, 784, 880, 988, 1046];
  function schedulePing() {
    if (stopped) return;
    const delayMs = 6000 + Math.random() * 8000;
    setTimeout(() => {
      if (stopped) return;
      const t = c.currentTime;
      const freq = pingFreqs[Math.floor(Math.random() * pingFreqs.length)];
      const p = c.createOscillator();
      p.type = 'sine';
      p.frequency.value = freq;
      const pF = c.createBiquadFilter();
      pF.type = 'lowpass'; pF.frequency.value = 2400; pF.Q.value = 0.7;
      const pG = c.createGain();
      pG.gain.setValueAtTime(0, t);
      pG.gain.linearRampToValueAtTime(0.05, t + 0.04);
      pG.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      p.connect(pF).connect(pG).connect(g);
      p.start(t); p.stop(t + 1.0);
      schedulePing();
    }, delayMs);
  }
  schedulePing();

  // Wrap noise into a fake "stoppable" node so the drone teardown
  // cleans up the ping scheduler too.
  const pseudo = { stop() { stopped = true; } };

  const now = c.currentTime;
  osc.start(now); nLfo.start(now); noise.start(now);
  return [osc, nLfo, noise, pseudo];
});

const SECTION_DRONES = [
  null,             // 0 Hero — the ambient bed is enough
  droneApproach,    // 1
  droneJourney,     // 2
  droneWork,        // 3
  droneSkills,      // 4
  droneRecognition, // 5
  droneVision,      // 6
  droneContact,     // 7
];

/** Swap the currently playing section drone. Called from main.js
 *  on section change. Cross-fades cleanly. */
export function setSectionDrone(idx) {
  if (currentDrone) {
    currentDrone.stop();
    currentDrone = null;
  }
  if (!enabled) return;
  const builder = SECTION_DRONES[idx | 0];
  if (!builder) return;
  const c = ensureCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume();
  // Drones go straight to the SFX bus (no reverb, they'd smear).
  currentDrone = builder(c, sfxBus);
}

// -------------------------------------------------------------
// Section-specific SFX
// -------------------------------------------------------------

// Trophy hold pulse — soft breath tone, no pitch stepping. Reads
// as "SENTINEL analysing" through gentle continuous presence.
export function analyze() {
  play((c, out) => {
    const now = c.currentTime;
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 260; // sits under the chime range
    const filt = c.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 700;
    filt.Q.value = 1.2;
    const g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.08, now + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
    osc.connect(filt).connect(g).connect(out);
    osc.start(now); osc.stop(now + 0.28);
  });
}

// Skills scan-fan / parsing — subtle warm sweep that hands off to
// the sustained `droneSkills`. Just a soft filter open + close on
// a single low sine. Reads as SENTINEL glancing across the group,
// not a laser scan.
let lastLaserAt = 0;
export function laser() {
  const nowT = performance.now();
  if (nowT - lastLaserAt < 300) return;
  lastLaserAt = nowT;
  play((c, out) => {
    const now = c.currentTime;
    const dur = 1.0;
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 220;
    const filt = c.createBiquadFilter();
    filt.type = 'lowpass'; filt.Q.value = 2;
    filt.frequency.setValueAtTime(500, now);
    filt.frequency.exponentialRampToValueAtTime(1400, now + dur * 0.5);
    filt.frequency.exponentialRampToValueAtTime(700, now + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.10, now + 0.15);
    g.gain.linearRampToValueAtTime(0.06, now + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(filt).connect(g).connect(out);
    osc.start(now); osc.stop(now + dur + 0.05);
  });
}

// "Click into place" — per-item cue as each skill item snaps into
// the scan. Very short, very quiet, slightly pitch-varied per
// call so a cascade doesn't sound like a machine gun. Reads as
// individual data points registering.
let clickIntoPlaceCount = 0;
export function clickIntoPlace() {
  play((c, out) => {
    const now = c.currentTime;
    // Two-note stack — one sub thump, one high accent, both super
    // short. Pitch varies per call by ±60 cents so the cascade
    // feels natural.
    const cents = ((clickIntoPlaceCount++ % 6) - 3) * 20;
    const detune = Math.pow(2, cents / 1200);

    const sub = c.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 260 * detune;
    const subG = c.createGain();
    subG.gain.setValueAtTime(0, now);
    subG.gain.linearRampToValueAtTime(0.14, now + 0.004);
    subG.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
    sub.connect(subG).connect(out);
    sub.start(now); sub.stop(now + 0.09);

    const hi = c.createOscillator();
    hi.type = 'sine';
    hi.frequency.value = 2400 * detune;
    const hiG = c.createGain();
    hiG.gain.setValueAtTime(0, now);
    hiG.gain.linearRampToValueAtTime(0.05, now + 0.002);
    hiG.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    hi.connect(hiG).connect(out);
    hi.start(now); hi.stop(now + 0.06);
  });
}

// Vision map — soft single-note ping when an item is mapped. The
// previous triad + stacking (5 items in a row) was overwhelming.
// One quiet high note per hit, rate-limited more aggressively.
let lastBroadcastAt = 0;
export function broadcast() {
  const nowT = performance.now();
  if (nowT - lastBroadcastAt < 500) return;
  lastBroadcastAt = nowT;
  play((c, out) => {
    const now = c.currentTime;
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 880; // A5 — bright but not sharp
    const filt = c.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 2400; filt.Q.value = 0.7;
    const g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.05, now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
    osc.connect(filt).connect(g).connect(out);
    osc.start(now); osc.stop(now + 0.75);
  });
}

// Contact meta hover — subtle sustained hum. A3 sine through a
// lowpass with very slow filter movement (12 s cycle). Quieter and
// steadier than the previous "scanning wa-wa" — sits under the
// section drone as a gentle focus tone. Returns { stop } handle.
export function hum() {
  if (!enabled) return { stop: () => {} };
  const c = ensureCtx();
  if (!c) return { stop: () => {} };
  if (c.state === 'suspended') c.resume();
  const now = c.currentTime;

  const out = toSfxBus();
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 220; // A3

  const filt = c.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = 800;
  filt.Q.value = 1.5;

  // Slow LFO drifts the filter opening — 12 s cycle so it barely
  // moves during a typical hover. No pumping wa-wa.
  const lfo = c.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 1 / 12;
  const lfoDepth = c.createGain();
  lfoDepth.gain.value = 180;
  lfo.connect(lfoDepth).connect(filt.frequency);

  const g = c.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(0.06, now + 0.3);

  osc.connect(filt).connect(g).connect(out);
  osc.start(now); lfo.start(now);

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      const nowS = c.currentTime;
      g.gain.cancelScheduledValues(nowS);
      g.gain.setValueAtTime(g.gain.value, nowS);
      g.gain.linearRampToValueAtTime(0, nowS + 0.3);
      setTimeout(() => {
        try { osc.stop(); lfo.stop(); } catch (_e) {}
      }, 350);
    },
  };
}

// Spinning sound — hover-only. Sustained low tone with tremolo +
// vibrato at 4 Hz (steady, not accelerating) that reads as SENTINEL
// spinning while the user reads a timeline item. Returns { stop }
// handle for on-leave cleanup. Very subtle so it sits under the
// section drone without overwhelming it.
export function startSpin() {
  if (!enabled) return { stop: () => {} };
  const c = ensureCtx();
  if (!c) return { stop: () => {} };
  if (c.state === 'suspended') c.resume();
  const now = c.currentTime;
  const out = toSfxBus();

  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 220; // A3 — sits under speech range

  const filt = c.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = 700;
  filt.Q.value = 1.4;

  // Tremolo (the "wuh-wuh") — 4 Hz steady rotation. Depth is
  // subtractive so the base gain becomes the ceiling; the tremolo
  // dips beneath it periodically.
  const trem = c.createOscillator();
  trem.type = 'sine';
  trem.frequency.value = 4.0;
  const tremDepth = c.createGain(); tremDepth.gain.value = 0.05;
  trem.connect(tremDepth);

  // Vibrato at same rate for coherent wobble
  const vib = c.createOscillator();
  vib.type = 'sine';
  vib.frequency.value = 4.0;
  const vibDepth = c.createGain(); vibDepth.gain.value = 5;
  vib.connect(vibDepth).connect(osc.frequency);

  const g = c.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(0.09, now + 0.4); // 400 ms fade in
  tremDepth.connect(g.gain);

  osc.connect(filt).connect(g).connect(out);
  osc.start(now); trem.start(now); vib.start(now);

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      const nowS = c.currentTime;
      g.gain.cancelScheduledValues(nowS);
      g.gain.setValueAtTime(g.gain.value, nowS);
      g.gain.linearRampToValueAtTime(0, nowS + 0.5);
      setTimeout(() => {
        try { osc.stop(); trem.stop(); vib.stop(); } catch (_e) {}
      }, 550);
    },
  };
}

// Journey timeline — soft low-register breath, no chirp. Distinct
// from blip by being lower and slightly longer.
export function journey() {
  play((c, out) => {
    const now = c.currentTime;
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 165; // E3
    const filt = c.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 650; filt.Q.value = 1.2;
    const g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.11, now + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    osc.connect(filt).connect(g).connect(out);
    osc.start(now); osc.stop(now + 0.3);
  });
}

// Recognition trophy hover — warm sustained glow. No transient.
export function verify() {
  play((c, out) => {
    const now = c.currentTime;
    const osc = c.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 330; // E4
    const filt = c.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 900; filt.Q.value = 1;
    const g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.09, now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.36);
    osc.connect(filt).connect(g).connect(out);
    osc.start(now); osc.stop(now + 0.4);
  });
}

// -------------------------------------------------------------
// Ambient — Hans Zimmer-style scifi atmosphere (v4).
//
// Design brief: think Interstellar / Dune / Blade Runner 2049 —
// sustained harmonic layers, deep sub, high shimmer, huge reverb,
// no percussion, no bells, no plinks. Movement comes from slow
// LFOs on filters + individual voice amplitudes, not from active
// note events. Chord stays on Am9 (A minor 9) throughout; the
// perceived movement is entirely textural.
//
// Layers:
//   (1) Sub bass drone at 55 Hz (A1). 15-second amp LFO — feels
//       like the room breathing.
//   (2) Chord pad — 5 detuned sawtooth voices spelling Am9
//       (A2 C3 E3 G3 B3) through a shared lowpass with 28-second
//       filter LFO. Each voice has its own slow amp LFO at a
//       different rate so their relative levels drift — creates
//       constant motion inside a static chord.
//   (3) High shimmer — highpass-filtered noise at ~4 kHz with a
//       35-second amp LFO. Very quiet. Adds "void sparkle."
//   (4) Choir-like formant — filtered noise passing through two
//       resonant bandpass filters tuned to vowel-ish formants.
//       Fades in slowly and drifts.
//
// Master music bus stays at 0.022 for balance with SFX (0.14).
// -------------------------------------------------------------
function startAmbient() {
  if (ambientHandles) return;
  const c = ensureCtx();
  if (!c || !musicBus) return;

  const now = c.currentTime;
  const fadeIn = 8; // long lift-in so unmute isn't jarring

  // -------- (1) Sub bass drone --------
  // Slowed LFO cycle 15 s → 40 s so the breath is imperceptible
  // rather than "waves."
  const sub = c.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = 55; // A1

  const subLfo = c.createOscillator();
  subLfo.type = 'sine';
  subLfo.frequency.value = 1 / 40;
  const subLfoGain = c.createGain();
  subLfoGain.gain.value = 0.28;
  subLfo.connect(subLfoGain);

  const subGain = c.createGain();
  subGain.gain.setValueAtTime(0, now);
  subGain.gain.linearRampToValueAtTime(0.5, now + fadeIn);
  subLfoGain.connect(subGain.gain);
  sub.connect(subGain).connect(musicBus);

  // -------- (2) Am9 chord pad --------
  // Frequencies for A2 C3 E3 G3 B3 — the 1 b3 5 b7 9 of Am.
  const chordFreqs = [110.0, 130.81, 164.81, 196.0, 246.94];
  // Very tiny detune per voice — was ±3 cents which produced 5-8 s
  // beat cycles; now ±1 cent gives 15-30 s beats. Barely perceptible
  // movement rather than "waves."
  const detunes    = [ +1, -1, +1, -1, +1 ]; // cents

  // Filter LFO cycle 28 s → 70 s. The single slowest movement in
  // the whole bed. Reads as one continuous slow inhale/exhale.
  const chordFilt = c.createBiquadFilter();
  chordFilt.type = 'lowpass';
  chordFilt.Q.value = 4;
  const chordFiltLfo = c.createOscillator();
  chordFiltLfo.type = 'sine';
  chordFiltLfo.frequency.value = 1 / 70;
  const chordFiltLfoGain = c.createGain();
  chordFiltLfoGain.gain.value = 480;
  chordFiltLfo.connect(chordFiltLfoGain).connect(chordFilt.frequency);
  chordFilt.frequency.value = 700;

  const chordBus = c.createGain();
  chordBus.gain.setValueAtTime(0, now);
  chordBus.gain.linearRampToValueAtTime(0.45, now + fadeIn);
  chordFilt.connect(chordBus).connect(musicBus);

  const voices = chordFreqs.map((freq, i) => {
    const oscA = c.createOscillator();
    const oscB = c.createOscillator();
    oscA.type = 'sawtooth';
    oscB.type = 'sawtooth';
    oscA.frequency.value = freq;
    oscB.frequency.value = freq;
    oscA.detune.value =  detunes[i];
    oscB.detune.value = -detunes[i] * 1.3;

    const voiceGain = c.createGain();
    // Individual voice LFO rates 18-34 s → 45-85 s. Voices phase in
    // and out against each other so slowly you almost don't notice.
    const vLfo = c.createOscillator();
    vLfo.type = 'sine';
    vLfo.frequency.value = 1 / (45 + i * 10);
    const vLfoGain = c.createGain();
    vLfoGain.gain.value = 0.15;
    vLfo.connect(vLfoGain);

    voiceGain.gain.setValueAtTime(0, now);
    voiceGain.gain.linearRampToValueAtTime(0.55, now + fadeIn);
    vLfoGain.connect(voiceGain.gain);

    oscA.connect(voiceGain);
    oscB.connect(voiceGain);
    voiceGain.connect(chordFilt);

    return { oscA, oscB, voiceGain, vLfo };
  });

  // -------- (3) High shimmer --------
  const shimBuf = c.createBuffer(1, c.sampleRate * 6, c.sampleRate);
  const sd = shimBuf.getChannelData(0);
  for (let i = 0; i < sd.length; i++) sd[i] = (Math.random() * 2 - 1) * 0.4;
  const shim = c.createBufferSource();
  shim.buffer = shimBuf;
  shim.loop = true;

  const shimFilt = c.createBiquadFilter();
  shimFilt.type = 'highpass';
  shimFilt.frequency.value = 3800;
  shimFilt.Q.value = 1;

  const shimLfo = c.createOscillator();
  shimLfo.type = 'sine';
  shimLfo.frequency.value = 1 / 80; // was 35 s
  const shimLfoGain = c.createGain();
  shimLfoGain.gain.value = 0.06;
  shimLfo.connect(shimLfoGain);

  const shimGain = c.createGain();
  shimGain.gain.setValueAtTime(0, now);
  shimGain.gain.linearRampToValueAtTime(0.08, now + fadeIn);
  shimLfoGain.connect(shimGain.gain);
  shim.connect(shimFilt).connect(shimGain).connect(musicBus);

  // -------- (4) Choir-like formant --------
  const chorBuf = c.createBuffer(1, c.sampleRate * 6, c.sampleRate);
  const cd = chorBuf.getChannelData(0);
  let x = 0;
  for (let i = 0; i < cd.length; i++) {
    x = (x + (Math.random() * 2 - 1) * 0.1) * 0.98;
    cd[i] = x;
  }
  const chor = c.createBufferSource();
  chor.buffer = chorBuf;
  chor.loop = true;

  // Two bandpass filters in series — an "ah" formant (F1 ~700 Hz,
  // F2 ~1100 Hz). Gives the noise a vocal-ish colour.
  const chorF1 = c.createBiquadFilter();
  chorF1.type = 'bandpass'; chorF1.Q.value = 8; chorF1.frequency.value = 720;
  const chorF2 = c.createBiquadFilter();
  chorF2.type = 'bandpass'; chorF2.Q.value = 8; chorF2.frequency.value = 1100;

  // Very slow LFO drifts the formants slightly — reads as vowel
  // shift from "ah" to "oh" and back. 42 s → 100 s cycle.
  const chorLfo = c.createOscillator();
  chorLfo.type = 'sine';
  chorLfo.frequency.value = 1 / 100;
  const chorLfoGain = c.createGain();
  chorLfoGain.gain.value = 140;
  chorLfo.connect(chorLfoGain).connect(chorF1.frequency);
  const chorLfoGain2 = c.createGain();
  chorLfoGain2.gain.value = 220;
  chorLfo.connect(chorLfoGain2).connect(chorF2.frequency);

  const chorGain = c.createGain();
  chorGain.gain.setValueAtTime(0, now);
  chorGain.gain.linearRampToValueAtTime(0.18, now + fadeIn);
  chor.connect(chorF1).connect(chorF2).connect(chorGain).connect(musicBus);

  // -------- start everything --------
  sub.start(now); subLfo.start(now);
  chordFiltLfo.start(now);
  voices.forEach(v => { v.oscA.start(now); v.oscB.start(now); v.vLfo.start(now); });
  shim.start(now); shimLfo.start(now);
  chor.start(now); chorLfo.start(now);

  ambientHandles = {
    sub, subLfo, subGain,
    chordFiltLfo, chordBus, voices,
    shim, shimLfo, shimGain,
    chor, chorLfo, chorGain,
  };
}

function stopAmbient() {
  if (!ambientHandles || !ctx) return;
  const now = ctx.currentTime;
  const {
    sub, subLfo, subGain,
    chordFiltLfo, chordBus, voices,
    shim, shimLfo, shimGain,
    chor, chorLfo, chorGain,
  } = ambientHandles;

  const fadeOut = 0.6;
  [subGain, chordBus, shimGain, chorGain].forEach(g => {
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(0, now + fadeOut);
  });

  setTimeout(() => {
    try {
      sub.stop(); subLfo.stop();
      chordFiltLfo.stop();
      voices.forEach(v => { v.oscA.stop(); v.oscB.stop(); v.vLfo.stop(); });
      shim.stop(); shimLfo.stop();
      chor.stop(); chorLfo.stop();
    } catch (_e) {}
    ambientHandles = null;
  }, (fadeOut + 0.1) * 1000);
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
    // Also stop any section drone playing when the user mutes.
    if (currentDrone) { currentDrone.stop(); currentDrone = null; }
  }
}

export function toggle() {
  setEnabled(!enabled);
  return enabled;
}

export function isEnabled() {
  return enabled;
}
