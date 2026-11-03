// geo.test.mjs — WGS84 local frames, distances, bearings and circular averages (js/core/geo.js).
//
// Every photo's spot on the plan goes through toEnu/fromEnu, so the round
// trip must lose nothing a tape measure could see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toEnu, fromEnu, makeFrame, distance, bearing, geodeticToEcef, ecefToGeodetic,
  circularMean, circularStats, smoothAngle, enuDistance, enuBearing, metersPerDegree,
} from '../js/core/geo.js';

const SAC = { lat: 38.5816, lng: -121.4944 };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);

/** A tiny deterministic random source so failures repeat. */
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('ECEF round trip is exact to well under a millimeter, poles included', () => {
  for (const [lat, lng, h] of [[0, 0, 0], [38.5816, -121.4944, 12], [-33.9, 151.2, 50], [89.9999, 10, 0], [-90, 0, 0], [60, 179.9999, 1000]]) {
    const [x, y, z] = geodeticToEcef(lat, lng, h);
    const g = ecefToGeodetic(x, y, z);
    near(g.lat, lat, 1e-9, 'lat');
    if (Math.abs(lat) < 90) near(((g.lng - lng + 540) % 360) - 180, 0, 1e-9, 'lng');
    near(g.h, h, 1e-6, 'h');
  }
});

test('toEnu → fromEnu round trip < 1 mm anywhere within 5 km, at many latitudes', () => {
  const r = rng(7);
  const origins = [SAC, { lat: 0, lng: 0 }, { lat: 64.84, lng: -147.72 }, { lat: -41.29, lng: 174.78 }, { lat: 45, lng: 179.99 }, { lat: 78.2, lng: 15.6 }];
  for (const o of origins) {
    for (let i = 0; i < 200; i++) {
      const e = (r() * 2 - 1) * 5000, n = (r() * 2 - 1) * 5000;
      if (Math.hypot(e, n) > 5000) continue;
      const ll = fromEnu(o, e, n);
      const back = toEnu(o, ll.lat, ll.lng);
      assert.ok(Math.hypot(back.e - e, back.n - n) < 1e-3, `origin ${o.lat},${o.lng}: (${e},${n}) → (${back.e},${back.n})`);
    }
  }
});

test('fromEnu → toEnu is consistent the other way, and positions near the date line stay in range', () => {
  const o = { lat: 10, lng: 179.999 };
  const p = fromEnu(o, 500, 0);   // crosses 180°
  assert.ok(p.lng < -179.99 && p.lng >= -180, `lng ${p.lng}`);
  const back = toEnu(o, p.lat, p.lng);
  near(back.e, 500, 1e-6); near(back.n, 0, 1e-6);
});

test('ENU agrees with the ellipsoid: meters per degree and geodesic distance', () => {
  // 1° of latitude at the equator is 110 574.3 m, 1° of longitude 111 319.5 m (WGS84).
  const m0 = metersPerDegree(0);
  near(m0.lat, 110574.3, 0.2); near(m0.lng, 111319.49, 0.02);
  const o = { lat: 0, lng: 0 };
  const p = toEnu(o, 0.001, 0.001);
  near(p.n, 110.5743, 0.001); near(p.e, 111.3195, 0.001);
  // The tangent-plane distance matches the ellipsoid distance to < 1 mm over 1 km.
  const q = fromEnu(SAC, 600, -800);
  near(distance(SAC, q), 1000, 0.001);
  near(enuDistance({ e: 0, n: 0 }, toEnu(SAC, q.lat, q.lng)), 1000, 1e-6);
});

test('a frame object gives the same answers as the cached helpers, with height', () => {
  const f = makeFrame(SAC);
  const a = f.toEnu(38.59, -121.48, 0);
  const b = toEnu(SAC, 38.59, -121.48);
  near(a.e, b.e, 1e-9); near(a.n, b.n, 1e-9);
  assert.ok(a.u < 0, 'a point on the ground away from the origin is below the tangent plane');
  assert.equal(makeFrame({ lat: 1, lon: 2 }).origin.lng, 2);
});

test('Vincenty: Flinders Peak → Buninyong (the classic test line)', () => {
  const dms = (d, m, s) => Math.sign(d) * (Math.abs(d) + m / 60 + s / 3600);
  const a = { lat: dms(-37, 57, 3.72030), lng: dms(144, 25, 29.52440) };
  const b = { lat: dms(-37, 39, 10.15610), lng: dms(143, 55, 35.38390) };
  near(distance(a, b), 54972.271, 0.002);
  near(bearing(a, b), dms(306, 52, 5.37), 1 / 3600);
});

test('distances and bearings: known easy cases', () => {
  const o = { lat: 0, lng: 0 };
  near(distance(o, { lat: 0, lng: 1 }), 111319.491, 0.01);
  near(bearing(o, { lat: 0, lng: 1 }), 90, 1e-9);
  near(bearing(o, { lat: 1, lng: 0 }), 0, 1e-9);
  near(bearing(o, { lat: -1, lng: 0 }), 180, 1e-9);
  near(bearing(o, { lat: 0, lng: -1 }), 270, 1e-9);
  assert.equal(distance(SAC, SAC), 0);
  assert.equal(bearing(SAC, SAC), 0);
  // Across the date line the short way round.
  near(distance({ lat: 0, lng: 179.5 }, { lat: 0, lng: -179.5 }), 111319.491, 0.01);
  near(bearing({ lat: 0, lng: 179.5 }, { lat: 0, lng: -179.5 }), 90, 1e-9);
  // ENU bearing matches the ellipsoid bearing over a short distance.
  const q = fromEnu(SAC, 30, 30);
  near(bearing(SAC, q), 45, 0.01);
  near(enuBearing({ e: 0, n: 0 }, { e: 30, n: 30 }), 45, 1e-12);
  // Nearly antipodal points fall back instead of looping forever.
  assert.ok(Number.isFinite(distance({ lat: 0, lng: 0 }, { lat: 0.5, lng: 179.7 })));
});

test('circular mean never averages 350° and 10° to 180°', () => {
  near(circularMean([350, 10]), 0, 1e-9);
  near(circularMean([359, 1, 0]), 0, 1e-9);
  near(circularMean([90, 180]), 135, 1e-9);
  near(circularMean([10, 20], [3, 1]), 12.4952, 1e-3);
  assert.equal(circularMean([0, 180]), null);
  assert.equal(circularMean([]), null);
  const s = circularStats([355, 0, 5, null]);
  assert.equal(s.n, 3);
  assert.ok(s.spread > 3.5 && s.spread < 4.5, `spread ${s.spread}`);
  near(circularStats([42, 42, 42]).spread, 0, 1e-6);
});

test('smoothAngle goes the short way round and never jumps 359 → 0 the long way', () => {
  near(smoothAngle(350, 10, 0.5), 0, 1e-9);
  near(smoothAngle(10, 350, 0.5), 0, 1e-9);
  near(smoothAngle(359, 1, 0.25), 359.5, 1e-9);
  assert.equal(smoothAngle(null, 370, 0.1), 10);
  assert.equal(smoothAngle(20, null, 0.1), 20);
  // Repeated smoothing across north stays continuous: each step moves < 2°.
  let h = 340, prev = 340;
  for (let i = 0; i < 60; i++) {
    h = smoothAngle(h, 20, 0.1);
    const step = Math.abs(((h - prev + 540) % 360) - 180);
    assert.ok(step < 4.1, `step ${step} at ${h}`);
    prev = h;
  }
  near(h, 20, 0.2);
});
