// calibration.js — how a floor plan lines up with the ground.
//
// On site the estimator marks a few spots on the plan and stands on each one
// while the phone averages its GPS (js/ui/calibrate-screen.js). Each spot is a
// *pair*: where it is on the plan (pixels) and where it is on the ground
// (meters east/north of the job walk's origin — "ENU", js/core/geo.js). From
// the pairs this module works out the plan's scale, rotation and position,
// and from then on turns any ground position into a spot on the plan (and
// back). In the office the same math lines a plan up with the satellite map.
//
// Choices a maintainer should know about (docs/RESEARCH.md, "maps"):
//
//  - A *similarity* transform: one scale, a rotation and a shift. Plans are
//    drawn to scale, so there is no shear or stretch to fit. A general affine
//    would fit 3 points exactly, soak the GPS error into a fake shear, and
//    leave nothing to check the result against. The similarity has 4
//    unknowns, so 3 points leave 2 spare — the residuals are a real check.
//  - With a scale line (a known dimension marked on the plan) the scale comes
//    from it — far more precise than GPS over a short distance — and only the
//    rotation and the shift are fitted (3 unknowns).
//  - Weighted least squares in closed form (Umeyama 1991), weights 1/σ²,
//    fitted as ENU = f(plan): the noise is on the GPS side, so the residuals
//    are meters on the ground, where σ is.
//  - Plan pixels have y DOWN; the ground has north UP. A rotation cannot turn
//    one into the other (it would need a mirror), so the fit runs on a y-up
//    copy of the plan and the flip is folded into the stored matrices.
//  - Honest quality. Phone GPS is good to a few meters however long you stand
//    still (its error drifts over minutes, so averaging helps far less than
//    √n), and a small residual does NOT prove a calibration is good — with 2
//    points it is always 0. So the quality comes from an error estimate that
//    uses a realistic floor for each GPS point's σ, grows when the residuals
//    say the points disagree, and shrinks only with more or better-spread
//    points. The person is told the truth: phone GPS gives a few meters.
//
// Headings: `northAngle` is the clockwise angle from plan "up" to true north,
// as a north arrow would be drawn on the plan (0 when north is up, 90 when it
// points right). A camera pointing true north points `northAngle` on the plan,
// so planHeading = heading + northAngle. Use headingToPlan /
// planHeadingToTrue rather than re-deriving the sign.
//
// Pure: no DOM and no database, so tests/calibration.test.mjs imports it as is.

import { toEnu as geoToEnu, metersPerDegree, normDeg } from './geo.js';
import { formatLength, formatAccuracy, M_PER_FT } from './util.js';

// ---- limits ------------------------------------------------------------------------------
//
// All in meters (or degrees). The quality bands are for the error a pin can
// be expected to have because of the calibration itself.

export const QUALITY_GOOD_M = 1.5;
export const QUALITY_FAIR_M = 4;

/**
 * The smallest σ (per axis, meters) a GPS calibration point is trusted to.
 * Phone GPS under open sky is ~4.9 m at 95 % (σ ≈ 2 m per axis), and standing
 * still for half a minute only takes 10–30 % off that, because the error
 * drifts slowly. The phone's own estimate of an average can be far smaller;
 * believing it would make every calibration look "good".
 */
export const GPS_SIGMA_FLOOR = 2.0;

/** σ of a pair picked on the plan and on the satellite photo (office alignment). */
export const MAP_SIGMA = 0.5;
const MAP_SIGMA_FLOOR = 0.25;

/**
 * Satellite photos are not exactly where GPS says the ground is (often a meter
 * or two off). A plan lined up with the photo inherits that offset against
 * the GPS positions of photos taken on site, so it is part of the honest error.
 */
export const IMAGERY_OFFSET_M = 1.0;

/** Calibration points closer than this (meters) say little about rotation or scale. */
export const MIN_SPACING_M = 5;

/** The fewest pairs that fix a similarity transform. */
export const MIN_PAIRS = 2;

const DEFAULT_SIGMA = { gps: 3, map: MAP_SIGMA };
const SIGMA_FLOOR = { gps: GPS_SIGMA_FLOOR, map: MAP_SIGMA_FLOOR };
const COLLINEAR_RATIO = 0.1;    // largest triangle area / (largest distance)²; an equilateral triangle is 0.43
const OUTLIER_RATIO = 2.5;      // a residual this many times the others' RMS…
const OUTLIER_MIN_M = { gps: 2, map: 1 };   // …and at least this big, points at one bad point
const DISAGREE_CHI = 4;         // χ²/dof above this: residuals twice what the GPS precision explains
const SPREAD_WARN_DEG = 5;      // rotation uncertainty worth mentioning
const WEAK_POINT_M = 6;         // a point whose own GPS σ was this bad
const SCALE_MISMATCH_MIN = 0.08;

