// sim.js — demo mode: a pretend estimator walking a loop around the job site.
//
// So the whole app — the dot on the plan, the camera wedge, video paths,
// calibration, "I'm here" — can be shown and tested on a desktop, indoors,
// with no phone. Settings > Demo mode (settings.simulate) makes the position
// engine take its GPS, compass and steps from here instead of the sensors;
// poses then say source: 'sim'.
//
// It behaves like the real thing on purpose, so the engine's smoothing is
// exercised rather than flattered:
//  - GPS: one fix a second whose error drifts slowly (a few meters, changing
//    over about a minute — like real multipath) plus jitter, with worse
//    accuracy under the "roof" side of the loop and now and then for a while;
//  - compass: the walking direction with sway, noise and a slow magnetic wobble,
//    against MAGNETIC north (true north minus the place's WMM declination, as a
//    phone measures it); standing at a corner, the person looks around and
//    sometimes points the camera at the floor;
//  - steps at ~1.8 a second while walking, standing still at corners.
//
// Tests drive it with a fake clock (autoRun: false, then tick()) and a seed.

import { Emitter } from './bus.js';
import { fromEnu, normDeg, deltaDeg } from './geo.js';
import { cameraPose } from './orientation.js';
import { declination as wmmDeclination } from '../../vendor/geomagnetism/index.js';

/** Where the demo walks when the job walk has no location yet: Sacramento, CA. */
export const SACRAMENTO = Object.freeze({ lat: 38.5816, lng: -121.4944 });

