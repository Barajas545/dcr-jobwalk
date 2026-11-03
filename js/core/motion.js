// motion.js — counting steps and telling walking from standing still, from the
// phone's accelerometer.
//
// Between GPS fixes (one a second at best, and worse under a roof) the position
// moves forward by one step length along the walking direction for every step
// detected here. Just as important, "standing still" lets the position engine
// stop the dot from drifting while the estimator stands and shoots.
//
// How (docs/RESEARCH.md, "PDR step length"):
//  - The magnitude of accelerationIncludingGravity, so it works whichever way
//    the phone is held and whatever sign convention the browser uses (iOS and
//    Android disagree on the sign of z).
//  - Low-pass at ~3 Hz, then a peak above the resting level followed by a dip
//    below it is one step, if it comes 0.3–2 s after the previous one. A first
//    step after a pause is held until a second one confirms it, so a single
//    bump (setting the phone down) is never counted, but a walk loses no step.
//  - Time between samples comes from event.timeStamp, not event.interval (its
//    unit is not reliable on iOS).
//  - Step length: settings.stepLength is the person's typical step. With the
//    Weinberg option each step is scaled by (bounce / typical bounce)^¼, so
//    longer, bouncier steps count a little longer; the typical bounce is learned
//    as the person walks, so the average step stays settings.stepLength.
//
// The detector is a pure function on a state object (processSample), tested in
// Node with synthetic walks; createMotionSource() wires it to 'devicemotion'.

import { Emitter } from './bus.js';
import { eventTime } from './orientation.js';

export const G = 9.80665;

/** Detector tuning. Thresholds are engineering heuristics (docs/RESEARCH.md); tune on a real walk. */
export const STEP_DEFAULTS = Object.freeze({
  cutoffHz: 3,            // low-pass on |a|
  peakAbove: 1.2,         // m/s² above the resting level to start a step
  valleyBelow: 0.8,       // m/s² below it to finish one
  minIntervalMs: 300,     // faster than this is a jiggle, not walking
  maxIntervalMs: 2000,    // slower than this is not one walk
  maxAmplitude: 30,       // a bigger swing is a knock or a drop
  baselineTauS: 2.0,      // how quickly the resting level follows the sensor (bias, tilt)
  varianceTauS: 0.5,      // window of the "is it moving" variance
  stillStd: 0.35,         // m/s² — below this (and no steps) the person stands still
  stillMs: 2000,          // no step for this long → not walking
  gapResetMs: 500,        // a pause in the samples (page hidden) restarts the filters
  weinberg: true,         // scale step length by bounce (normalised to stepLength)
  stepLength: 0.72,       // m, settings.stepLength — set state.stepLength to change it live
});

/** A fresh detector state. `opts` overrides STEP_DEFAULTS. */
export function createStepState(opts = {}) {
  const o = { ...STEP_DEFAULTS, ...opts };
  return {
    opts: o,
    stepLength: o.stepLength,
    lastT: null,
    startT: null,                // when the filters last (re)started: a second of warm-up before judging
    lp: null,
    base: G,
    variance: 0,
    phase: 'wait',
    peak: -Infinity,
    valley: Infinity,
    phaseT: 0,
    lastCandidateT: -Infinity,   // the last peak-and-dip, counted or not (sets the spacing)
    lastStepT: -Infinity,        // the last COUNTED step
    pending: null,               // a first step waiting for a second one to confirm the walk
    chain: 'none',               // 'none' | 'pending' | 'walking' — steps only count inside a run of evenly spaced ones
    refLogAmp: null,             // learned typical bounce (log), for Weinberg
    motion: 'unknown',           // 'walking' | 'stationary' | 'moving' | 'unknown'
    steps: 0,
  };
}

/** The length of a step with this bounce, normalised so the person's average is state.stepLength. */
export function stepLengthFor(state, amplitude) {
  const base = state.stepLength > 0 ? state.stepLength : STEP_DEFAULTS.stepLength;
  if (!state.opts.weinberg || !(amplitude > 0)) return base;
  const la = Math.log(amplitude);
  if (state.refLogAmp == null) state.refLogAmp = la;
  else state.refLogAmp += 0.05 * (la - state.refLogAmp); // geometric mean over ~20 steps
  const f = Math.exp(0.25 * (la - state.refLogAmp));     // Weinberg: L ∝ (Amax − Amin)^¼
  return base * Math.min(1.25, Math.max(0.8, f));
}

