// geomagnetism.test.mjs — the WMM2025 port in vendor/geomagnetism gives NOAA's own answers.
//
// Every compass heading in the app is turned from magnetic to true north
// with this declination, so a wrong coefficient would rotate every photo's
// direction on the plan. The table below is NOAA's official WMM2025 test
// values (decimal year, altitude km, latitude, longitude, inclination,
// declination — rounded to 0.01° by NOAA), as shipped in geomagnetism 0.2.0's
// test/values.csv.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { model, declination, declinationInfo, decimalYear, isValidDate, MODEL_NAME } from '../vendor/geomagnetism/index.js';

// [year, altKm, lat, lon, incl, decl]
const NOAA_WMM2025 = [
  [2025, 28, 89, -121, 88.47, -99.77],
  [2025, 48, 80, -96, 87.77, -29.91],
  [2025, 54, 82, 87, 87.68, 54.89],
  [2025, 65, 43, 93, 64.10, 0.50],
  [2025, 51, -33, 109, -67.50, -5.49],
  [2025, 39, -59, -8, -58.55, -15.75],
  [2025, 3, -50, -103, -54.89, 27.96],
  [2025, 94, -29, -110, -38.25, 15.74],
  [2025, 66, 14, 143, 12.82, -0.19],
  [2025, 18, 0, 21, -26.06, 1.29],
  [2025.5, 6, -36, -137, -52.11, 20.28],
  [2025.5, 63, 26, 81, 41.07, 0.51],
  [2025.5, 69, 38, -144, 56.97, 12.93],
  [2025.5, 50, -70, -133, -71.94, 57.21],
  [2025.5, 8, -52, -75, -49.63, 14.91],
  [2025.5, 8, -66, 17, -59.55, -33.14],
  [2025.5, 22, -37, 140, -68.62, 9.28],
  [2025.5, 40, -12, -129, -15.46, 10.76],
  [2025.5, 44, 33, -118, 57.89, 11.10],
  [2025.5, 50, -81, -67, -67.61, 28.13],
  [2026, 74, -57, 3, -58.65, -22.51],
  [2026, 46, -24, -122, -34.17, 14.01],
  [2026, 69, 23, 63, 35.92, 1.17],
  [2026, 33, -3, -147, -2.12, 9.71],
  [2026, 47, -72, -22, -61.16, -6.32],
  [2026, 62, -14, 99, -44.70, -1.43],
  [2026, 83, 86, -46, 86.84, -30.61],
  [2026, 82, -64, 87, -75.40, -81.74],
  [2026, 34, -19, 43, -52.33, -14.98],
  [2026, 56, -81, 40, -68.45, -59.77],
  [2026.5, 14, 0, 80, -17.15, -3.10],
  [2026.5, 12, -82, -68, -68.07, 29.79],
  [2026.5, 44, -46, -42, -54.39, -11.36],
  [2026.5, 43, 17, 52, 23.95, 1.19],
  [2026.5, 64, 10, 78, 7.53, -1.53],
  [2026.5, 12, 33, -145, 52.51, 11.96],
  [2026.5, 12, -79, 115, -77.37, -137.58],
  [2026.5, 14, -33, -114, -44.10, 18.12],
  [2026.5, 19, 29, 66, 46.04, 2.24],
  [2026.5, 86, -11, 167, -31.60, 10.24],
  [2027, 37, -66, -5, -59.04, -17.22],
  [2027, 67, 72, -115, 84.84, 13.73],
  [2027, 44, 22, 174, 31.89, 6.46],
  [2027, 54, 54, 178, 65.46, 0.63],
  [2027, 57, -43, 50, -63.13, -48.27],
  [2027, 44, -43, -111, -52.57, 24.31],
  [2027, 12, -63, 178, -79.14, 57.87],
  [2027, 38, 27, -169, 42.66, 8.48],
  [2027, 61, 59, -77, 78.68, -16.48],
  [2027, 67, -47, -32, -57.98, -13.52],
  [2027.5, 8, 62, 53, 76.67, 19.39],
  [2027.5, 77, -68, -7, -59.82, -16.19],
  [2027.5, 98, -5, 159, -23.22, 7.79],
  [2027.5, 34, -29, -107, -37.45, 15.64],
  [2027.5, 60, 27, 65, 42.83, 1.85],
  [2027.5, 73, -72, 95, -76.49, -102.64],
  [2027.5, 96, -46, -85, -47.37, 17.93],
  [2027.5, 0, -13, -59, -15.26, -17.49],
  [2027.5, 16, 66, -178, 75.67, 0.37],
  [2027.5, 72, -87, 38, -70.97, -65.44],
  [2028, 49, 20, 167, 26.82, 5.10],
  [2028, 71, 5, -13, -17.66, -6.47],
  [2028, 95, 14, 65, 17.44, -0.51],
  [2028, 86, -85, -79, -70.25, 41.09],
  [2028, 30, -36, -64, -40.08, -4.65],
  [2028, 75, 79, 125, 87.42, -18.59],
  [2028, 21, 6, -32, -8.70, -14.34],
  [2028, 1, -76, -75, -65.23, 29.87],
  [2028, 45, -46, -41, -54.96, -11.68],
  [2028, 11, -22, -21, -57.67, -23.24],
  [2028.5, 28, 54, -120, 73.74, 15.43],
  [2028.5, 68, -58, 156, -81.52, 41.57],
  [2028.5, 39, -65, -88, -60.20, 29.45],
  [2028.5, 27, -23, 81, -58.58, -13.27],
  [2028.5, 11, 34, 0, 46.77, 1.57],
  [2028.5, 72, -62, 65, -68.50, -67.87],
  [2028.5, 55, 86, 70, 87.57, 67.64],
  [2028.5, 59, 32, 163, 43.10, 0.15],
  [2028.5, 65, 48, 148, 61.79, -9.55],
  [2028.5, 95, 30, 28, 44.27, 4.56],
  [2029, 95, -60, -59, -55.17, 8.58],
  [2029, 95, -70, 42, -64.54, -55.06],
  [2029, 50, 87, -154, 89.07, -73.48],
  [2029, 58, 32, 19, 46.03, 4.11],
  [2029, 57, 34, -13, 45.74, -1.89],
  [2029, 38, -76, 49, -67.36, -64.28],
  [2029, 49, -50, -179, -71.33, 32.11],
  [2029, 90, -55, -171, -72.79, 38.65],
  [2029, 41, 42, -19, 56.44, -4.13],
  [2029, 19, 46, -22, 60.89, -5.65],
  [2029.5, 31, 13, -132, 31.41, 9.04],
  [2029.5, 93, -2, 158, -17.84, 7.09],
  [2029.5, 51, -76, 40, -66.22, -56.34],
  [2029.5, 64, 22, -132, 43.76, 10.23],
  [2029.5, 26, -65, 55, -65.71, -63.48],
  [2029.5, 66, -21, 32, -56.68, -14.63],
  [2029.5, 18, 9, -172, 15.85, 9.24],
  [2029.5, 63, 88, 26, 87.37, 36.52],
  [2029.5, 33, 17, 5, 13.77, 0.89],
  [2029.5, 77, -18, 138, -47.55, 4.45],
];

