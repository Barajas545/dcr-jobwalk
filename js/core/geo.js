// geo.js — positions on the Earth, as the app needs them: meters east/north of
// a job walk's origin, distances, bearings, and averaging angles.
//
// Why it matters: a plan is calibrated in meters, and a photo's spot on the
// plan comes from its meters east/north of the project's origin. A
// shortcut such as "1° = 111 km on a sphere" is off by up to 0.3 % (30 cm
// over 100 m) — enough to move a pin past a wall. So this works on the WGS84
// ellipsoid (the one GPS uses) through Earth-centred coordinates (ECEF) and the
// local tangent plane (ENU) at the origin. Going there and back loses well under
// a millimeter within 5 km.
//
// Also here: the circular statistics used for compass headings — the average
// of 350° and 10° is 0°, not 180°.
//
// Pure functions only (no DOM), so the Node tests import this file as it is.

import { deltaDeg } from './util.js';

/**
 * An angle in degrees folded into [0, 360). (util.normDeg can return exactly
 * 360 for a tiny negative input such as -1e-15; this one never does.)
 */
export function normDeg(d) {
  let r = d % 360;
  if (r < 0) r += 360;
  return r >= 360 ? 0 : r;
}

/** WGS84: semi-major axis (m) and flattening. */
export const WGS84 = Object.freeze({ a: 6378137, f: 1 / 298.257223563 });

const A = WGS84.a;
const F = WGS84.f;
const E2 = F * (2 - F);          // first eccentricity squared
const B = A * (1 - F);           // semi-minor axis
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const lngOf = (p) => (p.lng ?? p.lon);

// ---- Earth-centred coordinates ---------------------------------------------------------

/** Geodetic degrees (+ height above the ellipsoid, m) → ECEF meters [x, y, z]. */
export function geodeticToEcef(lat, lng, h = 0) {
  const phi = lat * D2R;
  const lam = lng * D2R;
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  const N = A / Math.sqrt(1 - E2 * s * s);
  return [(N + h) * c * Math.cos(lam), (N + h) * c * Math.sin(lam), (N * (1 - E2) + h) * s];
}

/**
 * ECEF meters → {lat, lng, h}. Iterates Bowring's latitude equation to
 * machine precision (3–5 rounds near the ground); the height formula
 * stays exact at the poles.
 */
export function ecefToGeodetic(x, y, z) {
  const lng = Math.atan2(y, x) * R2D;
  const p = Math.hypot(x, y);
  let phi = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 12; i++) {
    const s = Math.sin(phi);
    const N = A / Math.sqrt(1 - E2 * s * s);
    h = p * Math.cos(phi) + z * s - A * A / N;
    const next = Math.atan2(z, p * (1 - E2 * N / (N + h)));
    const done = Math.abs(next - phi) < 1e-15;
    phi = next;
    if (done) break;
  }
  const s = Math.sin(phi);
  h = p * Math.cos(phi) + z * s - A * Math.sqrt(1 - E2 * s * s);
  return { lat: phi * R2D, lng, h };
}

// ---- the local frame (meters east/north of an origin) ----------------------------------

/**
 * A local east/north/up frame on the ellipsoid surface at `origin` ({lat, lng}).
 * Returns {origin, toEnu(lat, lng, h = 0) → {e, n, u}, fromEnu(e, n) → {lat, lng}}.
 * fromEnu puts the point back on the ellipsoid (height 0), which is exactly
 * the inverse of toEnu for points at height 0.
 */
