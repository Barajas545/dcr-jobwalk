// orientation.js — which way the camera points: compass heading, tilt and roll
// from the phone's orientation sensors.
//
// Every photo saves the direction its camera faced, drawn as a wedge on the
// plan. Getting that right on both phones takes care, because the browsers
// report orientation differently (docs/RESEARCH.md, "Device orientation"):
//
//  - Android Chrome: `deviceorientationabsolute` gives alpha/beta/gamma against
//    MAGNETIC north (the plain `deviceorientation` there is relative — its alpha
//    points nowhere in particular, so it is never shown as a heading). Some
//    devices fire it with alpha = null (no magnetometer).
//  - iPhone Safari: `deviceorientation` alpha is relative to an arbitrary
//    direction; `webkitCompassHeading` is the magnetic heading of the phone's
//    TOP EDGE. So while the phone is held flat-ish (top edge near horizontal) we
//    learn the offset between the two, hold it while the phone is raised to
//    shoot, and re-learn it whenever the phone is lowered again. iOS restarts
//    its motion reference whenever the page is hidden (app switch, the system
//    camera), so the offset is thrown away then and learned again.
//  - The back camera looks along the device's −Z axis. Its heading and tilt
//    come from the full W3C rotation matrix (atan2(−m13, −m23), asin(−m33)), not
//    from alpha alone, which is only right when the phone lies flat. When the
//    camera points nearly straight down or up its heading is meaningless, so the
//    app switches to where the top of the picture points (facing: 'top').
//  - iOS asks permission for these sensors, and only inside a tap. Chrome 151+
//    has the same requestPermission() functions, so their presence does NOT mean
//    iOS — iOS is recognised by a numeric webkitCompassHeading on the events.
//  - Chrome fires only when an angle moves 0.1° or more: a phone held still
//    sends nothing, and the last reading stays valid.
//  - Which edge of the picture is up comes from gravity, not
//    screen.orientation.angle (wrong under rotation lock and on iPads).
//
// Headings here are MAGNETIC; positioning.js adds the declination. The raw
// sensor values travel with every reading so a photo's direction can be
// recomputed later if this math is ever improved.
//
// Pure math at the top (Node-tested); the browser part is createOrientationSource().

import { Emitter } from './bus.js';
import { normDeg, deltaDeg, smoothAngle } from './geo.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrap180 = (d) => { const r = normDeg(d + 180) - 180; return r === -180 ? 180 : r; };

/** Camera tilt (|pitch|, degrees) beyond which the picture's top edge gives the heading instead of the camera. */
export const FACING_TOP_ENTER = 70;
/** …and below which it goes back to the camera direction (hysteresis, so it does not flicker at 70°). */
export const FACING_TOP_EXIT = 62;

/** An iPhone sensor silence longer than this (ms) means Core Motion restarted: the alpha offset is dropped. */
const IOS_GAP_MS = 3000;

/** iOS webkitCompassAccuracy (± degrees) above which the compass is reported as needing calibration. */
export const UNCALIBRATED_ACC = 30;

// ---- the math --------------------------------------------------------------------------

/**
 * The W3C rotation matrix R = Rz(alpha)·Rx(beta)·Ry(gamma) (spec Appendix A),
 * row-major [m11, m12, m13, m21, m22, m23, m31, m32, m33]. Its columns are the
 * device's x (right), y (top) and z (out of the screen) axes in the Earth frame
 * (x = east, y = north, z = up).
 */
export function rotationMatrix(alpha, beta, gamma) {
  const cX = Math.cos(beta * D2R), sX = Math.sin(beta * D2R);
  const cY = Math.cos(gamma * D2R), sY = Math.sin(gamma * D2R);
  const cZ = Math.cos(alpha * D2R), sZ = Math.sin(alpha * D2R);
  return [
    cZ * cY - sZ * sX * sY, -cX * sZ, cY * sZ * sX + cZ * sY,
    cY * sZ + cZ * sX * sY, cZ * cX, sZ * sY - cZ * cY * sX,
    -cX * sY, sX, cX * cY,
  ];
}