test('NOAA WMM2025 test values: declination and inclination within 0.01°', () => {
  assert.equal(NOAA_WMM2025.length, 100);
  let worstD = 0, worstI = 0;
  for (const [year, alt, lat, lon, incl, decl] of NOAA_WMM2025) {
    const p = model(year).point([lat, lon, alt]);
    worstD = Math.max(worstD, Math.abs(p.decl - decl));
    worstI = Math.max(worstI, Math.abs(p.incl - incl));
    assert.ok(Math.abs(p.decl - decl) <= 0.01, `decl ${year} ${lat},${lon}: ${p.decl.toFixed(3)} vs ${decl}`);
    assert.ok(Math.abs(p.incl - incl) <= 0.01, `incl ${year} ${lat},${lon}: ${p.incl.toFixed(3)} vs ${incl}`);
  }
  // Rounding of the table alone allows 0.005°.
  assert.ok(worstD <= 0.0051 && worstI <= 0.0051, `worst decl ${worstD}, incl ${worstI}`);
});

test('declination(lat, lng, altMeters, date) matches the model and takes meters', () => {
  for (const [year, alt, lat, lon, , decl] of NOAA_WMM2025.slice(0, 30)) {
    // declination() rounds the date to the nearest day for its cache; that moves it by < 0.001°.
    const d = declination(lat, lon, alt * 1000, year);
    assert.ok(Math.abs(d - decl) <= 0.012, `${lat},${lon}: ${d} vs ${decl}`);
  }
});

