// positioning.test.mjs — the position engine (js/core/positioning.js) and demo mode (js/core/sim.js).
//
// Driven entirely with a fake clock, fake timers and fake GPS / compass /
// step sources, so every behaviour the photos depend on is checked in Node:
// the filter converges without over-claiming, outliers are gated, "I'm here"
// corrects later fixes and fades, steps move the dot, and the calibration
// averaging is honest about correlated GPS error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../js/core/bus.js';
import { toEnu, fromEnu } from '../js/core/geo.js';
import {
  createPositioning, EnuKalman, qualityFor, gpsSigma, emptyPose, createGpsSource, GPS_OPTIONS, TUNING,
  planHeadingFromCalibration, enuToPlanMatrix,
} from '../js/core/positioning.js';
import { createSimulator, createRng, SACRAMENTO, loopRoute } from '../js/core/sim.js';

const SAC = { lat: 38.5816, lng: -121.4944 };

function fakeEnv(start = 1_800_000_000_000) {
  let t = start;
  let id = 0;
  const tasks = [];
  const timers = {
    setTimeout(fn, ms = 0) { const i = ++id; tasks.push({ i, at: t + Math.max(0, ms), fn, every: 0 }); return i; },
    clearTimeout(i) { const k = tasks.findIndex((x) => x.i === i); if (k >= 0) tasks.splice(k, 1); },
    setInterval(fn, ms) { const i = ++id; tasks.push({ i, at: t + ms, fn, every: ms }); return i; },
    clearInterval(i) { timers.clearTimeout(i); },
  };
  return {
    now: () => t,
    timers,
    pending: () => tasks.length,
    /** Move the clock forward, running due timers in order. */
    advance(ms) {
      const end = t + ms;
      for (;;) {
        tasks.sort((a, b) => a.at - b.at || a.i - b.i);
        const next = tasks[0];
        if (!next || next.at > end) break;
        t = next.at;
        if (next.every) next.at += next.every; else tasks.shift();
        next.fn();
      }
      t = end;
    },
  };
}

function fakeSource(extra = {}) {
  const e = new Emitter();
  e.running = false;
  e.status = 'ok';
  e.start = () => { e.running = true; };
  e.stop = () => { e.running = false; };
  e.getStatus = () => (e.running ? e.status : 'off');
  return Object.assign(e, extra);
}

function makeEngine({ settings = {}, calibration = null, declination = () => 13, ios = false, win = {} } = {}) {
  const env = fakeEnv();
  const gps = fakeSource({ getReason: () => gps.reason || '', resume() {} });
  const ori = fakeSource({ getHint: () => '', needsPermission: () => false, setPermission(s) { ori.perm = s; } });
  const mot = fakeSource({ state: 'unknown', getState() { return mot.state; }, needsPermission: () => false, setPermission() {} });
  const s = { stepLength: 0.72, declination: null, simulate: false, units: 'metric', ...settings };
  const bus = new Emitter();
  const engine = createPositioning({
    now: env.now,
    timers: env.timers,
    getSettings: () => s,
    bus,
    win: () => win,
    geolocation: () => null,
    createGps: () => gps,
    createOrientation: () => ori,
    createMotion: () => mot,
    calibration,
    loadCalibration: null,
    declination,
    isIOS: () => ios,
  });
  const fix = (lat, lng, acc = 5, extra = {}) => gps.emit('fix', { lat, lng, acc, alt: 10, altAcc: 3, speed: null, t: env.now(), ...extra });
  const fixEnu = (e, n, acc = 5, extra = {}) => { const ll = fromEnu(SAC, e, n); fix(ll.lat, ll.lng, acc, extra); };
  return { env, gps, ori, mot, settings: s, bus, engine, fix, fixEnu };
}

function gaussFrom(seed) { const r = createRng(seed); return () => r.gauss(); }
const project = (extra = {}) => ({ id: 'p1', origin: { ...SAC, setAt: 1 }, compassOffset: null, levels: [], ...extra });
const level = (calibration = null) => ({ id: 'l1', name: 'Level 1', calibration });

/** A plan 10 px per meter, north up, origin at plan (500, 400). */
const NORTH_UP = { version: 1, method: 'gps', createdAt: 1, toPlan: [10, 0, 0, -10, 500, 400], toEnu: [0.1, 0, 0, -0.1, -50, 40], pxPerMeter: 10, northAngle: 0 };

// ---- the filter itself ----------------------------------------------------------------------

test('Kalman: converges on noisy fixes of a still point', () => {
  const kf = new EnuKalman();
  const g = gaussFrom(1);
  kf.init(10, -10, 20);
  for (let i = 0; i < 400; i++) kf.update(3 * g(), 3 * g(), 9);
  assert.ok(Math.hypot(kf.x[0], kf.x[1]) < 0.6, `ended at ${kf.x}`);
  assert.ok(kf.sigma() < 0.2);
  assert.ok(kf.P[0] > 0 && kf.P[3] > 0 && Math.abs(kf.P[1] - kf.P[2]) < 1e-12, 'covariance stays symmetric and positive');
});