const DEG = Math.PI / 180;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const unitsOf = (u) => ((u && typeof u === 'object' ? u.units : u) === 'metric' ? 'metric' : 'imperial');

/** 'good' | 'fair' | 'poor' for an expected error in meters. */
export function qualityFor(meters) {
  if (!fin(meters)) return 'poor';
  return meters <= QUALITY_GOOD_M ? 'good' : meters <= QUALITY_FAIR_M ? 'fair' : 'poor';
}

// ---- 2-D affine helpers ------------------------------------------------------------------
//
// A matrix [a, b, c, d, tx, ty] maps (u, v) to (a·u + b·v + tx, c·u + d·v + ty).

/** Apply [a, b, c, d, tx, ty] to (u, v) → [x, y]. */
export function applyAffine(m, u, v) {
  return [m[0] * u + m[1] * v + m[4], m[2] * u + m[3] * v + m[5]];
}

/** The exact inverse of [a, b, c, d, tx, ty]. */
export function invertAffine(m) {
  const [a, b, c, d, tx, ty] = m;
  const det = a * d - b * c;
  if (!fin(det) || det === 0) throw new Error('This calibration cannot be reversed (its scale is zero).');
  const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
  return [ia, ib, ic, id, -(ia * tx + ib * ty), -(ic * tx + id * ty)];
}

/** Degrees clockwise from plan "up" (−y) of a plan-pixel vector (dx, dy). */
function vecPlanHeading(dx, dy) {
  return normDeg(Math.atan2(dx, -dy) / DEG);
}

/** The direction from plan point `a` to plan point `b`, degrees clockwise from plan "up". */
export function planBearing(a, b) {
  return vecPlanHeading(b.x - a.x, b.y - a.y);
}

/**
 * Pixels per meter given by a scale line {a: {x, y}, b: {x, y}, meters}.
 * Throws a message for the person when the line cannot give a scale.
 */
export function scaleLinePxPerMeter(line) {
  if (!line || !line.a || !line.b || !fin(line.a.x) || !fin(line.a.y) || !fin(line.b.x) || !fin(line.b.y)) {
    throw new Error('The scale line is missing one of its ends. Mark both ends again.');
  }
  const px = Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y);
  if (!(px >= 1)) throw new Error('Both ends of the scale line are on the same spot. Mark the two ends of a long wall.');
  if (!fin(line.meters) || line.meters <= 0) throw new Error('The scale line needs its length, for example 24\' 0".');
  return px / line.meters;
}

// ---- the fit -----------------------------------------------------------------------------

function checkPair(p, i) {
  const ok = p && p.plan && p.enu && fin(p.plan.x) && fin(p.plan.y) && fin(p.enu.e) && fin(p.enu.n);
  if (!ok) throw new Error(`Point ${i + 1} is missing its spot on the plan or its position on the ground.`);
  return p;
}

/**
 * Weighted least-squares similarity ENU = c·Q + t, where Q is the plan point
 * with y flipped up and c, t are complex numbers (c = scale·rotation, in
 * meters per pixel). `fixedPxPerMeter` pins |c| (a scale line); the best
 * rotation is the same angle either way.
 */
function fitSimilarity(pairs, sigmas, fixedPxPerMeter) {
  let W = 0, mx = 0, my = 0, me = 0, mn = 0;
  for (let i = 0; i < pairs.length; i++) {
    const w = 1 / (sigmas[i] * sigmas[i]);
    const { plan, enu } = pairs[i];
    W += w; mx += w * plan.x; my += w * -plan.y; me += w * enu.e; mn += w * enu.n;
  }
  mx /= W; my /= W; me /= W; mn /= W;
  let re = 0, im = 0, dq = 0, dp = 0;
  for (let i = 0; i < pairs.length; i++) {
    const w = 1 / (sigmas[i] * sigmas[i]);
    const { plan, enu } = pairs[i];
    const X = plan.x - mx, Y = -plan.y - my, u = enu.e - me, v = enu.n - mn;
    re += w * (X * u + Y * v);
    im += w * (X * v - Y * u);
    dq += w * (X * X + Y * Y);
    dp += w * (u * u + v * v);
  }
  if (!(Math.sqrt(dq / W) > 0.5)) {
    throw new Error('The points on the plan are all on the same spot. Mark spots far apart on the plan.');
  }
  if (!(Math.sqrt(dp / W) > 0.01)) {
    throw new Error('All the points have the same ground position. Walk to each point before you set its location.');
  }
  let a = re / dq, b = im / dq;
  const mag = Math.hypot(a, b);
  if (!(mag > 0) || !fin(mag)) {
    throw new Error('The points could not be lined up. Check that each mark is on the spot you stood on.');
  }
  if (fixedPxPerMeter) {
    const k = 1 / fixedPxPerMeter / mag;
    a *= k; b *= k;
  }
  // E = a·X − b·Y + te,  N = b·X + a·Y + tn, with X = x and Y = −y:
  //   e = a·x + b·y + te,  n = b·x − a·y + tn
  const te = me - (a * mx - b * my);
  const tn = mn - (b * mx + a * my);
  return { toEnu: [a, b, b, -a, te, tn], W, dq, mag: Math.hypot(a, b), mx, my };
}

