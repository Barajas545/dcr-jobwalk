// views.test.mjs — the math behind the plan and map views (js/ui/plan-view.js,
// js/ui/map-view.js) and the marker drawing (js/ui/markers.js).
//
// The views themselves need a browser (canvas, pointer events, Leaflet) and are
// checked at integration. What is checked here is everything that decides
// WHERE things land: plan ↔ screen transforms, fit and pan limits, hit
// testing, video-track interpolation (the moving marker during playback), the
// image-pyramid choice, the plan-over-map affine, tile and search URLs, and
// that the marker functions draw what they should on a recording canvas.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const pv = await import('../js/ui/plan-view.js');
const mk = await import('../js/ui/markers.js');
const mv = await import('../js/ui/map-view.js');

const near = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);

/** A canvas context that records every call and assignment. */
function fakeCtx() {
  const calls = [];
  const props = {};
  return new Proxy({}, {
    get(_, k) {
      if (k === 'calls') return calls;
      if (typeof k === 'string' && k in props) return props[k];
      if (k === 'measureText') return (t) => ({ width: String(t).length * 7 });
      if (k === 'createRadialGradient' || k === 'createLinearGradient') {
        return (...a) => {
          const g = { stops: [], addColorStop(o, c) { this.stops.push([o, c]); } };
          calls.push([k, a, g]);
          return g;
        };
      }
      return (...a) => { calls.push([k, ...a]); };
    },
    set(_, k, v) {
      props[k] = v;
      calls.push([`=${String(k)}`, v]);
      return true;
    },
  });
}
const named = (ctx, name) => ctx.calls.filter((c) => c[0] === name);

// ---- transforms --------------------------------------------------------------------------

test('fitTransform shows the whole plan, centred, with the requested air', () => {
  const t = pv.fitTransform(400, 800, 8000, 6000);
  near(t.scale, 0.05);
  near(t.tx, 0);
  near(t.ty, 250);
  const p = pv.fitTransform(400, 800, 8000, 6000, 12);
  near(p.scale, 376 / 8000);
  near(p.tx, 12);
  // a tall plan in a wide view fits by height
  const q = pv.fitTransform(1000, 500, 1000, 2000);
  near(q.scale, 0.25);
  near(q.tx, 375);
  near(q.ty, 0);
});

test('planToScreen and screenToPlan are inverses', () => {
  const t = { scale: 0.37, tx: -123.4, ty: 56.7 };
  for (const [x, y] of [[0, 0], [8000, 6000], [1234.5, 77.25], [-50, 9000]]) {
    const s = pv.planToScreen(t, x, y);
    const back = pv.screenToPlan(t, s.x, s.y);
    near(back.x, x, 1e-9);
    near(back.y, y, 1e-9);
  }
});

test('zoomAround keeps the point under the finger still', () => {
  const t = { scale: 0.2, tx: 30, ty: -40 };
  const before = pv.screenToPlan(t, 150, 260);
  const z = pv.zoomAround(t, 1.7, 150, 260);
  near(z.scale, 1.7);
  const after = pv.screenToPlan(z, 150, 260);
  near(after.x, before.x, 1e-9);
  near(after.y, before.y, 1e-9);
});

test('centerTransform puts the plan point in the middle of the view', () => {
  const t = pv.centerTransform({ x: 500, y: 250 }, 2, 400, 300);
  const c = pv.planToScreen(t, 500, 250);
  near(c.x, 200);
  near(c.y, 150);
});

test('clampTransform keeps a plan that fits on screen centred (like a photo)', () => {
  const b = { x0: 0, y0: 0, x1: 8000, y1: 6000 };
  const t = pv.clampTransform({ scale: 0.05, tx: 999, ty: -999 }, 400, 800, b);
  near(t.tx, 0);      // 8000 × 0.05 = 400 = the view width: centred
  near(t.ty, 250);
});

