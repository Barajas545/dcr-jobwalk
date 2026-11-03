// annotations.test.mjs — the markup model and geometry of js/core/annotations.js.
//
// Node has no canvas, so these cover the pure parts: sizes, geometry, hit
// testing, the revision-cloud path, moving and reshaping, cleaning damaged
// data, what Save writes to an item and when a draft is offered (through the
// real store, on a fake IndexedDB) — plus a smoke test that drawing every
// shape type on a recording fake context neither throws nor skips anything.
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const A = await import('../js/core/annotations.js');
const store = await import('../js/core/store.js');

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const pt = (x, y) => ({ x, y });
const approxMeasure = (text, size) => String(text).length * size * 0.5;

// ---- sizes ------------------------------------------------------------------------

test('stroke defaults are a fraction of the long side (S/M/L ≈ 0.25 / 0.5 / 0.9 %)', () => {
  assert.equal(A.strokeWidthFor('S', 4000, 3000), 10);
  assert.equal(A.strokeWidthFor('M', 4000, 3000), 20);
  assert.equal(A.strokeWidthFor('L', 4000, 3000), 36);
  // Portrait uses the long side too.
  assert.equal(A.strokeWidthFor('M', 3000, 4000), 20);
  // An unknown key falls back to M.
  assert.equal(A.strokeWidthFor('XL', 4000, 3000), 20);
});

test('a markup looks the same on a 4000 px photo and a 1000 px one', () => {
  for (const k of A.SIZE_KEYS) {
    const big = A.strokeWidthFor(k, 4000, 3000) / 4000;
    const small = A.strokeWidthFor(k, 1000, 750) / 1000;
    assert.ok(near(big, small, 0.0002), `${k}: ${big} vs ${small}`);
    assert.ok(near(A.fontSizeFor(k, 4000, 3000) / 4000, A.fontSizeFor(k, 1000, 750) / 1000, 0.0002));
  }
  assert.ok(A.strokeWidthFor('S', 4000, 3000) < A.strokeWidthFor('M', 4000, 3000));
  assert.ok(A.strokeWidthFor('M', 4000, 3000) < A.strokeWidthFor('L', 4000, 3000));
});

test('highlighter strokes are much wider than the pen, and sizes never collapse to zero', () => {
  assert.equal(A.highlightWidthFor('M', 4000, 3000), 20 * A.HIGHLIGHT_FACTOR);
  assert.ok(A.strokeWidthFor('S', 10, 10) >= 1);
  assert.ok(A.fontSizeFor('S', 10, 10) >= 10);
  assert.ok(A.strokeWidthFor('M', 0, 0) > 0, 'unknown photo size still gives a width');
});

test('nearestSizeKey finds the preset a shape was drawn with', () => {
  const W = 4000, H = 3000;
  for (const k of A.SIZE_KEYS) {
    assert.equal(A.nearestSizeKey({ type: 'line', width: A.strokeWidthFor(k, W, H) }, W, H), k);
    assert.equal(A.nearestSizeKey({ type: 'pen', mode: 'highlight', width: A.highlightWidthFor(k, W, H) }, W, H), k);
    assert.equal(A.nearestSizeKey({ type: 'text', width: 1, size: A.fontSizeFor(k, W, H) }, W, H), k);
  }
  assert.equal(A.nearestSizeKey(null, W, H), 'M');
});

test('applySize and applyColor return new shapes and leave the original alone', () => {
  const W = 4000, H = 3000;
  const line = A.createShape('line', { color: '#e53935', width: 10, a: pt(0, 0), b: pt(100, 0) });
  const big = A.applySize(line, 'L', W, H);
  assert.equal(big.width, 36);
  assert.equal(line.width, 10);
  const blue = A.applyColor(line, '#1e88e5');
  assert.equal(blue.color, '#1e88e5');
  assert.equal(line.color, '#e53935');
  assert.equal(blue.id, line.id);

  const text = A.createShape('text', { width: 10, at: pt(100, 100), text: 'Header', size: 96 });
  const bigText = A.applySize(text, 'L', W, H, approxMeasure);
  assert.equal(bigText.size, A.fontSizeFor('L', W, H));
  // It grows around its centre.
  const c0 = A.shapeBounds(text, approxMeasure);
  const c1 = A.shapeBounds(bigText, approxMeasure);
  assert.ok(near(c0.x + c0.w / 2, c1.x + c1.w / 2, 1e-6));
  assert.ok(near(c0.y + c0.h / 2, c1.y + c1.h / 2, 1e-6));
});

// ---- geometry ---------------------------------------------------------------------