function residualsOf(toEnu, pairs) {
  return pairs.map(({ plan, enu }) => {
    const [e, n] = applyAffine(toEnu, plan.x, plan.y);
    return Math.hypot(e - enu.e, n - enu.n);
  });
}

/**
 * Line a plan up with the ground.
 *
 * pairs: [{plan: {x, y} (plan px, y down), enu: {e, n} (meters), sigma (m, 1σ per axis), …}]
 *        — anything else on a pair (its raw lat/lng, sample count) is kept,
 *        so the calibration can be solved again later.
 * scaleLine: null | {a: {x, y}, b: {x, y}, meters} — fixes the scale.
 * method: 'gps' (standing on the spots) | 'map' (picked on the satellite map).
 *
 * Returns a Calibration (docs/SPEC.md §6) plus: scaleSource ('gps'|'map'|'line'),
 * sigma (per-axis σ used, m), fitError and expectedError (m, how far a pin may
 * be off because of the calibration; expectedError also counts the satellite
 * photo's own offset for 'map'), rotationSigma (deg), scaleSigma (fraction),
 * dof, chi2, gpsPxPerMeter and scaleMismatch (when a scale line is used), and
 * warnings: [{code, pair?, pairs?, value?}] (describeWarnings words them).
 * Throws an Error with a plain message when the points cannot give an answer.
 */
export function solveCalibration({ pairs, scaleLine = null, method = 'gps' } = {}) {
  const how = method === 'map' ? 'map' : 'gps';
  const list = (pairs || []).map(checkPair);
  if (list.length < MIN_PAIRS) throw new Error('At least 2 points are needed to line up the plan — 3 give a check.');
  const sigmasGiven = list.map((p) => (fin(p.sigma) && p.sigma > 0 ? p.sigma : DEFAULT_SIGMA[how]));
  const sigmas = sigmasGiven.map((s) => Math.max(s, SIGMA_FLOOR[how]));
  const linePx = scaleLine ? scaleLinePxPerMeter(scaleLine) : null;

  const fit = fitSimilarity(list, sigmas, linePx);
  const toEnu = fit.toEnu;
  const toPlan = invertAffine(toEnu);
  const pxPerMeter = 1 / fit.mag;
  // Where true north (0, 1) lands on the plan, as a heading from plan "up".
  const northAngle = vecPlanHeading(toPlan[1], toPlan[3]);

  const n = list.length;
  const residuals = residualsOf(toEnu, list);
  const rms = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / n);
  const maxResidual = Math.max(...residuals);
  const k = linePx ? 3 : 4;                     // unknowns: rotation + 2 shifts (+ scale)
  const dof = 2 * n - k;
  const chi2 = residuals.reduce((s, r, i) => s + (r * r) / (sigmas[i] * sigmas[i]), 0);
  const varianceFactor = dof > 0 ? chi2 / dof : 1;
  // The residuals may say the points are worse than their σ; never that they are better.
  const inflate = Math.max(1, varianceFactor);
  // Error of a pin over the building: the shift (2/W) + the rotation (1/W)
  // + the scale (1/W, unless a scale line fixes it), averaged over the spread
  // of the points. With phone GPS this is a few meters by design.
  const fitError = Math.sqrt((k / fit.W) * inflate);
  const expectedError = how === 'map' ? Math.hypot(fitError, IMAGERY_OFFSET_M) : fitError;
  const spreadM2 = fit.dq * fit.mag * fit.mag;  // Σ w·|point − centre|² in meters, weighted by 1/σ²
  const rotationSigma = Math.sqrt(inflate / spreadM2) / DEG;
  const scaleSigma = linePx ? 0 : Math.sqrt(inflate / spreadM2);

  let gpsPxPerMeter = null, scaleMismatch = null, freeScaleSigma = null;
  if (linePx) {
    // The scale GPS alone would give: if it disagrees with the line by much
    // more than GPS can explain, the typed length or a point is wrong.
    const free = fitSimilarity(list, sigmas, null);
    gpsPxPerMeter = 1 / free.mag;
    scaleMismatch = gpsPxPerMeter / linePx - 1;
    const freeRes = residualsOf(free.toEnu, list);
    const freeDof = 2 * n - 4;
    const freeChi = freeRes.reduce((s, r, i) => s + (r * r) / (sigmas[i] * sigmas[i]), 0);
    const freeInflate = Math.max(1, freeDof > 0 ? freeChi / freeDof : 1);
    freeScaleSigma = Math.sqrt(freeInflate / (free.dq * free.mag * free.mag));
  }

  const warnings = findWarnings(list, {
    how, sigmasGiven, sigmas, residuals, dof, chi2, varianceFactor, rotationSigma,
    linePx, scaleMismatch, freeScaleSigma,
  });

  return {
    version: 1,
    method: how,
    createdAt: Date.now(),
    toPlan,
    toEnu,
    pxPerMeter,
    northAngle,
    pairs: list.map((p, i) => ({ ...JSON.parse(JSON.stringify(p)), sigma: sigmasGiven[i] })),
    scaleLine: scaleLine ? JSON.parse(JSON.stringify(scaleLine)) : null,
    residuals,
    rms,
    maxResidual,
    quality: qualityFor(Math.max(expectedError, rms)),
    scaleSource: linePx ? 'line' : how,
    sigma: Math.sqrt(n / fit.W) * Math.sqrt(inflate),
    fitError,
    expectedError,
    rotationSigma,
    scaleSigma,
    dof,
    chi2,
    gpsPxPerMeter,
    scaleMismatch,
    warnings,
  };
}