test('clampTransform lets the centre reach every corner when zoomed in or placing a point', () => {
  const b = { x0: 0, y0: 0, x1: 8000, y1: 6000 };
  // Zoomed in far (content ≫ screen): the view centre may sit right on a corner…
  const s = 1;
  let t = pv.clampTransform(pv.centerTransform({ x: 8000, y: 6000 }, s, 400, 800), 400, 800, b);
  let c = pv.screenToPlan(t, 200, 400);
  near(c.x, 8000);
  near(c.y, 6000);
  // …but not beyond it.
  t = pv.clampTransform(pv.centerTransform({ x: 9000, y: -500 }, s, 400, 800), 400, 800, b);
  c = pv.screenToPlan(t, 200, 400);
  near(c.x, 8000);
  near(c.y, 0);
  // Placing a point (lockSmall: false) reaches the corner even at fit zoom.
  t = pv.clampTransform(pv.centerTransform({ x: -100, y: -100 }, 0.05, 400, 800), 400, 800, b, { lockSmall: false });
  c = pv.screenToPlan(t, 200, 400);
  near(c.x, 0);
  near(c.y, 0);
});

test('clampTransform reach grows smoothly with zoom (no snap when pinching out)', () => {
  const b = { x0: 0, y0: 0, x1: 1000, y1: 1000 };
  const reachAt = (scale) => {
    // ask for the far right edge, see how far the centre may go from the middle
    const t = pv.clampTransform(pv.centerTransform({ x: 1000, y: 500 }, scale, 500, 500), 500, 500, b);
    return pv.screenToPlan(t, 250, 250).x - 500;
  };
  near(reachAt(0.5), 0);          // content = view: locked in the middle
  near(reachAt(0.75), 250);       // 1.5 × view: half way
  near(reachAt(1.0), 500);        // 2 × view: anywhere over the content
  assert.ok(reachAt(0.6) > 0 && reachAt(0.6) < reachAt(0.7));
});

test('distToSegment measures to the nearest point of the segment', () => {
  near(pv.distToSegment(5, 5, 0, 0, 10, 0), 5);
  near(pv.distToSegment(-3, 4, 0, 0, 10, 0), 5);      // beyond the start: to the end point
  near(pv.distToSegment(13, 4, 0, 0, 10, 0), 5);
  near(pv.distToSegment(3, 4, 0, 0, 0, 0), 5);        // a zero-length segment
});

// ---- hit testing -----------------------------------------------------------------------

test('hitTestTargets: generous pins, nearest wins, pins beat paths', () => {
  const a = { id: 'a' }, b = { id: 'b' }, v = { id: 'v' };
  const targets = [
    { kind: 'path', pts: [{ x: 0, y: 100 }, { x: 300, y: 100 }], item: v },
    { kind: 'pin', x: 100, y: 100, item: a },
    { kind: 'pin', x: 130, y: 100, item: b },
  ];
  assert.equal(pv.hitTestTargets(targets, 112, 100).item, a);
  assert.equal(pv.hitTestTargets(targets, 118, 100).item, b);
  assert.equal(pv.hitTestTargets(targets, 100, 121).item, a);       // 21 px away: still a hit
  assert.equal(pv.hitTestTargets(targets, 250, 110).item, v);       // only the path is near
  assert.equal(pv.hitTestTargets(targets, 250, 130), null);         // 30 px from the path
  assert.equal(pv.hitTestTargets([], 0, 0), null);
});

test('hitTestTargets: a tie goes to the pin drawn later; the selected one gets help', () => {
  const a = { id: 'a' }, b = { id: 'b' };
  const tie = [{ kind: 'pin', x: 0, y: 0, item: a }, { kind: 'pin', x: 0, y: 0, item: b }];
  assert.equal(pv.hitTestTargets(tie, 3, 3).item, b);
  const sel = [{ kind: 'pin', x: 0, y: 0, item: a, selected: true }, { kind: 'pin', x: 10, y: 0, item: b }];
  assert.equal(pv.hitTestTargets(sel, 6, 0).item, a);    // b is 4 px nearer, but a is selected
});

test('simplifyScreenPath drops points on the same pixel and always keeps the last one', () => {
  const pts = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 5, y: 0 }, { x: 5.2, y: 0 }, { x: null, y: 3 }];
  const out = pv.simplifyScreenPath(pts);
  assert.deepEqual(out.map((p) => p.x), [0, 5]);
  const scaled = pv.simplifyScreenPath([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }], (p) => ({ x: p.x * 10, y: p.y }));
  assert.deepEqual(scaled.map((p) => p.x), [0, 10, 20]);
  const lastKept = pv.simplifyScreenPath([{ x: 0, y: 0 }, { x: 0.2, y: 0 }]);
  assert.deepEqual(lastKept.map((p) => p.x), [0, 0.2]);
});

// ---- video tracks --------------------------------------------------------------------------