/** A small seeded random source (mulberry32): {next() → [0, 1), gauss() → N(0, 1)}. */
export function createRng(seed = 1) {
  let s = (seed >>> 0) || 1;
  const next = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const gauss = () => {
    if (spare != null) { const v = spare; spare = null; return v; }
    let u = 0, v = 0;
    while (u === 0) u = next();
    v = next();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  return { next, gauss };
}

/**
 * The default walk: a rectangle `width` × `depth` meters centred on the origin,
 * standing still at two corners; the north side is "under a roof" (worse GPS).
 * Points are {e, n, pause (s, on arrival), roof (the stretch from here on)}.
 */
export function loopRoute({ width = 36, depth = 24 } = {}) {
  const w = width / 2, d = depth / 2;
  return [
    { e: -w, n: -d, pause: 6 },
    { e: w, n: -d },
    { e: w, n: d, pause: 8, roof: true },
    { e: -w, n: d, roof: true },
  ];
}

function normalizeRoute(points) {
  if (points === 'loop' || !Array.isArray(points)) return loopRoute();
  const pts = points
    .filter((p) => p && isFinite(p.e) && isFinite(p.n))
    .map((p) => ({ e: p.e, n: p.n, pause: Math.max(0, Number(p.pause) || 0), roof: !!p.roof }));
  return pts.length >= 2 ? pts : loopRoute();
}

const segHeading = (a, b) => normDeg(Math.atan2(b.e - a.e, b.n - a.n) * 180 / Math.PI);

/**
 * A simulated walker. Returns {gps, orientation, motion} — sources with the same
 * events as the real ones (js/core/positioning.js createGpsSource,
 * orientation.js, motion.js) — plus controls:
 *   start(), stop(), tick() (advance to now(); called every `tickMs` when autoRun),
 *   setRoute(points | 'loop'), pause(seconds), setSeed(n),
 *   truth() → {e, n, lat, lng, heading (true walking direction), walking, gpsError {e, n}},
 *   origin, declination (degrees used to make magnetic headings).
 */
export function createSimulator({
  origin = SACRAMENTO,
  seed = 1,
  now = () => Date.now(),
  timers = globalThis,
  getSettings = () => ({}),
  declination = wmmDeclination,
  autoRun = true,
  route = null,
  gpsIntervalMs = 1000,
  orientationIntervalMs = 50,
  tickMs = 50,
  cadenceHz = 1.8,
} = {}) {
  const o = { lat: origin?.lat ?? SACRAMENTO.lat, lng: origin?.lng ?? SACRAMENTO.lng };
  let rng = createRng(seed);
  let pts = normalizeRoute(route);
  let decl = 0;
  try { decl = Number(declination(o.lat, o.lng, 0, new Date(now()))) || 0; } catch { decl = 0; }

  // Walker
  let seg = 0;
  let along = 0;
  let pos = { e: pts[0].e, n: pts[0].n };
  let pauseUntil = -Infinity;
  let pauseStart = -Infinity;
  let pauses = 0;
  let walking = true;
  // GPS error (slow part per axis, m) and accuracy episodes
  let be = 0, bn = 0;
  let poorUntil = -Infinity;
  let nextEpisodeCheck = 0;
  // Compass wobble (deg) and smoothed walking direction (magnetic)
  let wobble = 0;
  let walkMag = null;
  let facing = 'camera';
  // Scheduling
  let running = false;
  let refs = 0;
  let timer = null;
  let lastT = null;
  let nextGps = 0, nextOrient = 0, nextStep = 0, lastStepT = null;
  let lastMotion = null;

  const gps = new Emitter();
  const orientation = new Emitter();
  const motion = new Emitter();

  const stepLength = () => {
    const v = Number(getSettings()?.stepLength);
    return v > 0.3 && v < 1.3 ? v : 0.72;
  };
  // A little slower than the step length says, as a real person often is.
  const speed = () => cadenceHz * stepLength() * 0.97;

  const segFrom = () => pts[seg % pts.length];
  const segTo = () => pts[(seg + 1) % pts.length];

  function moveWalker(t, dtS) {
    if (t < pauseUntil) { walking = false; return; }
    walking = true;
    let left = speed() * dtS;
    let guard = 0;
    while (left > 0 && guard++ < 100) {
      const a = segFrom(), b = segTo();
      const len = Math.hypot(b.e - a.e, b.n - a.n);
      if (len < 1e-6) { seg++; along = 0; continue; }
      if (along + left < len) {
        along += left;
        left = 0;
      } else {
        left -= len - along;
        seg++;
        along = 0;
        const arrived = segFrom();
        if (arrived.pause > 0) {
          pauseStart = t;
          pauseUntil = t + arrived.pause * 1000;
          pauses++;
          walking = false;
          left = 0;
        }
      }
    }
    const a = segFrom(), b = segTo();
    const len = Math.hypot(b.e - a.e, b.n - a.n) || 1;
    pos = { e: a.e + (b.e - a.e) * along / len, n: a.n + (b.n - a.n) * along / len };
  }

  function accuracyNow(t) {
    if (t >= nextEpisodeCheck) {
      nextEpisodeCheck = t + 30000;
      if (rng.next() < 0.15) poorUntil = t + 10000 + rng.next() * 10000;
    }
    const roof = segFrom().roof;
    let base = roof ? 12 : 4.7;
    if (t < poorUntil) base = Math.max(base, 9 + rng.next() * 7);
    return Math.round(base * (1 + 0.1 * rng.gauss()) * 10) / 10;
  }

  function emitFix(t) {
    const acc = Math.max(3, accuracyNow(t));
    // Slow GPS error: Gauss-Markov, ~60 s correlation, ~0.43 × accuracy per axis.
    const tau = 60, dt = gpsIntervalMs / 1000, sb = 0.43 * acc;
    const k = Math.exp(-dt / tau), q = sb * Math.sqrt(1 - k * k);
    be = be * k + q * rng.gauss();
    bn = bn * k + q * rng.gauss();
    const sw = 0.25 * acc;
    const ll = fromEnu(o, pos.e + be + sw * rng.gauss(), pos.n + bn + sw * rng.gauss());
    const h = walking ? segHeading(segFrom(), segTo()) : null;
    gps.emit('fix', {
      lat: ll.lat,
      lng: ll.lng,
      acc,
      alt: 8 + rng.gauss() * 2,
      altAcc: 4,
      speed: walking ? speed() : 0,
      course: h,
      t,
      receivedAt: t,
    });
  }

  function emitOrientation(t) {
    const walkTrue = segHeading(segFrom(), segTo());
    let camTrue = walkTrue;
    let pitch = -12 + 3 * Math.sin(t / 1300);
    if (walking) {
      camTrue = walkTrue + 4 * Math.sin(2 * Math.PI * (cadenceHz / 2) * t / 1000) + rng.gauss();
    } else {
      // Standing at a corner: looking around, and on every other stop at the floor for a moment.
      const s = (t - pauseStart) / 1000;
      camTrue = walkTrue + 55 * Math.sin(2 * Math.PI * s / 9);
      pitch = -15 + 18 * Math.sin(2 * Math.PI * s / 7);
      if (pauses % 2 === 0 && s > 2 && s < 4) pitch = -82;
    }
    wobble = wobble * Math.exp(-0.05 / 20) + 3 * Math.sqrt(1 - Math.exp(-0.1 / 20)) * rng.gauss();
    const camMag = normDeg(camTrue - decl + wobble + 1.2 * rng.gauss());
    const beta = Math.max(1, Math.min(179, 90 + pitch));
    const alpha = normDeg(-camMag);
    const p = cameraPose(alpha, beta, 0, 0, { facingPrev: facing });
    facing = p.facing;
    const wm = normDeg(walkTrue - decl + wobble);
    walkMag = walkMag == null ? wm : normDeg(walkMag + 0.3 * deltaDeg(walkMag, wm));
    orientation.emit('orientation', {
      t,
      magHeading: p.heading,
      headingAcc: 8,
      pitch: p.pitch,
      roll: p.roll,
      facing: p.facing,
      walkHeading: walkMag,
      camHeading: p.camHeading,
      upHeading: p.upHeading,
      mode: 'sim',
      raw: { alpha, beta, gamma: 0, absolute: true, src: 'sim', compass: null, compassAcc: null, screenAngle: 0, t, alphaOffset: null },
    });
  }

  function emitMotionState(t) {
    const m = walking ? 'walking' : (lastStepT != null && t - lastStepT < 2000 ? 'walking' : 'stationary');
    if (m !== lastMotion) {
      lastMotion = m;
      motion.emit('state', { motion: m, t });
    }
  }

  /** Advance the walk to now(), emitting what happened on the way. */
  function tick() {
    if (!running) return;
    const t = now();
    if (lastT == null) {
      lastT = t;
      nextGps = t + 300;
      nextOrient = t;
      nextStep = t + 1000 / cadenceHz;
      nextEpisodeCheck = t + 30000;
      emitMotionState(t);
      return;
    }
    if (t <= lastT) return;
    // After a long gap (tab in the background) skip ahead quietly, then play the last second.
    if (t - lastT > 5000) {
      const skip = t - lastT - 1000;
      moveWalker(lastT + skip, skip / 1000);
      lastT += skip;
      nextGps = Math.max(nextGps, lastT);
      nextOrient = Math.max(nextOrient, lastT);
      nextStep = Math.max(nextStep, lastT);
    }
    let ct = lastT;
    while (ct < t) {
      const st = Math.min(t, ct + 50);
      moveWalker(st, (st - ct) / 1000);
      while (walking && nextStep <= st) {
        lastStepT = nextStep;
        motion.emit('step', { t: nextStep, length: stepLength() * (1 + 0.05 * rng.gauss()), amplitude: 3, interval: 1000 / cadenceHz });
        nextStep += (1000 / cadenceHz) * (1 + 0.03 * rng.gauss());
      }
      if (!walking) nextStep = Math.max(nextStep, st + 300);
      emitMotionState(st);
      while (nextOrient <= st) { emitOrientation(nextOrient); nextOrient += orientationIntervalMs; }
      while (nextGps <= st) { emitFix(nextGps); nextGps += gpsIntervalMs; }
      ct = st;
    }
    lastT = t;
  }

  function start() {
    if (running) return;
    running = true;
    lastT = null;
    tick();
    if (autoRun) timer = timers.setInterval(tick, tickMs);
  }

  function stop() {
    if (!running) return;
    running = false;
    if (timer) { timers.clearInterval(timer); timer = null; }
  }

  function makeSource(em, extra = {}) {
    let on = false;
    em.start = () => {
      if (on) return;
      on = true;
      refs++;
      start();
      em.emit('status', 'ok');
    };
    em.stop = () => {
      if (!on) return;
      on = false;
      refs = Math.max(0, refs - 1);
      if (!refs) stop();
      em.emit('status', 'off');
    };
    em.getStatus = () => (on ? 'ok' : 'off');
    em.needsPermission = () => false;
    em.setPermission = () => {};
    em.requestPermission = () => Promise.resolve(true);
    Object.assign(em, extra);
    return em;
  }

  makeSource(gps, { getReason: () => '', resume: () => {}, getLastFixAt: () => null });
  makeSource(orientation, { getHint: () => '', getLast: () => null });
  makeSource(motion, {
    getState: () => (lastMotion == null ? 'unknown' : lastMotion),
    getStepCount: () => 0,
  });

  return {
    gps,
    orientation,
    motion,
    origin: o,
    get declination() { return decl; },
    start,
    stop,
    tick,
    isRunning: () => running,
    /** A new route: [{e, n, pause, roof}] meters from the origin, or 'loop'. Starts at its first point. */
    setRoute(points) {
      pts = normalizeRoute(points);
      seg = 0;
      along = 0;
      pos = { e: pts[0].e, n: pts[0].n };
      pauseUntil = -Infinity;
    },
    /** Stand still for `seconds` from now. */
    pause(seconds = 5) {
      pauseStart = now();
      pauseUntil = pauseStart + seconds * 1000;
      walking = false;
    },
    setSeed(n) { rng = createRng(n); },
    /** Where the pretend person really is (for tests and the demo's honesty check). */
    truth() {
      const ll = fromEnu(o, pos.e, pos.n);
      return { e: pos.e, n: pos.n, lat: ll.lat, lng: ll.lng, heading: segHeading(segFrom(), segTo()), walking, gpsError: { e: be, n: bn } };
    },
  };
}
