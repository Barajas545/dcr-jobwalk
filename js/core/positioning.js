// positioning.js — where the estimator is standing and which way the camera
// faces, for every photo, video and note.
//
// "Be as precise with the location as possible." Phone GPS alone is a few
// meters off outdoors and much worse under a roof, its fixes come once or
// twice a second, and its error drifts slowly (it is the same few meters for
// minutes at a time). So this engine combines (docs/SPEC.md §5):
//
//  - GPS (watchPosition, high accuracy, no cached fixes; stale ones dropped),
//  - steps from the accelerometer (motion.js): each step moves the estimate
//    one step length along the walking direction, so the dot moves smoothly
//    between fixes and does not wander while the person stands still,
//  - the compass and tilt (orientation.js), turned from magnetic to true
//    north with the project's compass alignment, a typed declination, or the
//    World Magnetic Model (vendor/geomagnetism, WMM2025),
//  - "I'm here" (fixHere): the person shows exactly where they stand. The
//    position snaps there, and the GPS error at that moment is remembered and
//    taken off later fixes, fading over ~10 minutes — GPS error changes slowly,
//    so this genuinely improves the next few minutes of photos.
//
// The fusion is a 2-D Kalman filter on meters east/north of the project's
// origin. Honesty matters as much as the estimate: the accuracy shown (and the
// good/fair/poor quality) is a 1σ figure in meters that never claims GPS
// averaging beats GPS's own slowly drifting error. Fixes that arrive close
// together are de-weighted (they share most of their error) and the reported
// σ never drops below most of the GPS error unless the person fixed their spot.
//
// Pose shape: docs/SPEC.md §4.3, always complete (nulls when unknown), plus
// `fix` — the raw GPS fix behind it — so a photo keeps the measurement itself.
// `pose.geo.acc` and `planAcc` are 1σ (per axis) estimates.
//
// Everything browser-specific is created in start() through replaceable
// factories, so the Node tests drive the engine with fake GPS, compass, steps
// and clock (see createPositioning).

import { Emitter, bus as appBus } from './bus.js';
import { getSettings as appGetSettings } from './settings.js';
import { formatAccuracy, isIOS as detectIOS } from './util.js';
import { toEnu, fromEnu, normDeg, deltaDeg, circularStats } from './geo.js';
import { createOrientationSource, requestSensorPermission } from './orientation.js';
import { createMotionSource } from './motion.js';
import { createSimulator, SACRAMENTO } from './sim.js';
import { declination as wmmDeclination } from '../../vendor/geomagnetism/index.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

/** watchPosition options (docs/SPEC.md §5). */
export const GPS_OPTIONS = Object.freeze({ enableHighAccuracy: true, maximumAge: 0, timeout: 27000 });

/**
 * The engine's numbers in one place. They are reasoned estimates (see each
 * comment and docs/RESEARCH.md) to be checked on a real walk.
 */
export const TUNING = Object.freeze({
  // GPS
  gpsSigmaFloor: 1.5,       // m — no phone fix is better than this, whatever it claims
  gpsAccToSigma: 0.5,       // coords.accuracy is a 68–95 % radius (platforms differ): σ per axis ≈ accuracy / 2
  maxFixAgeMs: 10000,       // older fixes are stale and dropped
  originMaxAcc: 50,         // m — the first fix this good becomes the project's origin
  ignoreAcc: 2000,          // m — this coarse or worse is Chrome's 'approximate' location, not a spot on a site
  roughAcc: 50,             // m — above this, tell the person to turn on precise location
  gpsWhiteFrac: 0.5,        // part of the GPS error that changes fix to fix; the rest drifts slowly
  corrTauS: { walking: 1.5, moving: 2, stationary: 30, unknown: 0 }, // s — how long consecutive fixes share their error
  corrMaxFactor: 60,        // never count a fix as less than 1/60 of an independent one
  floorFrac: 0.85,          // never claimed better than the slowly drifting part of the GPS error (√(1 − 0.5²) ≈ 0.87 σ): it does not average out
  gate: 13.82,              // Mahalanobis² gate: 2 degrees of freedom, 99.9 %
  maxRejects: 5,            // accept the next fix after this many rejected in a row: the filter was wrong
  maxRejectsStill: 30,      // …but when the person has not moved, a jumping GPS is the one that is wrong
  // Movement between fixes (m² per second added to each axis)
  q: { walking: 0.02, moving: 0.15, stationary: 0.0005, unknown: 1.0 },
  qUnknownBySpeed: { still: 0.1, moving: 1.5 }, // no motion sensor: use the GPS speed when there is one
  blindSpeed: 1.4,          // m/s — app hidden (phone locked) or positioning stopped: nothing is measured, so the person may have walked anywhere at a walking pace
  stepAlongFrac: 0.2,       // step length error (fixed-K Weinberg is ~20 %)
  stepHeadingSigma: 25,     // deg — the phone is not always pointed where the person walks
  stepHeadingSigmaTop: 20,  // deg — phone held flat (reading the plan): the top edge usually leads
  // "I'm here"
  manualSigma: 0.3,         // m
  biasTauS: 600,            // s — the remembered GPS error fades over ~10 minutes
  manualRecentMs: 120000,   // pose.source says 'manual' for 2 minutes after a fix
  // Output
  poseIntervalMs: 100,      // ≤ 10 poses a second
  gpsLostMs: 30000,         // no fix for this long → "waiting"
  restartWatchMs: 120000,   // no fix AND no error for this long → the watch is stuck: start it again
  resetAfterStopMs: 600000, // stopped for 10 minutes → the old estimate is forgotten
  // sampleStationary
  stationaryCorrTauS: 60,   // s — standing still, GPS error stays the same for about a minute or more
});

/** good ≤ 1.5 m, fair ≤ 5 m, poor > 5 m (1σ), none when unknown. */
export function qualityFor(sigma) {
  if (sigma == null || !isFinite(sigma)) return 'none';
  if (sigma <= 1.5) return 'good';
  if (sigma <= 5) return 'fair';
  return 'poor';
}

/**
 * m² per axis for `seconds` with no sensor at all (app hidden, positioning
 * stopped): the person may have walked up to blindSpeed × seconds in any
 * direction, so the spread grows with the time itself, not its square root —
 * a 90 s lock is up to ~125 m, not 9 m. Never less than q.unknown per second.
 */
export function blindNoise(seconds) {
  if (!(seconds > 0)) return 0;
  return Math.max(TUNING.q.unknown * seconds, (TUNING.blindSpeed * seconds) ** 2 / 2);
}

/** σ per axis (m) for a fix's coords.accuracy. */
export function gpsSigma(accuracy) {
  if (!(accuracy > 0)) return TUNING.gpsSigmaFloor * 4;
  return Math.max(TUNING.gpsSigmaFloor, accuracy * TUNING.gpsAccToSigma);
}

/** A Pose with nothing known yet (docs/SPEC.md §4.3). */
export function emptyPose(t = Date.now()) {
  return {
    t,
    geo: null,
    enu: null,
    plan: null,
    planAcc: null,
    planLocked: false,
    heading: null,
    headingAcc: null,
    planHeading: null,
    pitch: null,
    roll: null,
    facing: 'camera',
    source: 'none',
    quality: 'none',
    magHeading: null,
    declination: null,
    headingSource: 'none',
    raw: null,
    zoom: null,
    fix: null,
  };
}

// ---- plan geometry straight from a Calibration (docs/SPEC.md §6) ---------------------

/** Plan px for {e, n} using cal.toPlan = [a, b, c, d, tx, ty]: x = a·e + b·n + tx, y = c·e + d·n + ty. */
export function enuToPlanMatrix(cal, enu) {
  const m = cal?.toPlan;
  if (!Array.isArray(m) || m.length < 6 || !enu) return null;
  const x = m[0] * enu.e + m[1] * enu.n + m[4];
  const y = m[2] * enu.e + m[3] * enu.n + m[5];
  return isFinite(x) && isFinite(y) ? { x, y } : null;
}

/** {e, n} for plan px using cal.toEnu (same layout). */
export function planToEnuMatrix(cal, p) {
  const m = cal?.toEnu;
  if (!Array.isArray(m) || m.length < 6 || !p) return null;
  const e = m[0] * p.x + m[1] * p.y + m[4];
  const n = m[2] * p.x + m[3] * p.y + m[5];
  return isFinite(e) && isFinite(n) ? { e, n } : null;
}

/**
 * Degrees clockwise from plan "up" (−y) of a TRUE heading, from the toPlan
 * matrix itself (no sign convention to get wrong). Used to check — and stand in
 * for — calibration.headingToPlan.
 */
export function planHeadingFromCalibration(cal, trueHeading) {
  const m = cal?.toPlan;
  if (!Array.isArray(m) || m.length < 4 || trueHeading == null || !isFinite(trueHeading)) return null;
  const h = trueHeading * D2R;
  const de = Math.sin(h), dn = Math.cos(h);
  const dx = m[0] * de + m[1] * dn;
  const dy = m[2] * de + m[3] * dn;
  if (!isFinite(dx) || !isFinite(dy) || (dx === 0 && dy === 0)) return null;
  return normDeg(Math.atan2(dx, -dy) * R2D);
}

// ---- the filter -------------------------------------------------------------------------