test('interpolateTrack: linear position, shortest-arc heading', () => {
  const track = [
    { t: 0, x: 0, y: 0, lat: 38, lng: -121, e: 0, n: 0, heading: 350, planHeading: 10, pitch: -10, acc: 4 },
    { t: 1000, x: 100, y: 50, lat: 38.001, lng: -121.002, e: 10, n: 20, heading: 10, planHeading: 350, pitch: 10, acc: 2 },
  ];
  const mid = pv.interpolateTrack(track, 500);
  near(mid.x, 50); near(mid.y, 25);
  near(mid.lat, 38.0005, 1e-12); near(mid.lng, -121.001, 1e-12);
  near(mid.e, 5); near(mid.n, 10);
  near(mid.heading, 0, 1e-9, 'through north, not south:');
  near(mid.planHeading, 0, 1e-9);
  near(mid.pitch, 0); near(mid.acc, 3);
  near(pv.interpolateTrack(track, 250).heading, 355);
  assert.ok(mid.heading >= 0 && mid.heading < 360);
  assert.equal(mid.t, 500);
});

test('interpolateTrack: before the start and after the end hold the ends; exact samples are exact', () => {
  const track = [{ t: 100, x: 1, y: 2, heading: 90 }, { t: 200, x: 3, y: 4, heading: 180 }];
  assert.deepEqual([pv.interpolateTrack(track, -50).x, pv.interpolateTrack(track, -50).y], [1, 2]);
  assert.deepEqual([pv.interpolateTrack(track, 5000).x, pv.interpolateTrack(track, 5000).y], [3, 4]);
  assert.equal(pv.interpolateTrack(track, 200).heading, 180);
  assert.equal(pv.interpolateTrack(track, 100).x, 1);
  assert.equal(pv.interpolateTrack(track, 'not a number').x, 1);   // treated as t = 0
});

test('interpolateTrack: a field missing from some samples comes from the samples that have it', () => {
  const track = [
    { t: 0, x: 0, y: 0, heading: null, planHeading: null },
    { t: 500, x: null, y: null, heading: 90, planHeading: null },
    { t: 1000, x: 100, y: 100, heading: 180, planHeading: null },
  ];
  const a = pv.interpolateTrack(track, 250);
  near(a.x, 25);                 // between t=0 and t=1000 (the middle sample has no x, y)
  near(a.heading, 90);           // before the first heading: hold it
  near(pv.interpolateTrack(track, 750).heading, 135);
  assert.equal(a.planHeading, null);   // no sample has it
  assert.equal(a.lat, null);
  // half a position does not count
  const half = pv.interpolateTrack([{ t: 0, x: 5, y: null }, { t: 10, x: 7, y: 9 }], 0);
  assert.equal(half.x, 7);
  assert.equal(half.y, 9);
});

test('interpolateTrack: unsorted tracks, live tracks that grow, empty tracks', () => {
  const track = [{ t: 1000, x: 10, y: 0 }, { t: 0, x: 0, y: 0 }];
  near(pv.interpolateTrack(track, 500).x, 5);
  track.push({ t: 2000, x: 30, y: 0 });
  near(pv.interpolateTrack(track, 1500).x, 20);
  assert.equal(pv.interpolateTrack([], 0), null);
  assert.equal(pv.interpolateTrack(null, 0), null);
  assert.equal(pv.interpolateTrack([{ t: null, x: 1, y: 1 }], 0), null);
  const one = pv.interpolateTrack([{ t: 0, x: 4, y: 5, heading: 12 }], 999);
  assert.deepEqual([one.x, one.y, one.heading], [4, 5, 12]);
});

test('interpolateTrack is fast enough for 60 fps over a 10-minute video', () => {
  const track = [];
  for (let i = 0; i < 3000; i++) track.push({ t: i * 200, x: i, y: i * 2, heading: (i * 7) % 360, planHeading: null, lat: null, lng: null });
  const t0 = performance.now();
  for (let k = 0; k < 6000; k++) pv.interpolateTrack(track, (k * 97) % 600000);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `6000 lookups took ${ms.toFixed(0)} ms`);
  near(pv.interpolateTrack(track, 1100).x, 5.5);
});

// ---- image pyramid and plan drawing ----------------------------------------------------------