test('Kalman: a 50 m outlier is gated out; after 5 rejects in a row the next is accepted', () => {
  const kf = new EnuKalman();
  kf.init(0, 0, 2);
  for (let i = 0; i < 20; i++) kf.update(0, 0, 6.25);
  const before = [...kf.x];
  for (let i = 0; i < 5; i++) {
    const r = kf.update(50, 0, 6.25);
    assert.equal(r.accepted, false, `outlier ${i + 1} rejected`);
    assert.ok(r.d2 > TUNING.gate);
  }
  assert.deepEqual(kf.x, before, 'rejected fixes do not move the estimate');
  const r = kf.update(50, 0, 6.25);
  assert.equal(r.accepted, true);
  assert.equal(r.reset, true);
  assert.deepEqual(kf.x, [50, 0]);
  // A good fix between outliers resets the count.
  const k2 = new EnuKalman();
  k2.init(0, 0, 1);
  for (let i = 0; i < 4; i++) k2.update(60, 0, 1);
  k2.update(0.5, 0, 1);
  assert.equal(k2.update(60, 0, 1).accepted, false);
});

test('Kalman: steps move the estimate along the heading; cross-track error grows faster', () => {
  const kf = new EnuKalman();
  kf.init(0, 0, 0.5);
  for (let i = 0; i < 10; i++) kf.predictStep(0.7, 90, { alongFrac: 0.2, headingSigmaDeg: 25 });
  assert.ok(Math.abs(kf.x[0] - 7) < 1e-9 && Math.abs(kf.x[1]) < 1e-9, `${kf.x}`);
  assert.ok(kf.P[3] > kf.P[0], 'north (across the walk) is less certain than east (along it)');
  const k2 = new EnuKalman();
  k2.init(0, 0, 0.5);
  k2.predictStep(0.7, 45);
  assert.ok(Math.abs(k2.x[0] - k2.x[1]) < 1e-12 && k2.x[0] > 0.49);
  assert.ok(Math.abs(k2.P[1]) > 0 && k2.P[1] === k2.P[2]);
  // No heading: no movement, but the step's uncertainty is added.
  const k3 = new EnuKalman();
  k3.init(1, 2, 0.5);
  k3.predictStep(0.7, null);
  assert.deepEqual(k3.x, [1, 2]);
  assert.ok(k3.sigma() > 0.5);
});

test('quality buckets and GPS σ', () => {
  assert.equal(qualityFor(null), 'none');
  assert.equal(qualityFor(0.3), 'good');
  assert.equal(qualityFor(1.5), 'good');
  assert.equal(qualityFor(1.51), 'fair');
  assert.equal(qualityFor(5), 'fair');
  assert.equal(qualityFor(5.01), 'poor');
  assert.equal(gpsSigma(1), 1.5, 'floor');
  assert.equal(gpsSigma(10), 5, 'accuracy is a ~95 % radius: σ ≈ accuracy / 2');
});

// ---- the engine with fake sources ----------------------------------------------------------

test('every pose is complete (docs/SPEC.md §4.3), before and after fixes', () => {
  const { engine, env, fixEnu, ori } = makeEngine();
  const keys = Object.keys(emptyPose()).sort();
  assert.deepEqual(Object.keys(engine.getPose()).sort(), keys);
  engine.setContext({ project: project(), level: level(NORTH_UP) });
  engine.start();
  fixEnu(1, 2);
  ori.emit('orientation', { t: env.now(), magHeading: 100, headingAcc: null, pitch: -10, roll: 1, facing: 'camera', walkHeading: 100, raw: { alpha: 260, beta: 80, gamma: 0, absolute: true, src: 'abs', compass: null, compassAcc: null, screenAngle: 0, t: env.now() } });
  const p = engine.getPose();
  assert.deepEqual(Object.keys(p).sort(), keys);
  assert.ok(p.geo && p.enu && p.plan && p.heading != null && p.raw && p.fix);
  assert.equal(p.planLocked, false);
  assert.equal(p.zoom, null);
  assert.equal(p.facing, 'camera');
  engine.stop();
});

test('noisy GPS while standing still: converges, but never claims better than the GPS can do', () => {
  const { engine, env, fixEnu, mot } = makeEngine();
  engine.setContext({ project: project(), level: level() });
  engine.start();
  mot.state = 'stationary';
  const g = gaussFrom(5);
  let be = 0, bn = 0;
  for (let i = 0; i < 300; i++) {
    env.advance(1000);
    be = be * Math.exp(-1 / 60) + 2.2 * Math.sqrt(1 - Math.exp(-2 / 60)) * g();
    bn = bn * Math.exp(-1 / 60) + 2.2 * Math.sqrt(1 - Math.exp(-2 / 60)) * g();
    fixEnu(10 + be + 1.2 * g(), 20 + bn + 1.2 * g(), 5);
  }
  const p = engine.getPose();
  assert.ok(Math.hypot(p.enu.e - 10, p.enu.n - 20) < 4, `estimate ${p.enu.e},${p.enu.n}`);
  // σ_gps = 2.5 m; its slowly drifting part does not average away, so σ stays ≥ floorFrac × 2.5.
  assert.ok(p.geo.acc >= TUNING.floorFrac * 2.5 - 1e-9, `claimed ${p.geo.acc}`);
  assert.ok(TUNING.floorFrac >= 0.8, 'the floor covers the correlated part of the GPS error');
  assert.equal(p.quality, 'fair');
  assert.equal(p.source, 'fused');
  // The dot is steady: one more noisy fix moves it little.
  const before = { ...p.enu };
  env.advance(1000);
  fixEnu(14, 24, 5);
  const after = engine.getPose().enu;
  assert.ok(Math.hypot(after.e - before.e, after.n - before.n) < 0.5, 'standing still, a 5.7 m jump moves the dot < 0.5 m');
  engine.stop();
});