/**
 * Where the back camera points, from absolute (Earth-referenced) alpha/beta/gamma
 * in degrees.
 *
 * "Which edge of the picture is up" comes from gravity — how the phone is held
 * (holdAngle) — not from screen.orientation.angle, which stays 0 under the
 * iPhone's rotation lock, reads 90 for portrait on an iPad, and may be
 * collapsed to 0/90 for privacy (docs/RESEARCH.md). When the phone is nearly
 * flat gravity cannot tell, so `holdFallback` (the last good hold angle) or else
 * `screenAngle` is used.
 *
 * Returns (degrees):
 *  - camHeading: back-camera direction, clockwise from the north the angles use
 *    (= the spec's compassHeading(), but with atan2 so a flat phone is not NaN —
 *    though meaningless then, hence `facing`)
 *  - pitch: camera tilt above the horizon (+up, 0 level, −90 straight down)
 *  - holdAngle: how the phone is held, counter-clockwise from portrait on the
 *    screen.orientation.angle scale (0 portrait, 90 top edge to the LEFT, 180, 270);
 *    holdOK: false when the phone is too flat for it to mean anything
 *  - imageAngle: the multiple of 90° taken as the picture's orientation
 *  - upHeading: where the TOP OF THE PICTURE points
 *  - topHeading: where the phone's top edge points (device +Y)
 *  - roll: how far the picture's horizon is turned from level (+ = phone turned
 *    clockwise); null when the camera points within 5° of straight up/down
 *  - facing: 'camera', or 'top' when |pitch| > FACING_TOP_ENTER (pass the previous
 *    facing as `facingPrev` for hysteresis)
 *  - heading: the direction to draw — camHeading when facing 'camera', upHeading
 *    when 'top'. (`planHeading` is the same value, the name docs/RESEARCH.md
 *    uses; it is still Earth-referenced, not relative to a plan.)
 *
 * Checks (docs/RESEARCH.md): (0,90,0) → heading 0, pitch 0, hold 0; (30,90,20) →
 * 310; (0,60,0) → pitch −30; (0,0,0) → pitch −90; (90,0,−90) → heading 0, hold 90.
 */
export function cameraPose(alpha, beta, gamma, screenAngle = 0, { facingPrev = null, holdFallback = null } = {}) {
  const [m11, m12, m13, m21, m22, m23, m31, m32, m33] = rotationMatrix(alpha, beta, gamma);
  // Back camera = device −Z = −(third column).
  const pitch = Math.asin(clamp(-m33, -1, 1)) * R2D;
  const camHeading = normDeg(Math.atan2(-m13, -m23) * R2D);
  // Row 3 of R is world-up in device coordinates: its direction in the screen plane is how the phone is held.
  const holdAngle = normDeg(Math.atan2(m31, m32) * R2D);
  const holdOK = Math.hypot(m31, m32) > 0.5;
  const fallback = holdFallback != null && isFinite(holdFallback) ? holdFallback : (screenAngle || 0);
  const imageAngle = (Math.round((holdOK ? holdAngle : normDeg(fallback)) / 90) % 4) * 90;
  // Picture-up in device coordinates for an image turned θ counter-clockwise: (sinθ, cosθ, 0);
  // picture-right: (cosθ, −sinθ, 0).
  const th = imageAngle * D2R;
  const ux = Math.sin(th), uy = Math.cos(th);
  const upHeading = normDeg(Math.atan2(m11 * ux + m12 * uy, m21 * ux + m22 * uy) * R2D);
  const topHeading = normDeg(Math.atan2(m12, m22) * R2D);
  const upZ = m31 * ux + m32 * uy;
  const rightZ = m31 * uy - m32 * ux;
  const roll = Math.abs(pitch) > 85 ? null : Math.atan2(-rightZ, upZ) * R2D;
  const ap = Math.abs(pitch);
  const facing = facingPrev === 'top'
    ? (ap > FACING_TOP_EXIT ? 'top' : 'camera')
    : (ap > FACING_TOP_ENTER ? 'top' : 'camera');
  const heading = facing === 'top' ? upHeading : camHeading;
  return { camHeading, upHeading, topHeading, pitch, roll, facing, heading, planHeading: heading, holdAngle, holdOK, imageAngle };
}