test('chooseLevel picks the smallest copy that is still sharp enough', () => {
  const levels = [{ w: 8000 }, { w: 4000 }, { w: 2000 }, { w: 1000 }];
  assert.equal(pv.chooseLevel(levels, 1), 0);
  assert.equal(pv.chooseLevel(levels, 2), 0);        // zoomed in past 1:1: the full image
  assert.equal(pv.chooseLevel(levels, 0.5), 1);
  assert.equal(pv.chooseLevel(levels, 0.3), 1);      // ¼ would be stretched 20%: too soft
  assert.equal(pv.chooseLevel(levels, 0.27), 2);     // ¼ stretched < 10%: fine
  assert.equal(pv.chooseLevel(levels, 0.01), 3);
  assert.equal(pv.chooseLevel([{ w: 0 }], 0.5), 0);
});

test('acquirePyramid shares one pyramid per image and counts its users', () => {
  const img = { width: 1200, height: 800 };
  const a = pv.acquirePyramid(img);
  const b = pv.acquirePyramid(img);
  assert.equal(a, b);
  assert.equal(a.refs, 2);
  assert.deepEqual([a.levels[0].w, a.levels[0].h], [1200, 800]);
  pv.releasePyramid(a);
  pv.releasePyramid(b);
  assert.equal(a.refs, 0);
  pv.releasePyramid(null);   // harmless
});

test('drawPlanImage draws only the part of the plan that is on screen', () => {
  const img = { width: 1000, height: 500 };
  const pyr = { levels: [{ src: img, w: 1000, h: 500 }] };
  const ctx = fakeCtx();
  // plan × 0.5, shifted (10, 20): a 300 × 200 view shows plan x −20…580, y −40…360
  const ok = pv.drawPlanImage(ctx, pyr, 1000, 500, [0.5, 0, 0, 0.5, 10, 20], { dpr: 2, viewW: 300, viewH: 200 });
  assert.equal(ok, true);
  const [d] = named(ctx, 'drawImage');
  assert.equal(d[1], img);
  assert.deepEqual(d.slice(2), [0, 0, 580, 360, 0, 0, 580, 360]);
  const [st] = named(ctx, 'setTransform');
  assert.deepEqual(st.slice(1), [1, 0, 0, 1, 20, 40]);   // × device pixel ratio
  // off screen entirely: nothing drawn, still "ok"
  const ctx2 = fakeCtx();
  assert.equal(pv.drawPlanImage(ctx2, pyr, 1000, 500, [0.5, 0, 0, 0.5, 5000, 0], { viewW: 300, viewH: 200 }), true);
  assert.equal(named(ctx2, 'drawImage').length, 0);
  // not decoded yet
  assert.equal(pv.drawPlanImage(fakeCtx(), { levels: [{ src: {}, w: 0, h: 0 }] }, 10, 10, [1, 0, 0, 1, 0, 0], { viewW: 10, viewH: 10 }), false);
});

test('drawPlanImage reads a smaller pyramid level in its own pixels', () => {
  const full = { width: 4000, height: 2000 }, half = { width: 2000, height: 1000 };
  const pyr = { levels: [{ src: full, w: 4000, h: 2000 }, { src: half, w: 2000, h: 1000 }] };
  const ctx = fakeCtx();
  // 0.1 CSS px per plan px at dpr 2 → 0.2 device px per full pixel → the half copy
  pv.drawPlanImage(ctx, pyr, 4000, 2000, [0.1, 0, 0, 0.1, 0, 0], { dpr: 2, viewW: 1000, viewH: 1000 });
  const [d] = named(ctx, 'drawImage');
  assert.equal(d[1], half);
  assert.deepEqual(d.slice(2), [0, 0, 2000, 1000, 0, 0, 4000, 2000]);
});

// ---- affine (plan over map) -------------------------------------------------------------------

test('affineFromCorners maps the image corners where asked; invertAffine undoes it', () => {
  const tl = { x: 100, y: 50 }, tr = { x: 300, y: 150 }, bl = { x: 50, y: 150 };
  const m = pv.affineFromCorners(tl, tr, bl, 400, 200);
  const at = (x, y) => pv.applyAffine(m, x, y);
  assert.deepEqual(at(0, 0), tl);
  assert.deepEqual(at(400, 0), tr);
  assert.deepEqual(at(0, 200), bl);
  assert.deepEqual(at(400, 200), { x: tr.x + bl.x - tl.x, y: tr.y + bl.y - tl.y });
  const inv = pv.invertAffine(m);
  const back = pv.applyAffine(inv, 123, 77);
  const again = at(back.x, back.y);
  near(again.x, 123, 1e-9);
  near(again.y, 77, 1e-9);
  assert.equal(pv.invertAffine([1, 2, 2, 4, 0, 0]), null);   // degenerate
});