/**
 * A 2-D Kalman filter on {e, n} meters: x = [e, n], P = [pee, pen, pne, pnn].
 * Pure, so the tests exercise it directly.
 */
export class EnuKalman {
  constructor() { this.reset(); }

  reset() {
    this.x = null;
    this.P = null;
    this.rejects = 0;
  }

  get initialized() { return this.x !== null; }

  /** Start (or restart) at a point with σ meters on each axis. */
  init(e, n, sigma) {
    const v = sigma * sigma;
    this.x = [e, n];
    this.P = [v, 0, 0, v];
    this.rejects = 0;
  }

  /** 1σ per axis (RMS of the two axes), meters. */
  sigma() {
    return this.P ? Math.sqrt(Math.max(0, (this.P[0] + this.P[3]) / 2)) : null;
  }

  /** Add q m² of uncertainty to each axis (time passing). */
  addNoise(q) {
    if (!this.P || !(q > 0)) return;
    this.P[0] += q;
    this.P[3] += q;
  }

  /**
   * One step of `length` m along `headingDeg` (true). Its error is
   * `alongFrac` of the length along the way and `headingSigmaDeg` across it.
   * With no heading the person moved about a step in an unknown direction.
   */
  predictStep(length, headingDeg, { alongFrac = TUNING.stepAlongFrac, headingSigmaDeg = TUNING.stepHeadingSigma, baseNoise = 0.0025 } = {}) {
    if (!this.x || !(length > 0)) return;
    if (headingDeg == null || !isFinite(headingDeg)) {
      this.addNoise(length * length / 2 + baseNoise);
      return;
    }
    const h = headingDeg * D2R;
    const ux = Math.sin(h), uy = Math.cos(h);
    this.x[0] += length * ux;
    this.x[1] += length * uy;
    const sa2 = (alongFrac * length) ** 2;
    const sc2 = (length * Math.min(1.2, headingSigmaDeg * D2R)) ** 2;
    // Q = sa²·u·uᵀ + sc²·v·vᵀ with v = (uy, −ux) across the step.
    this.P[0] += sa2 * ux * ux + sc2 * uy * uy + baseNoise;
    const off = (sa2 - sc2) * ux * uy;
    this.P[1] += off;
    this.P[2] += off;
    this.P[3] += sa2 * uy * uy + sc2 * ux * ux + baseNoise;
  }

  /** Mahalanobis² of a measurement with variance r per axis (without applying it). */
  distance2(ze, zn, r) {
    if (!this.x) return 0;
    const ye = ze - this.x[0], yn = zn - this.x[1];
    const s00 = this.P[0] + r, s01 = this.P[1], s11 = this.P[3] + r;
    const det = s00 * s11 - s01 * s01;
    if (!(det > 0)) return Infinity;
    return (ye * (s11 * ye - s01 * yn) + yn * (-s01 * ye + s00 * yn)) / det;
  }

  /**
   * A position measurement (ze, zn) with variance r (m²) per axis. Gated:
   * an outlier (Mahalanobis² > gate) is rejected, unless `maxRejects` were
   * rejected in a row before it — then the filter was wrong and restarts there.
   * `gateR` is the spread one measurement really has, when the weight `r` is
   * deliberately larger (fixes that share their error count for less, but a
   * 50 m jump is still a 50 m jump). gate 0 turns gating off.
   * Returns {accepted, reset?, d2}.
   */
  update(ze, zn, r, { gate = TUNING.gate, maxRejects = TUNING.maxRejects, gateR = r } = {}) {
    if (!(r > 0) || !isFinite(ze) || !isFinite(zn)) return { accepted: false, d2: NaN };
    if (!this.x) {
      this.init(ze, zn, Math.sqrt(r));
      return { accepted: true, reset: true, d2: 0 };
    }
    const [p0, p1, , p3] = this.P;
    const ye = ze - this.x[0], yn = zn - this.x[1];
    const d2 = this.distance2(ze, zn, gateR > 0 ? gateR : r);
    if (gate && d2 > gate) {
      if (this.rejects >= maxRejects) {
        this.init(ze, zn, Math.sqrt(gateR > 0 ? gateR : r));
        return { accepted: true, reset: true, d2 };
      }
      this.rejects++;
      return { accepted: false, d2 };
    }
    this.rejects = 0;
    const s00 = p0 + r, s01 = p1, s11 = p3 + r;
    const det = s00 * s11 - s01 * s01;
    const i00 = s11 / det, i01 = -s01 / det, i11 = s00 / det;
    // K = P·S⁻¹
    const k00 = p0 * i00 + p1 * i01, k01 = p0 * i01 + p1 * i11;
    const k10 = p1 * i00 + p3 * i01, k11 = p1 * i01 + p3 * i11;
    this.x[0] += k00 * ye + k01 * yn;
    this.x[1] += k10 * ye + k11 * yn;
    // Joseph form, P = (I−K)·P·(I−K)ᵀ + K·R·Kᵀ: stays symmetric and positive.
    const a00 = 1 - k00, a01 = -k01, a10 = -k10, a11 = 1 - k11;
    const m00 = a00 * p0 + a01 * p1, m01 = a00 * p1 + a01 * p3;
    const m10 = a10 * p0 + a11 * p1, m11 = a10 * p1 + a11 * p3;
    let n00 = m00 * a00 + m01 * a01;
    let n01 = m00 * a10 + m01 * a11;
    let n11 = m10 * a10 + m11 * a11;
    n00 += r * (k00 * k00 + k01 * k01);
    n01 += r * (k00 * k10 + k01 * k11);
    n11 += r * (k10 * k10 + k11 * k11);
    this.P = [n00, n01, n01, n11];
    return { accepted: true, d2 };
  }

  /** Never claim better than `sigmaFloor` m on either axis. */
  floor(sigmaFloor) {
    if (!this.P || !(sigmaFloor > 0)) return;
    const f2 = sigmaFloor * sigmaFloor;
    if (this.P[0] < f2) this.P[0] = f2;
    if (this.P[3] < f2) this.P[3] = f2;
  }

  /** Move the state (a new origin). */
  shift(de, dn) {
    if (!this.x) return;
    this.x[0] += de;
    this.x[1] += dn;
  }
}

// ---- GPS ---------------------------------------------------------------------------------

/**
 * navigator.geolocation as a source: emits 'fix' {lat, lng, acc, alt, altAcc,
 * speed, course, t, receivedAt} and 'status' ('off'|'waiting'|'ok'|'denied'|
 * 'unavailable'|'error'). getReason(): '' | 'no-api' | 'insecure' | 'denied' |
 * 'position-unavailable' | 'timeout' | 'lost'. Only a denial ends the watch; it
 * is started again when it has been completely silent for two minutes, and
 * when the app comes back to the screen after a problem (resume()).
 */
export function createGpsSource({ geolocation, win = globalThis, now = () => Date.now(), timers = globalThis, options = GPS_OPTIONS } = {}) {
  const src = new Emitter();
  let running = false;
  let status = 'off';
  let reason = '';
  let watchId = null;
  let lastFixAt = null;
  let lastCallbackAt = null;  // any answer from the watch, fix or error
  let watchStartedAt = null;
  let tickTimer = null;

  function setStatus(s, r = '') {
    if (s === status && r === reason) return;
    status = s;
    reason = r;
    src.emit('status', s);
  }

  function clear() {
    if (watchId != null) {
      try { geolocation.clearWatch(watchId); } catch { /* already gone */ }
      watchId = null;
    }
  }

  function watch() {
    clear();
    watchStartedAt = now();
    try {
      watchId = geolocation.watchPosition(onPosition, onError, { ...options });
    } catch (err) {
      console.warn('[gps] watchPosition failed', err);
      setStatus('unavailable', 'no-api');
    }
  }

  function onPosition(p) {
    if (!running) return;
    const c = p?.coords;
    if (!c || !isFinite(c.latitude) || !isFinite(c.longitude)) return;
    const t = now();
    lastCallbackAt = t;
    let ft = p.timestamp;
    // A few browsers stamp fixes on another clock; a stamp a day off is not a real age.
    if (!isFinite(ft) || Math.abs(t - ft) > 86_400_000) ft = t;
    lastFixAt = t;
    setStatus('ok');
    // iOS passes an altitude with altitudeAccuracy 0 when it has none (Apple: invalid when <= 0).
    const altAcc = num(c.altitudeAccuracy);
    const altOk = altAcc == null || altAcc > 0;
    src.emit('fix', {
      lat: c.latitude,
      lng: c.longitude,
      acc: num(c.accuracy),
      alt: altOk ? num(c.altitude) : null,
      altAcc: altOk ? altAcc : null,
      speed: num(c.speed) != null && c.speed >= 0 ? c.speed : null,
      course: num(c.heading),
      t: ft,
      receivedAt: t,
    });
  }

  function onError(err) {
    if (!running) return;
    lastCallbackAt = now();
    const code = err?.code;
    // Only a denial ends a watch (W3C): a timeout or 'unavailable' under a roof
    // leaves it running, so averaging carries on when the signal returns.
    if (code === 1) {
      clear();
      setStatus('denied', 'denied');
    } else if (code === 2) {
      setStatus(lastFixAt ? 'error' : 'unavailable', 'position-unavailable');
    } else if (code === 3) {
      if (!lastFixAt || now() - lastFixAt > options.timeout) setStatus(lastFixAt ? 'error' : 'waiting', 'timeout');
    } else {
      setStatus('error', 'unknown');
    }
  }

  function tick() {
    if (!running || status === 'denied' || reason === 'no-api' || reason === 'insecure') return;
    const t = now();
    if (status === 'ok' && lastFixAt && t - lastFixAt > TUNING.gpsLostMs) setStatus('waiting', 'lost');
    // A watch that has said nothing at all (not even a timeout) for two minutes is stuck.
    const silent = t - Math.max(lastCallbackAt ?? 0, watchStartedAt ?? 0);
    if (silent > TUNING.restartWatchMs) {
      watch();
      setStatus('waiting', lastFixAt ? 'lost' : 'timeout');
    }
  }

  src.start = () => {
    if (running) return;
    running = true;
    lastFixAt = null;
    lastCallbackAt = null;
    if (win && win.isSecureContext === false) { setStatus('unavailable', 'insecure'); return; }
    if (!geolocation || typeof geolocation.watchPosition !== 'function') { setStatus('unavailable', 'no-api'); return; }
    setStatus('waiting');
    watch();
    tickTimer = timers.setInterval(tick, 5000);
  };

  src.stop = () => {
    if (!running) return;
    running = false;
    clear();
    if (tickTimer) { timers.clearInterval(tickTimer); tickTimer = null; }
    setStatus('off');
  };

  /** The app is back on screen: try again if location was blocked or stuck (the person may have fixed a setting). */
  src.resume = () => {
    if (!running || !geolocation || typeof geolocation.watchPosition !== 'function' || reason === 'insecure') return;
    if (status === 'denied' || status === 'unavailable' || status === 'error' || (lastFixAt && now() - lastFixAt > 5000)) {
      if (status === 'denied' || status === 'unavailable') setStatus('waiting');
      watch();
    }
  };

  src.getStatus = () => status;
  src.getReason = () => reason;
  src.getLastFixAt = () => lastFixAt;
  return src;
}