test('a 50 m GPS outlier is rejected; a real move is accepted after 5 rejects in a row', () => {
  const { engine, env, fixEnu, mot } = makeEngine();
  engine.setContext({ project: project(), level: level() });
  engine.start();
  mot.state = 'walking';
  for (let i = 0; i < 30; i++) { env.advance(1000); fixEnu(0, 0, 4); }
  env.advance(1000);
  fixEnu(50, 0, 4);
  assert.ok(Math.abs(engine.getPose().enu.e) < 0.5, 'outlier ignored');
  for (let i = 0; i < 5; i++) { env.advance(1000); fixEnu(50, 0, 4); }
  assert.ok(Math.abs(engine.getPose().enu.e - 50) < 1, `moved to the new place: ${engine.getPose().enu.e}`);
  engine.stop();
});

test('standing still, a GPS jump is held off much longer (the person did not move)', () => {
  const { engine, env, fixEnu, mot } = makeEngine();
  engine.setContext({ project: project(), level: level() });
  engine.start();
  mot.state = 'stationary';
  for (let i = 0; i < 30; i++) { env.advance(1000); fixEnu(0, 0, 4); }
  for (let i = 0; i < 10; i++) { env.advance(1000); fixEnu(40, 0, 4); }
  assert.ok(Math.abs(engine.getPose().enu.e) < 1, `held: ${engine.getPose().enu.e}`);
  for (let i = 0; i < 30; i++) { env.advance(1000); fixEnu(40, 0, 4); }
  assert.ok(engine.getPose().enu.e > 30, 'eventually follows');
  engine.stop();
});

test('stale fixes (> 10 s old), duplicates and city-level fixes are ignored', () => {
  const { engine, env, fix } = makeEngine();
  engine.setContext({ project: project(), level: level() });
  engine.start();
  fix(SAC.lat, SAC.lng, 5, { t: env.now() - 11_000 });
  assert.equal(engine.getPose().geo, null);
  fix(SAC.lat, SAC.lng, 3000);
  fix(SAC.lat, SAC.lng, 2000);
  assert.equal(engine.getPose().geo, null);
  assert.match(engine.getStatus().message, /approximate location/);
  const t = env.now();
  fix(SAC.lat, SAC.lng, 5, { t });
  const n1 = engine.recentFixes.length;
  fix(SAC.lat, SAC.lng, 5, { t });
  assert.equal(engine.recentFixes.length, n1);
  engine.stop();
});

test('"I\'m here" snaps to the spot, corrects later GPS by the remembered error, which fades over ~10 min', () => {
  const { engine, env, fixEnu, mot } = makeEngine();
  engine.setContext({ project: project(), level: level(NORTH_UP) });
  engine.start();
  mot.state = 'stationary';
  const g = gaussFrom(9);
  // GPS reads 4 m east of the truth (0, 0), steadily.
  for (let i = 0; i < 20; i++) { env.advance(1000); fixEnu(4 + 0.3 * g(), 0.3 * g(), 5); }
  assert.ok(engine.getPose().enu.e > 3);
  const pose = engine.fixHere({ plan: { x: 500, y: 400 } }); // plan spot = ENU (0, 0)
  assert.ok(Math.hypot(pose.enu.e, pose.enu.n) < 1e-9);
  assert.ok(pose.geo.acc <= 0.31 && pose.quality === 'good');
  assert.equal(pose.source, 'manual');
  assert.ok(engine.bias && Math.abs(engine.bias.e + 4) < 0.5, `bias ${engine.bias?.e}`);
  // The next minute of (still 4 m off) fixes stays on the spot.
  for (let i = 0; i < 60; i++) { env.advance(1000); fixEnu(4 + 0.3 * g(), 0.3 * g(), 5); }
  let p = engine.getPose();
  assert.ok(Math.hypot(p.enu.e, p.enu.n) < 0.6, `after a minute: ${p.enu.e}`);
  assert.equal(p.quality, 'good');
  // Ten minutes on, the correction has faded to ~e⁻¹ and the estimate has moved toward GPS.
  for (let i = 0; i < 540; i++) { env.advance(1000); fixEnu(4 + 0.3 * g(), 0.3 * g(), 5); }
  p = engine.getPose();
  assert.ok(p.enu.e > 1.5 && p.enu.e < 3.5, `after 10 min: ${p.enu.e}`);
  assert.ok(Math.abs(engine.biasWeight(env.now()) - Math.exp(-1)) < 0.01);
  // Forty minutes on, GPS has taken over.
  for (let i = 0; i < 1800; i++) { env.advance(1000); fixEnu(4 + 0.3 * g(), 0.3 * g(), 5); }
  assert.ok(engine.getPose().enu.e > 3.5, `after 40 min: ${engine.getPose().enu.e}`);
  assert.notEqual(engine.getPose().source, 'manual');
  engine.stop();
});

