// plan-import.test.mjs — the pure parts of the SCREENS workstream:
//   js/core/plan-import.js   size limits, encoding choice, file sniffing, EXIF, rotate/crop math
//   js/ui/items-panel.js     labels, filters, sorting, tags
//   js/ui/projects-screen.js covers, counts, backup badges, import texts
//   js/ui/project-screen.js  backup reminder, position chip, banners, map start, note poses
//   js/ui/trash-screen.js    "what will be lost" sentences
// No DOM and no database is touched: these are the decisions the screens make.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const PI = await import('../js/core/plan-import.js');
const IP = await import('../js/ui/items-panel.js');
const HOME = await import('../js/ui/projects-screen.js');
const PJ = await import('../js/ui/project-screen.js');
const TR = await import('../js/ui/trash-screen.js');

// ---- byte builders ---------------------------------------------------------------------

const bytes = (...parts) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));

function jpeg({ orientation = null, le = false, w = 4032, h = 3024 } = {}) {
  const u16 = (v) => (le ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v) => (le ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255] : [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255]);
  const segs = [0xff, 0xd8];
  if (orientation != null) {
    const tiff = [...(le ? [0x49, 0x49, 0x2a, 0x00] : [0x4d, 0x4d, 0x00, 0x2a]), ...u32(8),
      ...u16(2),
      ...u16(0x010f), ...u16(2), ...u32(4), ...u32(0),          // Make (ignored)
      ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0,
      ...u32(0)];
    const app1 = [...'Exif'].map((c) => c.charCodeAt(0)).concat([0, 0], tiff);
    const len = app1.length + 2;
    segs.push(0xff, 0xe1, len >> 8, len & 255, ...app1);
  }
  segs.push(0xff, 0xdb, 0x00, 0x04, 0x00, 0x00);                 // a small DQT before the frame
  segs.push(0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  segs.push(0xff, 0xda, 0x00, 0x02, 0xff, 0xd9);
  return new Uint8Array(segs);
}

const be32 = (v) => [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];
const le32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
const png = (w, h) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), 'IHDR', be32(w), be32(h), [8, 6, 0, 0, 0]);

// ---- plan-import: limits -------------------------------------------------------------------

describe('plan image size limits', () => {
  test('phones are capped below WebKit\'s 16,777,216 px canvas limit; desktops get more', () => {
    for (const l of [PI.limitsFor({ ios: true }), PI.limitsFor({ mobile: true })]) {
      assert.ok(l.maxPixels < 16_777_216);
      assert.ok(l.maxSide <= 8192);
    }
    const d = PI.limitsFor({});
    assert.equal(d.maxSide, 16384);
    assert.ok(d.maxPixels > 16_777_216);
    assert.ok(PI.PLAN_LIMITS.maxPixels < 16_777_216, 'stored plans must open on an iPhone');
  });

  test('fitWithin keeps small images as they are and never enlarges by default', () => {
    assert.deepEqual(PI.fitWithin(1200, 800, { maxSide: 8192, maxPixels: 16e6 }), { width: 1200, height: 800, scale: 1 });
  });

  test('fitWithin scales down by the long side, keeping the aspect', () => {
    const r = PI.fitWithin(12000, 6000, { maxSide: 8000, maxPixels: 1e9 });
    assert.equal(r.width, 8000);
    assert.equal(r.height, 4000);
  });

  test('fitWithin scales down by the pixel budget, and never exceeds it', () => {
    for (const [w, h] of [[10000, 7000], [9999, 9999], [30001, 1013], [4097, 4097]]) {
      const r = PI.fitWithin(w, h, PI.PLAN_LIMITS);
      assert.ok(r.width * r.height <= PI.PLAN_LIMITS.maxPixels, `${w}x${h} → ${r.width}x${r.height}`);
      assert.ok(Math.max(r.width, r.height) <= PI.PLAN_LIMITS.maxSide);
      assert.ok(Math.abs(r.width / r.height - w / h) / (w / h) < 0.01, 'aspect kept');
      assert.ok(Number.isInteger(r.width) && Number.isInteger(r.height));
    }
  });

  test('fitWithin handles nonsense sizes without throwing', () => {
    assert.deepEqual(PI.fitWithin(0, 100, PI.PLAN_LIMITS), { width: 0, height: 0, scale: 0 });
    assert.deepEqual(PI.fitWithin(NaN, 100, PI.PLAN_LIMITS), { width: 0, height: 0, scale: 0 });
  });

  test('a 36×24 in sheet renders at about 6000 px wide, capped by the pixel budget', () => {
    const s = PI.pdfRenderScale(36 * 72, 24 * 72);
    const w = Math.floor(36 * 72 * s), h = Math.floor(24 * 72 * s);
    assert.ok(w <= 6000);
    assert.ok(w * h <= PI.PLAN_LIMITS.maxPixels);
    assert.ok(w > 4500, `still sharp enough to zoom: ${w}px`);
  });

  test('a small PDF page is enlarged up to the target, not left blurry', () => {
    const s = PI.pdfRenderScale(612, 792, { targetSide: 6000, maxSide: 8192, maxPixels: 1e9 });
    assert.equal(Math.round(792 * s), 6000);
  });

  test('an 11×17 page on a phone stays inside the phone limits', () => {
    const lim = PI.limitsFor({ ios: true });
    const s = PI.pdfRenderScale(11 * 72, 17 * 72, { maxSide: lim.maxSide, maxPixels: lim.maxPixels });
    assert.ok(Math.floor(11 * 72 * s) * Math.floor(17 * 72 * s) <= lim.maxPixels);
  });

  test('intersectLimits takes the tighter of each', () => {
    assert.deepEqual(PI.intersectLimits({ maxSide: 16384, maxPixels: 40e6 }, { maxSide: 8192, maxPixels: 50e6 }), { maxSide: 8192, maxPixels: 40e6 });
  });
});