// ---- the engine --------------------------------------------------------------------------

const sameOrigin = (a, b) => !!a && !!b && Math.abs(a.lat - b.lat) < 1e-10 && Math.abs(a.lng - b.lng) < 1e-10;
const validOrigin = (o) => (o && isFinite(o.lat) && isFinite(o.lng) ? { lat: o.lat, lng: o.lng } : null);
const abortError = (signal) => signal?.reason instanceof Error ? signal.reason
  : (typeof DOMException === 'function' ? new DOMException('Stopped', 'AbortError') : Object.assign(new Error('Stopped'), { name: 'AbortError' }));

/**
 * The positioning engine (docs/SPEC.md §5). Use the shared `positioning`;
 * construct your own only in tests, replacing any of:
 *   now, timers {setTimeout, clearTimeout, setInterval, clearInterval},
 *   getSettings, bus, win (a function returning the window),
 *   geolocation (a function), createGps(opts), createOrientation(opts),
 *   createMotion(opts), createSim(opts), calibration (a module with
 *   enuToPlan/planToEnu/headingToPlan), loadCalibration (a function → Promise<module>),
 *   declination(lat, lng, altMeters, date), isIOS.
 *
 * Events: 'pose' (≤ 10 Hz, at once on each GPS fix), 'status', and for
 * screens that want them: 'fix' (each raw GPS fix that was accepted as fresh),
 * 'orientation' (each sensor reading, ~60 Hz).
 */
export class PositioningEngine extends Emitter {
  constructor(deps = {}) {
    super();
    this.deps = {
      now: () => Date.now(),
      timers: globalThis,
      getSettings: appGetSettings,
      bus: appBus,
      win: () => globalThis,
      geolocation: () => globalThis.navigator?.geolocation ?? null,
      createGps: (o) => createGpsSource(o),
      createOrientation: (o) => createOrientationSource(o),
      createMotion: (o) => createMotionSource(o),
      createSim: (o) => createSimulator(o),
      calibration: null,
      loadCalibration: () => import('./calibration.js'),
      declination: wmmDeclination,
      isIOS: detectIOS,
      ...deps,
    };
    this.kf = new EnuKalman();
    this.running = false;
    this.simulating = false;
    this.sources = { gps: null, orientation: null, motion: null, sim: null };
    this.offs = [];
    this.project = null;
    this.level = null;
    this.onOrigin = null;
    this.calKey = null;
    this.calModule = this.deps.calibration || null;
    this.calLoading = null;
    this.frameOrigin = null;          // the origin the filter computes in
    this.provisionalOrigin = null;    // offered to a project without one (onOrigin)
    this.originRequestedFor = null;
    this.lastFix = null;
    this.recentFixes = [];
    this.lastGpsUpdateT = null;       // fix time of the last fix the filter used
    this.bestGpsSigma = null;         // the best GPS σ used since the estimate started
    this.lastAdvanceT = null;
    this.orient = null;
    this.bias = null;                 // {e, n, t, sigma} GPS error at the last "I'm here"
    this.manual = null;               // {e, n, t}
    this.pose = emptyPose(this.now());
    this.poseDirty = true;
    this.lastPoseAt = -Infinity;
    this.poseTimer = null;
    this.tickTimer = null;
    this.statusKey = '';
    this.status = null;
    this.stoppedAt = null;
    this.blindFrom = null;            // when the sensors went dark (app hidden or stopped); null while they run
    this.movedUnseen = false;         // a dark spell since GPS last agreed: the person may have moved, so a jump is not "GPS wrong"
    this.declCache = { key: '', value: null };
    this.warnedHeading = false;
    this.coarseFix = null;
    this.visibilityOff = null;
    this.settingsOff = null;
  }

  now() { return this.deps.now(); }
  settings() {
    try { return this.deps.getSettings() || {}; } catch { return {}; }
  }

  // ---- life cycle ----------------------------------------------------------------------

  /** Begin the GPS watch and the sensors (or the simulation). Idempotent. */
  start() {
    if (this.running) return;
    this.running = true;
    const t = this.now();
    if (this.stoppedAt != null && t - this.stoppedAt > TUNING.resetAfterStopMs) this.resetEstimate();
    this.simulating = !!this.settings().simulate;
    try {
      this.settingsOff = this.deps.bus?.on?.('settings:change', (s) => this.onSettings(s)) || null;
    } catch { this.settingsOff = null; }
    this.startSources();
    this.tickTimer = this.deps.timers.setInterval(() => this.tick(), 1000);
    this.watchVisibility();
    // Nothing was measured while stopped: that time counts as unknown movement.
    if (!this.pageHidden()) this.endBlind(t);
    this.ensureCalibrationModule();
    this.refreshStatus();
    this.schedulePose();
  }

  /** Stop everything (leaving the job walk). Idempotent. The estimate is kept for a quick return. */
  stop() {
    if (!this.running) return;
    this.running = false;
    this.stopSources();
    if (this.tickTimer) { this.deps.timers.clearInterval(this.tickTimer); this.tickTimer = null; }
    if (this.poseTimer) { this.deps.timers.clearTimeout(this.poseTimer); this.poseTimer = null; }
    this.settingsOff?.();
    this.settingsOff = null;
    this.visibilityOff?.();
    this.visibilityOff = null;
    this.stoppedAt = this.now();
    if (this.blindFrom == null) this.blindFrom = this.stoppedAt;
    this.refreshStatus();
  }

  startSources() {
    const d = this.deps;
    const common = { now: d.now, timers: d.timers };
    try {
      if (this.simulating) {
        const sim = d.createSim({
          ...common,
          origin: this.simOrigin(),
          getSettings: () => this.settings(),
          declination: d.declination,
        });
        this.sources = { gps: sim.gps, orientation: sim.orientation, motion: sim.motion, sim };
        this.simRouteKey = null;
        this.fitSimRouteToPlan();
      } else {
        const win = d.win();
        this.sources = {
          gps: d.createGps({ ...common, geolocation: d.geolocation(), win }),
          orientation: d.createOrientation({ ...common, win }),
          motion: d.createMotion({ ...common, win, getStepLength: () => this.settings().stepLength }),
          sim: null,
        };
      }
    } catch (err) {
      console.error('[positioning] could not create the sources', err);
      this.sources = { gps: null, orientation: null, motion: null, sim: null };
    }
    const { gps, orientation, motion } = this.sources;
    const on = (src, type, fn) => { if (src?.on) this.offs.push(src.on(type, fn)); };
    on(gps, 'fix', (f) => this.onFix(f));
    on(gps, 'status', () => this.refreshStatus());
    on(orientation, 'orientation', (o) => this.onOrientation(o));
    on(orientation, 'status', () => this.refreshStatus());
    on(motion, 'step', (s) => this.onStep(s));
    on(motion, 'state', () => { this.refreshStatus(); });
    on(motion, 'status', () => this.refreshStatus());
    for (const s of [gps, orientation, motion]) {
      try { s?.start?.(); } catch (err) { console.error('[positioning] a source failed to start', err); }
    }
  }

  stopSources() {
    for (const off of this.offs) { try { off(); } catch { /* gone */ } }
    this.offs = [];
    const { gps, orientation, motion } = this.sources;
    for (const s of [gps, orientation, motion]) {
      try { s?.stop?.(); } catch (err) { console.warn('[positioning] a source failed to stop', err); }
    }
    this.sources = { gps: null, orientation: null, motion: null, sim: null };
    this.orient = null;
  }