/** The screen's rotation in degrees (0, 90, 180, 270), counter-clockwise from portrait. */
export function screenAngle(win = globalThis) {
  try {
    const so = win?.screen?.orientation;
    if (so && typeof so.angle === 'number' && isFinite(so.angle)) return normDeg(so.angle);
    const wo = win?.orientation; // legacy iOS: 0, 90, -90, 180
    if (typeof wo === 'number' && isFinite(wo)) return normDeg(wo);
  } catch { /* not available */ }
  return 0;
}

/**
 * The time of a sensor event as epoch ms. event.timeStamp is a high-resolution
 * time since the page loaded in current browsers (epoch ms in some old ones).
 */
export function eventTime(e, win = globalThis, now = () => Date.now()) {
  const ts = e?.timeStamp;
  if (typeof ts === 'number' && isFinite(ts) && ts > 0) {
    if (ts > 1e12) return ts;
    const origin = win?.performance?.timeOrigin;
    if (typeof origin === 'number' && isFinite(origin) && origin > 1e12) return origin + ts;
  }
  return now();
}

/**
 * iPhone: learns `offset` = relative alpha − absolute (magnetic) alpha from
 * webkitCompassHeading. The W3C top-edge heading is exactly −alpha for any
 * gamma while |beta| < 90, so with the top edge near horizontal
 *   offset = wrap(alpha − (360 − webkitCompassHeading)).
 * Rules (docs/RESEARCH.md): learn only while |beta| and |gamma| < `gate` (35°)
 * and the compass accuracy is 0…`maxAcc` (25°); smooth on the circle; hold the
 * offset while the phone is raised (no learning there); after `gapMs` without
 * learning, catch up quickly when it is lowered again (the gyro drifts slowly).
 * Before any proper sample, a phone held at a reading angle (|beta| < 65°,
 * |gamma| < 30°) gives a provisional offset, replaced by the first proper one.
 */
export function createIosOffsetLearner({ gate = 35, maxAcc = 25, tau = 1.5, wideBeta = 65, wideGamma = 30, gapMs = 20000 } = {}) {
  let offset = null;
  let quality = 'none';   // 'none' | 'provisional' | 'learned'
  let n = 0;
  let lastT = null;

  function blend(s, t) {
    if (lastT == null || t - lastT > gapMs) n = 1;
    const dt = lastT == null ? 0 : clamp((t - lastT) / 1000, 0, 0.1);
    const k = Math.max(1 - Math.exp(-dt / tau), 1 / (n + 1));
    offset = wrap180(offset + k * wrap180(s - offset));
    n = Math.min(n + 1, 10000);
    lastT = t;
  }

  return {
    get offset() { return offset; },
    get quality() { return quality; },
    reset() { offset = null; quality = 'none'; n = 0; lastT = null; },
    /** Feed one event's values; returns the current offset (or null). */
    update({ alpha, beta, gamma, compass, compassAcc, t = Date.now() }) {
      if (alpha == null || beta == null || gamma == null || !isFinite(alpha)) return offset;
      if (!(typeof compass === 'number' && isFinite(compass) && compass >= 0)) return offset;
      if (!(typeof compassAcc === 'number' && compassAcc >= 0 && compassAcc <= maxAcc)) return offset;
      const s = wrap180(alpha - (360 - compass));
      const ab = Math.abs(beta), ag = Math.abs(gamma);
      if (ab < gate && ag < gate) {
        if (quality !== 'learned') { offset = s; quality = 'learned'; n = 1; lastT = t; return offset; }
        blend(s, t);
      } else if (quality !== 'learned' && ab < wideBeta && ag < wideGamma) {
        if (quality === 'none') { offset = s; quality = 'provisional'; n = 1; lastT = t; return offset; }
        blend(s, t);
      }
      return offset;
    },
    /** Absolute magnetic alpha for a relative one, or null until an offset is known. */
    absAlpha(alpha) {
      return offset == null || alpha == null || !isFinite(alpha) ? null : normDeg(alpha - offset);
    },
  };
}