function classify(st, t) {
  if (st.startT == null || t - st.startT < st.opts.varianceTauS * 1000) return t - st.lastStepT < st.opts.stillMs ? 'walking' : 'unknown';
  if (t - st.lastStepT < st.opts.stillMs) return 'walking';
  return Math.sqrt(Math.max(0, st.variance)) < st.opts.stillStd ? 'stationary' : 'moving';
}

/**
 * Feed one accelerometer sample {t (ms), x, y, z} (accelerationIncludingGravity,
 * m/s²) or {t, mag}. Returns {steps: [{t, length, amplitude, interval}],
 * motion: 'walking'|'stationary'|'moving'|'unknown', changed}. `steps` is
 * usually empty, sometimes one step, and two when a held first step is confirmed.
 */
export function processSample(st, sample) {
  const out = { steps: [], motion: st.motion, changed: false };
  const o = st.opts;
  const t = sample?.t;
  const m = sample?.mag != null ? sample.mag
    : (sample?.x == null || sample?.y == null || sample?.z == null) ? NaN : Math.hypot(sample.x, sample.y, sample.z);
  if (!isFinite(m) || !isFinite(t)) return out;

  if (st.lastT == null || t - st.lastT > o.gapResetMs || t < st.lastT - 1000) {
    // First sample, or the samples stopped for a while: start the filters over.
    st.lastT = t;
    st.startT = t;
    st.lp = m;
    st.base = Math.abs(m - G) < 2 ? m : G;
    st.variance = 0;
    st.phase = 'wait';
    st.peak = -Infinity;
    st.valley = Infinity;
    st.pending = null;
    st.chain = 'none';
    return out;
  }
  const dtMs = t - st.lastT;
  if (dtMs <= 0) return out; // a repeated timestamp
  st.lastT = t;
  const dt = Math.min(0.2, dtMs / 1000);

  // ~3 Hz one-pole low-pass (alpha ≈ 0.24 at 60 Hz).
  const rc = 1 / (2 * Math.PI * o.cutoffHz);
  st.lp += (dt / (rc + dt)) * (m - st.lp);
  // The resting level (gravity as this sensor reads it) and how much |a| moves around it.
  st.base += (1 - Math.exp(-dt / o.baselineTauS)) * (st.lp - st.base);
  const dev = m - st.base;
  st.variance += (1 - Math.exp(-dt / o.varianceTauS)) * (dev * dev - st.variance);

  const hi = st.base + o.peakAbove;
  const lo = st.base - o.valleyBelow;
  if (st.phase !== 'wait' && t - st.phaseT > o.maxIntervalMs) {
    st.phase = 'wait'; // stuck half-way through a "step": forget it
    st.peak = -Infinity;
    st.valley = Infinity;
  }
  if (st.phase === 'wait') {
    if (st.lp > hi) { st.phase = 'peak'; st.peak = st.lp; st.phaseT = t; }
  } else if (st.phase === 'peak') {
    if (st.lp > st.peak) st.peak = st.lp;
    if (st.lp < st.base) { st.phase = 'valley'; st.valley = st.lp; }
  } else if (st.phase === 'valley') {
    if (st.lp < st.valley) st.valley = st.lp;
    if (st.lp > st.base) {
      if (st.valley < lo) {
        const amplitude = st.peak - st.valley;
        const interval = t - st.lastCandidateT;
        if (amplitude <= o.maxAmplitude) {
          if (interval >= o.minIntervalMs && interval <= o.maxIntervalMs && st.chain !== 'none') {
            if (st.chain === 'pending' && st.pending) {
              const p = st.pending;
              out.steps.push({ t: p.t, amplitude: p.amplitude, interval: null, length: stepLengthFor(st, p.amplitude) });
            }
            st.pending = null;
            st.chain = 'walking';
            out.steps.push({ t, amplitude, interval, length: stepLengthFor(st, amplitude) });
          } else if (interval >= o.minIntervalMs) {
            // The first step of a walk (or after a jiggle), or a lone bump: hold it
            // until the next one shows it was walking.
            st.pending = { t, amplitude };
            st.chain = 'pending';
          } else {
            st.pending = null; // too quick: shaking the phone, not walking
            st.chain = 'none';
          }
        } else {
          st.pending = null;
          st.chain = 'none';
        }
        st.lastCandidateT = t;
      }
      st.phase = 'wait';
      st.peak = -Infinity;
      st.valley = Infinity;
    }
  }
  if (st.pending && t - st.pending.t > o.maxIntervalMs) { st.pending = null; st.chain = 'none'; } // a lone bump
  if (st.chain === 'walking' && t - st.lastCandidateT > o.maxIntervalMs) st.chain = 'none'; // the walk ended

  if (out.steps.length) {
    st.lastStepT = out.steps[out.steps.length - 1].t;
    st.steps += out.steps.length;
  }
  const motion = classify(st, t);
  if (motion !== st.motion) {
    st.motion = motion;
    out.changed = true;
  }
  out.motion = motion;
  return out;
}