test('planCornersLatLng chains plan → ENU → lat/lng', () => {
  const fns = {
    planToEnu: (cal, p) => ({ e: p.x / cal.k, n: -p.y / cal.k }),
    fromEnu: (o, e, n) => ({ lat: o.lat + n / 1e5, lng: o.lng + e / 1e5 }),
  };
  const c = mv.planCornersLatLng({ k: 10 }, { lat: 38, lng: -121 }, 1000, 500, fns);
  assert.deepEqual(c.tl, { lat: 38, lng: -121 });
  near(c.tr.lng, -121 + 100 / 1e5, 1e-12);
  near(c.bl.lat, 38 - 50 / 1e5, 1e-12);
  near(c.br.lat, 38 - 50 / 1e5, 1e-12);
  near(c.br.lng, -121 + 100 / 1e5, 1e-12);
});

// ---- scene and markers -----------------------------------------------------------------------

test('markerColors falls back to the app colours without a stylesheet', () => {
  const c = mk.markerColors();
  assert.equal(c.photo, '#c8371f');
  assert.equal(c.video, '#7b3fd1');
  assert.equal(c.note, '#d98a00');
  assert.equal(c.me, '#1a73e8');
  assert.equal(mk.markerColors(), c);   // cached
});

test('rgba turns any token colour into a translucent one', () => {
  assert.equal(mk.rgba('#c8371f', 0.5), 'rgba(200, 55, 31, 0.5)');
  assert.equal(mk.rgba('#fff', 1), 'rgba(255, 255, 255, 1)');
  assert.equal(mk.rgba('#00000080', 1), 'rgba(0, 0, 0, 0.502)');
  assert.equal(mk.rgba('rgba(26, 115, 232, 0.18)', 0.5), 'rgba(26, 115, 232, 0.09)');
  assert.equal(mk.rgba('rgb(1 2 3)', 0.25), 'rgba(1, 2, 3, 0.25)');
  assert.equal(mk.rgba('rebeccapurple', 0.3), 'rebeccapurple');
});

test('a photo wedge points along the heading (east = 0 rad on a canvas), 60° wide', () => {
  const ctx = fakeCtx();
  mk.drawPhotoPin(ctx, 50, 60, Math.PI / 2, { n: 7 });
  const wedge = named(ctx, 'arc').find((c) => c[3] === 46);
  assert.ok(wedge, 'a 46 px wedge arc');
  near(wedge[4], -Math.PI / 6, 1e-12);
  near(wedge[5], Math.PI / 6, 1e-12);
  assert.ok(named(ctx, 'fillText').some((c) => c[1] === '7'));
  // north-up heading 0 → canvas −90°
  near(mk.canvasAngle(0), -Math.PI / 2);
});

test('a photo with no heading has no wedge; markup shows a dot; light mode has no number', () => {
  const ctx = fakeCtx();
  mk.drawPhotoPin(ctx, 0, 0, null, { n: 3, annotated: true });
  assert.equal(named(ctx, 'createRadialGradient').length, 0);
  const dots = named(ctx, 'arc').filter((c) => near2(c[3], 4.6));
  assert.equal(dots.length, 1, 'one markup dot');
  const light = fakeCtx();
  mk.drawPhotoPin(light, 0, 0, 1, { n: 3, light: true });
  assert.equal(named(light, 'fillText').length, 0);
});
function near2(a, b) { return Math.abs(a - b) < 1e-9; }

test('the person: accuracy circle only when bigger than the dot; cone fades when the phone is flat', () => {
  const up = fakeCtx();
  mk.drawMe(up, 10, 10, 40, 0, 'camera');
  assert.ok(named(up, 'arc').some((c) => c[3] === 40), 'accuracy circle');
  const stopUp = named(up, 'createRadialGradient')[0][2].stops[0][1];
  const flat = fakeCtx();
  mk.drawMe(flat, 10, 10, 5, 0, 'top');
  assert.ok(!named(flat, 'arc').some((c) => c[3] === 5), 'no circle smaller than the dot');
  const stopFlat = named(flat, 'createRadialGradient')[0][2].stops[0][1];
  const alpha = (s) => Number(s.match(/([\d.]+)\)$/)[1]);
  assert.ok(alpha(stopFlat) < alpha(stopUp), `${stopFlat} fainter than ${stopUp}`);
  const none = fakeCtx();
  mk.drawMe(none, 10, 10, null, null);
  assert.equal(named(none, 'createRadialGradient').length, 0, 'no heading, no cone');
});