  onSettings(s) {
    const want = !!s?.simulate;
    if (this.running && want !== this.simulating) {
      // Demo positions and real ones must never mix in one estimate.
      this.stopSources();
      this.simulating = want;
      this.resetEstimate();
      this.startSources();
    }
    this.poseDirty = true;
    this.refreshStatus();
    this.schedulePose();
  }

  watchVisibility() {
    const doc = this.deps.win()?.document;
    if (!doc || typeof doc.addEventListener !== 'function') return;
    const fn = () => {
      if (doc.visibilityState === 'hidden') {
        // No sensor events while hidden; the direction may have changed by the time it returns.
        this.orient = null;
        // …and no steps or GPS either: from now on nobody knows where the person goes.
        if (this.blindFrom == null) this.blindFrom = this.now();
        this.poseDirty = true;
      } else if (doc.visibilityState === 'visible') {
        this.endBlind(this.now());
        try { this.sources.gps?.resume?.(); } catch { /* ignore */ }
        this.refreshStatus();
        this.schedulePose();
      }
    };
    doc.addEventListener('visibilitychange', fn);
    this.visibilityOff = () => doc.removeEventListener('visibilitychange', fn);
  }

  pageHidden() {
    try { return this.deps.win()?.document?.visibilityState === 'hidden'; } catch { return false; }
  }

  /**
   * The sensors are back (the app is on screen again, or positioning started
   * again). The time they were dark is charged as unknown movement at a
   * walking pace — not at whatever the motion sensor says now: someone who
   * locks the phone, walks 40 m and stands still to shoot is 'stationary' on
   * return, and the old spot must not hold the new fixes off for half a
   * minute while claiming ±2 m.
   */
  endBlind(t) {
    if (this.blindFrom == null) return;
    this.advance(t);
    if (this.kf.initialized && t > this.blindFrom) this.movedUnseen = true;
    this.blindFrom = null;
    this.poseDirty = true;
  }

  tick() {
    if (!this.running) return;
    // Let time pass every second, so each second is charged at the motion of
    // THAT second, not at whatever it is when the next fix or step comes.
    this.advance(this.now());
    this.refreshStatus();
    // Keep screens current (accuracy grows while nothing comes in).
    if (this.kf.initialized && this.now() - this.lastPoseAt > 900) this.schedulePose();
  }

  /** Forget the estimate (a new place, demo mode switched). */
  resetEstimate() {
    this.kf.reset();
    this.lastFix = null;
    this.recentFixes = [];
    this.lastGpsUpdateT = null;
    this.lastAdvanceT = null;
    this.bestGpsSigma = null;
    this.bias = null;
    this.manual = null;
    this.coarseFix = null;
    this.movedUnseen = false;
    if (!validOrigin(this.project?.origin)) {
      this.frameOrigin = null;
      this.provisionalOrigin = null;
      this.originRequestedFor = null;
    }
    this.poseDirty = true;
  }

  // ---- context ---------------------------------------------------------------------------

  /**
   * The open job walk: its origin, the active level's calibration and the
   * compass alignment. onOrigin({lat, lng}) is called once when the project
   * has no origin yet and a good fix (≤ 50 m) arrives.
   */
  /**
   * Demo mode on a calibrated plan: walk a loop inside the building (the
   * middle half of the sheet) instead of the default 36 × 24 m loop, so the
   * demo puts its pins and paths on the plan rather than beside it.
   */
  fitSimRouteToPlan() {
    const sim = this.sources?.sim;
    const cal = this.level?.calibration;
    const plan = this.level?.plan;
    if (!sim?.setRoute || !Array.isArray(cal?.toEnu) || !(plan?.width > 0) || !validOrigin(this.project?.origin)) return;
    const key = `${this.level.id}:${cal.toEnu.join(',')}`;
    if (this.simRouteKey === key) return;
    this.simRouteKey = key;
    const [a, b, c, d, tx, ty] = cal.toEnu;
    // The calibration is in meters from the project's origin; the walker
    // measures its route from its own origin (where it started, before the
    // project had one), so each corner is moved into the walker's frame.
    const po = validOrigin(this.project.origin);
    const so = validOrigin(sim.origin) || po;
    const at = (fx, fy) => {
      const x = plan.width * fx, y = plan.height * fy;
      const g = fromEnu(po, a * x + b * y + tx, c * x + d * y + ty);
      return toEnu(so, g.lat, g.lng);
    };
    try {
      sim.setRoute([{ ...at(0.28, 0.3), pause: 6 }, at(0.72, 0.3), { ...at(0.72, 0.7), pause: 6, roof: true }, { ...at(0.28, 0.7), roof: true }]);
    } catch (err) {
      console.warn('[positioning] demo route', err);
    }
  }

  setContext({ project = null, level = null, onOrigin = null } = {}) {
    const prevId = this.project?.id ?? null;
    this.project = project || null;
    this.level = level || null;
    this.onOrigin = typeof onOrigin === 'function' ? onOrigin : null;
    const id = this.project?.id ?? null;
    if (id !== prevId) {
      // Another job walk is another place (maybe a drive away): the last walk's
      // estimate must not hold this one's first fixes off as "GPS jumping".
      if (prevId != null) this.resetEstimate();
      this.bias = null;
      this.manual = null;
      this.originRequestedFor = null;
      this.provisionalOrigin = null;
    }
    const cal = this.level?.calibration || null;
    const calKey = cal ? `${this.level.id}:${cal.createdAt ?? ''}:${(cal.toPlan || []).join(',')}` : `${this.level?.id ?? ''}:none`;
    if (calKey !== this.calKey) {
      // The remembered GPS error was measured against the old plan alignment.
      if (this.calKey != null) this.bias = null;
      this.calKey = calKey;
    }
    if (cal) this.ensureCalibrationModule();
    this.fitSimRouteToPlan();

    const po = validOrigin(this.project?.origin);
    if (po) {
      if (!sameOrigin(po, this.frameOrigin)) this.rebase(po);
      this.provisionalOrigin = null;
    } else if (this.project && this.originRequestedFor !== id) {
      const f = this.lastFix;
      if (f && f.acc <= TUNING.originMaxAcc && this.now() - f.receivedAt < TUNING.maxFixAgeMs) this.offerOrigin({ lat: f.lat, lng: f.lng });
    }
    this.poseDirty = true;
    this.refreshStatus();
    this.schedulePose();
  }

  simOrigin() {
    const p = this.project;
    return validOrigin(p?.origin) || validOrigin(p?.mapView) || SACRAMENTO;
  }

  ensureCalibrationModule() {
    if (this.calModule || this.calLoading || typeof this.deps.loadCalibration !== 'function') return;
    try {
      this.calLoading = Promise.resolve(this.deps.loadCalibration())
        .then((m) => { this.calModule = m?.default && !m.enuToPlan ? m.default : m; this.poseDirty = true; this.schedulePose(); })
        .catch((err) => { console.warn('[positioning] calibration.js could not load; using the matrices directly', err); })
        .finally(() => { this.calLoading = null; });
    } catch (err) {
      this.calLoading = null;
      console.warn('[positioning] calibration.js could not load', err);
    }
  }

  /** Compute in a new origin's frame from now on (the estimate is carried over through lat/lng). */
  rebase(origin) {
    const old = this.frameOrigin;
    this.frameOrigin = { lat: origin.lat, lng: origin.lng };
    if (!old) return;
    const move = (e, n) => { const ll = fromEnu(old, e, n); return toEnu(this.frameOrigin, ll.lat, ll.lng); };
    if (this.kf.initialized) {
      const p = move(this.kf.x[0], this.kf.x[1]);
      this.kf.x = [p.e, p.n];
    }
    if (this.manual) Object.assign(this.manual, move(this.manual.e, this.manual.n));
    for (const f of this.recentFixes) Object.assign(f, toEnu(this.frameOrigin, f.lat, f.lng));
    if (this.lastFix) Object.assign(this.lastFix, toEnu(this.frameOrigin, this.lastFix.lat, this.lastFix.lng));
    this.poseDirty = true;
  }

  offerOrigin(o) {
    if (!this.project) return;
    this.provisionalOrigin = { lat: o.lat, lng: o.lng };
    this.originRequestedFor = this.project.id;
    if (!sameOrigin(this.provisionalOrigin, this.frameOrigin)) this.rebase(this.provisionalOrigin);
    try {
      const r = this.onOrigin?.({ lat: o.lat, lng: o.lng });
      if (r && typeof r.catch === 'function') r.catch((err) => console.warn('[positioning] onOrigin failed', err));
    } catch (err) {
      console.warn('[positioning] onOrigin failed', err);
    }
  }

  /** Whether {e, n} in the filter frame are meters from THIS project's origin. */
  enuValid() {
    if (!this.project || !this.frameOrigin) return false;
    const po = validOrigin(this.project.origin);
    if (po) return sameOrigin(po, this.frameOrigin);
    return this.originRequestedFor === this.project.id && sameOrigin(this.provisionalOrigin, this.frameOrigin);
  }

  // ---- motion state ----------------------------------------------------------------------

  motionState(t = this.now()) {
    try {
      const m = this.sources.motion;
      if (!m || typeof m.getState !== 'function') return 'unknown';
      const s = m.getState(t);
      return s === 'walking' || s === 'stationary' || s === 'moving' ? s : 'unknown';
    } catch { return 'unknown'; }
  }