test('fixHere accepts {geo} and {enu}, refuses an uncalibrated plan with a plain message; clearFix drops the correction', () => {
  const { engine, env, fixEnu } = makeEngine();
  engine.setContext({ project: project(), level: level(null) });
  engine.start();
  fixEnu(3, 3, 5);
  assert.throws(() => engine.fixHere({ plan: { x: 1, y: 2 } }), /not calibrated/);
  assert.throws(() => engine.fixHere({}), /Pick the spot/);
  const g = fromEnu(SAC, -2, 5);
  let p = engine.fixHere({ geo: g });
  assert.ok(Math.abs(p.enu.e + 2) < 1e-6 && Math.abs(p.enu.n - 5) < 1e-6);
  p = engine.fixHere({ enu: { e: 7, n: 8 } });
  assert.deepEqual(p.enu, { e: 7, n: 8 });
  assert.ok(engine.bias);
  engine.clearFix();
  assert.equal(engine.bias, null);
  assert.ok(engine.getPose().geo.acc >= 2.5 - 1e-9, 'GPS takes over again');
  env.advance(1);
  engine.stop();
});

test('steps move the estimate along the walking heading (true north) between fixes', () => {
  const { engine, env, fixEnu, mot, ori } = makeEngine({ settings: { declination: 10 } });
  engine.setContext({ project: project(), level: level() });
  engine.start();
  fixEnu(0, 0, 5);
  engine.fixHere({ enu: { e: 0, n: 0 } });
  mot.state = 'walking';
  // Magnetic 80° + declination 10° = due east.
  for (let i = 0; i < 10; i++) {
    env.advance(550);
    ori.emit('orientation', { t: env.now(), magHeading: 80, headingAcc: null, pitch: -10, roll: 0, facing: 'camera', walkHeading: 80, raw: null });
    mot.emit('step', { t: env.now(), length: 0.7 });
  }
  const p = engine.getPose();
  assert.ok(Math.abs(p.enu.e - 7) < 1e-6 && Math.abs(p.enu.n) < 1e-6, `${p.enu.e}, ${p.enu.n}`);
  assert.equal(p.heading, 90);
  assert.equal(p.headingSource, 'setting');
  assert.ok(p.geo.acc > 0.3, 'uncertainty grows with each step');
  // No compass: steps add uncertainty but do not move.
  const { engine: e2, fixEnu: f2, mot: m2 } = makeEngine();
  e2.setContext({ project: project(), level: level() });
  e2.start();
  f2(0, 0, 5);
  const s0 = e2.getPose().geo.acc;
  m2.state = 'walking';
  for (let i = 0; i < 5; i++) m2.emit('step', { t: 0, length: 0.7 });
  assert.ok(Math.hypot(e2.getPose().enu.e, e2.getPose().enu.n) < 1e-6);
  assert.ok(e2.getPose().geo.acc > s0);
  engine.stop(); e2.stop();
});

test('declination order: compass alignment, then the typed setting, then WMM2025, else 0', () => {
  const { engine, env, fixEnu, ori, settings } = makeEngine({ declination: () => 13.2 });
  const o = (h) => ori.emit('orientation', { t: env.now(), magHeading: h, headingAcc: 5, pitch: 0, roll: 0, facing: 'camera', walkHeading: h, raw: null });
  engine.setContext({ project: project({ origin: null }), level: level() });
  engine.start();
  o(100);
  let p = engine.getPose();
  assert.equal(p.headingSource, 'none');
  assert.equal(p.heading, 100);
  assert.equal(p.declination, 0);
  fixEnu(0, 0, 5);
  p = engine.getPose();
  assert.equal(p.headingSource, 'wmm');
  assert.ok(Math.abs(p.heading - 113.2) < 1e-9 && p.magHeading === 100 && p.declination === 13.2);
  settings.declination = 12;
  engine.poseDirty = true;
  assert.equal(engine.getPose().headingSource, 'setting');
  assert.equal(engine.getPose().heading, 112);
  engine.setContext({ project: project({ compassOffset: -3.5 }), level: level() });
  p = engine.getPose();
  assert.equal(p.headingSource, 'compass-aligned');
  assert.equal(p.heading, 96.5);
  assert.equal(p.headingAcc, 5);
  engine.stop();
});

test('a project without an origin: the first fix ≤ 50 m becomes it (onOrigin once), ENU is relative to it', () => {
  const { engine, env, fix } = makeEngine();
  const calls = [];
  const p = { id: 'pX', origin: null, compassOffset: null };
  engine.setContext({ project: p, level: level(), onOrigin: (g) => calls.push(g) });
  engine.start();
  const far = fromEnu(SAC, 300, 0);
  fix(far.lat, far.lng, 80);
  assert.equal(calls.length, 0, 'an 80 m fix is not good enough for the origin');
  assert.equal(engine.getPose().enu, null, 'no ENU without an origin');
  env.advance(1000);
  fix(SAC.lat, SAC.lng, 12);
  assert.equal(calls.length, 1);
  assert.ok(Math.abs(calls[0].lat - SAC.lat) < 1e-12);
  const pose = engine.getPose();
  assert.ok(pose.enu, 'ENU relative to the new origin');
  env.advance(1000);
  fix(SAC.lat, SAC.lng, 5);
  engine.setContext({ project: p, level: level(), onOrigin: (g) => calls.push(g) }); // origin not saved yet
  assert.equal(calls.length, 1, 'asked once');
  engine.setContext({ project: { ...p, origin: { ...calls[0], setAt: 2 } }, level: level(), onOrigin: (g) => calls.push(g) });
  assert.equal(calls.length, 1);
  assert.ok(engine.getPose().enu && Math.hypot(engine.getPose().enu.e, engine.getPose().enu.n) < 30);
  engine.stop();
});