/**
 * Point i left out: how far the others put it from where it was measured
 * (pe, meters), how well the others agree among themselves (restRms), and
 * how much of the total misfit (χ²) goes away without it (drop). Null when
 * the others alone cannot be solved.
 */
function leaveOneOut(list, sigmas, linePx, chiAll, i) {
  const rest = list.filter((_, j) => j !== i);
  const rs = sigmas.filter((_, j) => j !== i);
  let f;
  try { f = fitSimilarity(rest, rs, linePx); } catch { return null; }
  const p = list[i];
  const [e, n] = applyAffine(f.toEnu, p.plan.x, p.plan.y);
  const pe = Math.hypot(e - p.enu.e, n - p.enu.n);
  const rr = residualsOf(f.toEnu, rest);
  const restRms = Math.sqrt(rr.reduce((s, r) => s + r * r, 0) / rr.length);
  const restChi = rr.reduce((s, r, j) => s + (r * r) / (rs[j] * rs[j]), 0);
  return { pe, restRms, drop: chiAll - restChi };
}

/** Geometry and consistency problems worth telling the person about, most important first. */
function findWarnings(list, info) {
  const out = [];
  const n = list.length;
  const pts = list.map((p) => p.enu);
  const { residuals } = info;
  const fixed = !!info.linePx;

  // One point that disagrees with the rest. A least-squares fit spreads one
  // bad point's error onto its neighbours, so the residuals alone often blame
  // the wrong one. Instead each point is left out in turn: the bad one is the
  // one whose removal makes the misfit (χ²) drop the most — the others then
  // agree among themselves, and it is far (2.5× the others' error) from where
  // they put it. With 3 points and a free scale the others are only 2 — they
  // fit anything — so WHICH point is off cannot be told; that case gets the
  // general "they disagree" instead.
  let outlier = -1;
  if (info.dof >= 2 && (n >= 4 || (n >= 3 && fixed))) {
    let best = null;
    for (let i = 0; i < n; i++) {
      const l = leaveOneOut(list, info.sigmas, info.linePx, info.chi2, i);
      if (l && (!best || l.drop > best.drop)) best = { ...l, i };
    }
    // The drop is χ² with 2 degrees of freedom for an honest point: above
    // 12.4 happens by chance about once in 500.
    if (best && best.drop > 12.4 && best.pe >= OUTLIER_MIN_M[info.how] && best.pe > OUTLIER_RATIO * best.restRms) {
      outlier = best.i;
      out.push({ code: 'outlier', pair: best.i, value: best.pe });
    }
  }
  if (outlier < 0 && info.dof > 0 && info.varianceFactor > DISAGREE_CHI) {
    out.push({ code: 'disagree', value: Math.max(...residuals) });
  }
  if (info.scaleMismatch != null &&
      Math.abs(info.scaleMismatch) > Math.max(SCALE_MISMATCH_MIN, 3 * (info.freeScaleSigma || 0))) {
    out.push({ code: 'scale-mismatch', value: info.scaleMismatch });
  }
  if (n === 2 && !fixed) out.push({ code: 'no-check' });

  let maxD = 0;
  let close = false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = Math.hypot(pts[j].e - pts[i].e, pts[j].n - pts[i].n);
      maxD = Math.max(maxD, d);
      if (d < MIN_SPACING_M) { close = true; out.push({ code: 'close', pairs: [i, j], value: d }); }
    }
  }
  if (n >= 3 && maxD >= MIN_SPACING_M) {
    let maxArea = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        for (let k = j + 1; k < n; k++) {
          const area = Math.abs((pts[j].e - pts[i].e) * (pts[k].n - pts[i].n) - (pts[k].e - pts[i].e) * (pts[j].n - pts[i].n)) / 2;
          maxArea = Math.max(maxArea, area);
        }
      }
    }
    const ratio = maxArea / (maxD * maxD);
    if (ratio < COLLINEAR_RATIO) out.push({ code: 'collinear', value: ratio });
  }
  if (!close && info.rotationSigma > SPREAD_WARN_DEG) out.push({ code: 'spread', value: info.rotationSigma });
  info.sigmasGiven.forEach((s, i) => { if (s > WEAK_POINT_M) out.push({ code: 'weak-point', pair: i, value: s }); });
  return out;
}

