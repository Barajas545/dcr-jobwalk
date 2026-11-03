// vendor/geomagnetism/index.js — magnetic declination from the World Magnetic Model (WMM2025).
//
// Phones measure direction against MAGNETIC north (iPhone webkitCompassHeading,
// Android's absolute orientation). Floor plans and maps use TRUE north. Around
// Sacramento the two differ by about 13°, which would put every photo's camera
// wedge 13° off on the plan. This module gives the difference (declination,
// east-positive: true = magnetic + declination) for any place and date, offline.
//
// This is an ES-module port of the npm package geomagnetism 0.2.0
// (https://github.com/naturalatlas/geomagnetism, Apache-2.0,
// Copyright (c) 2015-2024 Natural Atlas, Inc. & Contributors). See LICENSE and
// NOTICE in this folder.
//
// CHANGES FROM THE ORIGINAL (Apache-2.0 §4b), made for DCR Job Walk in 2026:
//  - The CommonJS files (index.js, lib/model.js, lib/legendre.js,
//    lib/magnetic_elements.js, lib/magnetic_vector.js, lib/ellipsoid.js,
//    lib/coords/geodetic.js, lib/coords/spherical.js) are merged into this one
//    ES module, so a no-build web app can import it and the service worker can
//    cache it as one file.
//  - Only the WMM2025 coefficients (data/wmm-2025.json) are included, inlined
//    below; the older WMM2015/2020 tables are dropped.
//  - The high-degree Legendre routine (PcupHigh, used only for n_max > 16) is
//    dropped: the WMM is degree 12, so the original always used PcupLow.
//  - The unused secular-variation element code and the (broken, never called)
//    cartesian -> geodetic conversion are dropped.
//  - The decimal year accounts for leap years (the original divided by 365
//    days), and a decimal year can be passed instead of a Date.
//  - The model's end is NOAA's 2030.0 (the package stopped at 2029-11-13, its
//    release date + 5 years). Out-of-range dates log nothing;
//    `allowOutOfBoundsModel` keeps its meaning (throw by default, extrapolate
//    when true).
//  - Added declination(), declinationInfo(), decimalYear(), isValidDate() helpers.
//
// The WMM2025 coefficients are from NOAA NCEI and are in the public domain.
// WMM2025 is valid from 2025.0 to 2030.0 (it expires 31 Dec 2029). Replace the
// coefficients with WMM2030 before then (NCEI publishes it in late 2029).

/** The model this file carries. Stored with headings so they can be recomputed later. */
export const MODEL_NAME = 'WMM2025';