test('plan position and plan heading: calibration module when given, the matrices otherwise', () => {
  // Matrices only (calibration.js not loaded).
  const { engine, env, fixEnu, ori } = makeEngine({ settings: { declination: 0 } });
  engine.setContext({ project: project(), level: level(NORTH_UP) });
  engine.start();
  fixEnu(3, 4, 5);
  ori.emit('orientation', { t: env.now(), magHeading: 90, headingAcc: null, pitch: 0, roll: 0, facing: 'camera', walkHeading: 90, raw: null });
  let p = engine.getPose();
  assert.ok(Math.abs(p.plan.x - 530) < 1e-6 && Math.abs(p.plan.y - 360) < 1e-6, `${p.plan.x},${p.plan.y}`);
  assert.ok(Math.abs(p.planAcc - p.geo.acc * 10) < 1e-9);
  assert.equal(p.planHeading, 90);
  engine.stop();
  // A rotated plan: north is 30° clockwise from plan-up.
  const c = Math.cos(Math.PI / 6) * 10, s = Math.sin(Math.PI / 6) * 10;
  const ROT = { ...NORTH_UP, toPlan: [c, s, s, -c, 0, 0], northAngle: 30 };
  assert.ok(Math.abs(planHeadingFromCalibration(ROT, 0) - 30) < 1e-9);
  assert.ok(Math.abs(planHeadingFromCalibration(ROT, 90) - 120) < 1e-9);
  assert.deepEqual(enuToPlanMatrix(NORTH_UP, { e: 1, n: 1 }), { x: 510, y: 390 });
  // With a calibration module, its answers are used.
  const mod = {
    enuToPlan: (cal, enu) => ({ x: 1000 + enu.e, y: 2000 + enu.n }),
    planToEnu: (cal, pt) => ({ e: pt.x - 1000, n: pt.y - 2000 }),
    headingToPlan: (cal, h) => (h + 30) % 360,
  };
  const m = makeEngine({ settings: { declination: 0 }, calibration: mod });
  m.engine.setContext({ project: project(), level: level(ROT) });
  m.engine.start();
  m.fixEnu(3, 4, 5);
  m.ori.emit('orientation', { t: m.env.now(), magHeading: 10, headingAcc: null, pitch: 0, roll: 0, facing: 'camera', walkHeading: 10, raw: null });
  p = m.engine.getPose();
  assert.ok(Math.abs(p.plan.x - 1003) < 1e-6 && Math.abs(p.plan.y - 2004) < 1e-6);
  assert.equal(p.planHeading, 40);
  const fixed = m.engine.fixHere({ plan: { x: 1010, y: 2010 } });
  assert.ok(Math.abs(fixed.enu.e - 10) < 1e-9 && Math.abs(fixed.enu.n - 10) < 1e-9);
  m.engine.stop();
});

test('poses come at most 10 a second from the compass, and at once on a GPS fix', () => {
  const { engine, env, fixEnu, ori } = makeEngine();
  engine.setContext({ project: project(), level: level() });
  engine.start();
  fixEnu(0, 0, 5);
  let count = 0;
  engine.on('pose', () => count++);
  for (let i = 0; i < 60; i++) {
    env.advance(16);
    ori.emit('orientation', { t: env.now(), magHeading: i, headingAcc: null, pitch: 0, roll: 0, facing: 'camera', walkHeading: i, raw: null });
  }
  env.advance(200);
  assert.ok(count >= 8 && count <= 11, `${count} poses in ~1.2 s`);
  const before = count;
  fixEnu(1, 1, 5);
  assert.equal(count, before + 1, 'a fix emits at once');
  engine.stop();
  assert.equal(env.pending(), 0, 'stop() leaves no timers behind');
});