export function makeFrame(origin) {
  const lat0 = origin.lat;
  const lng0 = lngOf(origin);
  if (!isFinite(lat0) || !isFinite(lng0)) throw new Error('makeFrame needs an origin with lat and lng');
  const [x0, y0, z0] = geodeticToEcef(lat0, lng0, 0);
  const sp = Math.sin(lat0 * D2R), cp = Math.cos(lat0 * D2R);
  const sl = Math.sin(lng0 * D2R), cl = Math.cos(lng0 * D2R);

  function toEnu(lat, lng, h = 0) {
    const [x, y, z] = geodeticToEcef(lat, lng, h || 0);
    const dx = x - x0, dy = y - y0, dz = z - z0;
    return {
      e: -sl * dx + cl * dy,
      n: -sp * cl * dx - sp * sl * dy + cp * dz,
      u: cp * cl * dx + cp * sl * dy + sp * dz,
    };
  }

  function enuToEcef(e, n, u) {
    return [
      x0 - sl * e - sp * cl * n + cp * cl * u,
      y0 + cl * e - sp * sl * n + cp * sl * u,
      z0 + cp * n + sp * u,
    ];
  }

  function fromEnu(e, n) {
    // The point in the tangent plane is above the ground by about d²/2R; slide
    // it along the plane's "up" until it sits on the ellipsoid (h = 0).
    let u = -(e * e + n * n) / (2 * 6371000);
    let g = null;
    for (let i = 0; i < 6; i++) {
      const [x, y, z] = enuToEcef(e, n, u);
      g = ecefToGeodetic(x, y, z);
      if (Math.abs(g.h) < 1e-7) break;
      u -= g.h;
    }
    let lng = g.lng;
    if (lng > 180) lng -= 360; else if (lng <= -180) lng += 360;
    return { lat: g.lat, lng };
  }

  return { origin: { lat: lat0, lng: lng0 }, toEnu, fromEnu };
}

// Most calls use the same origin (the open project's), so keep a few frames.
const frames = new Map();
function frameFor(origin) {
  const key = `${origin.lat},${lngOf(origin)}`;
  let f = frames.get(key);
  if (!f) {
    f = makeFrame(origin);
    if (frames.size >= 8) frames.delete(frames.keys().next().value);
    frames.set(key, f);
  }
  return f;
}

/** Meters east/north of `origin` ({lat, lng}) for a position: {e, n}. */
export function toEnu(origin, lat, lng) {
  const r = frameFor(origin).toEnu(lat, lng, 0);
  return { e: r.e, n: r.n };
}

/** The position `e` meters east and `n` meters north of `origin`: {lat, lng}. */
export function fromEnu(origin, e, n) {
  return frameFor(origin).fromEnu(e, n);
}

// ---- distance and bearing (Vincenty on the WGS84 ellipsoid) ---------------------------

function vincentyInverse(lat1, lon1, lat2, lon2) {
  const L = deltaDeg(lon1, lon2) * D2R;
  const U1 = Math.atan((1 - F) * Math.tan(lat1 * D2R));
  const U2 = Math.atan((1 - F) * Math.tan(lat2 * D2R));
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);
  let lambda = L;
  let sinLambda, cosLambda, sinSigma, cosSigma, sigma, cos2Alpha, cos2SigmaM;
  let iter = 0;
  let converged = false;
  while (iter++ < 200) {
    sinLambda = Math.sin(lambda);
    cosLambda = Math.cos(lambda);
    const t1 = cosU2 * sinLambda;
    const t2 = cosU1 * sinU2 - sinU1 * cosU2 * cosLambda;
    sinSigma = Math.sqrt(t1 * t1 + t2 * t2);
    if (sinSigma === 0) return { distance: 0, azimuth: 0 };
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = cosU1 * cosU2 * sinLambda / sinSigma;
    cos2Alpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cos2Alpha !== 0 ? cosSigma - 2 * sinU1 * sinU2 / cos2Alpha : 0; // on the equator
    const C = F / 16 * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha));
    const prev = lambda;
    lambda = L + (1 - C) * F * sinAlpha *
      (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(lambda - prev) < 1e-12) { converged = true; break; }
  }
  if (!converged) return null; // nearly antipodal: not a job-site question
  const uSq = cos2Alpha * (A * A - B * B) / (B * B);
  const Ak = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const Bk = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const dSigma = Bk * sinSigma * (cos2SigmaM + Bk / 4 * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
    Bk / 6 * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
  const distance = B * Ak * (sigma - dSigma);
  const az = Math.atan2(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) * R2D;
  return { distance, azimuth: normDeg(az) };
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const p1 = lat1 * D2R, p2 = lat2 * D2R;
  const dp = p2 - p1, dl = deltaDeg(lon1, lon2) * D2R;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return { distance: 2 * R * Math.asin(Math.min(1, Math.sqrt(h))), azimuth: normDeg(Math.atan2(y, x) * R2D) };
}