test('distToSegment: perpendicular, past either end, and a zero-length segment', () => {
  const a = pt(0, 0), b = pt(10, 0);
  assert.equal(A.distToSegment(pt(5, 3), a, b), 3);
  assert.equal(A.distToSegment(pt(-3, 4), a, b), 5);
  assert.equal(A.distToSegment(pt(13, 4), a, b), 5);
  assert.equal(A.distToSegment(pt(3, 4), a, a), 5);
  assert.equal(A.distToSegment(pt(5, 0), a, b), 0);
});

test('distToPolyline, open and closed', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(A.distToPolyline(pt(5, -2), sq), 2);
  // (−2, 5) is nearest the left side, which only exists when closed.
  assert.ok(A.distToPolyline(pt(-2, 5), sq) > 2);
  assert.equal(A.distToPolyline(pt(-2, 5), sq, true), 2);
  assert.equal(A.distToPolyline(pt(3, 4), [[0, 0]]), 5);
  assert.equal(A.distToPolyline(pt(0, 0), []), Infinity);
});

test('normalizeRect works whichever way the box was dragged', () => {
  const expect = { x: 10, y: 20, w: 30, h: 40 };
  assert.deepEqual(A.normalizeRect(pt(10, 20), pt(40, 60)), expect);
  assert.deepEqual(A.normalizeRect(pt(40, 60), pt(10, 20)), expect);
  assert.deepEqual(A.normalizeRect(pt(40, 20), pt(10, 60)), expect);
  assert.deepEqual(A.normalizeRect(pt(10, 60), pt(40, 20)), expect);
  assert.deepEqual(A.normalizeRect(pt(5, 5), pt(5, 5)), { x: 5, y: 5, w: 0, h: 0 });
});

test('snapAngle keeps the length and snaps to 45°; squareFrom makes a square', () => {
  const b = A.snapAngle(pt(0, 0), pt(100, 8));
  assert.ok(near(b.x, Math.hypot(100, 8)) && near(b.y, 0));
  const d = A.snapAngle(pt(0, 0), pt(70, 64));
  assert.ok(near(d.x, d.y, 1e-9));
  assert.deepEqual(A.squareFrom(pt(0, 0), pt(30, -10)), { x: 30, y: -30 });
  assert.deepEqual(A.snapAngle(pt(1, 1), pt(1, 1)), { x: 1, y: 1 });
});

test('arrowhead: the tip is the end point, the base is on the line, the sides are symmetric', () => {
  const a = pt(0, 0), b = pt(200, 0);
  const h = A.arrowHead(a, b, 10);
  assert.deepEqual(h.tip, b);
  assert.ok(near(h.base.y, 0) && near(h.base.x, 200 - h.length));
  assert.ok(near(h.length, 42), 'about 4.2 stroke widths long');
  assert.ok(near(h.left.x, h.right.x) && near(h.left.y, -h.right.y));
  // The shaft stops inside the head, so its round cap is hidden.
  assert.ok(h.shaftEnd.x > h.base.x && h.shaftEnd.x < b.x);
  // A short arrow gets a head of at most 60 % of its length.
  const s = A.arrowHead(a, pt(20, 0), 10);
  assert.ok(near(s.length, 12));
  assert.equal(A.arrowHead(a, a, 10), null);
});

test('dimension geometry: ticks across the line at both ends, an upright label angle', () => {
  const g = A.dimensionGeometry(pt(0, 0), pt(100, 0), 2);
  assert.equal(g.length, 100);
  assert.deepEqual(g.mid, { x: 50, y: 0 });
  assert.equal(g.angle, 0);
  for (const [u, v] of g.ticks) assert.ok(near(u.x, v.x) && near(Math.abs(u.y - v.y), 16));
  assert.equal(g.heads.length, 2);
  // Drawn right to left, the label still reads left to right.
  assert.equal(A.dimensionGeometry(pt(100, 0), pt(0, 0), 2).angle, 0);
  const up = A.dimensionGeometry(pt(0, 100), pt(0, 0), 2).angle;
  assert.ok(up > -Math.PI / 2 - 1e-9 && up <= Math.PI / 2 + 1e-9);
});