// ---- using a calibration -------------------------------------------------------------------

/** Plan pixels for a ground position {e, n} (meters), or null without a calibration. */
export function enuToPlan(cal, enu) {
  if (!cal || !Array.isArray(cal.toPlan) || !enu || !fin(enu.e) || !fin(enu.n)) return null;
  const [x, y] = applyAffine(cal.toPlan, enu.e, enu.n);
  return { x, y };
}

/** The ground position {e, n} (meters) of a plan point, or null without a calibration. */
export function planToEnu(cal, pt) {
  if (!cal || !Array.isArray(cal.toEnu) || !pt || !fin(pt.x) || !fin(pt.y)) return null;
  const [e, n] = applyAffine(cal.toEnu, pt.x, pt.y);
  return { e, n };
}

/** A direction clockwise from TRUE north → clockwise from plan "up" (null when unknown). */
export function headingToPlan(cal, trueHeadingDeg) {
  if (!cal || !fin(cal.northAngle) || !fin(trueHeadingDeg)) return null;
  return normDeg(trueHeadingDeg + cal.northAngle);
}

/** A direction clockwise from plan "up" → clockwise from TRUE north (null when unknown). */
export function planHeadingToTrue(cal, planHeadingDeg) {
  if (!cal || !fin(cal.northAngle) || !fin(planHeadingDeg)) return null;
  return normDeg(planHeadingDeg - cal.northAngle);
}

// ---- moving pins after a new calibration --------------------------------------------------

function poseEnu(pose, origin, toEnu) {
  if (pose.enu && fin(pose.enu.e) && fin(pose.enu.n)) return { e: pose.enu.e, n: pose.enu.n };
  const g = pose.geo;
  if (g && fin(g.lat) && fin(g.lng) && origin && fin(origin.lat) && fin(origin.lng)) {
    try {
      const r = toEnu(origin, g.lat, g.lng);
      if (r && fin(r.e) && fin(r.n)) return r;
    } catch { /* no position */ }
  }
  return null;
}

/** The accuracy behind a pose's planAcc, in meters, so it can be rescaled to the new plan scale. */
function accuracyMeters(pose, previous) {
  if (fin(pose.planAcc) && previous && fin(previous.pxPerMeter) && previous.pxPerMeter > 0) {
    return pose.planAcc / previous.pxPerMeter;
  }
  if (pose.geo && fin(pose.geo.acc)) return pose.geo.acc;
  return null;
}

const near = (a, b) => (a == null && b == null) || (fin(a) && fin(b) && Math.abs(a - b) < 1e-6);
const validPt = (p) => !!p && fin(p.x) && fin(p.y);
const HAND_PIN_M = 0.3; // m — how well a pin placed by hand on the plan shows the spot (camera-screen applyPin)

