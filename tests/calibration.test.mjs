// calibration.test.mjs — the plan ↔ ground math of js/core/calibration.js.
//
// Known transforms are built here independently of the solver: a plan with
// scale s (px per meter), north drawn at θ clockwise from plan "up", and a
// shift. In plan pixels (y down) a ground point (e, n) is at
//   x = s·( e·cosθ + n·sinθ) + tx
//   y = s·( e·sinθ − n·cosθ) + ty
// (θ = 0: north up, east right; θ = 90: north right, east down).
import 'fake-indexeddb/auto';   // only the last test touches the store
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import {
  solveCalibration, enuToPlan, planToEnu, headingToPlan, planHeadingToTrue,
  reprojectItems, describeQuality, describeWarnings, formatScale, planBearing,
  scaleLinePxPerMeter, applyAffine, invertAffine, qualityFor, averageFixes,
  combineSamples, GPS_SIGMA_FLOOR, QUALITY_GOOD_M, QUALITY_FAIR_M,
} from '../js/core/calibration.js';

// ---- helpers -----------------------------------------------------------------------------

/** A small seeded PRNG, so the noisy tests are the same on every run. */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.gauss = () => {
    const u = Math.max(next(), 1e-12), v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return next;
}

const D = Math.PI / 180;
function makeTruth(s, thetaDeg, tx, ty) {
  const c = Math.cos(thetaDeg * D), sn = Math.sin(thetaDeg * D);
  return {
    s, theta: thetaDeg, tx, ty,
    toPlan: ({ e, n }) => ({ x: s * (e * c + n * sn) + tx, y: s * (e * sn - n * c) + ty }),
  };
}
function randomTruth(r) {
  return makeTruth(5 + r() * 75, r() * 360, -2000 + r() * 6000, -2000 + r() * 6000);
}
function pairsFor(truth, enus, sigma = 2) {
  return enus.map((enu) => ({ plan: truth.toPlan(enu), enu: { ...enu }, sigma }));
}
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}, got ${a} (tol ${tol})`);
const angClose = (a, b, tol, msg) => {
  let d = ((a - b) % 360 + 540) % 360 - 180;
  assert.ok(Math.abs(d) <= tol, `${msg ?? ''} expected ${b}°, got ${a}° (tol ${tol})`);
};
const TRIANGLE = [{ e: 0, n: 0 }, { e: 40, n: 5 }, { e: 15, n: 35 }];

// ---- exact recovery --------------------------------------------------------------------------

test('recovers random known transforms exactly when there is no noise', () => {
  const r = rng(1);
  for (let trial = 0; trial < 200; trial++) {
    const truth = randomTruth(r);
    const n = 2 + Math.floor(r() * 6);
    const enus = Array.from({ length: n }, () => ({ e: -80 + r() * 160, n: -80 + r() * 160 }));
    // Make sure the points are not all on top of each other.
    enus[1] = { e: enus[0].e + 20 + r() * 40, n: enus[0].n - 10 + r() * 20 };
    const cal = solveCalibration({ pairs: pairsFor(truth, enus), method: 'gps' });
    close(cal.pxPerMeter, truth.s, truth.s * 1e-9, 'scale');
    angClose(cal.northAngle, truth.theta, 1e-7, 'north');
    for (const res of cal.residuals) close(res, 0, 1e-6, 'residual');
    // Any ground point lands where the true transform puts it.
    for (let k = 0; k < 5; k++) {
      const g = { e: -100 + r() * 200, n: -100 + r() * 200 };
      const want = truth.toPlan(g);
      const got = enuToPlan(cal, g);
      close(got.x, want.x, 1e-6, 'x');
      close(got.y, want.y, 1e-6, 'y');
    }
  }
});

test('a north-up plan gives northAngle 0; rotated 90° clockwise gives 90', () => {
  const up = solveCalibration({ pairs: pairsFor(makeTruth(20, 0, 500, 800), TRIANGLE) });
  angClose(up.northAngle, 0, 1e-9, 'north up');
  // North is up, so a spot due north is ABOVE (smaller y) on the plan, and east is to the right.
  const a = enuToPlan(up, { e: 0, n: 0 }), north = enuToPlan(up, { e: 0, n: 10 }), east = enuToPlan(up, { e: 10, n: 0 });
  assert.ok(north.y < a.y && Math.abs(north.x - a.x) < 1e-6, 'north is up');
  assert.ok(east.x > a.x && Math.abs(east.y - a.y) < 1e-6, 'east is right');
  // The plan's matrix contains the y flip: its determinant is negative.
  const [p, q, r2, s2] = up.toPlan;
  assert.ok(p * s2 - q * r2 < 0);

  const cw = solveCalibration({ pairs: pairsFor(makeTruth(20, 90, 500, 800), TRIANGLE) });
  angClose(cw.northAngle, 90, 1e-9, 'rotated 90° clockwise');
  const b = enuToPlan(cw, { e: 0, n: 0 }), n2 = enuToPlan(cw, { e: 0, n: 10 });
  assert.ok(n2.x > b.x, 'north now points right');

  angClose(solveCalibration({ pairs: pairsFor(makeTruth(20, 270, 0, 0), TRIANGLE) }).northAngle, 270, 1e-9);
  angClose(solveCalibration({ pairs: pairsFor(makeTruth(20, 180, 0, 0), TRIANGLE) }).northAngle, 180, 1e-9);
});

test('toEnu is the exact inverse of toPlan, and round trips hold', () => {
  const r = rng(2);
  for (let trial = 0; trial < 50; trial++) {
    const truth = randomTruth(r);
    const noisy = TRIANGLE.concat([{ e: -20, n: 25 }]).map((g) => ({ e: g.e + r.gauss() * 2, n: g.n + r.gauss() * 2 }));
    const pairs = TRIANGLE.concat([{ e: -20, n: 25 }]).map((g, i) => ({ plan: truth.toPlan(g), enu: noisy[i], sigma: 2 }));
    const cal = solveCalibration({ pairs });
    for (let k = 0; k < 10; k++) {
      const g = { e: -150 + r() * 300, n: -150 + r() * 300 };
      const back = planToEnu(cal, enuToPlan(cal, g));
      close(back.e, g.e, 1e-9);
      close(back.n, g.n, 1e-9);
      const p = { x: r() * 8000, y: r() * 8000 };
      const p2 = enuToPlan(cal, planToEnu(cal, p));
      close(p2.x, p.x, 1e-7);
      close(p2.y, p.y, 1e-7);
    }
    // The two matrices compose to the identity.
    const [x1, y1] = applyAffine(cal.toPlan, ...applyAffine(cal.toEnu, 1234.5, 678.9));
    close(x1, 1234.5, 1e-8);
    close(y1, 678.9, 1e-8);
  }
  assert.deepEqual(invertAffine(invertAffine([2, 0.5, -0.5, 2, 10, -4])).map((v) => Math.round(v * 1e9) / 1e9), [2, 0.5, -0.5, 2, 10, -4]);
});

// ---- noise -------------------------------------------------------------------------------------

test('with GPS noise the error shrinks as points are added, and the estimate is honest', () => {
  const r = rng(3);
  const grid = [];
  for (let e = 0; e <= 60; e += 15) for (let n = 0; n <= 40; n += 10) grid.push({ e, n });
  function trial(nPts) {
    const truth = randomTruth(r);
    const enus = Array.from({ length: nPts }, () => ({ e: r() * 60, n: r() * 40 }));
    const pairs = enus.map((g) => ({ plan: truth.toPlan(g), enu: { e: g.e + r.gauss() * 2, n: g.n + r.gauss() * 2 }, sigma: 2 }));
    const cal = solveCalibration({ pairs });
    // How far pins land, in meters, over the whole building.
    let ss = 0;
    for (const g of grid) {
      const want = truth.toPlan(g), got = enuToPlan(cal, g);
      ss += ((got.x - want.x) ** 2 + (got.y - want.y) ** 2) / (truth.s * truth.s);
    }
    return { err: Math.sqrt(ss / grid.length), expected: cal.expectedError };
  }
  const run = (nPts, times) => {
    let e = 0, x = 0;
    for (let i = 0; i < times; i++) { const t = trial(nPts); e += t.err ** 2; x += t.expected ** 2; }
    return { err: Math.sqrt(e / times), expected: Math.sqrt(x / times) };
  };
  const three = run(3, 400), twelve = run(12, 400);
  assert.ok(twelve.err < three.err * 0.75, `12 points (${twelve.err.toFixed(2)} m) should beat 3 points (${three.err.toFixed(2)} m)`);
  // The error the app reports is within a factor of two of the real one.
  for (const t of [three, twelve]) {
    assert.ok(t.expected > t.err * 0.5 && t.expected < t.err * 2, `expected ${t.expected.toFixed(2)} m vs real ${t.err.toFixed(2)} m`);
  }
});

test('phone GPS points are never called better than the GPS floor allows', () => {
  // Perfect data, and the phone claims ±0.3 m: still only "fair" with 3 points.
  const cal = solveCalibration({ pairs: pairsFor(makeTruth(30, 20, 100, 100), TRIANGLE, 0.3) });
  assert.ok(cal.expectedError >= GPS_SIGMA_FLOOR, `expected error ${cal.expectedError}`);
  assert.equal(cal.quality, 'fair');
  assert.equal(cal.rms < 1e-6, true, 'the residuals are zero, which proves nothing');
  // The same picks done on the satellite map can be good.
  const map = solveCalibration({ pairs: pairsFor(makeTruth(30, 20, 100, 100), TRIANGLE, 0.5), method: 'map' });
  assert.equal(map.quality, 'good');
  assert.ok(map.expectedError > map.fitError, 'the satellite photo offset is counted');
});

test('quality bands: good ≤ 1.5 m, fair ≤ 4 m, else poor', () => {
  assert.equal(qualityFor(QUALITY_GOOD_M), 'good');
  assert.equal(qualityFor(1.51), 'fair');
  assert.equal(qualityFor(QUALITY_FAIR_M), 'fair');
  assert.equal(qualityFor(4.01), 'poor');
  assert.equal(qualityFor(NaN), 'poor');
});

// ---- scale line --------------------------------------------------------------------------------

test('a scale line fixes the scale exactly; only rotation and shift are fitted', () => {
  const r = rng(4);
  const truth = makeTruth(24.3, 37, 900, 1200);
  const a = truth.toPlan({ e: 0, n: 0 }), b = truth.toPlan({ e: 7.3152, n: 0 });  // a 24' wall
  const scaleLine = { a, b, meters: 7.3152 };
  close(scaleLinePxPerMeter(scaleLine), 24.3, 1e-9);
  const pairs = TRIANGLE.map((g) => ({ plan: truth.toPlan(g), enu: { e: g.e + r.gauss() * 3, n: g.n + r.gauss() * 3 }, sigma: 3 }));
  const cal = solveCalibration({ pairs, scaleLine });
  close(cal.pxPerMeter, 24.3, 1e-9, 'scale from the line');
  assert.equal(cal.scaleSource, 'line');
  assert.equal(cal.dof, 3);
  assert.equal(cal.scaleSigma, 0);
  assert.ok(cal.gpsPxPerMeter > 0 && cal.gpsPxPerMeter !== cal.pxPerMeter);
  assert.deepEqual(cal.scaleLine, scaleLine);
  // Without noise the rotation is exact too.
  const exact = solveCalibration({ pairs: pairsFor(truth, TRIANGLE), scaleLine });
  angClose(exact.northAngle, 37, 1e-7);
  for (const res of exact.residuals) close(res, 0, 1e-6);
  // With a scale line, 2 points already have a check (1 spare).
  assert.equal(solveCalibration({ pairs: pairsFor(truth, TRIANGLE.slice(0, 2)), scaleLine }).dof, 1);
});

test('a scale line that disagrees with GPS is flagged', () => {
  const truth = makeTruth(20, 10, 0, 0);
  const a = truth.toPlan({ e: 0, n: 0 }), b = truth.toPlan({ e: 10, n: 0 });
  const good = solveCalibration({ pairs: pairsFor(truth, TRIANGLE), scaleLine: { a, b, meters: 10 } });
  assert.ok(!good.warnings.some((w) => w.code === 'scale-mismatch'));
  // Someone typed 13 m for a 10 m wall: 30 % off.
  const bad = solveCalibration({ pairs: pairsFor(truth, [{ e: 0, n: 0 }, { e: 60, n: 5 }, { e: 20, n: 50 }]), scaleLine: { a, b, meters: 13 } });
  const w = bad.warnings.find((x) => x.code === 'scale-mismatch');
  assert.ok(w, 'mismatch warning');
  assert.ok(Math.abs(w.value - 0.3) < 0.01, `mismatch ${w.value}`);
  assert.match(describeWarnings(bad).find((x) => x.code === 'scale-mismatch').text, /30%/);
});

test('bad input gets a plain message', () => {
  assert.throws(() => solveCalibration({ pairs: [] }), /2 points/);
  assert.throws(() => solveCalibration({ pairs: [{ plan: { x: 1, y: 1 }, enu: { e: 0, n: 0 } }] }), /2 points/);
  assert.throws(() => solveCalibration({ pairs: [{ plan: { x: 1, y: 1 }, enu: { e: 0, n: 0 } }, { plan: { x: 1, y: 1 }, enu: { e: 10, n: 0 } }] }), /same spot/);
  assert.throws(() => solveCalibration({ pairs: [{ plan: { x: 1, y: 1 }, enu: { e: 0, n: 0 } }, { plan: { x: 100, y: 1 }, enu: { e: 0, n: 0 } }] }), /same ground position/);
  assert.throws(() => solveCalibration({ pairs: [{ plan: { x: 1, y: 1 }, enu: null }, { plan: { x: 100, y: 1 }, enu: { e: 0, n: 0 } }] }), /Point 1/);
  const pairs = pairsFor(makeTruth(10, 0, 0, 0), TRIANGLE);
  assert.throws(() => solveCalibration({ pairs, scaleLine: { a: { x: 5, y: 5 }, b: { x: 5, y: 5 }, meters: 3 } }), /same spot/);
  assert.throws(() => solveCalibration({ pairs, scaleLine: { a: { x: 5, y: 5 }, b: { x: 50, y: 5 }, meters: 0 } }), /length/);
});

// ---- geometry warnings ----------------------------------------------------------------------------

test('nearly collinear points are flagged; a good triangle is not', () => {
  const truth = makeTruth(15, 45, 300, 300);
  const line = [{ e: 0, n: 0 }, { e: 30, n: 1 }, { e: 60, n: 0.5 }];
  const cal = solveCalibration({ pairs: pairsFor(truth, line) });
  assert.ok(cal.warnings.some((w) => w.code === 'collinear'), JSON.stringify(cal.warnings));
  assert.match(describeWarnings(cal).find((w) => w.code === 'collinear').text, /straight line/);
  const tri = solveCalibration({ pairs: pairsFor(truth, [{ e: 0, n: 0 }, { e: 60, n: 0 }, { e: 30, n: 45 }]) });
  assert.ok(!tri.warnings.some((w) => w.code === 'collinear'));
  assert.deepEqual(tri.warnings, []);
});

test('points closer than 5 m are flagged, and 2 points have no check', () => {
  const truth = makeTruth(15, 0, 0, 0);
  const cal = solveCalibration({ pairs: pairsFor(truth, [{ e: 0, n: 0 }, { e: 3, n: 0 }, { e: 30, n: 30 }]) });
  const w = cal.warnings.find((x) => x.code === 'close');
  assert.deepEqual(w.pairs, [0, 1]);
  assert.match(describeWarnings(cal, 'imperial').find((x) => x.code === 'close').text, /Points 1 and 2 are only 9' 10"/);
  const two = solveCalibration({ pairs: pairsFor(truth, [{ e: 0, n: 0 }, { e: 40, n: 0 }]) });
  assert.ok(two.warnings.some((x) => x.code === 'no-check'));
  assert.equal(two.dof, 0);
  assert.ok(two.expectedError > 2, 'two GPS points are not called precise');
});

test('one bad point among several is named, so it can be redone — corner or middle', () => {
  const r = rng(5);
  const truth = makeTruth(25, 120, 1000, 1000);
  const grounds = [{ e: 0, n: 0 }, { e: 60, n: 0 }, { e: 60, n: 45 }, { e: 0, n: 45 }, { e: 30, n: 20 }];
  for (let bad = 0; bad < grounds.length; bad++) {
    const pairs = grounds.map((g) => ({ plan: truth.toPlan(g), enu: { e: g.e + r.gauss() * 0.5, n: g.n + r.gauss() * 0.5 }, sigma: 2 }));
    pairs[bad].enu = { e: pairs[bad].enu.e + 15, n: pairs[bad].enu.n - 6 };   // stood in the wrong place
    const cal = solveCalibration({ pairs });
    const w = cal.warnings.find((x) => x.code === 'outlier');
    assert.ok(w, `point ${bad + 1}: ${JSON.stringify(cal.warnings)}`);
    assert.equal(w.pair, bad);
    assert.ok(Math.abs(w.value - Math.hypot(15, 6)) < 2, `how far off: ${w.value}`);
    const words = describeWarnings(cal).find((x) => x.code === 'outlier');
    assert.equal(words.redo, bad);
    assert.match(words.text, new RegExp(`Redo point ${bad + 1}`));
    assert.notEqual(cal.quality, 'good');
  }
  // With a scale line, 3 points are enough to name the bad one.
  const a = truth.toPlan({ e: 0, n: 0 }), b = truth.toPlan({ e: 20, n: 0 });
  const pairs = pairsFor(truth, [{ e: 0, n: 0 }, { e: 60, n: 0 }, { e: 30, n: 45 }]);
  pairs[1].enu = { e: pairs[1].enu.e + 12, n: pairs[1].enu.n + 10 };
  const cal = solveCalibration({ pairs, scaleLine: { a, b, meters: 20 } });
  assert.equal(cal.warnings.find((x) => x.code === 'outlier')?.pair, 1, JSON.stringify(cal.warnings));
});

test('ordinary GPS noise rarely blames a point', () => {
  const r = rng(9);
  let blamed = 0;
  const trials = 400;
  for (let t = 0; t < trials; t++) {
    const truth = randomTruth(r);
    const grounds = Array.from({ length: 5 }, () => ({ e: r() * 60, n: r() * 45 }));
    const pairs = grounds.map((g) => ({ plan: truth.toPlan(g), enu: { e: g.e + r.gauss() * 2, n: g.n + r.gauss() * 2 }, sigma: 2 }));
    let cal;
    try { cal = solveCalibration({ pairs }); } catch { continue; }
    if (cal.warnings.some((w) => w.code === 'outlier')) blamed++;
  }
  assert.ok(blamed / trials < 0.03, `blamed a point in ${blamed} of ${trials} noise-only walks`);
});

test('three points that disagree get a general warning (the bad one cannot be told apart)', () => {
  const truth = makeTruth(25, 0, 0, 0);
  const pairs = pairsFor(truth, TRIANGLE);
  pairs[1].enu = { e: pairs[1].enu.e + 14, n: pairs[1].enu.n + 9 };
  const cal = solveCalibration({ pairs });
  assert.ok(cal.warnings.some((x) => x.code === 'disagree'), JSON.stringify(cal.warnings));
  assert.ok(!cal.warnings.some((x) => x.code === 'outlier'));
  assert.equal(cal.quality, 'poor');
});

test('weak GPS on one point is flagged', () => {
  const pairs = pairsFor(makeTruth(25, 0, 0, 0), TRIANGLE);
  pairs[0].sigma = 9;
  const cal = solveCalibration({ pairs });
  const w = cal.warnings.find((x) => x.code === 'weak-point');
  assert.equal(w.pair, 0);
  assert.equal(cal.pairs[0].sigma, 9, 'the given σ is stored, not the floored one');
});

// ---- headings ----------------------------------------------------------------------------------

test('heading conversions match the transform, both ways', () => {
  const r = rng(6);
  for (let trial = 0; trial < 50; trial++) {
    const truth = randomTruth(r);
    const cal = solveCalibration({ pairs: pairsFor(truth, TRIANGLE) });
    const h = r() * 360;
    // Push a ground direction through the plan matrix and measure it on the plan.
    const a = enuToPlan(cal, { e: 0, n: 0 });
    const b = enuToPlan(cal, { e: Math.sin(h * D) * 10, n: Math.cos(h * D) * 10 });
    angClose(headingToPlan(cal, h), planBearing(a, b), 1e-7, 'headingToPlan');
    angClose(planHeadingToTrue(cal, headingToPlan(cal, h)), h, 1e-9, 'round trip');
  }
  const up = solveCalibration({ pairs: pairsFor(makeTruth(20, 0, 0, 0), TRIANGLE) });
  angClose(headingToPlan(up, 90), 90, 1e-9, 'east is right on a north-up plan');
  const cw = solveCalibration({ pairs: pairsFor(makeTruth(20, 90, 0, 0), TRIANGLE) });
  angClose(headingToPlan(cw, 0), 90, 1e-9, 'north points right');
  angClose(planHeadingToTrue(cw, 0), 270, 1e-9, 'plan up faces west');
  assert.equal(headingToPlan(null, 10), null);
  assert.equal(headingToPlan(up, null), null);
  assert.equal(enuToPlan(null, { e: 0, n: 0 }), null);
});

test('the exported viewer turns a true heading onto the plan exactly like headingToPlan (its wedges match the app)', () => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../viewer/viewer.js', import.meta.url), 'utf8'), ctx, { filename: 'viewer.js' });
  const V = ctx.JobWalkViewer;
  const r = rng(7);
  for (let trial = 0; trial < 50; trial++) {
    const cal = solveCalibration({ pairs: pairsFor(randomTruth(r), TRIANGLE) });
    const lvl = { northAngle: cal.northAngle };   // what package.js puts in the viewer's data
    const h = r() * 360;
    angClose(V.planHeadingOf({ heading: h }, lvl), headingToPlan(cal, h), 1e-9, 'a pin with no stored planHeading');
    const [pt] = V.trackPoints({ track: [{ t: 0, x: 1, y: 2, heading: h }] }, lvl);
    angClose(pt.h, headingToPlan(cal, h), 1e-9, 'a video path point');
  }
  const cw = solveCalibration({ pairs: pairsFor(makeTruth(20, 90, 0, 0), TRIANGLE) });
  angClose(V.planHeadingOf({ heading: 0 }, { northAngle: cw.northAngle }), 90, 1e-9, 'north points right');
  assert.equal(V.planHeadingOf({ planHeading: 12, heading: 30 }, { northAngle: 40 }), 12, 'a stored planHeading wins');
});

test('planBearing is clockwise from plan up (−y)', () => {
  angClose(planBearing({ x: 0, y: 0 }, { x: 0, y: -10 }), 0, 1e-12);
  angClose(planBearing({ x: 0, y: 0 }, { x: 10, y: 0 }), 90, 1e-12);
  angClose(planBearing({ x: 0, y: 0 }, { x: 0, y: 10 }), 180, 1e-12);
  angClose(planBearing({ x: 0, y: 0 }, { x: -10, y: 0 }), 270, 1e-12);
});

// ---- reprojecting pins ---------------------------------------------------------------------

test('reprojectItems moves unlocked pins on the level and leaves the rest alone', () => {
  const oldCal = solveCalibration({ pairs: pairsFor(makeTruth(10, 0, 0, 0), TRIANGLE) });
  const newCal = solveCalibration({ pairs: pairsFor(makeTruth(20, 90, 100, 50), TRIANGLE) });
  const level = { id: 'l_1', calibration: newCal };
  const pose = (enu, extra = {}) => ({
    t: 1, geo: { lat: 38.58, lng: -121.49, acc: 4 }, enu, plan: enuToPlan(oldCal, enu), planAcc: 3 * oldCal.pxPerMeter,
    planLocked: false, heading: 30, planHeading: headingToPlan(oldCal, 30), ...extra,
  });
  const items = [
    { id: 'i_photo', levelId: 'l_1', type: 'photo', pose: pose({ e: 5, n: 7 }) },
    { id: 'i_locked', levelId: 'l_1', type: 'photo', pose: pose({ e: 1, n: 1 }, { planLocked: true }) },
    { id: 'i_other', levelId: 'l_2', type: 'photo', pose: pose({ e: 2, n: 2 }) },
    { id: 'i_nopos', levelId: 'l_1', type: 'note', pose: { t: 1, geo: null, enu: null, plan: { x: 10, y: 10 }, planLocked: false } },
    { id: 'i_nopose', levelId: 'l_1', type: 'note', pose: null },
    { id: 'i_deleted', levelId: 'l_1', type: 'photo', deletedAt: 5, pose: pose({ e: 9, n: 1 }) },
    {
      id: 'i_video', levelId: 'l_1', type: 'video', pose: pose({ e: 0, n: 0 }),
      track: [
        { t: 0, e: 0, n: 0, x: 0, y: 0, heading: 0, planHeading: 0 },
        { t: 250, e: 1, n: 2, x: 0, y: 0, heading: 90, planHeading: 90 },
        { t: 500, e: null, n: null, x: 7, y: 8, heading: null, planHeading: null },
      ],
    },
  ];
  const before = JSON.stringify(items);
  const out = reprojectItems(items, level, { lat: 38.58, lng: -121.49 }, { previous: oldCal });
  assert.equal(JSON.stringify(items), before, 'the input items are not changed');
  const byId = Object.fromEntries(out.map((o) => [o.id, o]));
  assert.deepEqual(Object.keys(byId).sort(), ['i_deleted', 'i_locked', 'i_photo', 'i_video']);

  // A pin placed by hand keeps its spot; its wedge turns with the new calibration.
  const l = byId.i_locked.pose;
  assert.deepEqual(l.plan, items[1].pose.plan, 'a pin placed by hand stays');
  assert.equal(l.planLocked, true);
  close(l.planHeading, headingToPlan(newCal, 30), 1e-9);
  close(l.planAcc, 3 * newCal.pxPerMeter, 1e-9, 'planAcc keeps its size in meters');

  const p = byId.i_photo.pose;
  const want = enuToPlan(newCal, { e: 5, n: 7 });
  close(p.plan.x, want.x, 1e-9);
  close(p.plan.y, want.y, 1e-9);
  close(p.planAcc, 3 * newCal.pxPerMeter, 1e-9, 'planAcc keeps its size in meters');
  close(p.planHeading, headingToPlan(newCal, 30), 1e-9);
  assert.equal(p.planLocked, false);
  assert.equal(p.heading, 30, 'the true heading is kept');

  const tr = byId.i_video.track;
  const t1 = enuToPlan(newCal, { e: 1, n: 2 });
  close(tr[1].x, t1.x, 1e-9);
  close(tr[1].y, t1.y, 1e-9);
  close(tr[1].planHeading, headingToPlan(newCal, 90), 1e-9);
  assert.equal(tr[2].x, 7, 'a track point without a position stays');
  assert.equal(tr[2].planHeading, null);

  // Without the previous calibration, the GPS accuracy is used.
  const out2 = reprojectItems([items[0]], level, null);
  close(out2[0].pose.planAcc, 4 * newCal.pxPerMeter, 1e-9);
  // Running it again on the moved pins changes nothing.
  const moved = items.map((i) => (byId[i.id] ? { ...i, pose: byId[i.id].pose, track: byId[i.id].track } : i));
  assert.deepEqual(reprojectItems(moved, level, null, { previous: newCal }), []);
  // An uncalibrated level moves nothing.
  assert.deepEqual(reprojectItems(items, { id: 'l_1', calibration: null }, null), []);
});

test('reprojectItems: a pin placed by hand before calibrating gets its wedge; a locked video keeps its path', () => {
  // North points right on this plan: northAngle 90.
  const cal = solveCalibration({ pairs: pairsFor(makeTruth(10, 90, 0, 0), TRIANGLE) });
  close(cal.northAngle, 90, 1e-6);
  const level = { id: 'l', calibration: cal };
  const items = [
    // Pinned on the plan while it was not calibrated yet: no plan heading, the 2 px placeholder accuracy.
    { id: 'i_pin', levelId: 'l', type: 'photo', pose: { geo: null, enu: null, plan: { x: 1, y: 2 }, planAcc: 2, planLocked: true, heading: 0, planHeading: null } },
    { id: 'i_vid', levelId: 'l', type: 'video', pose: { enu: { e: 0, n: 0 }, plan: { x: 5, y: 5 }, planLocked: true, heading: 90, planHeading: null },
      track: [{ t: 0, e: 3, n: 4, x: 50, y: 60, heading: 90, planHeading: null }] },
    // Locked, with no heading and no accuracy: nothing to update.
    { id: 'i_note', levelId: 'l', type: 'note', pose: { enu: { e: 1, n: 1 }, plan: { x: 9, y: 9 }, planLocked: true, heading: null, planHeading: null } },
  ];
  const out = reprojectItems(items, level, null);
  const byId = Object.fromEntries(out.map((o) => [o.id, o]));
  assert.deepEqual(Object.keys(byId).sort(), ['i_pin', 'i_vid']);
  assert.deepEqual(byId.i_pin.pose.plan, { x: 1, y: 2 });
  close(byId.i_pin.pose.planHeading, 90, 1e-6, 'true north points right on this plan');
  close(byId.i_pin.pose.planAcc, 0.3 * cal.pxPerMeter, 1e-9, 'no old scale: the 2 px stand-in becomes a hand-placed 0.3 m');
  assert.deepEqual(byId.i_vid.pose.plan, { x: 5, y: 5 });
  close(byId.i_vid.pose.planHeading, 180, 1e-6, 'east points down');
  assert.equal(byId.i_vid.track[0].x, 50, 'the path of a locked video stays');
  assert.equal(byId.i_vid.track[0].y, 60);
  close(byId.i_vid.track[0].planHeading, 180, 1e-6);
  // Run again on the result: nothing changes.
  const moved = items.map((i) => (byId[i.id] ? { ...i, pose: byId[i.id].pose, track: byId[i.id].track } : i));
  assert.deepEqual(reprojectItems(moved, level, null), []);
});

test('reprojectItems uses lat/lng + origin when a pose has no ENU', () => {
  const cal = solveCalibration({ pairs: pairsFor(makeTruth(10, 0, 0, 0), TRIANGLE) });
  const fakeToEnu = (origin, lat, lng) => ({ e: (lng - origin.lng) * 1000, n: (lat - origin.lat) * 1000 });
  const items = [{ id: 'i_1', levelId: 'l', pose: { geo: { lat: 1.01, lng: 2.02, acc: 5 }, enu: null, plan: null, planLocked: false, heading: null } }];
  const [o] = reprojectItems(items, { id: 'l', calibration: cal }, { lat: 1, lng: 2 }, { toEnu: fakeToEnu });
  const want = enuToPlan(cal, { e: 20, n: 10 });
  close(o.pose.plan.x, want.x, 1e-6);
  close(o.pose.plan.y, want.y, 1e-6);
  assert.equal(o.pose.planHeading, null);
  // No origin, no position: skipped.
  assert.deepEqual(reprojectItems(items, { id: 'l', calibration: cal }, null, { toEnu: fakeToEnu }), []);
});

// ---- averaging and words ---------------------------------------------------------------------

test('averageFixes drops the settling third and reports an honest precision', () => {
  const fixes = [];
  for (let i = 0; i < 9; i++) fixes.push({ lat: i < 3 ? 38.6 : 38.5, lng: -121.5, acc: 5, alt: 10 });
  const avg = averageFixes(fixes);
  close(avg.lat, 38.5, 1e-12, 'the first three (far off) are dropped');
  assert.equal(avg.n, 6);
  close(avg.spread, 0, 1e-6);
  assert.ok(avg.acc >= 0.57 * 5 - 1e-9, `not √n better than one fix: ${avg.acc}`);
  assert.equal(avg.alt, 10);
  assert.equal(averageFixes([]), null);
  assert.equal(averageFixes([{ lat: NaN, lng: 0 }]), null);
});

test('combineSamples gains a little, never more than the gap allows', () => {
  const a = { lat: 38.5, lng: -121.5, acc: 2, n: 20, spread: 1, seconds: 20 };
  const b = { lat: 38.5, lng: -121.5, acc: 2, n: 20, spread: 1, seconds: 20 };
  const c = combineSamples(a, b);
  close(c.acc, 1.7, 1e-9);
  assert.equal(c.n, 40);
  assert.equal(c.seconds, 40);
  const far = combineSamples(a, { ...b, lat: 38.5 + 10 / 111000 });   // ~10 m apart
  assert.ok(far.acc >= 4.9, `two averages 10 m apart are not precise: ${far.acc}`);
});

test('describeQuality and formatScale speak feet by default, meters when asked', () => {
  const cal = solveCalibration({ pairs: pairsFor(makeTruth(30, 0, 0, 0), TRIANGLE) });
  const q = describeQuality(cal);
  assert.equal(q.level, 'fair');
  assert.equal(q.label, 'Fair');
  assert.match(q.detail, /±\d+(\.\d)? ft/);
  assert.match(q.detail, /phone GPS/);
  assert.match(describeQuality(cal, 'metric').detail, /±\d+(\.\d)? m/);
  assert.match(describeQuality(cal, { units: 'metric' }).detail, / m\b/);
  assert.equal(describeQuality(null).label, 'Not calibrated');
  assert.equal(formatScale(40.37, 'imperial'), '1 ft = 12.3 px');
  assert.equal(formatScale(20, 'imperial'), '1 ft = 6.10 px');
  assert.equal(formatScale(40.37, 'metric'), '1 m = 40.4 px');
  assert.equal(formatScale(null), '—');
  const map = solveCalibration({ pairs: pairsFor(makeTruth(30, 0, 0, 0), TRIANGLE, 0.5), method: 'map' });
  assert.match(describeQuality(map).detail, /satellite/);
});

// ---- saving, the way the calibration screen does it ----------------------------------------

test('saving keeps the previous calibration, moves unlocked pins, and never loses a note typed meanwhile', async () => {
  const store = await import('../js/core/store.js');
  const p = await store.createProject({ name: 'Calibrate and save' });
  const lid = p.activeLevelId;
  await store.setLevelPlan(p.id, lid, new Blob([new Uint8Array(32)], { type: 'image/png' }), { width: 4000, height: 3000, source: 'image' });
  await store.setOriginOnce(p.id, { lat: 38.58, lng: -121.49 });
  const first = solveCalibration({ pairs: pairsFor(makeTruth(12, 10, 500, 2500), TRIANGLE) });
  await store.setCalibration(p.id, lid, first);

  const enu = { e: 12, n: 8 };
  const photo = await store.createItem(p.id, {
    type: 'photo', levelId: lid,
    pose: { enu, geo: { lat: 38.5801, lng: -121.4899, acc: 5 }, plan: enuToPlan(first, enu), planAcc: 2 * first.pxPerMeter, planLocked: false, heading: 45, planHeading: headingToPlan(first, 45) },
  });
  const pinned = await store.createItem(p.id, {
    type: 'note', levelId: lid,
    pose: { enu: { e: 1, n: 1 }, plan: { x: 10, y: 10 }, planLocked: true },
  });

  // Save a new calibration: previous = the level's calibration before it.
  const second = solveCalibration({ pairs: pairsFor(makeTruth(14, 95, 3000, 400), TRIANGLE) });
  const previous = store.getLevel(await store.getProject(p.id), lid).calibration;
  await store.setCalibration(p.id, lid, second);
  const proj = await store.getProject(p.id);
  const level = store.getLevel(proj, lid);
  assert.equal(level.calibrationHistory.length, 1, 'the old calibration is kept');
  close(level.calibrationHistory[0].pxPerMeter, first.pxPerMeter, 1e-9);
  close(level.calibration.pxPerMeter, second.pxPerMeter, 1e-9);

  const todo = reprojectItems(await store.listItems(p.id, { includeDeleted: true }), level, proj.origin, { previous });
  assert.deepEqual(todo.map((t) => t.id), [photo.id], 'only the unlocked pin moves');

  // The person adds a note to the photo between the list and the pin move.
  await store.updateItem(photo.id, { text: 'Header over the garage door' });
  for (const t of todo) {
    await store.updateItem(t.id, (cur) => {
      const [fresh] = reprojectItems([cur], level, proj.origin, { previous });
      if (fresh) { cur.pose = fresh.pose; cur.track = fresh.track; }
      return cur;
    });
  }
  const a = await store.getItem(photo.id);
  const b = await store.getItem(pinned.id);
  assert.equal(a.text, 'Header over the garage door');
  const want = enuToPlan(second, enu);
  close(a.pose.plan.x, want.x, 1e-9);
  close(a.pose.plan.y, want.y, 1e-9);
  close(a.pose.planAcc, 2 * second.pxPerMeter, 1e-9);
  close(a.pose.planHeading, headingToPlan(second, 45), 1e-9);
  assert.deepEqual(b.pose.plan, { x: 10, y: 10 }, 'a pin placed by hand stays');
});