/** WMM2025 coefficients (Schmidt semi-normalized, nT and nT/yr), index i = n(n+1)/2 + m. */
export const WMM2025 = Object.freeze({
  name: 'WMM-2025',
  epoch: 2025.0,
  // The package's release window. NOAA's validity is 2025.0–2030.0 (see VALID_TO).
  start_date: '2024-11-13T03:00:00.000Z',
  end_date: '2029-11-13T03:00:00.000Z',
  n_max: 12,
  n_max_sec_var: 12,
  main_field_coeff_g: Object.freeze([
    0, -29351.8, -1410.8, -2556.6, 2951.1, 1649.3, 1361, -2404.1, 1243.8, 453.6,
    895, 799.5, 55.7, -281.1, 12.1, -233.2, 368.9, 187.2, -138.7, -142,
    20.9, 64.4, 63.8, 76.9, -115.7, -40.9, 14.9, -60.7, 79.5, -77,
    -8.8, 59.3, 15.8, 2.5, -11.1, 14.2, 23.2, 10.8, -17.5, 2,
    -21.7, 16.9, 15, -16.8, 0.9, 4.6, 7.8, 3, -0.2, -2.5,
    -13.1, 2.4, 8.6, -8.7, -12.9, -1.3, -6.4, 0.2, 2, -1,
    -0.6, -0.9, 1.5, 0.9, -2.7, -3.9, 2.9, -1.5, -2.5, 2.4,
    -0.6, -0.1, -0.6, -0.1, 1.1, -1, -0.2, 2.6, -2, -0.2,
    0.3, 1.2, -1.3, 0.6, 0.6, 0.5, -0.1, -0.4, -0.2, -1.3,
    -0.7,
  ]),
  main_field_coeff_h: Object.freeze([
    0, 0, 4545.4, 0, -3133.6, -815.1, 0, -56.6, 237.5, -549.5,
    0, 278.6, -133.9, 212, -375.6, 0, 45.4, 220.2, -122.9, 43,
    106.1, 0, -18.4, 16.8, 48.8, -59.8, 10.9, 72.7, 0, -48.9,
    -14.4, -1, 23.4, -7.4, -25.1, -2.3, 0, 7.1, -12.6, 11.4,
    -9.7, 12.7, 0.7, -5.2, 3.9, 0, -24.8, 12.2, 8.3, -3.3,
    -5.2, 7.2, -0.6, 0.8, 10, 0, 3.3, 0, 2.4, 5.3,
    -9.1, 0.4, -4.2, -3.8, 0.9, -9.1, 0, 0, 2.9, -0.6,
    0.2, 0.5, -0.3, -1.2, -1.7, -2.9, -1.8, -2.3, 0, -1.3,
    0.7, 1, -1.4, 0, 0.6, -0.1, 0.8, 0.1, -1, 0.1,
    0.2,
  ]),
  secular_var_coeff_g: Object.freeze([
    0, 12, 9.7, -11.6, -5.2, -8, -1.3, -4.2, 0.4, -15.6,
    -1.6, -2.4, -6, 5.6, -7, 0.6, 1.4, 0, 0.6, 2.2,
    0.9, -0.2, -0.4, 0.9, 1.2, -0.9, 0.3, 0.9, 0, -0.1,
    -0.1, 0.5, -0.1, -0.8, -0.8, 0.8, -0.1, 0.2, 0, 0.5,
    -0.1, 0.3, 0.2, 0, 0.2, 0, -0.1, 0.1, 0.3, -0.3,
    0, 0.3, -0.1, 0.1, -0.1, 0.1, 0, 0.1, 0.1, 0,
    -0.3, 0, -0.1, -0.1, 0, 0, 0, 0, 0, 0,
    0, -0.1, 0, 0, -0.1, -0.1, -0.1, -0.1, 0, 0,
    0, 0, 0, 0, 0.1, 0, 0, 0, -0.1, 0,
    -0.1,
  ]),
  secular_var_coeff_h: Object.freeze([
    0, 0, -21.5, 0, -27.7, -12.1, 0, 4, -0.3, -4.1,
    0, -1.1, 4.1, 1.6, -4.4, 0, -0.5, 2.2, 0.4, 1.7,
    1.9, 0, 0.3, -1.6, -0.4, 0.9, 0.7, 0.9, 0, 0.6,
    0.5, -0.8, 0, -1, 0.6, -0.2, 0, -0.2, 0.5, -0.4,
    0.4, -0.5, -0.6, 0.3, 0.2, 0, -0.3, 0.3, -0.3, 0.3,
    0.2, -0.1, -0.2, 0.4, 0.1, 0, 0, 0, -0.2, 0.1,
    -0.1, 0.1, 0, -0.1, 0.2, 0, 0, 0, 0.1, 0,
    0.1, 0, 0, 0.1, 0, 0, 0, 0, 0, 0,
    0, -0.1, 0.1, 0, 0, 0, 0, 0, 0, 0,
    -0.1,
  ]),
});

/** First and last moments the model is meant for (NOAA: valid 2025.0 to 2030.0). */
export const VALID_FROM = new Date(Date.UTC(2024, 10, 13, 3)); // the package's start (model released Dec 2024; extrapolates fine)
export const VALID_TO = new Date(Date.UTC(2030, 0, 1));

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// WGS84 as the WMM uses it, in kilometers; re is the WMM reference radius.
const ELLIPSOID = (() => {
  const a = 6378.137;
  const b = 6356.7523142;
  const eps = Math.sqrt(1 - (b * b) / (a * a));
  return { a, b, fla: 1 / 298.257223563, re: 6371.2, eps, epssq: eps * eps };
})();

/**
 * A Date (or a decimal year) as a decimal year: 2026-07-02T12:00Z -> 2026.5.
 * Leap years count 366 days.
 */
export function decimalYear(date) {
  if (typeof date === 'number') return date;
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  return y + (d.getTime() - start) / (end - start);
}