test('sampleStationary: weighted mean, honest accuracy (no √n), runs to maxSeconds when the target is out of reach', async () => {
  const { engine, env, fixEnu, mot } = makeEngine();
  engine.setContext({ project: project(), level: level() });
  engine.start();
  mot.state = 'stationary';
  const g = gaussFrom(21);
  let be = 1.5, bn = -1;
  const progress = [];
  const p = engine.sampleStationary({ minSeconds: 8, maxSeconds: 30, targetAcc: 1.0, onProgress: (x) => progress.push(x) });
  for (let i = 0; i < 31; i++) {
    env.advance(1000);
    be = be * Math.exp(-1 / 60) + 2 * Math.sqrt(1 - Math.exp(-2 / 60)) * g();
    bn = bn * Math.exp(-1 / 60) + 2 * Math.sqrt(1 - Math.exp(-2 / 60)) * g();
    fixEnu(5 + be + 1.2 * g(), -7 + bn + 1.2 * g(), 5);
  }
  const r = await p;
  assert.ok(r.n >= 18 && r.n <= 21, `kept ${r.n} of ~30 (the settling third dropped)`);
  assert.ok(Math.hypot(r.enu.e - 5, r.enu.n + 7) < 4, `mean ${r.enu.e},${r.enu.n}`);
  // 20 fixes of σ 2.5 m: √n would claim 0.56 m. Correlated error allows only a little gain.
  assert.ok(r.acc > 1.8 && r.acc <= 2.5 + 1e-9, `acc ${r.acc}`);
  assert.ok(r.nEff >= 1 && r.nEff < 2, `nEff ${r.nEff}`);
  assert.ok(r.spread > 0 && r.spread < 6);
  assert.ok(Math.abs(r.lat - fromEnu(SAC, r.enu.e, r.enu.n).lat) < 1e-9);
  assert.ok(r.fixes.length >= 29 && r.fixes.length <= 30, `${r.fixes.length} fixes kept for the record`);
  assert.ok(progress.length > 20 && typeof progress[0].finish === 'function');
  assert.ok(progress.some((x) => x.remaining < 1));
  engine.stop();
});

test('sampleStationary: finishes early at targetAcc but never before minSeconds; finish() waits for minSeconds', async () => {
  const { engine, env, fixEnu, mot } = makeEngine();
  engine.setContext({ project: project(), level: level() });
  engine.start();
  mot.state = 'stationary';
  const t0 = env.now();
  let resolvedAt = null;
  const p = engine.sampleStationary({ minSeconds: 8, maxSeconds: 30, targetAcc: 4 }).then((r) => { resolvedAt = env.now(); return r; });
  for (let i = 0; i < 12; i++) { env.advance(1000); fixEnu(0, 0, 5); await null; }
  const r = await p;
  assert.ok(resolvedAt - t0 >= 8000 && resolvedAt - t0 <= 9000, `resolved after ${(resolvedAt - t0) / 1000} s`);
  assert.ok(r.acc <= 4);

  const t1 = env.now();
  let at2 = null;
  const p2 = engine.sampleStationary({ minSeconds: 5, maxSeconds: 30, targetAcc: 0.01 });
  p2.then(() => { at2 = env.now(); });
  env.advance(1000); fixEnu(0, 0, 5);
  p2.finish(); // "Done" pressed after 1 s
  await null;
  assert.equal(at2, null, 'not before minSeconds');
  for (let i = 0; i < 6; i++) { env.advance(1000); fixEnu(0, 0, 5); await null; }
  await p2;
  assert.ok(at2 - t1 >= 5000 && at2 - t1 <= 6000);
  engine.stop();
});

test('sampleStationary: abort rejects and cleans up; no fixes at all is a plain error', async () => {
  const { engine, env, fixEnu } = makeEngine();
  engine.setContext({ project: project(), level: level() });
  engine.start();
  const ac = new AbortController();
  const p = engine.sampleStationary({ signal: ac.signal });
  env.advance(1000); fixEnu(0, 0, 5);
  ac.abort();
  await assert.rejects(p, (err) => err.name === 'AbortError');
  assert.equal(engine._h.get('fix')?.size || 0, 0, 'the fix listener is gone');
  const ac2 = new AbortController(); ac2.abort();
  await assert.rejects(engine.sampleStationary({ signal: ac2.signal }), (err) => err.name === 'AbortError');
  const p3 = engine.sampleStationary({ minSeconds: 2, maxSeconds: 4 });
  env.advance(5000);
  await assert.rejects(p3, /No GPS fix came in/);
  engine.stop();
});

test('sampleHeading: circular mean across north, spread, and true heading with the declination in use', async () => {
  const { engine, env, ori } = makeEngine({ settings: { declination: 13 } });
  engine.setContext({ project: project(), level: level() });
  engine.start();
  const progress = [];
  const p = engine.sampleHeading({ seconds: 3, onProgress: (x) => progress.push(x) });
  const g = gaussFrom(3);
  for (let i = 0; i < 180; i++) {
    env.advance(16.7);
    const h = (360 + 2 * g()) % 360;
    ori.emit('orientation', { t: env.now(), magHeading: h, headingAcc: null, pitch: 0, roll: 0, facing: 'camera', walkHeading: h, raw: null });
  }
  env.advance(500);
  const r = await p;
  assert.ok(Math.min(r.magnetic, 360 - r.magnetic) < 0.6, `mean ${r.magnetic}`);
  assert.ok(r.spread > 1 && r.spread < 3, `spread ${r.spread}`);
  assert.ok(Math.abs(r.true - ((r.magnetic + 13) % 360)) < 1e-9);
  assert.equal(r.headingSource, 'setting');
  assert.equal(r.facing, 'camera');
  assert.ok(progress.length >= 10);
  // A phone held still on Chrome sends no events at all: the last reading is sampled.
  ori.emit('orientation', { t: env.now(), magHeading: 42, headingAcc: null, pitch: 0, roll: 0, facing: 'camera', walkHeading: 42, raw: null });
  const still = engine.sampleHeading({ seconds: 2 });
  env.advance(2500);
  const rs = await still;
  assert.ok(Math.abs(rs.magnetic - 42) < 1e-9);
  assert.ok(rs.spread < 1e-6);
  assert.ok(rs.n >= 30, `${rs.n} samples`);
  // No compass readings → a plain error.
  ori.emit('orientation', { t: env.now(), magHeading: null, headingAcc: null, pitch: 0, roll: 0, facing: 'camera', walkHeading: null, raw: null });
  const p2 = engine.sampleHeading({ seconds: 1 });
  env.advance(1500);
  await assert.rejects(p2, /compass is not giving a direction/);
  engine.stop();
});