/**
 * Smooths a heading over time on the circle (an exponential average with time
 * constant `tau` seconds), the short way round — 359° → 1° moves 2°, never
 * 358°. A turn bigger than `snapDeg` is followed faster (`fastTau`), so the
 * cone keeps up when the person spins round.
 */
export function createAngleSmoother({ tau = 0.12, snapDeg = 60, fastTau = 0.03, resetAfterMs = 1000 } = {}) {
  let value = null;
  let lastT = null;
  return {
    get value() { return value; },
    reset(v = null) { value = v == null ? null : normDeg(v); lastT = null; },
    update(angle, tMs) {
      if (angle == null || !isFinite(angle)) return value;
      if (value == null || lastT == null || !(tMs >= lastT) || tMs - lastT > resetAfterMs) {
        value = normDeg(angle);
        lastT = tMs;
        return value;
      }
      const dt = (tMs - lastT) / 1000;
      lastT = tMs;
      const tc = Math.abs(deltaDeg(value, angle)) > snapDeg ? fastTau : tau;
      value = smoothAngle(value, angle, 1 - Math.exp(-dt / tc));
      return value;
    },
  };
}

// ---- permission ----------------------------------------------------------------------

function settlePermission(p) {
  if (p == null) return Promise.resolve('granted'); // nothing to ask: the browser allows it
  return Promise.resolve(p).then(
    (s) => (s === 'granted' || s === 'denied' || s === 'prompt' ? s : 'granted'),
    (err) => (err && err.name === 'NotAllowedError' ? 'prompt' : 'error'),
  );
}

/**
 * Ask for the orientation (with compass) and motion sensors. iOS only shows
 * its prompt when this runs inside a tap, so it calls both requestPermission()
 * functions SYNCHRONOUSLY, before any await — call it straight from the click
 * handler. Neither WebKit nor Chromium takes the spec's 'absolute' argument, so
 * none is passed; one answer covers both sensors. Resolves {orientation, motion}: 'granted' | 'denied' | 'prompt'
 * (needs a tap) | 'error'. Where a browser has no such function the sensor is
 * simply allowed ('granted').
 */
export function requestSensorPermission(win = globalThis) {
  const DOE = win?.DeviceOrientationEvent;
  const DME = win?.DeviceMotionEvent;
  let po = null;
  let pm = null;
  try {
    if (DOE && typeof DOE.requestPermission === 'function') po = DOE.requestPermission();
  } catch (err) { po = Promise.reject(err); }
  try {
    if (DME && typeof DME.requestPermission === 'function') pm = DME.requestPermission();
  } catch (err) { pm = Promise.reject(err); }
  return Promise.all([settlePermission(po), settlePermission(pm)])
    .then(([orientation, motion]) => ({ orientation, motion }));
}

// ---- the browser source -----------------------------------------------------------------