/** New plan points and directions for a video's path; `keepXY` (a pin placed by hand) changes only the directions. */
function reprojectTrack(track, cal, origin, toEnu, { keepXY = false } = {}) {
  let changed = false;
  const out = track.map((pt) => {
    if (!pt || typeof pt !== 'object') return pt;
    let e = pt.e, n = pt.n;
    if (!keepXY && !(fin(e) && fin(n)) && fin(pt.lat) && fin(pt.lng) && origin && fin(origin.lat) && fin(origin.lng)) {
      try { ({ e, n } = toEnu(origin, pt.lat, pt.lng)); } catch { e = n = null; }
    }
    const next = { ...pt };
    if (!keepXY && fin(e) && fin(n)) {
      const [x, y] = applyAffine(cal.toPlan, e, n);
      next.x = x; next.y = y;
    }
    if (fin(pt.heading)) next.planHeading = headingToPlan(cal, pt.heading);
    if (!near(next.x, pt.x) || !near(next.y, pt.y) || !near(next.planHeading, pt.planHeading)) changed = true;
    return next;
  });
  return { track: changed ? out : track, changed };
}

/**
 * New plan positions for the pins on `level` after its calibration changed.
 *
 * For every item on that level whose pin was not placed by hand
 * (pose.planLocked !== true) and that has a ground position (pose.enu, or
 * pose.geo + `origin`): pose.plan, pose.planAcc and pose.planHeading, and each
 * video track point's x, y and planHeading, are recomputed with
 * level.calibration. A pin placed by hand on the plan (planLocked with a plan
 * point) keeps its spot and its path; only what comes from the calibration is
 * recomputed — planHeading (from the true heading) and planAcc's size in
 * pixels. Items whose pins would not change are left out.
 *
 * opts.previous: the calibration the stored planAcc values were made with
 *   (the level's calibration before this one), so the accuracy circle keeps
 *   its size in meters; without it pose.geo.acc is used.
 * opts.toEnu: lat/lng → {e, n} (default js/core/geo.js toEnu).
 *
 * Returns [{id, pose, track}] — new objects; the items passed in are not changed.
 */
export function reprojectItems(items, level, origin, { previous = null, toEnu = geoToEnu } = {}) {
  const cal = level?.calibration;
  if (!cal || !Array.isArray(cal.toPlan) || !level.id) return [];
  const out = [];
  for (const item of items || []) {
    if (!item || item.levelId !== level.id) continue;
    const pose = item.pose;
    // Placed by hand: the spot stays. Which way the camera looked does not —
    // it is the true heading turned by THIS calibration, and nobody can set it
    // by hand, so a pin pinned before calibrating would otherwise never get a
    // wedge, and a recalibration would leave its wedge at the old rotation.
    // (A lock with no plan point has nothing on the plan to update.)
    // A lock with no plan point (an older map pin placed by hand) has nothing
    // on the plan to keep, so it is placed from its ground position instead.
    const locked = !!pose && pose.planLocked === true && validPt(pose.plan);
    const enu = pose && !locked ? poseEnu(pose, origin, toEnu) : null;
    const tr = Array.isArray(item.track) ? reprojectTrack(item.track, cal, origin, toEnu, { keepXY: locked }) : { track: item.track ?? null, changed: false };
    if (!enu && !locked && !tr.changed) continue;
    let nextPose = pose;
    if (locked) {
      const ppmWas = previous && fin(previous.pxPerMeter) && previous.pxPerMeter > 0 && fin(cal.pxPerMeter) ? previous.pxPerMeter : null;
      // The same size in meters at the new scale. Pinned while the plan had no
      // scale at all (no previous calibration), the stored size is only a
      // stand-in (the camera's 2 px): a spot placed by hand is good to about
      // HAND_PIN_M, as the camera says once the plan is calibrated.
      let planAcc = pose.planAcc ?? null;
      if (fin(pose.planAcc) && ppmWas) planAcc = (pose.planAcc / ppmWas) * cal.pxPerMeter;
      else if (fin(pose.planAcc) && !previous && fin(cal.pxPerMeter) && cal.pxPerMeter > 0) planAcc = HAND_PIN_M * cal.pxPerMeter;
      nextPose = {
        ...pose,
        planAcc,
        planHeading: fin(pose.heading) ? headingToPlan(cal, pose.heading) : (pose.planHeading ?? null),
      };
      if (near(pose.planAcc ?? null, nextPose.planAcc) && near(pose.planHeading ?? null, nextPose.planHeading)) nextPose = pose;
    } else if (enu) {
      const [x, y] = applyAffine(cal.toPlan, enu.e, enu.n);
      const accM = accuracyMeters(pose, previous);
      nextPose = {
        ...pose,
        plan: { x, y },
        planAcc: accM != null ? accM * cal.pxPerMeter : (pose.planAcc ?? null),
        planHeading: fin(pose.heading) ? headingToPlan(cal, pose.heading) : (pose.planHeading ?? null),
      };
      const same = pose.plan && near(pose.plan.x, x) && near(pose.plan.y, y) &&
        near(pose.planAcc ?? null, nextPose.planAcc) && near(pose.planHeading ?? null, nextPose.planHeading);
      if (same) nextPose = pose;
    }
    if (nextPose === pose && !tr.changed) continue;
    out.push({ id: item.id, pose: nextPose, track: tr.track });
  }
  return out;
}