test('a video path: one point is just the numbered start; a walk gets a line and chevrons', () => {
  // The white casing under a path is drawn 6.5 px wide (9.5 when selected): only a real path has one.
  const casings = (ctx) => named(ctx, '=lineWidth').filter((c) => c[1] === 6.5 || c[1] === 9.5).length;
  const one = fakeCtx();
  mk.drawVideoPath(one, [{ x: 5, y: 5 }], { n: 12 });
  assert.equal(casings(one), 0);
  assert.ok(named(one, 'fillText').some((c) => c[1] === '12'));
  const walk = fakeCtx();
  const pts = Array.from({ length: 20 }, (_, i) => ({ x: i * 20, y: 0 }));
  mk.drawVideoPath(walk, pts, { n: 4, selected: true });
  assert.equal(casings(walk), 1);
  assert.ok(named(walk, 'lineTo').length > 19);
  assert.ok(named(walk, 'stroke').length >= 3);
  mk.drawVideoPath(fakeCtx(), [], {});   // nothing, no throw
});

test('notes, marks, lines, labels, crosshair and the playhead draw without surprises', () => {
  const ctx = fakeCtx();
  mk.drawNotePin(ctx, 0, 0, { n: 101, selected: true });
  mk.drawMark(ctx, 0, 0, { label: '1', kind: 'calib' });
  mk.drawMark(ctx, 0, 0, { kind: 'scale' });
  mk.drawMark(ctx, 0, 0, { kind: 'temp' });
  mk.drawLineMark(ctx, { x: 0, y: 0 }, { x: 100, y: 0 }, { label: "24' 0\"", dashed: true });
  mk.drawLineMark(ctx, null, { x: 1, y: 1 });
  mk.drawCrosshair(ctx, 5, 5);
  mk.drawPlayhead(ctx, 5, 5, 1);
  assert.equal(mk.drawLabel(ctx, 0, 0, ''), 0);
  assert.ok(mk.drawLabel(ctx, 0, 0, 'abc') > 0);
  const texts = named(ctx, 'fillText').map((c) => c[1]);
  assert.ok(texts.includes('101') && texts.includes('1') && texts.includes("24' 0\""));
});

test('niceScaleLength picks round lengths in feet or meters', () => {
  const ft = mk.niceScaleLength(10, 'imperial');       // 90 px ≈ 29.5 ft → 20 ft
  assert.equal(ft.label, '20 ft');
  near(ft.meters, 20 * 0.3048, 1e-12);
  near(ft.px, 20 * 0.3048 * 10, 1e-9);
  assert.equal(mk.niceScaleLength(10, 'metric').label, '5 m');
  assert.equal(mk.niceScaleLength(1000, 'metric').label, '5 cm');
  assert.equal(mk.niceScaleLength(0.5, 'metric').label, '100 m');
  assert.equal(mk.niceScaleLength(null), null);
  assert.equal(mk.niceScaleLength(-1), null);
});

test('drawScene: paths, then pins (selected on top), marks, the playhead, the person last', () => {
  const ctx = fakeCtx();
  const item = (id, seq) => ({ id, seq });
  mk.markerColors();
  pv.drawScene(ctx, {
    selectedId: 'p2',
    playId: null,
    videos: [{ item: item('v1', 1), n: 1, screen: [{ x: 0, y: 0 }, { x: 50, y: 50 }] }],
    pins: [
      { item: item('p2', 2), kind: 'photo', sx: 10, sy: 10, h: 0, n: 2 },
      { item: item('p3', 3), kind: 'note', sx: 20, sy: 20, h: null, n: 3 },
      { item: item('p4', 4), kind: 'photo', sx: -500, sy: 20, h: null, n: 4 },   // far off screen: skipped
    ],
    marks: [{ sx: 30, sy: 30, label: 'A', kind: 'calib' }],
    lines: [],
    play: { sx: 40, sy: 40, h: 1 },
    me: { sx: 45, sy: 45, accPx: 30, h: 0, facing: 'camera' },
  }, { viewW: 300, viewH: 300 });
  const texts = named(ctx, 'fillText').map((c) => c[1]);
  assert.deepEqual(texts, ['1', '3', '2', 'A']);    // video start, other pins, selected pin, mark
  const lastArc = named(ctx, 'arc').at(-1);
  assert.deepEqual(lastArc.slice(1, 3), [45, 45]);  // the person is drawn last
});