/**
 * Listens to the phone's orientation sensors and emits readings.
 *
 *   const src = createOrientationSource();
 *   src.on('orientation', (o) => …);   // every sensor event (~60 Hz)
 *   src.on('status', (s) => …);
 *   src.start(); … src.stop();
 *
 * A reading: {t, magHeading, headingAcc, pitch, roll, facing, walkHeading,
 * camHeading, upHeading, mode, raw}. magHeading is the smoothed MAGNETIC
 * direction to draw (camera, or picture top when facing 'top'), null when the
 * phone cannot tell north; walkHeading is a slower-smoothed copy for walking
 * direction. headingAcc is ± degrees when the phone says (iPhone), else null.
 * raw = {alpha, beta, gamma, absolute, src: 'abs'|'ios'|'rel', compass,
 * compassAcc, screenAngle, t, alphaOffset, holdAngle} — the values behind it
 * (alphaOffset: the iPhone offset in use, needed to recompute its heading).
 *
 * Chrome only fires when an angle changes by 0.1° or more, so a phone held
 * still goes quiet: the last reading stays valid (getLast()), and silence is
 * never taken for a broken sensor once a reading has come in.
 *
 * Status: 'off' | 'ok' | 'needs-permission' | 'denied' | 'unavailable' |
 * 'uncalibrated'. `hint` says what the person can do when there is no
 * heading yet (iPhone: hold the phone flatter for a moment).
 *
 * `win`, `now` and `timers` can be replaced (tests).
 */