// ---- the browser source -------------------------------------------------------------------

/**
 * Listens to 'devicemotion' and emits:
 *   'step'  {t, length, amplitude, interval}
 *   'state' {motion: 'walking'|'stationary'|'moving', t}   (on change)
 *   'status' 'off'|'ok'|'needs-permission'|'denied'|'unavailable'
 * getState(now) → the current motion, or 'unknown' when no sample came in
 * the last 2 s (page hidden, sensor stopped) — then nobody knows whether the
 * person walked.
 * getStepLength() is read for every step (settings can change any time).
 */
export function createMotionSource({ win = globalThis, now = () => Date.now(), timers = globalThis, getStepLength = () => STEP_DEFAULTS.stepLength, weinberg = true, watchdogMs = 4000 } = {}) {
  const src = new Emitter();
  let st = createStepState({ weinberg });
  let running = false;
  let status = 'off';
  let perm = 'unknown';
  let gotData = false;
  let lastSampleAt = -Infinity;
  let watchdog = null;
  let watchdogFired = false;
  let attached = false;

  function computeStatus() {
    if (!running) return 'off';
    if (perm === 'denied') return 'denied';
    if (gotData) return 'ok';
    if (perm === 'prompt') return 'needs-permission';
    if (perm === 'error' || watchdogFired) return 'unavailable';
    return 'off';
  }
  function refreshStatus() {
    const s = computeStatus();
    if (s !== status) { status = s; src.emit('status', s); }
  }

  function onMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    const t = eventTime(e, win, now);
    lastSampleAt = t;
    if (!gotData) {
      gotData = true;
      if (perm === 'prompt' || perm === 'unknown') perm = 'granted';
      refreshStatus();
    }
    const len = Number(getStepLength());
    if (len > 0.2 && len < 1.5) st.stepLength = len;
    const r = processSample(st, { t, x: a.x, y: a.y, z: a.z });
    for (const s of r.steps) src.emit('step', s);
    if (r.changed) src.emit('state', { motion: r.motion, t });
  }

  function attach() {
    if (attached || !win || typeof win.addEventListener !== 'function') return;
    win.addEventListener('devicemotion', onMotion);
    attached = true;
  }
  function detach() {
    if (attached && win && typeof win.removeEventListener === 'function') win.removeEventListener('devicemotion', onMotion);
    attached = false;
  }
  function armWatchdog() {
    if (watchdog) timers.clearTimeout(watchdog);
    watchdogFired = false;
    watchdog = timers.setTimeout(() => { watchdog = null; watchdogFired = true; refreshStatus(); }, watchdogMs);
  }

  function setPermission(state) {
    if (state === 'granted') {
      perm = 'granted';
      if (running) { detach(); attach(); armWatchdog(); }
    } else if (!gotData) {
      perm = state;
    }
    refreshStatus();
  }

  function probe() {
    const DME = win?.DeviceMotionEvent;
    if (!DME || typeof DME.requestPermission !== 'function') return;
    let p;
    try { p = DME.requestPermission(); } catch (err) { p = Promise.reject(err); }
    Promise.resolve(p).then(
      (s) => { if (running) setPermission(s === 'denied' ? 'denied' : s === 'prompt' ? 'prompt' : 'granted'); },
      (err) => { if (running) setPermission(err && err.name === 'NotAllowedError' ? 'prompt' : 'error'); },
    );
  }

  src.start = () => {
    if (running) return;
    running = true;
    gotData = false;
    st = createStepState({ weinberg });
    if (!win || typeof win.addEventListener !== 'function' || !win.DeviceMotionEvent) {
      perm = 'error';
      refreshStatus();
      return;
    }
    attach();
    armWatchdog();
    probe();
    refreshStatus();
  };

  src.stop = () => {
    if (!running) return;
    running = false;
    detach();
    if (watchdog) { timers.clearTimeout(watchdog); watchdog = null; }
    refreshStatus();
  };

  src.getStatus = () => status;
  src.getState = (t = now()) => (!running || t - lastSampleAt > 2000 ? 'unknown' : st.motion);
  src.getStepCount = () => st.steps;
  src.needsPermission = () => perm === 'prompt' && !gotData;
  src.setPermission = setPermission;
  src.isRunning = () => running;
  return src;
}