/** True when the date is inside the model's window (outside it the model still answers, extrapolated). */
export function isValidDate(date = new Date()) {
  const yr = decimalYear(date);
  return yr >= decimalYear(VALID_FROM) && yr < decimalYear(VALID_TO);
}

// ---- the model -------------------------------------------------------------------

class Model {
  constructor(options) {
    this.epoch = options.epoch;
    this.start_date = new Date(options.start_date);
    this.end_date = new Date(options.end_date);
    this.name = options.name || '';
    this.main_field_coeff_g = options.main_field_coeff_g ? options.main_field_coeff_g.slice() : [0];
    this.main_field_coeff_h = options.main_field_coeff_h ? options.main_field_coeff_h.slice() : [0];
    this.secular_var_coeff_g = options.secular_var_coeff_g ? options.secular_var_coeff_g.slice() : [0];
    this.secular_var_coeff_h = options.secular_var_coeff_h ? options.secular_var_coeff_h.slice() : [0];
    this.n_max = options.n_max || 0;
    this.n_max_sec_var = options.n_max_sec_var || 0;
    this.num_terms = this.n_max * (this.n_max + 1) / 2 + this.n_max;
  }

  /** The coefficients moved to `date` by their yearly change (secular variation). */
  getTimedModel(date, allowOutOfBoundsModel = false) {
    const year = decimalYear(date);
    const dyear = year - this.epoch;
    const inRange = year >= decimalYear(this.start_date) && year < decimalYear(VALID_TO);
    if (!inRange && !allowOutOfBoundsModel) {
      throw new Error(`Model is only valid from ${this.start_date.toDateString()} to ${VALID_TO.toDateString()}`);
    }
    const model = new Model({
      epoch: this.epoch,
      n_max: this.n_max,
      n_max_sec_var: this.n_max_sec_var,
      name: this.name,
      start_date: this.start_date,
      end_date: this.end_date,
    });
    model.outOfRange = !inRange;
    model.year = year;
    const a = model.n_max_sec_var;
    const b = a * (a + 1) / 2 + a;
    for (let n = 1; n <= this.n_max; n++) {
      for (let m = 0; m <= n; m++) {
        const i = n * (n + 1) / 2 + m;
        const hnm = this.main_field_coeff_h[i];
        const gnm = this.main_field_coeff_g[i];
        const dhnm = this.secular_var_coeff_h[i];
        const dgnm = this.secular_var_coeff_g[i];
        if (i <= b) {
          model.main_field_coeff_h[i] = hnm + dyear * dhnm;
          model.main_field_coeff_g[i] = gnm + dyear * dgnm;
          model.secular_var_coeff_h[i] = dhnm;
          model.secular_var_coeff_g[i] = dgnm;
        } else {
          model.main_field_coeff_h[i] = hnm;
          model.main_field_coeff_g[i] = gnm;
        }
      }
    }
    return model;
  }

  /** The field in spherical components (bx north, by east, bz down), nT. */
  getSummation(legendre, sph, coordSpherical) {
    let bx = 0;
    let by = 0;
    let bz = 0;
    const rrp = sph.relative_radius_power;
    const cosml = sph.cos_mlambda;
    const sinml = sph.sin_mlambda;
    const g = this.main_field_coeff_g;
    const h = this.main_field_coeff_h;
    for (let n = 1; n <= this.n_max; n++) {
      for (let m = 0; m <= n; m++) {
        const i = n * (n + 1) / 2 + m;
        bz -= rrp[n] * (g[i] * cosml[m] + h[i] * sinml[m]) * (n + 1) * legendre.pcup[i];
        by += rrp[n] * (g[i] * sinml[m] - h[i] * cosml[m]) * m * legendre.pcup[i];
        bx -= rrp[n] * (g[i] * cosml[m] + h[i] * sinml[m]) * legendre.dpcup[i];
      }
    }
    const cosPhi = Math.cos(D2R * coordSpherical.phig);
    if (Math.abs(cosPhi) > 1e-10) {
      by /= cosPhi;
    } else {
      // At the geographic poles the east component needs its own series.
      by = 0;
      let norm1 = 1.0;
      const pcupS = [1];
      const sinPhi = Math.sin(D2R * coordSpherical.phig);
      for (let n = 1; n <= this.n_max; n++) {
        const i = n * (n + 1) / 2 + 1;
        const norm2 = norm1 * (2 * n - 1) / n;
        const norm3 = norm2 * Math.sqrt(2 * n / (n + 1));
        norm1 = norm2;
        if (n === 1) {
          pcupS[n] = pcupS[n - 1];
        } else {
          const k = ((n - 1) * (n - 1) - 1) / ((2 * n - 1) * (2 * n - 3));
          pcupS[n] = sinPhi * pcupS[n - 1] - k * pcupS[n - 2];
        }
        by += rrp[n] * (g[i] * sinml[1] - h[i] * cosml[1]) * pcupS[n] * norm3;
      }
    }
    return { bx, by, bz };
  }