export function createOrientationSource({ win = globalThis, now = () => Date.now(), timers = globalThis, watchdogMs = 4000 } = {}) {
  const src = new Emitter();
  const learner = createIosOffsetLearner();
  const headingSm = createAngleSmoother({ tau: 0.12, snapDeg: 50 });
  const walkSm = createAngleSmoother({ tau: 0.8, snapDeg: 120, fastTau: 0.2, resetAfterMs: 3000 });

  let running = false;
  let status = 'off';
  let perm = 'unknown';       // 'unknown' | 'granted' | 'denied' | 'prompt' | 'error'
  let listeners = [];
  let watchdog = null;
  let watchdogFired = false;
  let gotData = false;         // any event with beta/gamma
  let noCompass = false;       // the absolute event came with nulls: no magnetometer here
  let mode = null;             // 'abs' | 'ios' | 'rel' — the kind of the last usable event
  let lastAbsAt = -Infinity;   // Android: the last absolute event with data
  let lastEventT = null;
  let facing = 'camera';
  let pitchS = null;
  let rollS = null;
  let accBad = false;
  let last = null;
  let hint = '';
  let lastHold = null;         // the last hold angle gravity could tell (for a phone laid flat)
  let visOff = null;

  const hasAbsolute = () => { try { return !!win && 'ondeviceorientationabsolute' in win; } catch { return false; } };

  function computeStatus() {
    if (!running) return 'off';
    if (perm === 'denied') return 'denied';
    if (!gotData) {
      if (perm === 'prompt') return 'needs-permission';
      if (perm === 'error' || watchdogFired || noCompass) return 'unavailable';
      return 'off';
    }
    if (mode === 'rel') return 'unavailable';
    if (mode === 'ios' && accBad) return 'uncalibrated';
    return 'ok';
  }

  function refreshStatus() {
    const s = computeStatus();
    if (s !== status) {
      status = s;
      src.emit('status', s);
    }
  }

  function handle(e, alphaMag, meta) {
    const t = eventTime(e, win, now);
    if (lastEventT != null && t - lastEventT > IOS_GAP_MS && meta.src === 'ios') {
      // A long silence on an iPhone means its motion reference was restarted
      // (normally the visibility events below catch this first): the learned
      // alpha offset no longer holds. Learn it again.
      learner.reset();
      alphaMag = null;
      if (typeof meta.compass === 'number') {
        learner.update({ alpha: e.alpha, beta: e.beta, gamma: e.gamma, compass: meta.compass, compassAcc: meta.compassAcc, t });
        alphaMag = learner.absAlpha(e.alpha);
      }
    }
    const dt = lastEventT == null ? 0 : clamp((t - lastEventT) / 1000, 0, 1);
    lastEventT = t;
    const sa = screenAngle(win);
    const p = cameraPose(alphaMag ?? 0, e.beta, e.gamma, sa, { facingPrev: facing, holdFallback: lastHold });
    if (p.holdOK) lastHold = p.imageAngle;
    if (p.facing !== facing) {
      facing = p.facing;
      headingSm.reset(); // the drawn direction changes meaning: do not sweep between the two
    }
    const k = dt <= 0 || dt > 0.5 ? 1 : 1 - Math.exp(-dt / 0.08);
    pitchS = pitchS == null || k === 1 ? p.pitch : pitchS + k * (p.pitch - pitchS);
    if (p.roll == null) rollS = null;
    else rollS = rollS == null || k === 1 ? p.roll : wrap180(rollS + k * deltaDeg(rollS, p.roll));

    let magHeading = null;
    let walkHeading = null;
    let headingAcc = null;
    if (alphaMag != null) {
      magHeading = headingSm.update(p.heading, t);
      walkHeading = walkSm.update(p.heading, t);
      if (meta.src === 'ios' && typeof meta.compassAcc === 'number' && meta.compassAcc >= 0) {
        headingAcc = meta.compassAcc;
        if (learner.quality === 'provisional') headingAcc += 10;
        // A camera aimed steeply down/up has an ill-conditioned heading.
        if (facing === 'camera') headingAcc *= Math.min(3, 1 / Math.max(0.2, Math.cos(p.pitch * D2R)));
      }
      hint = '';
    } else {
      hint = meta.src === 'ios'
        ? 'Hold the phone flat for a moment so the compass can find north.'
        : '';
    }
    if (meta.src === 'ios') {
      const a = meta.compassAcc;
      const bad = !(typeof a === 'number' && a >= 0) || a > UNCALIBRATED_ACC;
      const good = typeof a === 'number' && a >= 0 && a <= 25;
      if (bad) accBad = true; else if (good) accBad = false;
    }
    mode = meta.src;
    gotData = true;
    if (perm === 'prompt' || perm === 'unknown') perm = 'granted'; // events flow, so access is allowed
    last = {
      t,
      magHeading,
      headingAcc,
      pitch: pitchS,
      roll: rollS,
      facing,
      walkHeading,
      camHeading: alphaMag != null ? p.camHeading : null,
      upHeading: alphaMag != null ? p.upHeading : null,
      mode: meta.src,
      raw: {
        alpha: e.alpha ?? null,
        beta: e.beta,
        gamma: e.gamma,
        absolute: !!meta.absolute,
        src: meta.src,
        compass: meta.compass ?? null,
        compassAcc: meta.compassAcc ?? null,
        screenAngle: sa,
        t,
        alphaOffset: meta.src === 'ios' ? learner.offset : null,
        holdAngle: p.holdOK ? p.holdAngle : null,
      },
    };
    refreshStatus();
    src.emit('orientation', last);
  }

  function onAbsolute(e) {
    if (e.alpha == null || e.beta == null || e.gamma == null) {
      // No magnetometer on this device (the spec's null event).
      noCompass = true;
      refreshStatus();
      return;
    }
    lastAbsAt = eventTime(e, win, now);
    handle(e, e.alpha, { src: 'abs', absolute: true });
  }

  function onOrientation(e) {
    if (e.beta == null || e.gamma == null) {
      // All null: no sensors here, or they are blocked (Chrome's 'Sensors' setting).
      if (e.alpha == null && !gotData) { noCompass = true; refreshStatus(); }
      return;
    }
    if (typeof e.webkitCompassHeading === 'number' && isFinite(e.webkitCompassHeading)) {
      const compass = e.webkitCompassHeading;
      const compassAcc = typeof e.webkitCompassAccuracy === 'number' ? e.webkitCompassAccuracy : null;
      const t = eventTime(e, win, now);
      if (!(lastEventT != null && t - lastEventT > IOS_GAP_MS)) {
        learner.update({ alpha: e.alpha, beta: e.beta, gamma: e.gamma, compass, compassAcc, t });
      }
      handle(e, learner.absAlpha(e.alpha), { src: 'ios', absolute: false, compass, compassAcc });
      return;
    }
    // Android sends absolute data on its own event; this relative one only
    // fills in tilt when the absolute one has nothing.
    if (eventTime(e, win, now) - lastAbsAt < 1000) return;
    if (e.absolute === true && e.alpha != null) {
      handle(e, e.alpha, { src: 'abs', absolute: true });
      return;
    }
    handle(e, null, { src: 'rel', absolute: false });
  }

  /**
   * iOS stops Core Motion whenever the page is hidden (app switch, lock screen,
   * the system camera or file picker) and restarts it on return, re-basing its
   * arbitrary alpha: a learned offset is then wrong. Drop it and learn again.
   */
  function onVisibility() {
    learner.reset();
    headingSm.reset();
    walkSm.reset();
    lastEventT = null;
    last = null;
  }

  function attach() {
    detach();
    if (!win || typeof win.addEventListener !== 'function') return;
    if (hasAbsolute()) listeners.push(['deviceorientationabsolute', onAbsolute]);
    listeners.push(['deviceorientation', onOrientation]);
    listeners.push(['pageshow', onVisibility]);
    for (const [type, fn] of listeners) win.addEventListener(type, fn);
    const doc = win.document;
    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', onVisibility);
      visOff = () => doc.removeEventListener('visibilitychange', onVisibility);
    }
  }

  function detach() {
    if (win && typeof win.removeEventListener === 'function') {
      for (const [type, fn] of listeners) win.removeEventListener(type, fn);
    }
    listeners = [];
    visOff?.();
    visOff = null;
  }

  function armWatchdog() {
    if (watchdog) timers.clearTimeout(watchdog);
    watchdogFired = false;
    watchdog = timers.setTimeout(() => { watchdog = null; watchdogFired = true; refreshStatus(); }, watchdogMs);
  }

  /** Apply a permission answer ('granted' | 'denied' | 'prompt' | 'error'), e.g. from requestSensorPermission. */
  function setPermission(state) {
    if (state === 'granted') {
      perm = 'granted';
      if (running) { attach(); armWatchdog(); }
    } else if (!gotData) {
      perm = state;
    }
    refreshStatus();
  }

  function probe() {
    // iOS (and Chrome 151+ set to "Ask") need requestPermission(); without a
    // tap it rejects on iOS while the answer is still open, which tells us to
    // show the button. When it was already granted, it resolves straight away.
    const DOE = win?.DeviceOrientationEvent;
    if (!DOE || typeof DOE.requestPermission !== 'function') return;
    let p;
    try { p = DOE.requestPermission(); } catch (err) { p = Promise.reject(err); }
    settlePermission(p).then((state) => { if (running) setPermission(state); });
  }

  src.start = () => {
    if (running) return;
    running = true;
    gotData = false;
    noCompass = false;
    mode = null;
    lastEventT = null;
    learner.reset();
    headingSm.reset();
    walkSm.reset();
    pitchS = null;
    rollS = null;
    facing = 'camera';
    hint = '';
    lastHold = null;
    const DOE = win?.DeviceOrientationEvent;
    if (!win || typeof win.addEventListener !== 'function' || (!DOE && !hasAbsolute())) {
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
    last = null;
    refreshStatus();
  };

  src.getStatus = () => status;
  src.getHint = () => hint;
  src.getLast = () => last;
  src.isRunning = () => running;
  src.needsPermission = () => perm === 'prompt' && !gotData;
  src.setPermission = setPermission;
  /** Ask (call from a tap). Resolves true when the sensors may be used. */
  src.requestPermission = () => requestSensorPermission(win).then(({ orientation }) => {
    setPermission(orientation);
    return orientation === 'granted';
  });
  return src;
}