// ---- averaging GPS fixes on one spot ------------------------------------------------------

/**
 * Average the GPS fixes taken while standing on one spot — used when the
 * person taps Done before the positioning engine finishes its own average.
 * Drops the first third (the fix settling in), weights by 1/accuracy², and
 * reports an honest precision: GPS error drifts over minutes, so the average
 * is not √n better than one fix.
 *
 * fixes: [{lat, lng, acc (m), alt?}] in the order they came.
 * Returns {lat, lng, alt, acc (m, 1σ), n (fixes used), spread (m RMS)} or null.
 */
export function averageFixes(fixes) {
  const ok = (fixes || []).filter((f) => f && fin(f.lat) && fin(f.lng) && Math.abs(f.lat) <= 90 && Math.abs(f.lng) <= 180);
  if (!ok.length) return null;
  const keep = ok.length >= 6 ? ok.slice(Math.floor(ok.length / 3)) : ok;
  let W = 0, lat = 0, lng = 0;
  for (const f of keep) {
    const a = fin(f.acc) && f.acc > 0 ? Math.max(f.acc, 1) : 10;
    const w = 1 / (a * a);
    W += w; lat += w * f.lat; lng += w * f.lng;
  }
  lat /= W; lng /= W;
  const k = metersPerDegree(lat);
  let ss = 0;
  for (const f of keep) {
    const dx = (f.lng - lng) * k.lng, dy = (f.lat - lat) * k.lat;
    ss += dx * dx + dy * dy;
  }
  const spread = Math.sqrt(ss / keep.length);
  const accs = keep.map((f) => f.acc).filter((a) => fin(a) && a > 0).sort((a, b) => a - b);
  const medAcc = accs.length ? accs[Math.floor(accs.length / 2)] : 10;
  const alts = keep.map((f) => f.alt).filter(fin);
  // The phone's accuracy is a ~68 % radius (≈1.5σ); averaging takes maybe 15 % off.
  const acc = Math.max(spread / Math.sqrt(keep.length), 0.57 * medAcc, 0.3);
  return {
    lat, lng,
    alt: alts.length ? alts.reduce((s, v) => s + v, 0) / alts.length : null,
    acc, n: keep.length, spread,
  };
}

/**
 * Two averages of the same spot ("Keep averaging") → one. Back-to-back
 * averages share most of their GPS error, so the combined precision is only
 * modestly better, and never better than half the gap between them.
 */
export function combineSamples(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const sa = fin(a.acc) && a.acc > 0 ? a.acc : 5;
  const sb = fin(b.acc) && b.acc > 0 ? b.acc : 5;
  const wa = 1 / (sa * sa), wb = 1 / (sb * sb), W = wa + wb;
  const lat = (wa * a.lat + wb * b.lat) / W;
  const lng = (wa * a.lng + wb * b.lng) / W;
  const k = metersPerDegree(lat);
  const gap = Math.hypot((a.lng - b.lng) * k.lng, (a.lat - b.lat) * k.lat);
  const acc = Math.max(Math.min(sa, sb) * 0.85, Math.sqrt(1 / W), gap / 2);
  const na = a.n || 1, nb = b.n || 1;
  const spread = Math.sqrt((na * (a.spread || 0) ** 2 + nb * (b.spread || 0) ** 2) / (na + nb) + (wa * wb / (W * W)) * gap * gap);
  const alt = fin(a.alt) && fin(b.alt) ? (wa * a.alt + wb * b.alt) / W : fin(b.alt) ? b.alt : fin(a.alt) ? a.alt : null;
  return { ...a, ...b, lat, lng, alt, acc, n: na + nb, spread, seconds: (a.seconds || 0) + (b.seconds || 0) };
}

// ---- words for the person -----------------------------------------------------------------

/** "1 ft = 12.3 px" (imperial) or "1 m = 40.4 px" (metric). */
export function formatScale(pxPerMeter, units = 'imperial') {
  if (!fin(pxPerMeter) || pxPerMeter <= 0) return '—';
  const metric = unitsOf(units) === 'metric';
  const v = metric ? pxPerMeter : pxPerMeter * M_PER_FT;
  const s = v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toPrecision(2);
  return `1 ${metric ? 'm' : 'ft'} = ${s} px`;
}