  /**
   * The magnetic elements at [lat, lon, altitudeKm] (geodetic degrees, km above
   * the ellipsoid): {x, y, z, h, f (nT), incl, decl (degrees)}.
   */
  point(coords) {
    const lat = coords[0];
    const lon = coords[1];
    const alt = (coords.length > 2 && typeof coords[2] === 'number' && isFinite(coords[2])) ? coords[2] : 0;
    const sph = geodeticToSpherical(lat, lon, alt);
    const legendre = pcupLow(Math.sin(D2R * sph.phig), this.n_max);
    const harmonic = harmonicVariables(sph, this.n_max);
    const v = this.getSummation(legendre, harmonic, sph);
    // Rotate from spherical (geocentric) to geodetic north/down.
    const psi = D2R * (sph.phig - lat);
    const bx = v.bx * Math.cos(psi) - v.bz * Math.sin(psi);
    const bz = v.bx * Math.sin(psi) + v.bz * Math.cos(psi);
    const by = v.by;
    const h = Math.sqrt(bx * bx + by * by);
    return {
      x: bx,
      y: by,
      z: bz,
      h,
      f: Math.sqrt(h * h + bz * bz),
      decl: R2D * Math.atan2(by, bx),
      incl: R2D * Math.atan2(bz, h),
    };
  }
}

function geodeticToSpherical(lat, lon, altKm) {
  const coslat = Math.cos(lat * D2R);
  const sinlat = Math.sin(lat * D2R);
  const rc = ELLIPSOID.a / Math.sqrt(1 - ELLIPSOID.epssq * sinlat * sinlat);
  const xp = (rc + altKm) * coslat;
  const zp = (rc * (1 - ELLIPSOID.epssq) + altKm) * sinlat;
  const r = Math.sqrt(xp * xp + zp * zp);
  return { r, phig: R2D * Math.asin(zp / r), lambda: lon };
}

function harmonicVariables(sph, nMax) {
  const cosL = Math.cos(D2R * sph.lambda);
  const sinL = Math.sin(D2R * sph.lambda);
  const cos_mlambda = [1.0, cosL];
  const sin_mlambda = [0.0, sinL];
  const ratio = ELLIPSOID.re / sph.r;
  const relative_radius_power = [ratio * ratio];
  for (let n = 1; n <= nMax; n++) relative_radius_power[n] = relative_radius_power[n - 1] * ratio;
  for (let m = 2; m <= nMax; m++) {
    cos_mlambda[m] = cos_mlambda[m - 1] * cosL - sin_mlambda[m - 1] * sinL;
    sin_mlambda[m] = cos_mlambda[m - 1] * sinL + sin_mlambda[m - 1] * cosL;
  }
  return { relative_radius_power, cos_mlambda, sin_mlambda };
}