function inverse(a, b) {
  return vincentyInverse(a.lat, lngOf(a), b.lat, lngOf(b)) || haversine(a.lat, lngOf(a), b.lat, lngOf(b));
}

/** Meters between two positions ({lat, lng}) along the WGS84 ellipsoid (Vincenty, ~0.5 mm). */
export function distance(a, b) {
  return inverse(a, b).distance;
}

/** Degrees clockwise from TRUE north to go from `a` to `b` (initial bearing); 0 for the same spot. */
export function bearing(a, b) {
  return inverse(a, b).azimuth;
}

/** Meters between two {e, n} points. */
export function enuDistance(a, b) {
  return Math.hypot(b.e - a.e, b.n - a.n);
}

/** Degrees clockwise from north of the direction from {e, n} `a` to `b`. */
export function enuBearing(a, b) {
  return normDeg(Math.atan2(b.e - a.e, b.n - a.n) * R2D);
}

/** Meters per degree of latitude and of longitude at a latitude (WGS84). */
export function metersPerDegree(lat) {
  const s = Math.sin(lat * D2R);
  const w = 1 - E2 * s * s;
  const N = A / Math.sqrt(w);
  const M = A * (1 - E2) / (w * Math.sqrt(w));
  return { lat: M * D2R, lng: N * Math.cos(lat * D2R) * D2R };
}

// ---- angles ---------------------------------------------------------------------------

/**
 * Circular statistics of angles in degrees (optionally weighted):
 * {mean (deg, or null when they cancel out), R (0..1, how tightly they
 * agree), spread (circular standard deviation, deg), n}.
 */
export function circularStats(angles, weights = null) {
  let sx = 0, sy = 0, sw = 0, n = 0;
  for (let i = 0; i < angles.length; i++) {
    const a = angles[i];
    if (a == null || !isFinite(a)) continue;
    const w = weights ? weights[i] : 1;
    if (!(w > 0)) continue;
    sx += w * Math.sin(a * D2R);
    sy += w * Math.cos(a * D2R);
    sw += w;
    n++;
  }
  if (!n || sw === 0) return { mean: null, R: 0, spread: null, n: 0 };
  const R = Math.min(1, Math.hypot(sx, sy) / sw);
  const mean = R < 1e-9 ? null : normDeg(Math.atan2(sx, sy) * R2D);
  const spread = R >= 1 ? 0 : R <= 1e-12 ? 180 : Math.min(180, Math.sqrt(-2 * Math.log(R)) * R2D);
  return { mean, R, spread, n };
}

/** The average direction of angles in degrees (350° and 10° → 0°), or null when there is none. */
export function circularMean(angles, weights = null) {
  return circularStats(angles, weights).mean;
}

/**
 * One step of smoothing on the circle: move `prev` toward `next` by the
 * fraction k (0..1) the short way round. Never jumps 359 → 0 the long way.
 */
export function smoothAngle(prev, next, k) {
  if (prev == null || !isFinite(prev)) return next == null ? null : normDeg(next);
  if (next == null || !isFinite(next)) return normDeg(prev);
  return normDeg(prev + Math.max(0, Math.min(1, k)) * deltaDeg(prev, next));
}

export { deltaDeg };