  processNoise(motion, t) {
    let q = TUNING.q[motion] ?? TUNING.q.unknown;
    if (motion === 'unknown') {
      const f = this.lastFix;
      if (f && f.speed != null && t - f.receivedAt < 5000) {
        q = f.speed > 0.5 ? TUNING.qUnknownBySpeed.moving : f.speed < 0.2 ? TUNING.qUnknownBySpeed.still : q;
      }
    }
    return q;
  }

  /**
   * m² per axis the person may have moved between the last advance and t:
   * time with the sensors running at the current motion's rate, time with
   * them dark (app hidden, positioning stopped) as unknown movement
   * (blindNoise). The dark part is how much blindNoise grew over the dark
   * spell since the last advance, so a spell split over several calls costs
   * the same as one.
   */
  gapNoise(t) {
    const from = this.lastAdvanceT;
    if (from == null || !(t > from)) return 0;
    const dark = this.blindFrom;
    const seenUntil = dark == null ? t : clamp(dark, from, t);
    let v = this.processNoise(this.motionState(t), t) * (seenUntil - from) / 1000;
    if (dark != null && t > dark) v += blindNoise((t - dark) / 1000) - blindNoise(Math.max(0, from - dark) / 1000);
    return v;
  }

  /** Let time pass in the filter up to t (uncertainty grows with how the person may have moved). */
  advance(t) {
    if (!this.kf.initialized) { this.lastAdvanceT = t; return; }
    if (this.lastAdvanceT == null) { this.lastAdvanceT = t; return; }
    if (!(t > this.lastAdvanceT)) return;
    this.kf.addNoise(this.gapNoise(t));
    this.lastAdvanceT = t;
  }

  /** σ now, including uncertainty grown since the last update (without changing the filter). */
  sigmaAt(t) {
    const s = this.kf.sigma();
    if (s == null) return null;
    return Math.sqrt(s * s + this.gapNoise(t));
  }

  // ---- GPS ---------------------------------------------------------------------------------

  biasWeight(t) {
    if (!this.bias) return 0;
    return Math.exp(-Math.max(0, t - this.bias.t) / 1000 / TUNING.biasTauS);
  }

  onFix(raw) {
    const t = this.now();
    if (!raw || !isFinite(raw.lat) || !isFinite(raw.lng) || Math.abs(raw.lat) > 90) return;
    const acc = num(raw.acc);
    if (!(acc > 0)) return;
    const ft = isFinite(raw.t) ? raw.t : t;
    if (t - ft > TUNING.maxFixAgeMs) return; // stale (a cached position)
    if (acc >= TUNING.ignoreAcc) {
      this.coarseFix = { acc, at: t };
      this.refreshStatus();
      return;
    }
    const last = this.lastFix;
    if (last && last.t === ft && last.lat === raw.lat && last.lng === raw.lng) return; // the same fix twice
    this.coarseFix = null;

    if (!this.frameOrigin) this.frameOrigin = { lat: raw.lat, lng: raw.lng };
    if (this.project && !validOrigin(this.project.origin) && this.originRequestedFor !== this.project.id && acc <= TUNING.originMaxAcc) {
      this.offerOrigin({ lat: raw.lat, lng: raw.lng });
    }
    const enu = toEnu(this.frameOrigin, raw.lat, raw.lng);
    const fix = {
      lat: raw.lat,
      lng: raw.lng,
      acc,
      alt: num(raw.alt),
      altAcc: num(raw.altAcc),
      speed: num(raw.speed),
      course: num(raw.course),
      t: ft,
      receivedAt: t,
      e: enu.e,
      n: enu.n,
      motion: this.motionState(t),
    };
    this.lastFix = fix;
    this.recentFixes.push(fix);
    while (this.recentFixes.length && t - this.recentFixes[0].receivedAt > 60000) this.recentFixes.shift();
    this.applyGps(fix, t);
    this.emit('fix', { lat: fix.lat, lng: fix.lng, acc: fix.acc, alt: fix.alt, altAcc: fix.altAcc, speed: fix.speed, t: fix.t, motion: fix.motion });
    this.poseDirty = true;
    this.emitPose();
    this.refreshStatus();
  }

  applyGps(fix, t) {
    const sg = gpsSigma(fix.acc);
    const w = this.biasWeight(t);
    let ze = fix.e, zn = fix.n;
    let sBe2 = 0;
    if (this.bias && w > 1e-3) {
      ze += this.bias.e * w;
      zn += this.bias.n * w;
      sBe2 = (this.bias.sigma || 0) ** 2;
    }
    const sw2 = (TUNING.gpsWhiteFrac * sg) ** 2;
    const sc2 = sg * sg - sw2;
    const motion = fix.motion;
    const tau = TUNING.corrTauS[motion] ?? 0;
    const dt = this.lastGpsUpdateT == null ? Infinity : (fix.t - this.lastGpsUpdateT) / 1000;
    // Fixes a second apart share most of their slowly drifting error: count them for less.
    const factor = tau > 0 && isFinite(dt) ? clamp(2 * tau / Math.max(0.05, dt), 1, TUNING.corrMaxFactor) : 1;
    const r = sw2 + (sc2 * (1 - w * w) + w * w * sBe2) * factor;

    this.advance(t);
    if (!this.kf.initialized) {
      this.kf.init(ze, zn, Math.sqrt(sw2 + sc2 * (1 - w * w) + w * w * sBe2));
      this.lastAdvanceT = t;
      this.lastGpsUpdateT = fix.t;
      this.bestGpsSigma = sg;
      this.movedUnseen = false;
      return;
    }
    // "Has not moved" needs the sensors to have watched all along: after the
    // app was hidden or stopped, standing still NOW says nothing about where
    // the person walked meanwhile, so a fix far from the old spot is not GPS
    // jumping until one has been accepted.
    const still = !this.movedUnseen && motion === 'stationary' && this.recentFixes.slice(-TUNING.maxRejects - 1).every((f) => f.motion === 'stationary');
    // Starting cold, the first fixes are often coarse (Wi-Fi) and further off than
    // they claim; the first much better fix is believed rather than gated out.
    const coldStart = this.bestGpsSigma == null || sg < this.bestGpsSigma / 2;
    const res = this.kf.update(ze, zn, r, {
      gate: coldStart ? 0 : TUNING.gate,
      maxRejects: still ? TUNING.maxRejectsStill : TUNING.maxRejects,
      gateR: sg * sg + w * w * sBe2,
    });
    if (!res.accepted) return;
    this.movedUnseen = false;
    this.bestGpsSigma = this.bestGpsSigma == null ? sg : Math.min(this.bestGpsSigma, sg);
    if (res.reset) {
      // The filter disagreed with GPS for too long: start again from GPS, and
      // drop the remembered "I'm here" correction (it no longer fits).
      this.bias = null;
      this.manual = null;
      this.bestGpsSigma = sg;
    }
    this.lastGpsUpdateT = fix.t;
    // GPS error that no averaging removes: the estimate cannot be better than most of it,
    // unless a recent "I'm here" took it off.
    this.kf.floor(TUNING.floorFrac * sg * Math.sqrt(Math.max(0, 1 - w * w)));
  }

  /** The raw GPS position now in the filter frame ({e, n, n: count, sigma}), or null when there is no fresh fix. */
  gpsNow(t) {
    const fresh = this.recentFixes.filter((f) => t - f.receivedAt < TUNING.maxFixAgeMs);
    if (!fresh.length) return null;
    const lastF = fresh[fresh.length - 1];
    // Standing still: average the last few seconds (less noise). Moving: only the latest fix.
    const pool = this.motionState(t) === 'stationary'
      ? fresh.filter((f) => t - f.receivedAt < 6000 && f.motion === 'stationary')
      : [lastF];
    const use = pool.length ? pool : [lastF];
    let W = 0, e = 0, n = 0;
    for (const f of use) { const wgt = 1 / gpsSigma(f.acc) ** 2; W += wgt; e += wgt * f.e; n += wgt * f.n; }
    const sw = TUNING.gpsWhiteFrac * gpsSigma(lastF.acc);
    return { e: e / W, n: n / W, count: use.length, sigma: sw / Math.sqrt(use.length) };
  }

  // ---- steps and orientation ------------------------------------------------------------

  onStep(s) {
    const t = this.now();
    this.advance(t);
    if (!this.kf.initialized) return;
    const len = s?.length > 0 ? s.length : Number(this.settings().stepLength) || 0.72;
    // The last reading holds while the phone keeps still (Chrome sends nothing then).
    const o = this.orient;
    let heading = null;
    let sigma = TUNING.stepHeadingSigma;
    if (o && o.walkHeading != null) {
      heading = normDeg(o.walkHeading + this.resolveDeclination(this.currentGeo(), t).value);
      sigma = o.facing === 'top' ? TUNING.stepHeadingSigmaTop : TUNING.stepHeadingSigma;
      if (o.headingAcc != null) sigma = Math.hypot(sigma, Math.min(45, o.headingAcc));
      sigma = Math.min(60, sigma);
    }
    this.kf.predictStep(len, heading, { headingSigmaDeg: sigma });
    this.poseDirty = true;
    this.schedulePose();
  }

  onOrientation(o) {
    if (!o) return;
    this.orient = o;
    this.poseDirty = true;
    this.emit('orientation', o);
    this.schedulePose();
  }