/** Schmidt semi-normalized associated Legendre functions and derivatives (WMM "PcupLow"). */
function pcupLow(x, nMax) {
  const schmidt = [1.0];
  const pcup = [1.0];
  const dpcup = [0.0];
  const z = Math.sqrt((1 - x) * (1 + x));
  for (let n = 1; n <= nMax; n++) {
    for (let m = 0; m <= n; m++) {
      const i = n * (n + 1) / 2 + m;
      if (n === m) {
        const i1 = (n - 1) * n / 2 + m - 1;
        pcup[i] = z * pcup[i1];
        dpcup[i] = z * dpcup[i1] + x * pcup[i1];
      } else if (n === 1 && m === 0) {
        const i1 = (n - 1) * n / 2 + m;
        pcup[i] = x * pcup[i1];
        dpcup[i] = x * dpcup[i1] - z * pcup[i1];
      } else if (n > 1 && n !== m) {
        const i1 = (n - 2) * (n - 1) / 2 + m;
        const i2 = (n - 1) * n / 2 + m;
        if (m > n - 2) {
          pcup[i] = x * pcup[i2];
          dpcup[i] = x * dpcup[i2] - z * pcup[i2];
        } else {
          const k = ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3));
          pcup[i] = x * pcup[i2] - k * pcup[i1];
          dpcup[i] = x * dpcup[i2] - z * pcup[i2] - k * dpcup[i1];
        }
      }
    }
  }
  for (let n = 1; n <= nMax; n++) {
    let i = n * (n + 1) / 2;
    let i1 = (n - 1) * n / 2;
    schmidt[i] = schmidt[i1] * (2 * n - 1) / n;
    for (let m = 1; m <= n; m++) {
      i = n * (n + 1) / 2 + m;
      i1 = n * (n + 1) / 2 + m - 1;
      schmidt[i] = schmidt[i1] * Math.sqrt(((n - m + 1) * (m === 1 ? 2 : 1)) / (n + m));
    }
  }
  for (let n = 1; n <= nMax; n++) {
    for (let m = 0; m <= n; m++) {
      const i = n * (n + 1) / 2 + m;
      pcup[i] *= schmidt[i];
      dpcup[i] *= -schmidt[i];
    }
  }
  return { pcup, dpcup };
}

const BASE = new Model(WMM2025);
const timedCache = new Map(); // decimal year (to ~1 day) -> timed model

/**
 * The model at a date, like the original package: model(date).point([lat, lon, altKm]).decl.
 * `date` is a Date or a decimal year (default now). Throws outside the model's
 * window unless {allowOutOfBoundsModel: true}.
 */
export function model(date = new Date(), options = {}) {
  return BASE.getTimedModel(date || new Date(), !!(options && options.allowOutOfBoundsModel));
}

function timedModel(date) {
  const yr = decimalYear(date || new Date());
  const key = Math.round(yr * 365.25); // one per day is plenty: declination moves ~0.1°/year
  let m = timedCache.get(key);
  if (!m) {
    m = BASE.getTimedModel(key / 365.25, true);
    if (timedCache.size > 16) timedCache.clear();
    timedCache.set(key, m);
  }
  return m;
}

/**
 * Magnetic declination in degrees, east-positive (true heading = magnetic
 * heading + declination), at a place and time. Never throws for a finite
 * position: outside 2025–2029 the model is extrapolated (still close to a
 * degree for a few years). Returns null for a missing position.
 */
export function declination(lat, lng, altMeters = 0, date = new Date()) {
  if (!isFinite(lat) || !isFinite(lng)) return null;
  const alt = isFinite(altMeters) && altMeters != null ? altMeters / 1000 : 0;
  return timedModel(date).point([lat, lng, alt]).decl;
}

/**
 * Declination plus what it is worth: {declination, inclination, h (nT),
 * uncertainty (1σ degrees, NOAA's WMM error model), model, valid}. Near the
 * magnetic poles (h < 2000 nT) a compass is unusable and `uncertainty` says so.
 */
export function declinationInfo(lat, lng, altMeters = 0, date = new Date()) {
  if (!isFinite(lat) || !isFinite(lng)) return null;
  const alt = isFinite(altMeters) && altMeters != null ? altMeters / 1000 : 0;
  const m = timedModel(date);
  const p = m.point([lat, lng, alt]);
  // NOAA WMM2025 error model: declination 1σ = sqrt(0.26² + (5417 / H)²) degrees.
  const uncertainty = Math.sqrt(0.26 * 0.26 + Math.pow(5417 / Math.max(1, p.h), 2));
  return {
    declination: p.decl,
    inclination: p.incl,
    h: p.h,
    uncertainty,
    model: MODEL_NAME,
    valid: !m.outOfRange,
  };
}

export default { model, declination, declinationInfo, decimalYear, isValidDate, MODEL_NAME, WMM2025, VALID_FROM, VALID_TO };