describe('plan image encoding', () => {
  test('a photo of a plan stays a JPEG', () => {
    assert.deepEqual(PI.chooseEncoding(800, 600, 'image/jpeg'), { type: 'image/jpeg', quality: 0.92 });
    assert.equal(PI.chooseEncoding(4000, 3000, 'image/heic').type, 'image/jpeg');
  });
  test('a drawing is PNG up to 4 MP, JPEG 0.9 above', () => {
    assert.equal(PI.chooseEncoding(2000, 2000, 'pdf').type, 'image/png');
    assert.equal(PI.chooseEncoding(2000, 2001, 'pdf').type, 'image/jpeg');
    assert.equal(PI.chooseEncoding(5000, 3300, '').quality, 0.9);
  });
});

// ---- plan-import: files --------------------------------------------------------------------

describe('file sniffing', () => {
  test('recognises the formats a plan arrives in, from the bytes', () => {
    assert.equal(PI.sniffImageType(jpeg()), 'jpeg');
    assert.equal(PI.sniffImageType(png(10, 10)), 'png');
    assert.equal(PI.sniffImageType(bytes('GIF89a', [1, 0, 1, 0])), 'gif');
    assert.equal(PI.sniffImageType(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8X')), 'webp');
    assert.equal(PI.sniffImageType(bytes('BM', new Array(30).fill(0))), 'bmp');
    assert.equal(PI.sniffImageType(bytes([0x49, 0x49, 0x2a, 0])), 'tiff');
    assert.equal(PI.sniffImageType(bytes([0, 0, 0, 0x18], 'ftypheic', [0, 0, 0, 0])), 'heic');
    assert.equal(PI.sniffImageType(bytes([0, 0, 0, 0x18], 'ftypmif1', [0, 0, 0, 0])), 'heic');
    assert.equal(PI.sniffImageType(bytes([0, 0, 0, 0x18], 'ftypavif', [0, 0, 0, 0])), 'avif');
    assert.equal(PI.sniffImageType(bytes('%PDF-1.7\n')), 'pdf');
    assert.equal(PI.sniffImageType(bytes([0xef, 0xbb, 0xbf, 10], '%PDF-1.4')), 'pdf', 'junk before the header');
    assert.equal(PI.sniffImageType(bytes('hello world')), null);
    assert.equal(PI.sniffImageType(new Uint8Array(0)), null);
  });

  test('classifyFile trusts bytes first, then the name and type', () => {
    assert.equal(PI.classifyFile({ name: 'plan.jpg', type: 'image/jpeg' }, bytes('%PDF-1.7')), 'pdf');
    assert.equal(PI.classifyFile({ name: 'scan.pdf', type: '' }, jpeg()), 'image');
    assert.equal(PI.classifyFile({ name: 'IMG_0001.HEIC', type: '' }, bytes('????????')), 'heic');
    assert.equal(PI.classifyFile({ name: 'A2.1.pdf', type: '' }, bytes('????')), 'pdf');
    assert.equal(PI.classifyFile({ name: 'x', type: 'image/png' }, bytes('????')), 'image');
    assert.equal(PI.classifyFile({ name: 'notes.docx', type: 'application/vnd.openxmlformats' }, bytes('PK\u0003\u0004')), 'unknown');
  });

  test('readImageSize reads the header of PNG, JPEG, GIF, WebP and BMP', () => {
    assert.deepEqual(PI.readImageSize(png(5100, 3300)), { width: 5100, height: 3300 });
    assert.deepEqual(PI.readImageSize(jpeg({ w: 4032, h: 3024, orientation: 6 })), { width: 4032, height: 3024 });
    assert.deepEqual(PI.readImageSize(bytes('GIF89a', [0x20, 0x03, 0x58, 0x02])), { width: 800, height: 600 });
    const vp8x = bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8X', le32(10), [0, 0, 0, 0], [0xff, 0x0f, 0], [0x9f, 0x0f, 0]);
    assert.deepEqual(PI.readImageSize(vp8x), { width: 4096, height: 4000 });
    const bmp = bytes('BM', le32(0), le32(0), le32(54), le32(40), le32(640), le32(-480 >>> 0), [0, 0]);
    assert.deepEqual(PI.readImageSize(bmp), { width: 640, height: 480 });
    assert.equal(PI.readImageSize(bytes('nope')), null);
  });

  test('readJpegOrientation finds the EXIF flag in both byte orders', () => {
    assert.equal(PI.readJpegOrientation(jpeg({ orientation: 6 })), 6);
    assert.equal(PI.readJpegOrientation(jpeg({ orientation: 8, le: true })), 8);
    assert.equal(PI.readJpegOrientation(jpeg({ orientation: 3, le: true })), 3);
    assert.equal(PI.readJpegOrientation(jpeg()), 1, 'no EXIF');
    assert.equal(PI.readJpegOrientation(jpeg({ orientation: 42 })), 1, 'nonsense value');
    assert.equal(PI.readJpegOrientation(png(10, 10)), 1, 'not a JPEG');
    assert.equal(PI.readJpegOrientation(jpeg({ orientation: 6 }).slice(0, 20)), 1, 'truncated');
  });

  test('orientedSize swaps the sides for the 90° orientations only', () => {
    assert.deepEqual(PI.orientedSize(4032, 3024, 6), { width: 3024, height: 4032 });
    assert.deepEqual(PI.orientedSize(4032, 3024, 8), { width: 3024, height: 4032 });
    assert.deepEqual(PI.orientedSize(4032, 3024, 3), { width: 4032, height: 3024 });
    assert.deepEqual(PI.orientedSize(4032, 3024, 1), { width: 4032, height: 3024 });
  });

  test('exifMatrix puts each raw corner where the upright picture has it', () => {
    const W = 300, H = 400;                    // upright size; the raw image is 400 × 300 for 5–8
    const at = (o, x, y) => PI.applyMatrix(PI.exifMatrix(o, W, H), x, y);
    // 6 = turn 90° clockwise: raw top-left → upright top-right, raw top-right → bottom-right.
    assert.deepEqual(at(6, 0, 0), { x: W, y: 0 });
    assert.deepEqual(at(6, H, 0), { x: W, y: H });
    assert.deepEqual(at(6, 0, W), { x: 0, y: 0 });
    // 8 = turn 90° counter-clockwise: raw top-left → bottom-left.
    assert.deepEqual(at(8, 0, 0), { x: 0, y: H });
    assert.deepEqual(at(8, H, W), { x: W, y: 0 });
    // 3 = 180°.
    assert.deepEqual(PI.applyMatrix(PI.exifMatrix(3, W, H), 0, 0), { x: W, y: H });
    assert.deepEqual(PI.applyMatrix(PI.exifMatrix(1, W, H), 7, 9), { x: 7, y: 9 });
  });

  test('planError carries a code for the dialog', () => {
    const e = PI.planError('pdf-password', 'locked');
    assert.equal(e.code, 'pdf-password');
    assert.equal(e.message, 'locked');
  });
});

// ---- plan-import: rotate and crop ---------------------------------------------------------------

describe('rotate and crop', () => {
  test('normalizeRotation folds any multiple of 90', () => {
    assert.equal(PI.normalizeRotation(-90), 270);
    assert.equal(PI.normalizeRotation(450), 90);
    assert.equal(PI.normalizeRotation(360), 0);
    assert.equal(PI.normalizeRotation(undefined), 0);
  });

  test('rotatedSize swaps sides at 90 and 270', () => {
    assert.deepEqual(PI.rotatedSize(6000, 4000, 90), { width: 4000, height: 6000 });
    assert.deepEqual(PI.rotatedSize(6000, 4000, 180), { width: 6000, height: 4000 });
    assert.deepEqual(PI.rotatedSize(6000, 4000, -90), { width: 4000, height: 6000 });
  });

  test('rotationMatrix maps the image exactly onto the rotated frame', () => {
    const w = 600, h = 400;
    for (const rot of [0, 90, 180, 270]) {
      const m = PI.rotationMatrix(rot, w, h);
      const R = PI.rotatedSize(w, h, rot);
      const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => PI.applyMatrix(m, x, y));
      const xs = pts.map((p) => p.x).sort((a, b) => a - b), ys = pts.map((p) => p.y).sort((a, b) => a - b);
      assert.deepEqual([xs[0], xs[3], ys[0], ys[3]], [0, R.width, 0, R.height], `rotation ${rot}`);
    }
    // 90° clockwise: the top-left corner goes to the top-right.
    assert.deepEqual(PI.applyMatrix(PI.rotationMatrix(90, w, h), 0, 0), { x: h, y: 0 });
    assert.deepEqual(PI.applyMatrix(PI.rotationMatrix(270, w, h), 0, 0), { x: 0, y: w });
  });

  test('turning the crop with the picture keeps it on the same part of the drawing', () => {
    const w = 600, h = 400;
    const r = { x: 0.1, y: 0.2, w: 0.3, h: 0.5 };
    for (const dir of [1, -1]) {
      const m = PI.rotationMatrix(dir > 0 ? 90 : 270, w, h);
      const R = PI.rotatedSize(w, h, 90);
      const corners = [[r.x, r.y], [r.x + r.w, r.y + r.h]].map(([u, v]) => PI.applyMatrix(m, u * w, v * h));
      const box = {
        x: Math.min(...corners.map((c) => c.x)) / R.width, y: Math.min(...corners.map((c) => c.y)) / R.height,
        w: Math.abs(corners[0].x - corners[1].x) / R.width, h: Math.abs(corners[0].y - corners[1].y) / R.height,
      };
      const got = PI.rotateNormRect(r, dir);
      for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(got[k] - box[k]) < 1e-9, `dir ${dir} ${k}: ${got[k]} vs ${box[k]}`);
    }
  });

  test('four quarter turns bring the crop back; left undoes right', () => {
    const r = { x: 0.12, y: 0.05, w: 0.6, h: 0.33 };
    let t = r;
    for (let i = 0; i < 4; i++) t = PI.rotateNormRect(t, 1);
    for (const k of Object.keys(r)) assert.ok(Math.abs(t[k] - r[k]) < 1e-12);
    const back = PI.rotateNormRect(PI.rotateNormRect(r, 1), -1);
    for (const k of Object.keys(r)) assert.ok(Math.abs(back[k] - r[k]) < 1e-12);
    assert.equal(PI.rotateNormRect(null, 1), null);
  });

  test('adjustCrop moves inside the image and resizes from any edge with a minimum size', () => {
    const r = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
    assert.deepEqual(PI.adjustCrop(r, 'move', 0.9, -0.9), { x: 0.5, y: 0, w: 0.5, h: 0.5 });
    const se = PI.adjustCrop(r, 'se', 0.2, 0.1);
    assert.ok(Math.abs(se.w - 0.7) < 1e-12 && Math.abs(se.h - 0.6) < 1e-12 && se.x === 0.1);
    const nw = PI.adjustCrop(r, 'nw', 0.9, 0.9, 0.05);           // dragged past the other corner
    assert.ok(Math.abs(nw.w - 0.05) < 1e-12 && Math.abs(nw.h - 0.05) < 1e-12);
    const e = PI.adjustCrop(r, 'e', 5, 0);                         // cannot leave the image
    assert.ok(Math.abs(e.x + e.w - 1) < 1e-12);
    const n = PI.adjustCrop(r, 'n', 0, -5);
    assert.equal(n.y, 0);
    assert.ok(Math.abs(n.h - 0.6) < 1e-12);
  });

  test('cropToPixels gives whole pixels inside the image; a full crop is the whole image', () => {
    assert.deepEqual(PI.cropToPixels(null, 6000, 4000), { x: 0, y: 0, width: 6000, height: 4000 });
    assert.deepEqual(PI.cropToPixels({ x: 0, y: 0, w: 1, h: 1 }, 6000, 4000), { x: 0, y: 0, width: 6000, height: 4000 });
    assert.deepEqual(PI.cropToPixels({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 6000, 4000), { x: 1500, y: 2000, width: 3000, height: 1000 });
    const tiny = PI.cropToPixels({ x: 0.9999, y: 0.9999, w: 0.00001, h: 0.00001 }, 100, 100);
    assert.ok(tiny.width >= 1 && tiny.height >= 1 && tiny.x + tiny.width <= 100 && tiny.y + tiny.height <= 100);
    assert.equal(PI.isFullCrop({ x: 0.001, y: 0, w: 0.998, h: 0.999 }), true);
    assert.equal(PI.isFullCrop({ x: 0.05, y: 0, w: 0.9, h: 1 }), false);
  });

  test('pixelsToCrop is the inverse of cropToPixels', () => {
    const px = { x: 1500, y: 2000, width: 3000, height: 1000 };
    assert.deepEqual(PI.cropToPixels(PI.pixelsToCrop(px, 6000, 4000), 6000, 4000), px);
  });
});

// ---- items panel ----------------------------------------------------------------------------------

const L1 = 'l_1', L2 = 'l_2';
const sample = [
  { id: 'a', type: 'photo', seq: 1, createdAt: 100, levelId: L1, tags: ['Walls'], text: '', media: { thumb: 't1', annotatedThumb: 'at1' }, voiceNotes: [] },
  { id: 'b', type: 'video', seq: 2, createdAt: 300, levelId: L1, tags: ['Headers/Beams', 'Issue/RFI'], text: 'Beam pocket missing', media: { poster: 'p2' }, voiceNotes: [] },
  { id: 'c', type: 'note', seq: 3, createdAt: 200, levelId: L2, tags: ['Custom thing'], title: 'Stair', text: 'Check stringer spacing', media: {}, voiceNotes: [{ transcript: 'hold downs at grid B' }] },
  { id: 'd', type: 'photo', seq: 12, createdAt: 400, levelId: L2, tags: [], text: '', media: { thumb: 't12' }, voiceNotes: [] },
  { id: 'e', type: 'photo', seq: 112, createdAt: 500, levelId: L2, tags: ['Walls'], text: '', media: {}, voiceNotes: [], deletedAt: 9 },
];

describe('items panel', () => {
  test('labels and icons', () => {
    assert.equal(IP.itemLabel(sample[0]), 'Photo #1');
    assert.equal(IP.itemLabel(sample[1]), 'Video #2');
    assert.equal(IP.itemLabel({ type: 'note' }), 'Note');
    assert.equal(IP.itemIconName(sample[0]), 'camera');
    assert.equal(IP.itemIconName(sample[1]), 'video');
    assert.equal(IP.itemIconName(sample[2]), 'note');
    assert.equal(IP.itemIconName({}), 'file');
  });

  test('the marked-up thumbnail is preferred; a video falls back to its poster', () => {
    assert.equal(IP.itemThumbId(sample[0]), 'at1');
    assert.equal(IP.itemThumbId(sample[1]), 'p2');
    assert.equal(IP.itemThumbId(sample[2]), null);
  });

  test('DEFAULT_TAGS are the framing estimating tags of the spec', () => {
    assert.equal(IP.DEFAULT_TAGS.length, 15);
    for (const t of ['Walls', 'Headers/Beams', 'Shear/Hold-downs', 'Issue/RFI', 'Safety']) assert.ok(IP.DEFAULT_TAGS.includes(t));
    assert.ok(Object.isFrozen(IP.DEFAULT_TAGS));
  });

  test('filters: type, any of the tags, level, has notes; deleted items never show', () => {
    const ids = (f) => IP.filterItems(sample, f).map((i) => i.id).sort().join('');
    assert.equal(ids({}), 'abcd');
    assert.equal(ids({ type: 'photo' }), 'ad');
    assert.equal(ids({ tags: ['Walls', 'Issue/RFI'] }), 'ab');
    assert.equal(ids({ levelId: L2 }), 'cd');
    assert.equal(ids({ hasNotes: true }), 'bc');
  });

  test('search looks in notes, titles, tags and voice-note transcripts; #12 finds exactly 12', () => {
    const ids = (q) => IP.filterItems(sample, { query: q }).map((i) => i.id).join('');
    assert.equal(ids('beam pocket'), 'b');
    assert.equal(ids('STRINGER'), 'c');
    assert.equal(ids('grid b'), 'c');
    assert.equal(ids('rfi'), 'b');
    assert.equal(ids('#12'), 'd');
    assert.equal(ids('12'), 'd');
    assert.equal(ids('nothing like this'), '');
  });

  test('sorting by newest, oldest and number', () => {
    const live = sample.slice(0, 4);
    assert.equal(IP.sortItems(live, 'new').map((i) => i.id).join(''), 'dbca');
    assert.equal(IP.sortItems(live, 'old').map((i) => i.id).join(''), 'acbd');
    assert.equal(IP.sortItems(live, 'seq').map((i) => i.id).join(''), 'abcd');
    assert.notEqual(IP.sortItems(live, 'new'), live, 'a copy');
  });

  test('tags in use: standard ones in their order, then custom A–Z', () => {
    assert.deepEqual(IP.tagsInUse(sample.slice(0, 4)), ['Walls', 'Headers/Beams', 'Issue/RFI', 'Custom thing']);
  });

  test('counts by type skip deleted items', () => {
    assert.deepEqual(IP.countTypes(sample), { all: 4, photo: 2, video: 1, note: 1 });
  });

  test('note excerpts are one short line', () => {
    assert.equal(IP.noteExcerpt(sample[2]), 'Stair — Check stringer spacing');
    assert.equal(IP.noteExcerpt({ text: 'x'.repeat(200) }, 20).length, 20);
    assert.match(IP.noteExcerpt({ text: '', voiceNotes: [{ transcript: 'blocking at the stair' }] }), /blocking at the stair/);
    assert.equal(IP.hasNotes({ text: '  ' }), false);
  });
});

// ---- home screen ------------------------------------------------------------------------------------

function project(over = {}) {
  return {
    id: 'p_1', name: 'Riverside Lofts', createdAt: Date.UTC(2026, 10, 1), changeSeq: 1,
    backup: { lastAt: null, changeSeq: 0, fileName: '' }, levels: [{ id: L1, plan: null }], activeLevelId: L1, ...over,
  };
}

describe('home screen', () => {
  test('counts by type and the cover is the first photo (markup preferred)', () => {
    const s = HOME.summarizeItems(sample);
    assert.deepEqual({ p: s.photos, v: s.videos, n: s.notes, t: s.total }, { p: 2, v: 1, n: 1, t: 4 });
    assert.equal(s.coverId, 'at1');
    assert.equal(HOME.summarizeItems([sample[1]]).coverId, 'p2', 'a video when there is no photo');
    assert.equal(HOME.summarizeItems([]).coverId, null);
  });

  test('without photos the plan thumbnail is the cover', () => {
    const p = project({ levels: [{ id: L1, plan: null }, { id: L2, plan: { thumbId: 'pt2' } }] });
    assert.equal(HOME.planCoverId(p), 'pt2');
    assert.equal(HOME.planCoverId(project()), null);
  });

  test('backup badges', () => {
    assert.equal(HOME.backupBadge(project(), { hasItems: false }).text, 'Not backed up yet');
    const b = HOME.backupBadge(project({ changeSeq: 13 }), { hasItems: true });
    assert.deepEqual([b.cls, b.text], ['warn', '13 changes not backed up']);
    assert.equal(HOME.backupBadge(project({ changeSeq: 1 }), { hasItems: true }).text, '1 change not backed up');
    const now = Date.UTC(2026, 10, 5, 18);
    const ok = HOME.backupBadge(project({ changeSeq: 20, backup: { lastAt: Date.UTC(2026, 10, 2, 18), changeSeq: 20 } }), { now });
    assert.equal(ok.cls, 'ok');
    assert.match(ok.text, /^Backed up /);
  });

  test('shortDate says today for today', () => {
    const now = Date.now();
    assert.match(HOME.shortDate(now - 1000, now), /^today /);
    assert.equal(HOME.shortDate(0), '');
  });

  test('import counts read any of the usual keys', () => {
    assert.equal(HOME.countsText({ photos: 24, videos: 2, notes: 1 }), '24 photos, 2 videos, 1 note');
    assert.equal(HOME.countsText({ photo: 1, voiceNotes: 3 }), '1 photo, 3 voice notes');
    assert.equal(HOME.countsText({ photos: 2, voice: 1, plans: 3, levels: 2, deleted: 4 }), '2 photos, 1 voice note, 2 levels, 3 plans', 'package.js counts');
    assert.equal(HOME.countsText({}), 'No photos, videos or notes');
  });

  test('progress callbacks of any shape', () => {
    assert.deepEqual(HOME.progressOf(0.5), { fraction: 0.5, text: null });
    assert.deepEqual(HOME.progressOf(50, 'Photos'), { fraction: 0.5, text: 'Photos' });
    assert.deepEqual(HOME.progressOf({ done: 3, total: 4, label: 'Videos' }), { fraction: 0.75, text: 'Videos' });
    assert.deepEqual(HOME.progressOf('Reading'), { text: 'Reading', fraction: null });
    assert.deepEqual(HOME.progressOf(undefined), { text: null, fraction: null });
  });
});

// ---- a job walk -------------------------------------------------------------------------------------

describe('job walk screen', () => {
  const now = Date.UTC(2026, 10, 2, 20);

  test('backup reminder: 25+ changes, or more than a day with changes; never when off or empty', () => {
    const fresh = project({ createdAt: now - 3600e3, changeSeq: 5 });
    assert.equal(PJ.shouldRemindBackup(fresh, {}, { now }), false);
    assert.equal(PJ.shouldRemindBackup(project({ createdAt: now - 3600e3, changeSeq: 26 }), {}, { now }), true);
    assert.equal(PJ.shouldRemindBackup(project({ createdAt: now - 2 * 86400e3, changeSeq: 3 }), {}, { now }), true);
    assert.equal(PJ.shouldRemindBackup(project({ changeSeq: 40 }), { backupReminder: false }, { now }), false);
    assert.equal(PJ.shouldRemindBackup(project({ changeSeq: 40 }), {}, { now, itemCount: 0 }), false);
    const backed = project({ changeSeq: 30, backup: { lastAt: now - 3 * 86400e3, changeSeq: 30 } });
    assert.equal(PJ.shouldRemindBackup(backed, {}, { now }), false, 'nothing new since the backup');
    const since = project({ changeSeq: 32, backup: { lastAt: now - 3 * 86400e3, changeSeq: 30 } });
    assert.equal(PJ.shouldRemindBackup(since, {}, { now }), true);
  });

  test('the position chip says what is going on', () => {
    assert.deepEqual(PJ.chipInfo(null, { gps: 'denied' }), { cls: 'poor', text: 'Location off' });
    assert.equal(PJ.chipInfo(null, { gps: 'waiting' }).text, 'Finding you…');
    assert.equal(PJ.chipInfo({ source: 'none' }, { gps: 'ok' }).text, 'Finding you…');
    const good = PJ.chipInfo({ source: 'fused', geo: { acc: 1.2192 }, quality: 'good', heading: 44 }, { gps: 'ok' }, 'imperial');
    assert.deepEqual(good, { cls: 'good', text: '±4.0 ft · NE' });
    assert.equal(PJ.chipInfo({ source: 'sim', geo: { acc: 3 }, quality: 'fair' }, { gps: 'ok' }, 'metric').text, 'Demo ±3.0 m');
    assert.equal(PJ.chipInfo({ source: 'manual', plan: { x: 1, y: 2 }, quality: 'good' }, {}).text, 'Set by you');
    assert.equal(PJ.chipInfo({ source: 'fused', enu: { e: 0, n: 0 }, quality: 'fair' }, { gps: 'ok', acc: 3.048 }, 'imperial').text, '±10 ft', 'the engine\'s σ when the pose has no geo');
  });

  test('banners: location first, then calibration or map, then backup; at most two; dismissable', () => {
    const lvl = { id: L1, plan: { mediaId: 'm' }, calibration: null };
    const ids = (o) => PJ.bannersFor({ now, ...o }).map((b) => b.id);
    assert.deepEqual(ids({ project: project(), level: lvl, mode: 'plan' }), ['calibrate']);
    assert.deepEqual(ids({ project: project(), level: { ...lvl, calibration: {} }, mode: 'plan' }), []);
    assert.deepEqual(ids({ project: project(), level: { id: L1, plan: null }, mode: 'map' }), ['no-plan']);
    const busy = project({ changeSeq: 60 });
    assert.deepEqual(ids({ project: busy, level: lvl, mode: 'plan', status: { gps: 'denied' }, itemCount: 9 }), ['gps-denied', 'calibrate']);
    assert.deepEqual(ids({ project: busy, level: lvl, mode: 'plan', itemCount: 9, dismissed: new Set(['calibrate']) }), ['backup']);
    const b = PJ.bannersFor({ project: busy, level: { ...lvl, calibration: {} }, mode: 'plan', itemCount: 9, now })[0];
    assert.equal(b.text, '60 changes not backed up');
    assert.equal(b.action.id, 'backup');
  });

  test('the map opens where it was, else at the person, else the origin, else looks up the address', () => {
    const pose = { geo: { lat: 38.6, lng: -121.5 } };
    assert.deepEqual(PJ.mapStart(project({ mapView: { lat: 1, lng: 2, zoom: 17 } }), pose), { center: { lat: 1, lng: 2 }, zoom: 17, geocode: false });
    assert.deepEqual(PJ.mapStart(project(), pose).center, { lat: 38.6, lng: -121.5 });
    assert.deepEqual(PJ.mapStart(project({ origin: { lat: 3, lng: 4 } }), null).center, { lat: 3, lng: 4 });
    const def = PJ.mapStart(project({ address: '123 Main St, Sacramento' }), null);
    assert.deepEqual(def, { center: null, zoom: null, geocode: true }, 'map-view centres itself on the first position');
    assert.equal(PJ.mapStart(project({ address: '  ' }), null).geocode, false);
    assert.equal(PJ.mapStart(project({ mapView: { lat: NaN, lng: 2 } }), null).center, null, 'a broken saved view is ignored');
  });

  test('a note dropped on a calibrated plan is locked there and gets ground coordinates', () => {
    const level = { id: L1, calibration: { k: 2 } };
    const planToEnu = (cal, p) => ({ e: p.x / cal.k, n: -p.y / cal.k });
    const fromEnu = (o, e, n) => ({ lat: o.lat + n / 1e5, lng: o.lng + e / 1e5 });
    const pose = PJ.notePoseAtPlan({ x: 100, y: 40 }, { level, project: project({ origin: { lat: 38, lng: -121 } }), planToEnu, fromEnu, now: 7 });
    assert.deepEqual(pose.plan, { x: 100, y: 40 });
    assert.equal(pose.planLocked, true);
    assert.deepEqual(pose.enu, { e: 50, n: -20 });
    assert.ok(Math.abs(pose.geo.lat - (38 - 20 / 1e5)) < 1e-12);
    assert.equal(pose.source, 'manual');
    assert.equal(pose.t, 7);
    const bare = PJ.notePoseAtPlan({ x: 1, y: 2 }, { level: { id: L1, calibration: null } });
    assert.deepEqual([bare.plan, bare.enu, bare.geo, bare.planLocked], [{ x: 1, y: 2 }, null, null, true]);
    const broken = PJ.notePoseAtPlan({ x: 1, y: 2 }, { level, planToEnu: () => { throw new Error('x'); } });
    assert.equal(broken.enu, null, 'a failing calibration keeps the plan point');
  });

  test('a note dropped on the map keeps its ground position and is not plan-locked', () => {
    const pose = PJ.notePoseAtGeo({ lat: 38.5, lng: -121.4 }, { project: project({ origin: { lat: 38.5, lng: -121.4 } }), toEnu: () => ({ e: 0, n: 0 }) });
    assert.deepEqual(pose.geo, { lat: 38.5, lng: -121.4, acc: null, alt: null, altAcc: null });
    assert.deepEqual(pose.enu, { e: 0, n: 0 });
    assert.equal(pose.planLocked, false);
    assert.equal(pose.plan, null);
  });

  test('mapViewOf reads both {lat, lng, zoom} and {center, zoom}', () => {
    assert.deepEqual(PJ.mapViewOf({ lat: 1, lng: 2, zoom: 18 }), { lat: 1, lng: 2, zoom: 18 });
    assert.deepEqual(PJ.mapViewOf({ center: { lat: 1, lng: 2 }, zoom: 16 }), { lat: 1, lng: 2, zoom: 16 });
    assert.equal(PJ.mapViewOf({ x: 1 }), null);
    assert.equal(PJ.mapViewOf(null), null);
  });
});

// ---- Recently Deleted --------------------------------------------------------------------------------

describe('Recently Deleted', () => {
  test('erasing a photo names its markup and voice notes, exactly', () => {
    const item = { type: 'photo', seq: 12, annotations: { shapes: [{}] }, media: {}, voiceNotes: [{}, {}], text: '' };
    assert.equal(TR.describeItemLoss(item, 'Riverside Lofts'),
      'Photo #12 from Riverside Lofts and its markup and 2 voice notes will be erased from this phone. This cannot be undone.');
  });

  test('a plain item, a video with its length, and three extras', () => {
    assert.equal(TR.describeItemLoss({ type: 'note', seq: 5, text: 'x' }, 'Job', { device: 'device' }),
      'Note #5 from Job will be erased from this device. This cannot be undone.');
    assert.match(TR.describeItemLoss({ type: 'video', seq: 3, duration: 92 }, 'Job'), /^Video #3 \(1:32\) from Job will be erased/);
    assert.match(TR.describeItemLoss({ type: 'photo', seq: 1, media: { annotated: 'm' }, text: 'see', voiceNotes: [{}] }, 'Job'),
      /^Photo #1 from Job and its markup, its typed notes and 1 voice note will be erased/);
  });

  test('erasing a job walk says what is in it and whether it was backed up', () => {
    const p = project({ levels: [{ plan: {}, planHistory: [{}] }, { plan: null }] });
    const c = TR.projectContents(p, [{ type: 'photo', voiceNotes: [{}] }, { type: 'photo' }, { type: 'note' }]);
    assert.deepEqual(c, { photos: 2, videos: 0, notes: 1, voice: 1, plans: 2 });
    const text = TR.describeProjectLoss(p, c);
    assert.match(text, /^"Riverside Lofts" and everything in it \(2 photos, 1 note, 1 voice note and 2 plans\) will be erased from this phone\./);
    assert.match(text, /It was never backed up\./);
    assert.match(text, /This cannot be undone\.$/);
    const later = TR.describeProjectLoss(project({ changeSeq: 9, backup: { lastAt: Date.UTC(2026, 10, 1, 12), changeSeq: 4 } }), c);
    assert.match(later, /5 changes since then are not in any backup/);
  });

  test('Empty names the totals', () => {
    assert.equal(TR.emptyAllText(2, 7), 'Everything in Recently Deleted — 2 job walks and 7 photos, videos and notes — will be erased from this phone. This cannot be undone.');
    assert.match(TR.emptyAllText(0, 1), /— 1 photo, video or note —/);
    assert.equal(TR.contentsText({ photos: 0, videos: 0, notes: 0, voice: 0, plans: 0 }), 'nothing captured');
  });
});