  // ---- heading ---------------------------------------------------------------------------

  currentGeo() {
    if (this.kf.initialized && this.frameOrigin) return fromEnu(this.frameOrigin, this.kf.x[0], this.kf.x[1]);
    if (this.lastFix) return { lat: this.lastFix.lat, lng: this.lastFix.lng };
    return validOrigin(this.project?.origin);
  }

  /**
   * What to add to a magnetic heading for true north, in order: the project's
   * compass alignment, a declination typed in Settings, WMM2025 at the
   * position, else 0. {value, source: 'compass-aligned'|'setting'|'wmm'|'none'}
   */
  resolveDeclination(geo, t = this.now()) {
    const co = this.project?.compassOffset;
    if (typeof co === 'number' && isFinite(co)) return { value: co, source: 'compass-aligned' };
    const sd = this.settings().declination;
    const sv = sd == null || sd === '' ? NaN : Number(sd);
    if (isFinite(sv)) return { value: sv, source: 'setting' };
    const ref = geo || this.currentGeo();
    if (ref && isFinite(ref.lat) && isFinite(ref.lng)) {
      const key = `${ref.lat.toFixed(2)},${ref.lng.toFixed(2)},${Math.floor(t / 86_400_000)}`;
      if (this.declCache.key !== key) {
        let v = null;
        try { v = this.deps.declination(ref.lat, ref.lng, this.lastFix?.alt ?? 0, new Date(t)); } catch (err) { console.warn('[positioning] WMM failed', err); }
        this.declCache = { key, value: num(v) };
      }
      if (this.declCache.value != null) return { value: this.declCache.value, source: 'wmm' };
    }
    return { value: 0, source: 'none' };
  }

  toPlanHeading(cal, heading) {
    const fromMatrix = planHeadingFromCalibration(cal, heading);
    let ph = null;
    const fn = this.calModule?.headingToPlan;
    if (typeof fn === 'function') {
      try { ph = num(fn(cal, heading)); } catch { ph = null; }
    }
    if (ph == null) return fromMatrix;
    if (fromMatrix != null && Math.abs(deltaDeg(ph, fromMatrix)) > 1 && !this.warnedHeading) {
      this.warnedHeading = true;
      console.warn(`[positioning] calibration.headingToPlan differs from the toPlan matrix by ${deltaDeg(fromMatrix, ph).toFixed(1)}°; check the northAngle sign`);
    }
    return normDeg(ph);
  }

  toPlan(cal, enu) {
    const fn = this.calModule?.enuToPlan;
    if (typeof fn === 'function') {
      try {
        const p = fn(cal, enu);
        if (p && isFinite(p.x) && isFinite(p.y)) return { x: p.x, y: p.y };
      } catch { /* fall back to the matrix */ }
    }
    return enuToPlanMatrix(cal, enu);
  }

  fromPlan(cal, p) {
    const fn = this.calModule?.planToEnu;
    if (typeof fn === 'function') {
      try {
        const q = fn(cal, p);
        if (q && isFinite(q.e) && isFinite(q.n)) return { e: q.e, n: q.n };
      } catch { /* fall back to the matrix */ }
    }
    return planToEnuMatrix(cal, p);
  }

  // ---- the pose -------------------------------------------------------------------------

  poseSource(t) {
    if (!this.kf.initialized) return 'none';
    if (this.simulating) return 'sim';
    if (this.manual && t - this.manual.t < TUNING.manualRecentMs) return 'manual';
    return this.sources.motion?.getStatus?.() === 'ok' ? 'fused' : 'gps';
  }

  buildPose(t) {
    const pose = emptyPose(t);
    const sigma = this.kf.initialized ? this.sigmaAt(t) : null;
    if (this.kf.initialized && this.frameOrigin) {
      const [e, n] = this.kf.x;
      const ll = fromEnu(this.frameOrigin, e, n);
      const lf = this.lastFix && t - this.lastFix.receivedAt < 60000 ? this.lastFix : null;
      pose.geo = { lat: ll.lat, lng: ll.lng, acc: sigma, alt: lf?.alt ?? null, altAcc: lf?.altAcc ?? null };
      if (this.enuValid()) pose.enu = { e, n };
      if (lf) pose.fix = { lat: lf.lat, lng: lf.lng, acc: lf.acc, alt: lf.alt, altAcc: lf.altAcc, speed: lf.speed, t: lf.t };
    }
    const cal = this.level?.calibration || null;
    if (pose.enu && cal) {
      const p = this.toPlan(cal, pose.enu);
      if (p) {
        pose.plan = p;
        const ppm = num(cal.pxPerMeter);
        pose.planAcc = ppm != null && sigma != null ? sigma * ppm : null;
      }
    }
    // Chrome fires only on a 0.1° change, so a still phone sends nothing: the last
    // reading stays valid (its time is raw.t) until the page is hidden or sensors stop.
    const o = this.orient;
    if (o) {
      pose.pitch = num(o.pitch);
      pose.roll = num(o.roll);
      pose.facing = o.facing === 'top' ? 'top' : 'camera';
      pose.raw = o.raw ? { ...o.raw } : null;
      if (o.magHeading != null && isFinite(o.magHeading)) {
        const d = this.resolveDeclination(pose.geo, t);
        pose.magHeading = normDeg(o.magHeading);
        pose.declination = d.value;
        pose.headingSource = d.source;
        pose.heading = normDeg(o.magHeading + d.value);
        pose.headingAcc = num(o.headingAcc);
        if (cal) pose.planHeading = this.toPlanHeading(cal, pose.heading);
      }
    }
    pose.source = this.poseSource(t);
    pose.quality = qualityFor(sigma);
    return pose;
  }

  /** The latest Pose (docs/SPEC.md §4.3). Synchronous; never throws. */
  getPose() {
    try {
      if (this.poseDirty || !this.pose || this.now() - this.pose.t > 250) {
        this.pose = this.buildPose(this.now());
        this.poseDirty = false;
      }
      return this.pose;
    } catch (err) {
      console.error('[positioning] getPose failed', err);
      return emptyPose(Date.now());
    }
  }

  emitPose() {
    if (this.poseTimer) { this.deps.timers.clearTimeout(this.poseTimer); this.poseTimer = null; }
    let p;
    try {
      p = this.buildPose(this.now());
    } catch (err) {
      console.error('[positioning] pose failed', err);
      p = emptyPose(this.now());
    }
    this.pose = p;
    this.poseDirty = false;
    this.lastPoseAt = this.now();
    this.emit('pose', p);
  }

  schedulePose() {
    if (!this.running) { this.poseDirty = true; return; } // getPose() still answers
    const wait = TUNING.poseIntervalMs - (this.now() - this.lastPoseAt);
    if (wait <= 0) { this.emitPose(); return; }
    if (!this.poseTimer) {
      this.poseTimer = this.deps.timers.setTimeout(() => { this.poseTimer = null; this.emitPose(); }, wait);
    }
  }

  // ---- "I'm here" -------------------------------------------------------------------

  /**
   * The person says exactly where they stand: {plan: {x, y}} (on the active
   * level's calibrated plan), {geo: {lat, lng}}, or {enu: {e, n}}. Snaps the
   * position there (σ 0.3 m) and remembers how far off GPS is right now, to
   * correct the next minutes of fixes. Returns the new Pose. Throws an Error
   * with a message for the person when the spot cannot be used.
   */
  fixHere(where = {}) {
    const t = this.now();
    let enu = null;
    if (where.enu && isFinite(where.enu.e) && isFinite(where.enu.n)) {
      this.useProjectFrame();
      enu = { e: where.enu.e, n: where.enu.n };
    } else if (where.geo && isFinite(where.geo.lat) && isFinite(where.geo.lng)) {
      const g = { lat: where.geo.lat, lng: where.geo.lng };
      if (!this.frameOrigin) this.frameOrigin = { lat: g.lat, lng: g.lng };
      if (this.project && !validOrigin(this.project.origin) && this.originRequestedFor !== this.project.id) this.offerOrigin(g);
      this.useProjectFrame(false);
      enu = toEnu(this.frameOrigin, g.lat, g.lng);
    } else if (where.plan && isFinite(where.plan.x) && isFinite(where.plan.y)) {
      const cal = this.level?.calibration;
      if (!cal) throw new Error('This plan is not calibrated yet, so the app cannot tell where that spot is. Calibrate the plan first, or set your spot on the map.');
      this.useProjectFrame();
      enu = this.fromPlan(cal, where.plan);
      if (!enu) throw new Error('That spot could not be placed with this plan\'s calibration. Try calibrating the plan again.');
    } else {
      throw new Error('Pick the spot where you are standing first.');
    }

    const g = this.gpsNow(t);
    this.bias = g ? { e: enu.e - g.e, n: enu.n - g.n, t, sigma: g.sigma } : null;
    this.manual = { e: enu.e, n: enu.n, t };
    this.kf.init(enu.e, enu.n, TUNING.manualSigma);
    this.lastAdvanceT = t;
    this.movedUnseen = false;
    // The next fix is a fresh measurement of the corrected GPS, not a repeat of the last one.
    this.lastGpsUpdateT = null;
    this.poseDirty = true;
    this.emitPose();
    this.refreshStatus();
    return this.pose;
  }