test('status: plain messages for waiting, blocked location (iPhone wording), and a working setup', () => {
  const { engine, gps, env, fixEnu } = makeEngine({ ios: true });
  engine.setContext({ project: project(), level: level() });
  engine.start();
  gps.status = 'waiting';
  assert.equal(engine.getStatus().gps, 'waiting');
  assert.equal(engine.getStatus().message, 'Waiting for GPS — step outside or near a window');
  gps.status = 'denied';
  let s = engine.getStatus();
  assert.equal(s.gps, 'denied');
  assert.match(s.message, /Location is blocked — allow it in Settings > Safari > Location/);
  assert.equal(s.level, 'error');
  gps.status = 'ok';
  fixEnu(0, 0, 4);
  s = engine.getStatus();
  assert.equal(s.gps, 'ok');
  assert.equal(s.compass, 'ok');
  assert.match(s.message, /^Position ±2\.0 m · compass on$/);
  env.advance(TUNING.gpsLostMs + 1000);
  assert.match(engine.getStatus().message, /GPS signal lost/);
  engine.stop();
  assert.equal(engine.getStatus().gps, 'off');
});

test('requestPermission makes the browser calls synchronously (inside the tap) and hands the answers to the sources', async () => {
  const calls = [];
  const win = {
    DeviceOrientationEvent: { requestPermission: (a) => { calls.push('orientation'); return Promise.resolve('granted'); } },
    DeviceMotionEvent: { requestPermission: () => { calls.push('motion'); return Promise.resolve('granted'); } },
  };
  const { engine, ori } = makeEngine({ win });
  engine.start();
  const p = engine.requestPermission();
  assert.deepEqual(calls, ['orientation', 'motion']);
  assert.equal(await p, true);
  assert.equal(ori.perm, 'granted');
  engine.stop();
});

test('createGpsSource: the exact watch options; fixes, denial and a missing API', () => {
  let opts = null, success = null, failure = null, cleared = 0;
  const geolocation = {
    watchPosition(s, f, o) { success = s; failure = f; opts = o; return 7; },
    clearWatch(id) { if (id === 7) cleared++; },
  };
  const env = fakeEnv();
  const src = createGpsSource({ geolocation, now: env.now, timers: env.timers, win: {} });
  const fixes = [];
  src.on('fix', (f) => fixes.push(f));
  src.start();
  assert.deepEqual(opts, { enableHighAccuracy: true, maximumAge: 0, timeout: 27000 });
  assert.deepEqual({ ...GPS_OPTIONS }, opts);
  assert.equal(src.getStatus(), 'waiting');
  success({ coords: { latitude: 1, longitude: 2, accuracy: 4.7, altitude: null, altitudeAccuracy: null, speed: -1, heading: null }, timestamp: env.now() - 500 });
  assert.equal(src.getStatus(), 'ok');
  assert.equal(fixes[0].acc, 4.7);
  assert.equal(fixes[0].speed, null, 'negative speed means unknown');
  assert.equal(fixes[0].t, env.now() - 500);
  // A timestamp on another clock is replaced by the arrival time.
  success({ coords: { latitude: 1, longitude: 2, accuracy: 5 }, timestamp: 1000 });
  assert.equal(fixes[1].t, env.now());
  // iOS: altitudeAccuracy 0 means the altitude is not valid.
  success({ coords: { latitude: 1, longitude: 2, accuracy: 5, altitude: 31, altitudeAccuracy: 0 }, timestamp: env.now() });
  assert.equal(fixes[2].alt, null);
  success({ coords: { latitude: 1, longitude: 2, accuracy: 5, altitude: 31, altitudeAccuracy: 4 }, timestamp: env.now() });
  assert.equal(fixes[3].alt, 31);
  // Timeouts under a roof do not end (or restart) the watch: only a denial does.
  for (let i = 0; i < 8; i++) { env.advance(27000); failure({ code: 3, message: 'timeout' }); }
  assert.equal(cleared, 0, 'a watch that keeps answering is left alone');
  assert.notEqual(src.getStatus(), 'denied');
  // Completely silent for two minutes (no fix, no error): the watch is started again.
  env.advance(TUNING.restartWatchMs + 6000);
  assert.ok(cleared >= 1);
  assert.equal(src.getStatus(), 'waiting');
  failure({ code: 1, message: 'denied' });
  assert.equal(src.getStatus(), 'denied');
  src.stop();
  assert.equal(src.getStatus(), 'off');
  assert.equal(env.pending(), 0);
  const none = createGpsSource({ geolocation: null, now: env.now, timers: env.timers, win: {} });
  none.start();
  assert.equal(none.getStatus(), 'unavailable');
  assert.equal(none.getReason(), 'no-api');
  const insecure = createGpsSource({ geolocation, now: env.now, timers: env.timers, win: { isSecureContext: false } });
  insecure.start();
  assert.equal(insecure.getReason(), 'insecure');
});

