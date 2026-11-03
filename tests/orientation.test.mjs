// orientation.test.mjs — camera heading, tilt, roll and the iPhone compass offset (js/core/orientation.js).
//
// The wedge on every photo pin comes from these numbers; the checks below
// are the ones docs/RESEARCH.md derives from the W3C rotation matrix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cameraPose, rotationMatrix, createIosOffsetLearner, createAngleSmoother, requestSensorPermission,
  createOrientationSource, screenAngle, eventTime, FACING_TOP_ENTER, FACING_TOP_EXIT,
} from '../js/core/orientation.js';

const angClose = (a, b, tol = 1e-6, msg = '') => {
  const d = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  assert.ok(d <= tol, `${msg} ${a} vs ${b} (±${tol})`);
};
const close = (a, b, tol = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b} (±${tol})`);

test('cameraPose: the numeric checks from docs/RESEARCH.md', () => {
  let p = cameraPose(0, 90, 0);
  angClose(p.camHeading, 0); close(p.pitch, 0); assert.equal(p.facing, 'camera');
  angClose(cameraPose(30, 90, 20).camHeading, 310);
  const lh = cameraPose(90, 0, -90);
  angClose(lh.camHeading, 0, 1e-9);
  close(lh.holdAngle, 90, 1e-9);
  close(cameraPose(0, 90, 0).holdAngle, 0, 1e-9);
  close(cameraPose(0, 90, 0, 0).holdAngle, 0, 1e-9);
  close(cameraPose(0, 60, 0).pitch, -30);
  close(cameraPose(0, 120, 0).pitch, 30);
  p = cameraPose(0, 0, 0);
  close(p.pitch, -90);
  assert.ok(Number.isFinite(p.camHeading), 'flat phone: atan2, never NaN');
  // gamma = 0: camera heading is −alpha for any tilt short of flat.
  for (const [a, b] of [[10, 30], [200, 80], [359, 100], [90, 150]]) angClose(cameraPose(a, b, 0).camHeading, 360 - a, 1e-9, `${a},${b}`);
  // beta = 90: −(alpha + gamma).
  for (const [a, g] of [[0, 45], [100, -30], [250, 80]]) angClose(cameraPose(a, 90, g).camHeading, -(a + g), 1e-9);
});

test('rotation matrix columns are the device axes in east/north/up', () => {
  // Upright portrait, camera north: x east, y up, z south.
  const m = rotationMatrix(0, 90, 0);
  close(m[0], 1); close(m[3], 0); close(m[6], 0);       // x
  close(m[1], 0); close(m[4], 0, 1e-12); close(m[7], 1); // y
  close(m[2], 0); close(m[5], -1); close(m[8], 0, 1e-12); // z
});

test('flat phone: facing "top", heading = where the picture top points (rotation-aware)', () => {
  // Lying face up, top edge toward west (alpha 90).
  let p = cameraPose(90, 0, 0, 0);
  assert.equal(p.facing, 'top');
  angClose(p.topHeading, 270); angClose(p.upHeading, 270); angClose(p.heading, 270);
  assert.equal(p.planHeading, p.heading);
  assert.equal(p.roll, null, 'roll means nothing when looking straight down');
  // Flat, gravity cannot tell how it is held: the last hold angle (or the screen angle) decides.
  assert.equal(p.holdOK, false);
  angClose(cameraPose(90, 0, 0, 0, { holdFallback: 90 }).upHeading, 0);
  // Same phone in landscape (screen turned 90°): the picture's top is the device's right side → north.
  p = cameraPose(90, 0, 0, 90);
  angClose(p.upHeading, 0); angClose(p.heading, 0); angClose(p.topHeading, 270);
  // Hysteresis around the switch.
  const at = (pitchDeg, prev) => cameraPose(0, 90 + pitchDeg, 0, 0, { facingPrev: prev }).facing;
  assert.equal(at(-(FACING_TOP_ENTER - 2), 'camera'), 'camera');
  assert.equal(at(-(FACING_TOP_ENTER + 2), 'camera'), 'top');
  assert.equal(at(-(FACING_TOP_EXIT + 3), 'top'), 'top');
  assert.equal(at(-(FACING_TOP_EXIT - 3), 'top'), 'camera');
});

test('roll: level is 0, turning the phone clockwise is positive, landscape is level', () => {
  close(cameraPose(0, 90, 0, 0).roll, 0, 1e-9);
  // Tilted back 20° and turned about the long axis: the right edge (device x) dips
  // below the left (m31 < 0) — clockwise as the person sees the screen — so roll > 0.
  const p = cameraPose(0, 70, 20, 0);
  const m31 = rotationMatrix(0, 70, 20)[6];
  assert.ok(m31 < 0 && p.roll > 0, `roll ${p.roll}`);
  assert.ok(cameraPose(0, 70, -20, 0).roll < 0);
  // Held upright in landscape (gamma −90 at beta 0 points device x up) with the screen
  // turned 90°: the picture is level and the camera looks at the horizon.
  const l = cameraPose(0, 0, -90, 90);
  close(Math.abs(l.pitch), 0, 1e-6);
  close(l.roll, 0, 1e-6);
  // Under rotation lock the screen still says 0, but gravity says landscape: still level.
  const locked = cameraPose(0, 0, -90, 0);
  close(locked.roll, 0, 1e-6);
  assert.equal(locked.holdOK, true);
  close(locked.holdAngle, 90, 1e-6);
  assert.equal(locked.imageAngle, 90);
});

test('iOS offset learner: learns flat, holds while raised, re-learns when lowered', () => {
  const offset = 123.4;
  const L = createIosOffsetLearner();
  // Phone flat-ish, top edge magnetic heading 320 → absolute alpha 40 → iOS relative alpha 40 + offset.
  const ev = (absAlpha, beta, gamma, compass, compassAcc, t) => ({ alpha: (absAlpha + offset) % 360, beta, gamma, compass, compassAcc, t });
  let t = 0;
  for (let i = 0; i < 30; i++) L.update(ev(40, 10, 5, 320, 10, (t += 16)));
  assert.equal(L.quality, 'learned');
  close(L.offset, offset, 1e-9);
  // Raised to shoot (upright): whatever the compass says there is ignored; heading comes from alpha.
  for (let i = 0; i < 60; i++) L.update(ev(40, 88, 0, 200 /* undocumented upright value */, 10, (t += 16)));
  close(L.offset, offset, 1e-9);
  const abs = L.absAlpha((40 + offset) % 360);
  angClose(abs, 40, 1e-9);
  angClose(cameraPose(abs, 88, 0).camHeading, 320, 1e-6, 'camera heading upright');
  // Gyro drift of 3° appears while raised; lowering for a second fixes it.
  const drifted = offset + 3;
  t += 25_000; // long enough to catch up quickly
  for (let i = 0; i < 60; i++) L.update({ alpha: (40 + drifted) % 360, beta: 12, gamma: -4, compass: 320, compassAcc: 12, t: (t += 16) });
  close(L.offset, drifted, 0.05);
  // Bad accuracy is ignored.
  const before = L.offset;
  L.update({ alpha: 10, beta: 0, gamma: 0, compass: 100, compassAcc: 40, t: (t += 16) });
  L.update({ alpha: 10, beta: 0, gamma: 0, compass: 100, compassAcc: -1, t: (t += 16) });
  L.update({ alpha: 10, beta: 0, gamma: 0, compass: -1, compassAcc: 5, t: (t += 16) });
  assert.equal(L.offset, before);
});

test('iOS offset learner: smooths noisy compass on the circle across north', () => {
  const L = createIosOffsetLearner();
  let t = 0;
  let s = 7;
  const noise = () => { s = (s * 16807) % 2147483647; return (s / 2147483647 - 0.5) * 8; }; // ±4°
  // True offset 179 (wraps through ±180 with noise).
  for (let i = 0; i < 600; i++) {
    const abs = 2; // top edge at 358 → near north
    L.update({ alpha: (abs + 179) % 360, beta: 5, gamma: 3, compass: (358 + noise() + 360) % 360, compassAcc: 15, t: (t += 16) });
  }
  angClose(L.offset, 179, 0.8);
});

test('iOS offset learner: a reading-angle hold gives a provisional offset, replaced by the first flat one', () => {
  const L = createIosOffsetLearner();
  L.update({ alpha: 100, beta: 50, gamma: 10, compass: 300, compassAcc: 10, t: 0 });
  assert.equal(L.quality, 'provisional');
  angClose(L.offset, 100 - 60, 1e-9);
  L.update({ alpha: 100, beta: 10, gamma: 0, compass: 310, compassAcc: 10, t: 16 });
  assert.equal(L.quality, 'learned');
  angClose(L.offset, 100 - 50, 1e-9);
  // Nothing learns while upright, not even provisionally.
  const U = createIosOffsetLearner();
  U.update({ alpha: 100, beta: 85, gamma: 0, compass: 300, compassAcc: 10, t: 0 });
  assert.equal(U.offset, null);
  assert.equal(U.absAlpha(100), null);
});

test('angle smoother never sweeps the long way across 0/360 and follows a fast turn', () => {
  const s = createAngleSmoother({ tau: 0.12, snapDeg: 50 });
  let prev = s.update(355, 0);
  for (let t = 16; t < 1000; t += 16) {
    const v = s.update(5, t);
    const step = Math.abs((((v - prev) % 360) + 540) % 360 - 180);
    assert.ok(step < 3, `jumped ${step}° at ${v}`);
    assert.ok(v >= 355 || v <= 5.0001, `left the short arc: ${v}`);
    prev = v;
  }
  angClose(prev, 5, 0.01);
  // A 120° spin: most of it within 0.1 s (fast follow above snapDeg), settled within ~0.5 s.
  for (let t = 1000; t < 1100; t += 16) prev = s.update(125, t);
  angClose(prev, 125, 40);
  for (let t = 1100; t < 1500; t += 16) prev = s.update(125, t);
  angClose(prev, 125, 2);
  // A long pause starts fresh.
  assert.equal(s.update(270, 5000), 270);
});

test('requestSensorPermission calls both requestPermission() synchronously (iOS tap rule)', async () => {
  const calls = [];
  const win = {
    DeviceOrientationEvent: { requestPermission(...args) { calls.push(['orientation', args.length]); return Promise.resolve('granted'); } },
    DeviceMotionEvent: { requestPermission(...args) { calls.push(['motion', args.length]); return Promise.resolve('granted'); } },
  };
  const p = requestSensorPermission(win);
  assert.deepEqual(calls, [['orientation', 0], ['motion', 0]], 'both were called before any await, with no argument (neither engine takes one)');
  assert.deepEqual(await p, { orientation: 'granted', motion: 'granted' });
  // No gesture: NotAllowedError → 'prompt'. A refusal → 'denied'. No function → allowed.
  const err = Object.assign(new Error('needs a gesture'), { name: 'NotAllowedError' });
  const w2 = { DeviceOrientationEvent: { requestPermission: () => Promise.reject(err) }, DeviceMotionEvent: { requestPermission: () => Promise.resolve('denied') } };
  assert.deepEqual(await requestSensorPermission(w2), { orientation: 'prompt', motion: 'denied' });
  assert.deepEqual(await requestSensorPermission({}), { orientation: 'granted', motion: 'granted' });
  const w3 = { DeviceOrientationEvent: { requestPermission: () => { throw new TypeError('boom'); } } };
  assert.equal((await requestSensorPermission(w3)).orientation, 'error');
});

test('screenAngle and eventTime read the browser safely', () => {
  assert.equal(screenAngle({ screen: { orientation: { angle: 90 } } }), 90);
  assert.equal(screenAngle({ orientation: -90 }), 270);
  assert.equal(screenAngle({}), 0);
  assert.equal(eventTime({ timeStamp: 1500 }, { performance: { timeOrigin: 1_700_000_000_000 } }), 1_700_000_001_500);
  assert.equal(eventTime({ timeStamp: 1_700_000_000_123 }, {}), 1_700_000_000_123);
  assert.equal(eventTime({}, {}, () => 42), 42);
});

// ---- the runtime source on a fake window ----------------------------------------------------

function fakeWindow({ absolute = false, requestPermission = null } = {}) {
  const handlers = new Map();
  const docHandlers = new Set();
  const win = {
    document: {
      visibilityState: 'visible',
      addEventListener(type, fn) { if (type === 'visibilitychange') docHandlers.add(fn); },
      removeEventListener(type, fn) { if (type === 'visibilitychange') docHandlers.delete(fn); },
    },
    setVisible(v) { win.document.visibilityState = v ? 'visible' : 'hidden'; for (const fn of [...docHandlers]) fn(); },
    docListeners: () => docHandlers.size,
    performance: { timeOrigin: 1_700_000_000_000 },
    screen: { orientation: { angle: 0 } },
    DeviceOrientationEvent: requestPermission ? { requestPermission } : function DeviceOrientationEvent() {},
    addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); },
    removeEventListener(type, fn) { handlers.get(type)?.delete(fn); },
    fire(type, e) { for (const fn of [...(handlers.get(type) || [])]) fn(e); },
    count(type) { return handlers.get(type)?.size || 0; },
  };
  if (absolute) win.ondeviceorientationabsolute = null;
  return win;
}
const fakeTimers = () => {
  const pending = new Map(); let id = 0;
  return { setTimeout: (fn, ms) => { pending.set(++id, fn); return id; }, clearTimeout: (i) => pending.delete(i), fireAll() { for (const [i, fn] of [...pending]) { pending.delete(i); fn(); } } };
};

test('Android: deviceorientationabsolute gives a magnetic camera heading; null alpha means no compass', () => {
  const win = fakeWindow({ absolute: true });
  const timers = fakeTimers();
  const src = createOrientationSource({ win, timers });
  const got = [];
  src.on('orientation', (o) => got.push(o));
  src.start();
  assert.equal(win.count('deviceorientationabsolute'), 1);
  for (let i = 0; i < 20; i++) win.fire('deviceorientationabsolute', { alpha: 30, beta: 90, gamma: 20, absolute: true, timeStamp: 100 + i * 16 });
  // The relative event is ignored while absolute data flows.
  win.fire('deviceorientation', { alpha: 200, beta: 90, gamma: 0, absolute: false, timeStamp: 450 });
  const o = got[got.length - 1];
  angClose(o.magHeading, 310, 0.01);
  close(o.pitch, 0, 0.01);
  assert.equal(o.facing, 'camera');
  assert.equal(o.raw.src, 'abs');
  assert.equal(o.raw.absolute, true);
  assert.equal(o.headingAcc, null);
  close(o.raw.holdAngle, 0, 1e-6);
  assert.equal(src.getStatus(), 'ok');
  // Chrome sends nothing while the phone is still: the last reading stays.
  assert.equal(src.getLast(), o);
  src.stop();
  assert.equal(win.count('deviceorientationabsolute'), 0);

  const w2 = fakeWindow({ absolute: true });
  const s2 = createOrientationSource({ win: w2, timers: fakeTimers() });
  s2.start();
  w2.fire('deviceorientationabsolute', { alpha: null, beta: null, gamma: null, timeStamp: 10 });
  assert.equal(s2.getStatus(), 'unavailable');
  // Tilt still comes through the relative event; the heading stays unknown.
  const seen = [];
  s2.on('orientation', (x) => seen.push(x));
  w2.fire('deviceorientation', { alpha: 12, beta: 60, gamma: 0, absolute: false, timeStamp: 30 });
  assert.equal(seen[0].magHeading, null);
  close(seen[0].pitch, -30, 1e-6);
  assert.equal(seen[0].raw.src, 'rel');
});

test('iPhone: recognised by webkitCompassHeading; learns flat, then gives the camera heading upright', () => {
  const win = fakeWindow({ requestPermission: () => Promise.resolve('granted') });
  const src = createOrientationSource({ win, timers: fakeTimers() });
  const got = [];
  src.on('orientation', (o) => got.push(o));
  src.start();
  assert.equal(win.count('deviceorientationabsolute'), 0);
  const offset = 77;
  let ts = 100;
  // Upright first: no heading yet, a hint to hold the phone flat.
  win.fire('deviceorientation', { alpha: (40 + offset) % 360, beta: 89, gamma: 0, webkitCompassHeading: 300, webkitCompassAccuracy: 10, timeStamp: ts });
  assert.equal(got[0].magHeading, null);
  assert.match(src.getHint(), /flat/);
  // Lowered: top edge at magnetic 320 → absolute alpha 40.
  for (let i = 0; i < 40; i++) win.fire('deviceorientation', { alpha: (40 + offset) % 360, beta: 15, gamma: 5, webkitCompassHeading: 320, webkitCompassAccuracy: 10, timeStamp: (ts += 16) });
  // Raised to shoot, turned 30° right (absolute alpha 10 → camera heading 350).
  for (let i = 0; i < 40; i++) win.fire('deviceorientation', { alpha: (10 + offset) % 360, beta: 88, gamma: 0, webkitCompassHeading: 123, webkitCompassAccuracy: 10, timeStamp: (ts += 16) });
  const o = got[got.length - 1];
  angClose(o.magHeading, 350, 0.05);
  assert.equal(o.raw.src, 'ios');
  assert.equal(o.raw.compass, 123);
  close(o.raw.alphaOffset, offset, 1e-6);
  assert.ok(o.headingAcc >= 10);
  assert.equal(src.getStatus(), 'ok');
  // Uncalibrated compass.
  win.fire('deviceorientation', { alpha: 50, beta: 10, gamma: 0, webkitCompassHeading: 320, webkitCompassAccuracy: -1, timeStamp: (ts += 16) });
  assert.equal(src.getStatus(), 'uncalibrated');
  win.fire('deviceorientation', { alpha: 50, beta: 10, gamma: 0, webkitCompassHeading: 320, webkitCompassAccuracy: 12, timeStamp: (ts += 16) });
  assert.equal(src.getStatus(), 'ok');
  // A pause (app in the background) drops the offset: iOS restarts its reference.
  win.fire('deviceorientation', { alpha: 300, beta: 88, gamma: 0, webkitCompassHeading: 10, webkitCompassAccuracy: 10, timeStamp: (ts += 5000) });
  assert.equal(got[got.length - 1].magHeading, null);
  // Learn again, then hide and show the page (camera picker, app switch): the offset is dropped at once.
  for (let i = 0; i < 10; i++) win.fire('deviceorientation', { alpha: (40 + offset) % 360, beta: 15, gamma: 5, webkitCompassHeading: 320, webkitCompassAccuracy: 10, timeStamp: (ts += 16) });
  assert.notEqual(got[got.length - 1].magHeading, null);
  win.setVisible(false);
  assert.equal(src.getLast(), null);
  win.setVisible(true);
  win.fire('deviceorientation', { alpha: 123, beta: 88, gamma: 0, webkitCompassHeading: 10, webkitCompassAccuracy: 10, timeStamp: (ts += 16) });
  assert.equal(got[got.length - 1].magHeading, null, 'no heading until the phone is lowered again');
  assert.equal(got[got.length - 1].raw.alphaOffset, null);
  src.stop();
  assert.equal(win.docListeners(), 0, 'stop() removes the visibility listener');
});

test('iPhone without a tap yet: "needs-permission" until requestPermission() succeeds', async () => {
  let granted = false;
  const err = Object.assign(new Error('gesture'), { name: 'NotAllowedError' });
  const win = fakeWindow({ requestPermission: () => (granted ? Promise.resolve('granted') : Promise.reject(err)) });
  const src = createOrientationSource({ win, timers: fakeTimers() });
  const statuses = [];
  src.on('status', (s) => statuses.push(s));
  src.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(src.getStatus(), 'needs-permission');
  assert.equal(src.needsPermission(), true);
  granted = true;
  assert.equal(await src.requestPermission(), true);
  assert.equal(src.needsPermission(), false);
  win.fire('deviceorientation', { alpha: 10, beta: 10, gamma: 0, webkitCompassHeading: 350, webkitCompassAccuracy: 10, timeStamp: 10 });
  assert.equal(src.getStatus(), 'ok');
  assert.ok(statuses.includes('needs-permission') && statuses.includes('ok'));
  src.stop();
});

test('no sensor events at all (desktop) → "unavailable" after the watchdog; denied stays denied', async () => {
  const win = fakeWindow({ absolute: true });
  const timers = fakeTimers();
  const src = createOrientationSource({ win, timers });
  src.start();
  assert.equal(src.getStatus(), 'off');
  timers.fireAll();
  assert.equal(src.getStatus(), 'unavailable');
  src.stop();

  const w2 = fakeWindow({ requestPermission: () => Promise.resolve('denied') });
  const s2 = createOrientationSource({ win: w2, timers: fakeTimers() });
  s2.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(s2.getStatus(), 'denied');
  assert.equal(s2.needsPermission(), false);

  const s3 = createOrientationSource({ win: {}, timers: fakeTimers() });
  s3.start();
  assert.equal(s3.getStatus(), 'unavailable');
});