  /** Make sure the filter computes in the project's origin frame ({e, n} given by the person are in it). */
  useProjectFrame(required = true) {
    const po = validOrigin(this.project?.origin) || (this.enuValid() ? this.frameOrigin : null) || this.provisionalOrigin;
    if (po) {
      if (!sameOrigin(po, this.frameOrigin)) this.rebase(po);
      return;
    }
    if (required) throw new Error('The app does not know where this job walk is on the map yet. Wait for a GPS fix (step outside for a moment), then try again.');
  }

  /** Forget the "I'm here" correction; GPS takes over again. */
  clearFix() {
    this.bias = null;
    this.manual = null;
    if (this.kf.initialized && this.lastFix) this.kf.floor(gpsSigma(this.lastFix.acc));
    this.poseDirty = true;
    this.emitPose();
    this.refreshStatus();
  }

  // ---- status ---------------------------------------------------------------------------

  gpsStatus() {
    if (!this.running) return 'off';
    if (this.simulating) return 'ok';
    const g = this.sources.gps;
    let s = g?.getStatus?.() ?? 'unavailable';
    if (s === 'ok' && this.lastFix && this.now() - this.lastFix.receivedAt > TUNING.gpsLostMs) s = 'waiting';
    if (s === 'ok' && !this.lastFix) s = 'waiting';
    return s;
  }

  /**
   * {gps, compass, motion, message, level: 'ok'|'info'|'warn'|'error', acc,
   * quality, source, simulated, hint}. `message` is one plain sentence about the
   * most important thing (what is wrong and what to do, or how good it is).
   */
  getStatus() {
    try {
      return this.computeStatus();
    } catch (err) {
      console.error('[positioning] status failed', err);
      return { gps: 'error', compass: 'off', motion: 'off', message: 'Positioning is having trouble. Close the job walk and open it again.', level: 'error', acc: null, quality: 'none', source: 'none', simulated: false, hint: '' };
    }
  }

  computeStatus() {
    const t = this.now();
    const units = this.settings().units || 'imperial';
    const running = this.running;
    const sim = running && this.simulating;
    const gps = this.gpsStatus();
    const compass = !running ? 'off' : sim ? 'ok' : (this.sources.orientation?.getStatus?.() ?? 'unavailable');
    const motion = !running ? 'off' : sim ? 'ok' : (this.sources.motion?.getStatus?.() ?? 'unavailable');
    const sigma = this.kf.initialized ? this.sigmaAt(t) : null;
    const quality = qualityFor(sigma);
    const hint = sim ? '' : (this.sources.orientation?.getHint?.() || '');
    const ios = (() => { try { return !!this.deps.isIOS(); } catch { return false; } })();
    const reason = this.sources.gps?.getReason?.() || '';
    let message = '';
    let level = 'ok';
    const say = (m, l) => { if (!message) { message = m; level = l; } };

    if (!running) say('Positioning is off.', 'info');
    if (sim) say('Demo mode — the position and compass are simulated. Turn it off in Settings.', 'info');
    if (gps === 'denied') {
      say(ios
        ? 'Location is blocked — allow it in Settings > Safari > Location (and Settings > Privacy & Security > Location Services), then open the app again.'
        : 'Location is blocked — allow it for this site in the browser\'s site settings (the icon next to the address), then reload.', 'error');
    }
    if (gps === 'unavailable') {
      if (reason === 'insecure') say('Location only works on the app\'s secure (https) address.', 'error');
      else if (reason === 'position-unavailable') say(ios ? 'The phone cannot find its location — check that Location Services is on in Settings > Privacy & Security.' : 'The phone cannot find its location — check that Location is turned on in the phone\'s quick settings.', 'error');
      else say('This browser cannot share its location here. Use Safari on iPhone or Chrome on Android.', 'error');
    }
    if (gps === 'waiting' || gps === 'error') {
      if (this.coarseFix && !this.lastFix) {
        say(ios
          ? 'Only an approximate location is shared — turn on Precise Location in Settings > Privacy & Security > Location Services > Safari Websites.'
          : 'Only an approximate location is shared — choose Precise for this site in Chrome, and turn on Android Settings > Apps > Chrome > Location > Use precise location.', 'warn');
      } else if (this.lastFix) {
        say('GPS signal lost — step outside or near a window, or tap “I\'m here” on the plan to set your spot.', 'warn');
      } else {
        say('Waiting for GPS — step outside or near a window', 'warn');
      }
    }
    if (gps === 'ok' && this.lastFix && this.lastFix.acc > TUNING.roughAcc && !(this.manual && t - this.manual.t < TUNING.manualRecentMs)) {
      say(`GPS is rough (${formatAccuracy(this.lastFix.acc, units)}) — step outside, or ${ios ? 'turn on Precise Location for Safari Websites in Settings > Privacy & Security > Location Services' : 'turn on Android Settings > Apps > Chrome > Location > Use precise location'}.`, 'warn');
    }
    if (compass === 'needs-permission') say('Tap the compass button and allow Motion & Orientation, so each photo saves which way the camera faced.', 'warn');
    if (compass === 'denied') say('Compass access was refused. Close the app completely, open it again, and tap Allow when asked.', 'warn');
    if (compass === 'uncalibrated') say('The compass needs calibrating — move the phone in a figure 8, away from steel and vehicles.', 'warn');
    if (hint) say(hint, 'info');
    if (quality === 'poor') say(`Position is rough (${formatAccuracy(sigma, units)}) — tap “I'm here” on the plan to correct it.`, 'warn');
    if (compass === 'unavailable') {
      say(ios
        ? 'No compass readings — photos will save without a direction.'
        : 'No compass readings — photos will save without a direction. If this phone has a compass, allow Motion sensors for this site in the browser\'s site settings.', 'info');
    }
    if (!message) {
      const parts = [];
      parts.push(sigma != null ? `Position ${formatAccuracy(sigma, units)}` : 'Finding your position');
      if (this.manual && t - this.manual.t < TUNING.manualRecentMs) parts.push('set by you');
      if (compass === 'ok') parts.push('compass on');
      else if (compass !== 'off') parts.push('no compass');
      message = parts.join(' · ');
      level = 'ok';
    }
    return { gps, compass, motion, message, level, acc: sigma, quality, source: this.poseSource(t), simulated: sim, hint };
  }

  refreshStatus() {
    const s = this.getStatus();
    const key = `${s.gps}|${s.compass}|${s.motion}|${s.message}|${s.level}|${s.quality}|${s.simulated}`;
    this.status = s;
    if (key !== this.statusKey) {
      this.statusKey = key;
      this.emit('status', s);
    }
  }

  // ---- permission --------------------------------------------------------------------------

  /** True while the compass/motion sensors still need a tap to be allowed (iPhone). */
  needsPermission() {
    if (this.simulating) return false;
    try {
      return !!(this.sources.orientation?.needsPermission?.() || this.sources.motion?.needsPermission?.());
    } catch { return false; }
  }

  /**
   * Ask for the compass and motion sensors. MUST be called from a tap handler:
   * the browser calls are made synchronously, before anything is awaited.
   * Resolves true when the compass may be used.
   */
  requestPermission() {
    let p;
    try {
      p = requestSensorPermission(this.deps.win());
    } catch (err) {
      return Promise.resolve(false);
    }
    return p.then(({ orientation, motion }) => {
      try { this.sources.orientation?.setPermission?.(orientation); } catch { /* ignore */ }
      try { this.sources.motion?.setPermission?.(motion); } catch { /* ignore */ }
      this.refreshStatus();
      return this.simulating || orientation === 'granted';
    }, () => false);
  }

  // ---- averaging for calibration -------------------------------------------------------