test('cloud scallops chain into one closed path around the box, bulging outward', () => {
  const a = pt(10, 20), b = pt(210, 120);
  const arcs = A.cloudArcs(a, b, 25);
  assert.ok(arcs.length >= 20 && arcs.length <= 28, `${arcs.length} arcs`);
  for (let i = 0; i < arcs.length; i++) {
    const cur = arcs[i];
    const next = arcs[(i + 1) % arcs.length];
    assert.ok(near(cur.x1, next.x0, 1e-6) && near(cur.y1, next.y0, 1e-6), `arc ${i} meets arc ${i + 1}`);
    // Both ends lie on the arc's circle.
    assert.ok(near(Math.hypot(cur.x0 - cur.cx, cur.y0 - cur.cy), cur.r, 1e-6));
    assert.ok(near(Math.hypot(cur.x1 - cur.cx, cur.y1 - cur.cy), cur.r, 1e-6));
    // The peak of every scallop is outside the box; its centre is inside.
    const r = A.normalizeRect(a, b);
    assert.ok(!A.pointInRect(cur.peak, r), `arc ${i} peaks outside the box`);
    assert.ok(A.pointInRect({ x: cur.cx, y: cur.cy }, r, 1e-6));
    // Drawn clockwise (canvas anticlockwise = false), the sweep from a0 to a1 passes the peak.
    const peakAng = Math.atan2(cur.peak.y - cur.cy, cur.peak.x - cur.cx);
    const sweep = (x) => ((x - cur.a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    assert.ok(sweep(peakAng) < sweep(cur.a1), `arc ${i} bulges the right way`);
  }
  // Starts at the top-left corner and ends back there.
  assert.ok(near(arcs[0].x0, 10) && near(arcs[0].y0, 20));
  assert.ok(near(arcs.at(-1).x1, 10) && near(arcs.at(-1).y1, 20));
});

test('cloud: more scallops for a bigger box, none for an empty one, a flat box still works', () => {
  const small = A.cloudArcs(pt(0, 0), pt(100, 100), 20).length;
  const large = A.cloudArcs(pt(0, 0), pt(400, 400), 20).length;
  assert.ok(large > small * 3);
  assert.deepEqual(A.cloudArcs(pt(5, 5), pt(5, 5), 20), []);
  const flat = A.cloudArcs(pt(0, 0), pt(100, 0), 20);
  assert.ok(flat.length > 0 && flat.every((c) => Number.isFinite(c.r)));
  // Each side has at least one scallop even when shorter than the arc size.
  assert.equal(A.cloudArcs(pt(0, 0), pt(5, 5), 50).length, 4);
});

test('decimatePoints and simplifyPath thin a stroke but keep its ends', () => {
  const pts = [];
  for (let i = 0; i <= 100; i++) pts.push([i, 0]);
  const d = A.decimatePoints(pts, 10);
  assert.deepEqual(d[0], [0, 0]);
  assert.deepEqual(d.at(-1), [100, 0]);
  assert.ok(d.length <= 12);
  const s = A.simplifyPath(pts, 0.5);
  assert.deepEqual(s, [[0, 0], [100, 0]]);
  // A corner survives.
  const corner = [[0, 0], [50, 0], [100, 0], [100, 50], [100, 100]];
  assert.deepEqual(A.simplifyPath(corner, 1), [[0, 0], [100, 0], [100, 100]]);
  // A long wiggly stroke does not overflow anything.
  const long = Array.from({ length: 20000 }, (_, i) => [i, Math.sin(i / 7) * 30]);
  assert.ok(A.simplifyPath(long, 0.5).length > 2);
  assert.deepEqual(A.roundPoints([[1.234, 5.678]]), [[1.2, 5.7]]);
});

test('fitCanvasSize respects the iPhone canvas area and the long-side limit', () => {
  assert.deepEqual(A.fitCanvasSize(4032, 3024), { width: 4032, height: 3024, scale: 1 });
  const big = A.fitCanvasSize(8000, 6000);
  assert.ok(big.width * big.height <= A.MAX_CANVAS_PIXELS);
  assert.ok(near(big.width / big.height, 8000 / 6000, 0.001));
  const capped = A.fitCanvasSize(4000, 3000, { maxSide: 400 });
  assert.equal(capped.width, 400);
  assert.equal(capped.height, 300);
  const panorama = A.fitCanvasSize(40000, 1000);
  assert.ok(panorama.width <= A.MAX_CANVAS_SIDE);
});

// ---- model ---------------------------------------------------------------------------

test('nextBadgeNumber is one more than the highest callout', () => {
  assert.equal(A.nextBadgeNumber([]), 1);
  assert.equal(A.nextBadgeNumber({ shapes: [] }), 1);
  const shapes = [
    { type: 'badge', n: 1 }, { type: 'line', n: 99 }, { type: 'badge', n: 3 },
  ];
  assert.equal(A.nextBadgeNumber(shapes), 4);
  assert.equal(A.nextBadgeNumber({ shapes }), 4);
});

test('createShape gives fresh ids and copies its inputs', () => {
  const a = pt(1, 2);
  const s1 = A.createShape('line', { a, b: pt(3, 4), width: 5, color: '#fff' });
  const s2 = A.createShape('line', { a, b: pt(3, 4), width: 5, color: '#fff' });
  assert.notEqual(s1.id, s2.id);
  a.x = 99;
  assert.equal(s1.a.x, 1);
  assert.equal(A.createShape('pen', { points: [[0, 0]] }).mode, 'pen');
  assert.equal(A.createShape('text', { at: pt(0, 0), text: 'x', size: 10 }).bg, true);
});

test('sanitizeShapes drops damaged shapes and fills in missing or repeated ids', () => {
  const good = A.createShape('rect', { a: pt(0, 0), b: pt(5, 5), width: 2 });
  const list = [
    good,
    { ...good }, // same id again
    { type: 'rect', color: '#f00', width: 2, a: pt(0, 0) }, // no b
    { type: 'pen', color: '#f00', width: 2, points: [[0, NaN]] },
    { type: 'mystery', color: '#f00', width: 2 },
    null,
    { type: 'text', color: '#f00', width: 2, at: pt(1, 1), text: 'ok', size: 20 }, // no id
    { type: 'badge', color: '#f00', width: 2, at: pt(1, 1), n: 2, id: 'b1' },
  ];
  const out = A.sanitizeShapes(list);
  assert.equal(out.length, 4);
  assert.equal(new Set(out.map((s) => s.id)).size, 4);
  assert.equal(out[0].id, good.id);
  assert.notEqual(out[0], good, 'copies, not the same objects');
  assert.deepEqual(A.sanitizeShapes('nope'), []);
});

test('toAnnotations, sameShapes and rescaleAnnotations', () => {
  const shapes = [A.createShape('line', { a: pt(100, 100), b: pt(200, 300), width: 10 })];
  const ann = A.toAnnotations(4000, 3000, shapes, 123);
  assert.equal(ann.v, 1);
  assert.equal(ann.width, 4000);
  assert.equal(ann.updatedAt, 123);
  assert.ok(A.sameShapes(ann.shapes, shapes));
  assert.notEqual(ann.shapes[0], shapes[0]);
  assert.ok(!A.sameShapes(ann.shapes, []));

  const same = A.rescaleAnnotations(ann, 4000, 3000);
  assert.ok(A.sameShapes(same.shapes, shapes));
  const half = A.rescaleAnnotations(ann, 2000, 1500);
  assert.deepEqual(half.shapes[0].a, { x: 50, y: 50 });
  assert.deepEqual(half.shapes[0].b, { x: 100, y: 150 });
  assert.equal(half.shapes[0].width, 5);
  assert.equal(half.width, 2000);
  assert.equal(A.rescaleAnnotations(null, 10, 10), null);
});

test('formatDimensionLabel tidies plain lengths and keeps everything else as typed', () => {
  assert.equal(A.formatDimensionLabel('12 6'), '12\' 6"');
  assert.equal(A.formatDimensionLabel('12-6'), '12\' 6"');
  assert.equal(A.formatDimensionLabel('12ft 6in'), '12\' 6"');
  assert.equal(A.formatDimensionLabel('150in'), '12\' 6"');
  assert.equal(A.formatDimensionLabel('12\'6"'), '12\' 6"');
  assert.equal(A.formatDimensionLabel('3.81m'), '3.81 m');
  assert.equal(A.formatDimensionLabel('16'), '16', 'a lone number could be feet or inches');
  assert.equal(A.formatDimensionLabel('TYP'), 'TYP');
  assert.equal(A.formatDimensionLabel('16" o.c.'), '16" o.c.');
  assert.equal(A.formatDimensionLabel('2x10 @ 16'), '2x10 @ 16');
  assert.equal(A.formatDimensionLabel('12\' 6.25"'), '12\' 6.25"', 'never rounded away');
  assert.equal(A.formatDimensionLabel('  '), '');
  assert.equal(A.formatDimensionLabel(null), '');
});

test('isLightColor and textColors give readable contrast', () => {
  assert.ok(A.isLightColor('#ffffff'));
  assert.ok(A.isLightColor('#fdd835'));
  assert.ok(A.isLightColor('#fff'));
  assert.ok(!A.isLightColor('#e53935'));
  assert.ok(!A.isLightColor('#111111'));
  assert.ok(!A.isLightColor('not a colour'));
  assert.equal(A.textColors('#e53935').border, '#e53935');
  assert.match(A.textColors('#ffffff').bg, /rgba\(17/);
});

// ---- bounds, moving, handles -----------------------------------------------------------

test('shapeBounds includes the stroke, arrowheads and scallops', () => {
  const r = A.shapeBounds({ type: 'rect', width: 10, a: pt(100, 100), b: pt(50, 200) });
  assert.deepEqual(r, { x: 45, y: 95, w: 60, h: 110 });
  const pen = A.shapeBounds({ type: 'pen', width: 4, points: [[10, 10], [30, 5], [20, 40]] });
  assert.deepEqual(pen, { x: 8, y: 3, w: 24, h: 39 });
  const arrow = A.shapeBounds({ type: 'arrow', width: 10, a: pt(0, 100), b: pt(200, 100) });
  assert.ok(arrow.h > 10, 'the head is wider than the shaft');
  const cloud = A.shapeBounds({ type: 'cloud', width: 10, a: pt(0, 0), b: pt(100, 100) });
  assert.ok(cloud.x < -5 && cloud.w > 110);
  const badge = A.shapeBounds({ type: 'badge', width: 4, size: 50, at: pt(100, 100) });
  assert.ok(near(badge.x + badge.w / 2, 100) && near(badge.y + badge.h / 2, 100));
  const text = A.shapeBounds({ type: 'text', width: 4, size: 20, text: 'abcd', at: pt(10, 10) }, approxMeasure);
  assert.ok(near(text.x, 10) && near(text.w, 40 + 20 * 0.38 * 2));
});

test('moveShape moves every type and never changes the original', () => {
  const shapes = [
    { type: 'pen', color: '#f00', width: 2, points: [[0, 0], [10, 10]], mode: 'pen' },
    { type: 'line', color: '#f00', width: 2, a: pt(0, 0), b: pt(10, 10) },
    { type: 'rect', color: '#f00', width: 2, a: pt(0, 0), b: pt(10, 10) },
    { type: 'dimension', color: '#f00', width: 2, a: pt(0, 0), b: pt(10, 0), label: '10' },
    { type: 'text', color: '#f00', width: 2, at: pt(0, 0), text: 'x', size: 10 },
    { type: 'badge', color: '#f00', width: 2, at: pt(0, 0), n: 1 },
  ];
  for (const s of shapes) {
    const before = JSON.stringify(s);
    const m = A.moveShape(s, 5, -3);
    assert.equal(JSON.stringify(s), before);
    const b0 = A.shapeBounds(s, approxMeasure);
    const b1 = A.shapeBounds(m, approxMeasure);
    assert.ok(near(b1.x - b0.x, 5) && near(b1.y - b0.y, -3), s.type);
  }
});

test('clampMoveDelta keeps a shape on the photo', () => {
  const b = { x: 100, y: 100, w: 50, h: 50 };
  assert.deepEqual(A.clampMoveDelta(b, -500, 20, 1000, 800), { dx: -100, dy: 20 });
  assert.deepEqual(A.clampMoveDelta(b, 2000, 2000, 1000, 800), { dx: 850, dy: 650 });
  // Something already past the edge is not snapped back by a small move…
  const out = { x: -10, y: 10, w: 50, h: 50 };
  assert.deepEqual(A.clampMoveDelta(out, 0, 0, 1000, 800), { dx: 0, dy: 0 });
  // …but placing new text pulls it inside.
  assert.deepEqual(A.clampMoveDelta(out, 0, 0, 1000, 800, { allowCurrent: false }), { dx: 10, dy: 0 });
});

test('handles: ends of lines, corners of boxes; dragging a corner past its opposite flips cleanly', () => {
  const line = { type: 'arrow', color: '#f00', width: 2, a: pt(0, 0), b: pt(10, 10) };
  assert.deepEqual(A.shapeHandles(line).map((h) => h.id), ['a', 'b']);
  assert.deepEqual(A.dragHandle(line, 'b', pt(50, 60)).b, { x: 50, y: 60 });
  assert.deepEqual(line.b, { x: 10, y: 10 });

  const box = { type: 'rect', color: '#f00', width: 2, a: pt(10, 10), b: pt(110, 60) };
  assert.deepEqual(A.shapeHandles(box).map((h) => h.id), ['nw', 'ne', 'se', 'sw']);
  const grown = A.dragHandle(box, 'se', pt(210, 160));
  assert.deepEqual(A.normalizeRect(grown.a, grown.b), { x: 10, y: 10, w: 200, h: 150 });
  const flipped = A.dragHandle(box, 'se', pt(0, 0));
  assert.deepEqual(A.normalizeRect(flipped.a, flipped.b), { x: 0, y: 0, w: 10, h: 10 });
  const nw = A.dragHandle(box, 'nw', pt(50, 30));
  assert.deepEqual(A.normalizeRect(nw.a, nw.b), { x: 50, y: 30, w: 60, h: 30 });
  assert.deepEqual(A.shapeHandles({ type: 'text', at: pt(0, 0) }), []);
});

// ---- hit testing ---------------------------------------------------------------------------

test('hitShape: a line within reach, a miss outside it', () => {
  const line = A.createShape('line', { a: pt(0, 0), b: pt(100, 0), width: 4 });
  const ann = { shapes: [line] };
  assert.equal(A.hitShape(ann, 50, 6, 5), line, '6 px away with 5 px tolerance + 2 px half-width');
  assert.equal(A.hitShape(ann, 50, 8, 5), null);
  assert.equal(A.hitShape(ann, 110, 0, 5), null);
  assert.equal(A.hitShape([line], 50, 0, 0), line, 'takes a plain array too');
});

test('hitShape: the topmost shape wins', () => {
  const under = A.createShape('line', { a: pt(0, 0), b: pt(100, 0), width: 4 });
  const over = A.createShape('line', { a: pt(50, -50), b: pt(50, 50), width: 4 });
  assert.equal(A.hitShape([under, over], 50, 0, 5), over);
  assert.equal(A.hitShape([over, under], 50, 0, 5), under);
});

test('hitShape: an outline beats the inside of a box; the smallest box wins inside', () => {
  const big = A.createShape('rect', { a: pt(0, 0), b: pt(200, 200), width: 4 });
  const small = A.createShape('ellipse', { a: pt(50, 50), b: pt(150, 150), width: 4 });
  const stroke = A.createShape('pen', { points: [[90, 100], [110, 100]], width: 4 });
  // Inside both boxes, the smaller one is picked even though it is underneath.
  assert.equal(A.hitShape([small, big], 100, 70, 2), small);
  // A stroke inside the boxes wins over their insides.
  assert.equal(A.hitShape([stroke, small, big], 100, 100, 2), stroke);
  // On the big box's edge, the edge wins.
  assert.equal(A.hitShape([big, small], 1, 100, 3), big);
  // The eraser ignores insides.
  assert.equal(A.hitShape([small, big], 100, 70, 2, { interior: false }), null);
  // Outside everything.
  assert.equal(A.hitShape([small, big], 300, 300, 2), null);
});

test('hitShape: ellipse outline, cloud scallops, arrowhead, badge, text, dimension label', () => {
  const ell = A.createShape('ellipse', { a: pt(0, 0), b: pt(200, 100), width: 2 });
  assert.equal(A.hitShape([ell], 200, 50, 3, { interior: false }), ell);
  assert.equal(A.hitShape([ell], 100, 0, 3, { interior: false }), ell);
  assert.equal(A.hitShape([ell], 190, 10, 3, { interior: false }), null, 'the corner of the box is not on the ellipse');

  const cloud = A.createShape('cloud', { a: pt(0, 0), b: pt(200, 100), width: 4 });
  const bulge = A.cloudArcSize(4) * A.CLOUD_BULGE;
  assert.equal(A.hitShape([cloud], 100, -bulge, 2, { interior: false }), cloud, 'the top of a scallop');

  const arrow = A.createShape('arrow', { a: pt(0, 0), b: pt(200, 0), width: 10 });
  const h = A.arrowHead(arrow.a, arrow.b, arrow.width);
  assert.equal(A.hitShape([arrow], h.base.x + 2, h.left.y * 0.8, 0), arrow, 'inside the head, off the shaft');

  const badge = A.createShape('badge', { at: pt(50, 50), n: 1, size: 40, width: 4 });
  assert.equal(A.hitShape([badge], 60, 60, 0), badge);
  assert.equal(A.hitShape([badge], 100, 100, 0), null);

  const text = A.createShape('text', { at: pt(10, 10), text: 'Header', size: 20, width: 2 });
  const L = A.textLayout(text, approxMeasure);
  assert.equal(A.hitShape([text], 10 + L.w - 1, 10 + L.h - 1, 0, { measure: approxMeasure }), text);
  assert.equal(A.hitShape([text], 10 + L.w + 5, 10, 0, { measure: approxMeasure }), null);

  const dim = A.createShape('dimension', { a: pt(0, 0), b: pt(400, 0), width: 2, label: '12\' 6"', size: 30 });
  const box = A.dimensionLabelBox(dim, approxMeasure);
  assert.ok(box && near(box.cx, 200));
  assert.equal(A.hitShape([dim], 200, box.h / 2 - 1, 0, { measure: approxMeasure }), dim, 'on the label, off the line');
  assert.equal(A.dimensionLabelBox({ ...dim, label: '  ' }), null);
});

test('hitShape skips damaged shapes instead of throwing', () => {
  const bad = { type: 'line', color: '#f00', width: 2, a: pt(0, 0) };
  assert.equal(A.hitShape([bad], 0, 0, 10), null);
});

// ---- saving and drafts -----------------------------------------------------------------------------

test('applySavedMarkup moves the previous copy to history and clears the draft', () => {
  const ann1 = A.toAnnotations(4000, 3000, [A.createShape('line', { a: pt(0, 0), b: pt(9, 9), width: 4 })], 100);
  const item = { media: { original: 'm_orig', thumb: 'm_th', annotated: null, annotatedThumb: null }, annotations: null, annotationsDraft: { shapes: [] } };
  A.applySavedMarkup(item, { annotations: ann1, annotatedId: 'm_a1', thumbId: 'm_t1', at: 100 });
  assert.equal(item.media.annotated, 'm_a1');
  assert.equal(item.media.annotatedThumb, 'm_t1');
  assert.equal(item.media.original, 'm_orig');
  assert.deepEqual(item.annotationHistory, []);
  assert.equal(item.annotationsDraft, null);
  assert.equal(item.annotations, ann1);

  const ann2 = A.toAnnotations(4000, 3000, [A.createShape('rect', { a: pt(0, 0), b: pt(9, 9), width: 4 })], 200);
  A.applySavedMarkup(item, { annotations: ann2, annotatedId: 'm_a2', thumbId: null, at: 200 });
  assert.equal(item.media.annotated, 'm_a2');
  assert.equal(item.media.annotatedThumb, null, 'a failed thumbnail is null, not the old one');
  assert.deepEqual(item.annotationHistory.map((h) => [h.mediaId, h.thumbId, h.at]), [['m_a1', 'm_t1', 200]]);
  assert.equal(item.annotationHistory[0].annotations, ann1, 'the shapes of the earlier copy are kept too');

  // Clearing all markup: no annotated copy, nothing lost.
  A.applySavedMarkup(item, { annotations: A.toAnnotations(4000, 3000, [], 300), annotatedId: null, at: 300 });
  assert.equal(item.media.annotated, null);
  assert.equal(item.media.annotatedThumb, null);
  assert.equal(item.annotations, null);
  assert.deepEqual(item.annotationHistory.map((h) => h.mediaId), ['m_a1', 'm_a2']);
  assert.equal(item.media.original, 'm_orig');
  // Works on an item from before markup existed.
  const bare = A.applySavedMarkup({}, { annotations: ann1, annotatedId: 'x', thumbId: 'y' });
  assert.equal(bare.media.annotated, 'x');
  assert.deepEqual(bare.annotationHistory, []);
});

test('draftToOffer: only a newer draft that differs from the saved markup', () => {
  const line = A.createShape('line', { a: pt(100, 100), b: pt(200, 200), width: 10 });
  const box = A.createShape('rect', { a: pt(10, 10), b: pt(50, 50), width: 10 });
  const saved = A.toAnnotations(4000, 3000, [line], 1000);
  assert.equal(A.draftToOffer({ annotations: saved }, 4000, 3000), null, 'no draft');
  assert.equal(A.draftToOffer(null, 4000, 3000), null);
  const older = { ...A.makeDraft(4000, 3000, [line, box]), updatedAt: 500 };
  assert.equal(A.draftToOffer({ annotations: saved, annotationsDraft: older }, 4000, 3000), null, 'saved after the draft');
  const same = { ...A.makeDraft(4000, 3000, [line]), updatedAt: 2000 };
  assert.equal(A.draftToOffer({ annotations: saved, annotationsDraft: same }, 4000, 3000), null, 'nothing new in it');
  const newer = { ...A.makeDraft(4000, 3000, [line, box]), updatedAt: 2000 };
  const offer = A.draftToOffer({ annotations: saved, annotationsDraft: newer }, 4000, 3000);
  assert.equal(offer.shapes.length, 2);
  assert.equal(offer.updatedAt, 2000);
  // A draft with everything erased is still offered (it differs from the saved markup).
  const erased = { ...A.makeDraft(4000, 3000, []), updatedAt: 2000 };
  assert.equal(A.draftToOffer({ annotations: saved, annotationsDraft: erased }, 4000, 3000).shapes.length, 0);
  // No saved markup at all: any non-empty draft is offered, fitted to the photo's size.
  const first = { ...A.makeDraft(4000, 3000, [line]), updatedAt: 10 };
  const fitted = A.draftToOffer({ annotations: null, annotationsDraft: first }, 2000, 1500);
  assert.deepEqual(fitted.shapes[0].a, { x: 50, y: 50 });
  const damaged = { annotationsDraft: { shapes: 'nope' } };
  assert.equal(A.draftToOffer(damaged, 100, 100), null);
});

test('through the store: the original is untouched and every marked-up copy stays readable', async () => {
  const jpeg = (n, fill) => new Blob([new Uint8Array(n).fill(fill)], { type: 'image/jpeg' });
  const p = await store.createProject({ name: 'Markup durability' });
  const item = await store.createItem(p.id, { type: 'photo', levelId: p.activeLevelId, width: 4000, height: 3000 });
  const orig = await store.putMedia(jpeg(500, 1), { kind: 'original', projectId: p.id, itemId: item.id });
  await store.updateItem(item.id, (i) => { i.media.original = orig; });

  // Editing: drafts are quiet writes (not a change for backups).
  const before = (await store.getProject(p.id)).changeSeq;
  const line = A.createShape('line', { a: pt(1, 1), b: pt(300, 300), width: 20 });
  await store.updateItem(item.id, (i) => { i.annotationsDraft = A.makeDraft(4000, 3000, [line]); }, { quiet: true });
  assert.equal((await store.getProject(p.id)).changeSeq, before);
  const reopened = await store.getItem(item.id);
  assert.equal(A.draftToOffer(reopened, 4000, 3000).shapes.length, 1, 'a crash here loses nothing');

  // Save #1.
  const a1 = await store.putMedia(jpeg(300, 2), { kind: 'annotated', projectId: p.id, itemId: item.id });
  const t1 = await store.putMedia(jpeg(40, 3), { kind: 'annotatedThumb', projectId: p.id, itemId: item.id });
  await store.updateItem(item.id, (i) => A.applySavedMarkup(i, { annotations: A.toAnnotations(4000, 3000, [line], 1), annotatedId: a1, thumbId: t1, at: 1 }));
  assert.ok((await store.getProject(p.id)).changeSeq > before, 'a save counts for backups');

  // Save #2 replaces the copy; save #3 clears all markup.
  const a2 = await store.putMedia(jpeg(310, 4), { kind: 'annotated', projectId: p.id, itemId: item.id });
  await store.updateItem(item.id, (i) => A.applySavedMarkup(i, { annotations: A.toAnnotations(4000, 3000, [line, line], 2), annotatedId: a2, thumbId: null, at: 2 }));
  await store.updateItem(item.id, (i) => A.applySavedMarkup(i, { annotations: A.toAnnotations(4000, 3000, [], 3), annotatedId: null, at: 3 }));

  const final = await store.getItem(item.id);
  assert.equal(final.media.original, orig);
  assert.equal(final.media.annotated, null);
  assert.equal(final.annotations, null);
  assert.equal(final.annotationsDraft, null);
  assert.deepEqual(final.annotationHistory.map((h) => h.mediaId), [a1, a2]);
  assert.equal(final.annotationHistory[0].thumbId, t1);
  for (const [id, size] of [[orig, 500], [a1, 300], [t1, 40], [a2, 310]]) {
    const b = await store.getMediaBlob(id);
    assert.equal(b?.size, size, `media ${id} is still on the phone`);
  }
  const back = await store.getMediaBlob(orig);
  assert.deepEqual(new Uint8Array(await back.arrayBuffer()), new Uint8Array(500).fill(1), 'original bytes unchanged');
});

// ---- drawing (on a recording fake context) -------------------------------------------------------

function fakeCtx() {
  const calls = [];
  const state = { font: '10px sans-serif', globalAlpha: 1 };
  const stack = [];
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') return (t) => ({ width: String(t).length * 10, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 0 });
      if (prop === 'save') return () => { stack.push({ ...state }); calls.push('save'); };
      if (prop === 'restore') return () => { Object.assign(state, stack.pop() || {}); calls.push('restore'); };
      return (...args) => { calls.push(prop); return args; };
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  return { ctx, calls, stack };
}

test('renderAnnotations draws every shape type and leaves the context as it found it', () => {
  const shapes = [
    A.createShape('pen', { points: [[0, 0], [10, 10], [20, 0], [30, 10]], width: 4 }),
    A.createShape('pen', { points: [[5, 5]], width: 4 }),
    A.createShape('pen', { points: [[0, 0], [50, 50]], width: 20, mode: 'highlight' }),
    A.createShape('line', { a: pt(0, 0), b: pt(10, 0), width: 2 }),
    A.createShape('arrow', { a: pt(0, 0), b: pt(100, 0), width: 2 }),
    A.createShape('rect', { a: pt(0, 0), b: pt(100, 50), width: 2 }),
    A.createShape('ellipse', { a: pt(0, 0), b: pt(100, 50), width: 2 }),
    A.createShape('cloud', { a: pt(0, 0), b: pt(100, 50), width: 2 }),
    A.createShape('dimension', { a: pt(0, 0), b: pt(100, 0), width: 2, label: '8\'' }),
    A.createShape('text', { at: pt(0, 0), text: 'Two\nlines', size: 20, width: 2, color: '#ffffff' }),
    A.createShape('text', { at: pt(0, 0), text: 'No box', size: 20, width: 2, bg: false }),
    A.createShape('badge', { at: pt(50, 50), n: 12, size: 30, width: 2 }),
    { type: 'line', color: '#f00', width: 2 }, // damaged: skipped
  ];
  const { ctx, calls, stack } = fakeCtx();
  A.renderAnnotations(ctx, { v: 1, width: 100, height: 100, shapes }, { scale: 2 });
  assert.equal(stack.length, 0, 'every save has its restore');
  assert.equal(ctx.globalAlpha, 1, 'the highlighter alpha does not leak');
  assert.ok(calls.includes('scale'));
  assert.ok(calls.includes('quadraticCurveTo'), 'pen strokes are smoothed');
  assert.ok(calls.includes('ellipse'));
  assert.ok(calls.filter((c) => c === 'arc').length > 20, 'cloud scallops and badge circle');
  assert.ok(calls.includes('fillText'));
  assert.ok(calls.includes('strokeText'), 'text without a box gets an outline');
  assert.ok(calls.includes('strokeRect'));
  // Nothing to draw: no calls at all.
  const empty = fakeCtx();
  A.renderAnnotations(empty.ctx, { shapes: [] });
  assert.equal(empty.calls.length, 0);
});