// ---- demo mode ---------------------------------------------------------------------------------

test('sim: a seeded walker loops at walking pace with ~1.8 steps/s and realistic GPS noise', () => {
  const env = fakeEnv();
  const sim = createSimulator({ origin: SAC, seed: 7, now: env.now, timers: env.timers, autoRun: false, declination: () => 13 });
  const fixes = [], steps = [], ori = [];
  sim.gps.on('fix', (f) => fixes.push({ ...f, truth: sim.truth() }));
  sim.motion.on('step', (s) => steps.push(s));
  sim.orientation.on('orientation', (o) => ori.push(o));
  sim.gps.start(); sim.orientation.start(); sim.motion.start();
  for (let i = 0; i < 2400; i++) { env.advance(50); sim.tick(); } // 120 s
  assert.ok(fixes.length >= 118 && fixes.length <= 121, `${fixes.length} fixes`);
  assert.ok(steps.length > 150 && steps.length < 216, `${steps.length} steps`);
  const errs = fixes.map((f) => { const p = toEnu(SAC, f.lat, f.lng); return Math.hypot(p.e - f.truth.e, p.n - f.truth.n); });
  const rms = Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length);
  assert.ok(rms > 1 && rms < 15, `GPS error RMS ${rms}`);
  assert.ok(fixes.every((f) => f.acc >= 3 && f.acc < 30));
  // Magnetic heading = true walking direction − declination, while walking straight.
  const walking = ori.filter((o) => o.facing === 'camera').slice(0, 40);
  assert.ok(walking.length > 10 && walking.every((o) => o.raw.src === 'sim'));
  // The loop route is a rectangle around the origin.
  assert.equal(loopRoute().length, 4);
  sim.gps.stop(); sim.orientation.stop(); sim.motion.stop();
  assert.equal(sim.isRunning(), false);
  // Same seed, same walk.
  const a = createSimulator({ seed: 3, now: () => 0, autoRun: false, declination: () => 0 });
  const b = createSimulator({ seed: 3, now: () => 0, autoRun: false, declination: () => 0 });
  assert.deepEqual(a.truth(), b.truth());
  assert.equal(createRng(5).next(), createRng(5).next());
});

test('demo mode end to end: the engine follows the simulated walker, poses say "sim", toggling restarts the sources', () => {
  const env = fakeEnv();
  let sim = null;
  const s = { stepLength: 0.72, declination: null, simulate: false, units: 'metric' };
  const bus = new Emitter();
  const realGps = fakeSource({ getReason: () => '' });
  const engine = createPositioning({
    now: env.now,
    timers: env.timers,
    getSettings: () => s,
    bus,
    win: () => ({}),
    geolocation: () => null,
    createGps: () => realGps,
    createOrientation: () => fakeSource({ getHint: () => '', needsPermission: () => false }),
    createMotion: () => fakeSource({ getState: () => 'unknown', needsPermission: () => false }),
    createSim: (o) => (sim = createSimulator({ ...o, seed: 11, autoRun: false })),
    loadCalibration: null,
    declination: () => 13,
    isIOS: () => false,
  });
  const origins = [];
  engine.setContext({ project: { id: 'demo', origin: null, mapView: { lat: 40, lng: -105, zoom: 18 } }, level: level(), onOrigin: (g) => origins.push(g) });
  engine.start();
  assert.equal(realGps.running, true);
  s.simulate = true;
  bus.emit('settings:change', s);
  assert.equal(realGps.running, false, 'real GPS stopped');
  assert.ok(sim && sim.isRunning());
  assert.ok(Math.abs(sim.origin.lat - 40) < 1e-9, 'walks where the map was looking');
  const errs = [];
  let walkingHeadingErr = [];
  for (let i = 0; i < 3600; i++) { // 180 s
    env.advance(50);
    sim.tick();
    if (i > 600 && i % 20 === 0) {
      const p = engine.getPose();
      const tr = sim.truth();
      const at = toEnu(sim.origin, p.geo.lat, p.geo.lng);
      errs.push(Math.hypot(at.e - tr.e, at.n - tr.n));
      if (tr.walking && p.facing === 'camera' && p.heading != null) walkingHeadingErr.push(Math.abs(((p.heading - tr.heading + 540) % 360) - 180));
    }
  }
  const p = engine.getPose();
  assert.equal(p.source, 'sim');
  assert.equal(origins.length, 1, 'the demo walk set the project origin once');
  const rms = Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length);
  assert.ok(rms < 6, `position error RMS ${rms.toFixed(2)} m`);
  const medH = walkingHeadingErr.sort((a, b) => a - b)[Math.floor(walkingHeadingErr.length / 2)];
  assert.ok(medH < 15, `median heading error while walking ${medH}`);
  assert.equal(p.headingSource, 'wmm');
  assert.equal(engine.getStatus().simulated, true);
  assert.match(engine.getStatus().message, /Demo mode/);
  s.simulate = false;
  bus.emit('settings:change', s);
  assert.equal(sim.isRunning(), false);
  assert.equal(realGps.running, true);
  engine.stop();
  assert.equal(env.pending(), 0);
  assert.equal(SACRAMENTO.lat, 38.5816);
});