/**
 * How good a calibration is, in words: {label, detail, level: 'good'|'fair'|'poor'}.
 * `units`: 'imperial' (default) | 'metric', or the settings object.
 */
export function describeQuality(cal, units = 'imperial') {
  const u = unitsOf(units);
  if (!cal) {
    return {
      level: 'poor',
      label: 'Not calibrated',
      detail: 'Photos still save with their GPS position. Their pins appear on this plan once it is calibrated.',
    };
  }
  const err = fin(cal.expectedError) ? cal.expectedError : fin(cal.rms) ? cal.rms : null;
  const level = cal.quality || qualityFor(err);
  const acc = formatAccuracy(err, u);
  const label = { good: 'Good', fair: 'Fair', poor: 'Poor' }[level] || 'Poor';
  let detail;
  if (cal.method === 'map') {
    const fit = formatAccuracy(fin(cal.fitError) ? cal.fitError : err, u);
    detail = `Lined up with the satellite photo to about ${fit}. Satellite photos can sit a few feet off from GPS, so pins from photos taken on site may be off by about ${acc}.`;
    if (level === 'poor') detail += ' Check that each pair marks exactly the same spot on the plan and on the map.';
  } else if (level === 'good') {
    detail = `Pins should land within about ${acc} of where you stood.`;
  } else if (level === 'fair') {
    detail = `Pins may be off by about ${acc} — normal for phone GPS. A scale line, or another point far from the others, makes it better.`;
  } else {
    detail = `Pins may be off by ${acc} or more. Redo the point that is off, or spread the points farther apart.`;
  }
  return { level, label, detail };
}

/**
 * The calibration's warnings as sentences: [{code, text, redo}] — `redo` is
 * the index of the pair worth redoing, or null.
 */
export function describeWarnings(cal, units = 'imperial') {
  const u = unitsOf(units);
  const map = cal?.method === 'map';
  const noun = map ? 'pair' : 'point';
  const Noun = map ? 'Pair' : 'Point';
  const L = (m) => formatLength(m, u);
  const out = [];
  for (const w of cal?.warnings || []) {
    const n = (w.pair ?? 0) + 1;
    switch (w.code) {
      case 'outlier':
        out.push({ code: w.code, redo: w.pair, text: map
          ? `Pair ${n} doesn't agree with the others (off by ${L(w.value)}). Redo pair ${n}: check that both marks are on exactly the same spot.`
          : `Point ${n} doesn't agree with the others (off by ${L(w.value)}). Redo point ${n}: check its mark on the plan, then stand on the spot again.` });
        break;
      case 'disagree':
        out.push({ code: w.code, redo: null, text: map
          ? `The pairs don't agree with each other (up to ${L(w.value)} off). Check that each pair marks the same spot on the plan and on the map.`
          : `The points don't agree with each other (up to ${L(w.value)} off). A mark may be on the wrong spot, or the GPS jumped. Check the marks, redo the point you're least sure of, or add another point to find the one that is off.` });
        break;
      case 'scale-mismatch':
        out.push({ code: w.code, redo: null, text: `${map ? 'Map' : 'GPS'} distances and the scale line differ by ${Math.round(Math.abs(w.value) * 100)}%. Check the length you typed and the two ends of the scale line — or one of the ${noun}s is off.` });
        break;
      case 'no-check':
        out.push({ code: w.code, redo: null, text: `With 2 ${noun}s there is nothing to check the result against. Add a 3rd ${noun} to catch a mistake.` });
        break;
      case 'close': {
        const [i, j] = w.pairs || [0, 1];
        out.push({ code: w.code, redo: null, text: `${Noun}s ${i + 1} and ${j + 1} are only ${L(w.value)} apart. ${Noun}s far apart — across the whole building — give a much better result.` });
        break;
      }
      case 'collinear':
        out.push({ code: w.code, redo: null, text: `The ${noun}s are almost in a straight line. Put one off to the side to make a big triangle — that checks the whole plan, not just one line.` });
        break;
      case 'spread':
        out.push({ code: w.code, redo: null, text: `The ${noun}s are close together for GPS, so the plan's rotation may be off by about ${Math.round(w.value)}°. ${Noun}s farther apart help the most.` });
        break;
      case 'weak-point':
        out.push({ code: w.code, redo: w.pair, text: `Point ${n} had weak GPS (${formatAccuracy(w.value, u)}). Redo it with a clearer view of the sky if you can.` });
        break;
      default:
        break;
    }
  }
  return out;
}