test('Sacramento in Nov 2026 matches NOAA\'s calculator: +12.839° east, ±0.354°, −0.092°/yr', () => {
  // NOAA magcalc, WMM-2025, 38.58 N 121.49 W, 2026-11-02 (docs/RESEARCH.md, maps section).
  const date = new Date(Date.UTC(2026, 10, 2));
  assert.ok(Math.abs(declination(38.58, -121.49, 0, date) - 12.839) < 0.002);
  const ref = declinationInfo(38.58, -121.49, 0, date);
  assert.ok(Math.abs(ref.uncertainty - 0.354) < 0.002, `uncertainty ${ref.uncertainty}`);
  const perYear = declination(38.58, -121.49, 0, new Date(Date.UTC(2027, 0, 1))) - declination(38.58, -121.49, 0, new Date(Date.UTC(2026, 0, 1)));
  assert.ok(Math.abs(perYear + 0.092) < 0.005, `per year ${perYear}`);
  const d = declination(38.5816, -121.4944, 10, date);
  assert.ok(d > 12 && d < 14, `got ${d}`);
  const info = declinationInfo(38.5816, -121.4944, 10, new Date(Date.UTC(2026, 10, 2)));
  assert.equal(info.model, MODEL_NAME);
  assert.equal(info.valid, true);
  assert.ok(info.uncertainty > 0.26 && info.uncertainty < 0.5, `uncertainty ${info.uncertainty}`);
});

test('decimal years count leap days; validity window is 2025.0–2030.0', () => {
  assert.equal(decimalYear(new Date(Date.UTC(2028, 0, 1))), 2028);
  assert.ok(Math.abs(decimalYear(new Date(Date.UTC(2028, 6, 1, 12))) - (2028 + 182.5 / 366)) < 1e-9);
  assert.equal(decimalYear(2027.25), 2027.25);
  assert.equal(isValidDate(new Date(Date.UTC(2026, 10, 2))), true);
  assert.equal(isValidDate(new Date(Date.UTC(2030, 5, 1))), false);
});

test('outside the window: model() throws by default, extrapolates when allowed; declination() never throws', () => {
  assert.throws(() => model(new Date(Date.UTC(2031, 0, 1))), /only valid/);
  const m = model(new Date(Date.UTC(2031, 0, 1)), { allowOutOfBoundsModel: true });
  assert.equal(m.outOfRange, true);
  const d = declination(38.5816, -121.4944, 0, new Date(Date.UTC(2031, 0, 1)));
  assert.ok(Number.isFinite(d));
  assert.equal(declination(NaN, 0), null);
  assert.equal(declinationInfo(10, undefined), null);
});

test('poles and the date line give finite answers', () => {
  for (const [lat, lon] of [[90, 0], [-90, 0], [89.999, 180], [0, -180], [0, 180]]) {
    const p = model(2026.5).point([lat, lon, 0]);
    assert.ok(Number.isFinite(p.decl) && Number.isFinite(p.incl), `${lat},${lon}`);
  }
});