test('meStyle and isAnnotated read the pose and item as the markers need', () => {
  assert.deepEqual(pv.meStyle({ facing: 'top', quality: 'good', source: 'fused', headingAcc: 50 }), { facing: 'top', stale: false, uncertain: true });
  assert.deepEqual(pv.meStyle({ quality: 'none', source: 'none' }), { facing: 'camera', stale: true, uncertain: false });
  assert.equal(pv.isAnnotated({ media: { annotated: 'm_1' } }), true);
  assert.equal(pv.isAnnotated({ annotations: { shapes: [{}] } }), true);
  assert.equal(pv.isAnnotated({ annotations: { shapes: [] }, media: {} }), false);
});

// ---- map helpers ------------------------------------------------------------------------------------

test('base maps: Esri public or keyed, OSM on its subdomains, all CORS, Esri native to 19', () => {
  const e = mv.baseLayerSpec('esri');
  assert.equal(e.kind, 'esri');
  assert.equal(e.url, 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}');
  assert.equal(e.options.crossOrigin, true);
  assert.equal(e.options.maxNativeZoom, 19);
  assert.equal(e.options.maxZoom, 22);
  assert.match(e.options.attribution, /Esri/);
  assert.match(e.options.attribution, /Maxar/);
  assert.match(e.options.attribution, /Earthstar Geographics/);
  const k = mv.baseLayerSpec('esri', { esriKey: ' AAPK a/b ' });
  assert.equal(k.kind, 'esri-key');
  assert.ok(k.url.startsWith('https://ibasemaps-api.arcgis.com/'));
  assert.ok(k.url.endsWith('/tile/{z}/{y}/{x}?token=AAPK%20a%2Fb'));
  const o = mv.baseLayerSpec('osm');
  assert.equal(o.url, 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
  assert.equal(o.options.subdomains, 'abc');
  assert.equal(o.options.crossOrigin, true);
  assert.match(o.options.attribution, /OpenStreetMap/);
  assert.equal(mv.baseLayerSpec('something else').kind, 'esri');
});

test('Google tile and viewport URLs', () => {
  const t = mv.googleTileUrl('ses/1+', 'KEY&');
  assert.equal(t, 'https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=ses%2F1%2B&key=KEY%26');
  const v = new URL(mv.googleViewportUrl('S', 'K', 19.6, { north: 38.6, south: 38.5, east: 238.6, west: -121.6 }));
  assert.equal(v.origin + v.pathname, 'https://tile.googleapis.com/tile/v1/viewport');
  assert.equal(v.searchParams.get('zoom'), '20');
  assert.equal(v.searchParams.get('session'), 'S');
  near(Number(v.searchParams.get('east')), -121.4, 1e-9);   // wrapped
  assert.equal(v.searchParams.get('south'), '38.5');
});

test('googleMaxZoomAt reads the best zoom for a spot, across the date line too', () => {
  const rects = [
    { maxZoom: 19, north: 90, south: -90, east: 180, west: -180 },
    { maxZoom: 21, north: 39, south: 38, east: -121, west: -122 },
  ];
  assert.equal(mv.googleMaxZoomAt(rects, { lat: 38.5, lng: -121.5 }), 21);
  assert.equal(mv.googleMaxZoomAt(rects, { lat: 10, lng: 10 }), 19);
  assert.equal(mv.googleMaxZoomAt([{ maxZoom: 18, north: 10, south: 0, east: -170, west: 170 }], { lat: 5, lng: 179 }), 18);
  assert.equal(mv.googleMaxZoomAt([], { lat: 0, lng: 0 }), null);
  assert.equal(mv.googleMaxZoomAt(null, { lat: 0, lng: 0 }), null);
});

test('tileXY and pxPerMeterAt follow Web Mercator', () => {
  assert.deepEqual(mv.tileXY(0, 0, 1), { x: 1, y: 1 });
  assert.deepEqual(mv.tileXY(85, -180, 2), { x: 0, y: 0 });
  assert.deepEqual(mv.tileXY(-85.06, 179.9999, 2), { x: 3, y: 3 });
  // docs/RESEARCH.md: 0.117 m/px at z20 and 0.058 m/px at z21 at 38.6° N
  near(1 / mv.pxPerMeterAt(38.6, 20), 0.117, 0.001);
  near(1 / mv.pxPerMeterAt(38.6, 21), 0.058, 0.001);
  near(mv.pxPerMeterAt(10, 18) * 2, mv.pxPerMeterAt(10, 19), 1e-9);
});

test('cubicBezier matches CSS timing; Leaflet\'s zoom curve eases out', () => {
  const lin = mv.cubicBezier(1 / 3, 1 / 3, 2 / 3, 2 / 3);
  for (const x of [0.1, 0.37, 0.5, 0.9]) near(lin(x), x, 1e-5);
  const e = mv.leafletZoomEase;
  assert.equal(e(0), 0);
  assert.equal(e(1), 1);
  assert.equal(e(-1), 0);
  assert.equal(e(2), 1);
  assert.ok(e(0.5) > 0.7, `fast start, slow end: ${e(0.5)}`);
  let prev = 0;
  for (let i = 1; i <= 50; i++) { const v = e(i / 50); assert.ok(v >= prev - 1e-9); prev = v; }
});

test('parseLatLng takes typed coordinates and leaves addresses alone', () => {
  assert.deepEqual(mv.parseLatLng('38.5816, -121.4944'), { lat: 38.5816, lng: -121.4944 });
  assert.deepEqual(mv.parseLatLng(' 38.5816 -121.4944 '), { lat: 38.5816, lng: -121.4944 });
  assert.deepEqual(mv.parseLatLng('38.5816;-121'), { lat: 38.5816, lng: -121 });
  assert.equal(mv.parseLatLng('12 6'), null);
  assert.equal(mv.parseLatLng('100 Main St'), null);
  assert.equal(mv.parseLatLng('91.5, 10'), null);
  assert.equal(mv.parseLatLng('45.1, 181'), null);
  assert.equal(mv.parseLatLng(''), null);
  assert.equal(mv.wrapLng(190), -170);
  assert.equal(mv.wrapLng(-180), -180);
  assert.equal(mv.wrapLng(-121.5), -121.5);
});

test('nominatimUrl asks for JSON, a few results, in the phone\'s language', () => {
  const u = new URL(mv.nominatimUrl('1200 J St, Sacramento', { limit: 5, lang: 'es' }));
  assert.equal(u.origin + u.pathname, 'https://nominatim.openstreetmap.org/search');
  assert.equal(u.searchParams.get('q'), '1200 J St, Sacramento');
  assert.equal(u.searchParams.get('format'), 'jsonv2');
  assert.equal(u.searchParams.get('limit'), '5');
  assert.equal(u.searchParams.get('accept-language'), 'es');
});

test('searchAddress: coordinates need no network; results come back as {label, lat, lng}', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  try {
    globalThis.fetch = async () => { throw new Error('should not be called'); };
    assert.deepEqual(await mv.searchAddress('38.5, -121.25'), [{ label: '38.500000, -121.250000', lat: 38.5, lng: -121.25 }]);
    assert.deepEqual(await mv.searchAddress('   '), []);

    globalThis.fetch = async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, json: async () => [{ display_name: '1200 J St', lat: '38.58', lon: '-121.49' }, { display_name: 'bad', lat: 'x', lon: '1' }] };
    };
    const r = await mv.searchAddress('1200 J St');
    assert.deepEqual(r, [{ label: '1200 J St', lat: 38.58, lng: -121.49 }]);
    assert.match(seen[0].url, /^https:\/\/nominatim\.openstreetmap\.org\/search\?/);
    assert.equal(seen[0].init.credentials, 'omit');

    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await assert.rejects(mv.searchAddress('somewhere'), /did not answer/);    // (waits Nominatim's 1 s turn)

    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(mv.searchAddress('elsewhere'), /could not be reached/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('createPickOverlay and the views need a DOM; the module still imports in Node', () => {
  assert.equal(typeof pv.createPlanView, 'function');
  assert.equal(typeof mv.createMapView, 'function');
  assert.throws(() => pv.createPlanView(null), /container/);
  assert.throws(() => mv.createMapView(null), /container/);
  assert.equal(pv.isTypingTarget({ tagName: 'INPUT' }), true);
  assert.equal(pv.isTypingTarget({ tagName: 'DIV' }), false);
  assert.equal(pv.isTypingTarget(null), false);
});