  /**
   * Average GPS while the person stands on a spot (calibration). Resolves
   * {lat, lng, enu, acc, alt, n, spread, nEff, fixes, seconds}:
   *  - a weighted mean (1/σ²) of the fixes after the first third (the settling
   *    ones), outliers dropped; fixes taken while walking are left out;
   *  - acc = 1σ of that mean, honestly: fixes a second apart share their error,
   *    so it divides by an effective number of independent fixes (about one per
   *    two minutes of GPS error correlation), not by √n;
   *  - spread = RMS distance of the fixes from the mean (m).
   * Raw GPS is used (not corrected by "I'm here"), so calibration points stay
   * comparable with each other. Finishes at maxSeconds, or after minSeconds once
   * acc ≤ targetAcc. The returned promise has finish() (finish with what there is
   * — not before minSeconds) and onProgress gets the same function. `prior` (an
   * earlier result) continues averaging ("Keep averaging"). Rejects on abort
   * (AbortError) or when no fix came at all.
   */
  sampleStationary({ minSeconds = 8, maxSeconds = 30, targetAcc = 1.0, onProgress = null, signal = null, prior = null } = {}) {
    const timers = this.deps.timers;
    const t0 = this.now();
    const fixes = Array.isArray(prior?.fixes) ? prior.fixes.map((f) => ({ ...f })) : [];
    let done = false;
    let wantFinish = false;
    let timer = null;
    let off = null;
    let onAbort = null;
    let resolveP;
    let rejectP;
    const promise = new Promise((res, rej) => { resolveP = res; rejectP = rej; });
    minSeconds = Math.max(0, Number(minSeconds) || 0);
    maxSeconds = Math.max(minSeconds, Number(maxSeconds) || 0);

    const cleanup = () => {
      done = true;
      off?.();
      if (timer) { timers.clearTimeout(timer); timer = null; }
      if (onAbort) signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = () => {
      if (done) return;
      const elapsed = (this.now() - t0) / 1000;
      if (elapsed < minSeconds) { wantFinish = true; return; }
      cleanup();
      const r = this.summarizeFixes(fixes, (this.now() - t0) / 1000 + (prior?.seconds || 0), { offerOrigin: true });
      if (!r) {
        rejectP(new Error('No GPS fix came in while you stood there. Step outside or near a window, wait for the position, and try again.'));
        return;
      }
      resolveP(r);
    };
    const progress = () => {
      if (done) return;
      const elapsed = (this.now() - t0) / 1000;
      const r = this.summarizeFixes(fixes, elapsed + (prior?.seconds || 0));
      try {
        onProgress?.({
          n: r?.n ?? 0,
          elapsed,
          remaining: Math.max(0, maxSeconds - elapsed),
          acc: r?.acc ?? null,
          spread: r?.spread ?? null,
          lastFix: fixes.length ? fixes[fixes.length - 1] : null,
          walking: this.motionState() === 'walking',
          finish,
        });
      } catch (err) { console.warn('[positioning] onProgress failed', err); }
      if (elapsed >= maxSeconds) finish();
      else if (elapsed >= minSeconds && (wantFinish || (r && r.acc <= targetAcc))) finish();
    };
    const loop = () => {
      timer = null;
      if (done) return;
      progress();
      if (!done) {
        const elapsed = (this.now() - t0) / 1000;
        const next = Math.min(1000, Math.max(20, (maxSeconds - elapsed) * 1000));
        timer = timers.setTimeout(loop, next);
      }
    };

    if (signal?.aborted) {
      rejectP(abortError(signal));
      promise.finish = () => {};
      return promise;
    }
    if (signal?.addEventListener) {
      onAbort = () => { if (!done) { cleanup(); rejectP(abortError(signal)); } };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    off = this.on('fix', (f) => {
      fixes.push({ lat: f.lat, lng: f.lng, acc: f.acc, alt: f.alt, altAcc: f.altAcc, t: f.t, walking: f.motion === 'walking' });
      progress();
    });
    timer = timers.setTimeout(loop, 1000);
    promise.finish = finish;
    return promise;
  }

  /** The averaged position of a set of fixes (see sampleStationary), or null with none. */
  summarizeFixes(all, seconds = 0, { offerOrigin = false } = {}) {
    let fixes = all.filter((f) => isFinite(f.lat) && isFinite(f.lng) && f.acc > 0);
    if (!fixes.length) return null;
    const still = fixes.filter((f) => !f.walking);
    if (still.length) fixes = still;
    const good = fixes.filter((f) => f.acc <= 100);
    if (good.length) fixes = good;
    // Drop the settling third (the first fixes after arriving are the worst).
    if (fixes.length >= 6) fixes = fixes.slice(Math.floor(fixes.length / 3));
    const ref = { lat: fixes[0].lat, lng: fixes[0].lng };
    const pts = fixes.map((f) => ({ ...toEnu(ref, f.lat, f.lng), w: 1 / gpsSigma(f.acc) ** 2, f }));
    const mean = (list) => {
      let W = 0, e = 0, n = 0;
      for (const p of list) { W += p.w; e += p.w * p.e; n += p.w * p.n; }
      return { e: e / W, n: n / W, W };
    };
    let m = mean(pts);
    let kept = pts;
    if (pts.length >= 4) {
      const d = pts.map((p) => Math.hypot(p.e - m.e, p.n - m.n)).sort((a, b) => a - b);
      const med = d[Math.floor(d.length / 2)];
      const ok = pts.filter((p) => Math.hypot(p.e - m.e, p.n - m.n) <= Math.max(3 * gpsSigma(p.f.acc), 3 * med, 1));
      if (ok.length >= 2 && ok.length < pts.length) { kept = ok; m = mean(kept); }
    }
    const n = kept.length;
    const spread = Math.sqrt(kept.reduce((a, p) => a + (p.e - m.e) ** 2 + (p.n - m.n) ** 2, 0) / n);
    // Effective number of independent fixes (AR(1) with the GPS error's correlation time).
    const span = n > 1 ? Math.max(0.001, (kept[n - 1].f.t - kept[0].f.t) / 1000) : 0;
    const dt = n > 1 ? span / (n - 1) : Infinity;
    const rho = isFinite(dt) ? Math.exp(-dt / TUNING.stationaryCorrTauS) : 0;
    let sum = 0;
    for (let k = 1; k < n; k++) sum += (1 - k / n) * rho ** k;
    const nEff = clamp(n / (1 + 2 * sum), 1, n);
    const meanVar = n / m.W;                 // average per-fix variance (harmonic)
    const accModel = Math.sqrt(meanVar / nEff);
    const accScatter = n > 1 ? (spread / Math.SQRT2) / Math.sqrt(nEff) : 0;
    const acc = Math.max(accModel, accScatter);
    const ll = fromEnu(ref, m.e, m.n);
    const alts = kept.filter((p) => p.f.alt != null && isFinite(p.f.alt));
    let alt = null;
    if (alts.length) {
      let W = 0, s = 0;
      for (const p of alts) { const wa = p.f.altAcc > 0 ? 1 / (p.f.altAcc * p.f.altAcc) : 1; W += wa; s += wa * p.f.alt; }
      alt = s / W;
    }
    let enu = null;
    // A job walk with no origin yet (every fix was rougher than 50 m): this spot becomes it.
    if (offerOrigin && this.project && !validOrigin(this.project.origin) && this.originRequestedFor !== this.project.id) this.offerOrigin(ll);
    if (this.enuValid()) enu = toEnu(this.frameOrigin, ll.lat, ll.lng);
    return {
      lat: ll.lat,
      lng: ll.lng,
      enu,
      acc,
      alt,
      n,
      spread,
      nEff,
      seconds,
      fixes: all.map((f) => ({ lat: f.lat, lng: f.lng, acc: f.acc, alt: f.alt ?? null, altAcc: f.altAcc ?? null, t: f.t, walking: !!f.walking })),
    };
  }

  /**
   * The camera's heading averaged over `seconds` (compass alignment), sampled
   * from the latest reading 20 times a second.
   * Resolves {magnetic, true, spread, n, facing, declination, headingSource}:
   * a circular mean (so 359° and 1° average to 0°) and its spread (circular
   * standard deviation, degrees). `true` adds the declination in use (the
   * compass alignment, a typed one, or WMM2025), null when none is known.
   */
  sampleHeading({ seconds = 3, onProgress = null, signal = null } = {}) {
    const timers = this.deps.timers;
    const t0 = this.now();
    const samples = [];
    let done = false;
    let timer = null;
    let onAbort = null;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        done = true;
        if (timer) { timers.clearTimeout(timer); timer = null; }
        if (onAbort) signal?.removeEventListener?.('abort', onAbort);
      };
      const stats = () => circularStats(samples.map((s) => s.h));
      const finish = () => {
        if (done) return;
        cleanup();
        const s = stats();
        if (samples.length < 3 || s.mean == null) {
          reject(new Error(this.sources.orientation?.getStatus?.() === 'needs-permission'
            ? 'The compass needs permission first — tap the compass button and allow Motion & Orientation.'
            : 'The compass is not giving a direction. Hold the phone still, away from steel, and try again.'));
          return;
        }
        const d = this.resolveDeclination(this.currentGeo(), this.now());
        const tops = samples.filter((x) => x.facing === 'top').length;
        resolve({
          magnetic: s.mean,
          true: d.source === 'none' ? null : normDeg(s.mean + d.value),
          spread: s.spread,
          n: samples.length,
          facing: tops > samples.length / 2 ? 'top' : 'camera',
          declination: d.source === 'none' ? null : d.value,
          headingSource: d.source,
        });
      };
      const progress = () => {
        const elapsed = (this.now() - t0) / 1000;
        const s = stats();
        try { onProgress?.({ n: samples.length, elapsed, remaining: Math.max(0, seconds - elapsed), magnetic: s.mean, spread: s.spread }); } catch { /* ignore */ }
        if (elapsed >= seconds) finish();
      };
      if (signal?.aborted) { reject(abortError(signal)); return; }
      if (signal?.addEventListener) {
        onAbort = () => { if (!done) { cleanup(); reject(abortError(signal)); } };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      // Sample the latest reading 20 times a second rather than counting events:
      // a phone held still on Chrome sends none, and iOS sends 60 a second.
      const take = () => {
        const o = this.orient;
        if (o && o.magHeading != null && isFinite(o.magHeading)) samples.push({ h: o.magHeading, facing: o.facing });
      };
      let ticks = 0;
      const loop = () => {
        timer = null;
        if (done) return;
        take();
        ticks++;
        if (ticks % 5 === 0 || (this.now() - t0) / 1000 >= seconds) progress();
        if (!done) timer = timers.setTimeout(loop, 50);
      };
      timer = timers.setTimeout(loop, 50);
    });
  }
}

/** A separate engine (tests); the app uses `positioning`. */
export function createPositioning(deps = {}) {
  return new PositioningEngine(deps);
}

/** The app's positioning engine (docs/SPEC.md §5). */
export const positioning = createPositioning();
