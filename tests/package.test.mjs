// package.test.mjs — js/core/package.js: export, import, the viewer data, photos-only, CSV.
//
// The rules under test are the owner's: a backup holds every byte (Recently
// Deleted and replaced plans too), an import brings every record and every
// byte back under new ids without touching anything already on the phone,
// and a note typed by a person can never break out of the viewer page.
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = await import('../js/core/store.js');
const db = await import('../js/core/db.js');
const settings = await import('../js/core/settings.js');
const pkg = await import('../js/core/package.js');
const { readZip, createZipWriter } = await import('../js/core/zip.js');
const { APP_VERSION } = await import('../js/version.js');
const { todayISO } = await import('../js/core/util.js');

const EVIL = 'Check </script><script>alert("x")</script> & <!-- <b>bold</b> "quoted", \'single\'\nline two \u2028 end';

function bytes(n, seed) {
  const b = new Uint8Array(n);
  let x = seed * 2654435761 >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = x & 0xff; }
  return b;
}
const blob = (n, seed, type) => new Blob([bytes(n, seed)], { type });
async function same(a, b) {
  assert.ok(a && b, 'both blobs exist');
  assert.equal(a.size, b.size);
  assert.deepEqual(new Uint8Array(await a.arrayBuffer()), new Uint8Array(await b.arrayBuffer()));
}

const POSE = {
  t: 1, geo: { lat: 38.5816123, lng: -121.4944456, acc: 3.2, alt: 12.5, altAcc: null }, enu: { e: 4.2, n: -3.1 },
  plan: { x: 400.5, y: 300.25 }, planAcc: 80, planLocked: false, heading: 42.4, headingAcc: 5, planHeading: 30.4,
  pitch: -12.3, roll: 1, facing: 'camera', source: 'gps', quality: 'fair',
};

/** A job walk with every kind of thing in it. */
async function makeFixture(name = 'Riverside / Lofts: "Phase 2"') {
  await settings.updateSettings({ userName: 'Cris Tester', units: 'imperial', stampExports: true });
  const p = await store.createProject({ name, address: '1 Main St', gc: 'Acme GC', number: 'A302', walkDate: '2026-11-02', notes: 'Bring the <ladder>' });
  const l1 = p.activeLevelId;
  const l2 = (await store.addLevel(p.id, 'Level 2')).id;
  await store.setLevelPlan(p.id, l1, blob(3000, 1, 'image/png'), { width: 1200, height: 800, source: 'image', thumbBlob: blob(300, 2, 'image/jpeg') });
  await store.setCalibration(p.id, l1, { version: 1, method: 'gps', pxPerMeter: 20, northAngle: 10 });
  await store.setLevelPlan(p.id, l1, blob(4000, 3, 'image/jpeg'), { width: 1600, height: 1000, source: 'pdf', fileName: 'A1.pdf', page: 1 });
  await store.setCalibration(p.id, l1, { version: 1, method: 'gps', pxPerMeter: 25, northAngle: 12 });

  const at = new Date(2026, 10, 2, 10, 32, 5).getTime();
  const photo = await store.createItem(p.id, {
    type: 'photo', levelId: l1, title: 'Header at grid B', text: EVIL, tags: ['Headers/Beams', 'Issue/RFI'],
    width: 4032, height: 3024, mimeType: 'image/jpeg', pose: POSE, createdAt: at, capturedBy: 'Cris',
  });
  const m = {
    original: await store.putMedia(blob(50000, 4, 'image/jpeg'), { kind: 'original', projectId: p.id, itemId: photo.id }),
    thumb: await store.putMedia(blob(2000, 5, 'image/jpeg'), { kind: 'thumb', projectId: p.id, itemId: photo.id }),
    annotated: await store.putMedia(blob(48000, 6, 'image/jpeg'), { kind: 'annotated', projectId: p.id, itemId: photo.id }),
    annotatedThumb: await store.putMedia(blob(2100, 7, 'image/jpeg'), { kind: 'annotatedThumb', projectId: p.id, itemId: photo.id }),
    poster: null,
  };
  const voice = await store.putMedia(blob(9000, 8, 'audio/mp4'), { kind: 'voice', projectId: p.id, itemId: photo.id });
  // A voice note the person removed, and an earlier marked-up version: both keep their bytes.
  const removedVoice = await store.putMedia(blob(800, 15, 'audio/webm'), { kind: 'voice', projectId: p.id, itemId: photo.id });
  const oldAnn = await store.putMedia(blob(47000, 16, 'image/jpeg'), { kind: 'annotated', projectId: p.id, itemId: photo.id });
  const oldAnnThumb = await store.putMedia(blob(1900, 17, 'image/jpeg'), { kind: 'annotatedThumb', projectId: p.id, itemId: photo.id });
  await store.updateItem(photo.id, (i) => {
    i.media = m;
    i.annotations = { v: 1, width: 4032, height: 3024, updatedAt: at, shapes: [{ id: 's1', type: 'arrow', color: '#c8371f', width: 8, a: { x: 1, y: 2 }, b: { x: 30, y: 40 } }] };
    i.voiceNotes = [{ id: 'v_test1', mediaId: voice, duration: 3.2, mimeType: 'audio/mp4', createdAt: at + 1000, transcript: 'second floor header, see <RFI>' }];
    i.removedVoiceNotes = [{ id: 'v_gone1', mediaId: removedVoice, duration: 1, mimeType: 'audio/webm', createdAt: at, transcript: '', removedAt: at + 5 }];
    i.annotationHistory = [{ mediaId: oldAnn, thumbId: oldAnnThumb, at, annotations: { v: 1, width: 4032, height: 3024, shapes: [] } }];
  });

  const photo2 = await store.createItem(p.id, { type: 'photo', levelId: l2, title: '=HYPERLINK("http://x")', tags: [], width: 3000, height: 4000, pose: null, createdAt: at + 60000 });
  const p2orig = await store.putMedia(blob(30000, 9, 'image/jpeg'), { kind: 'original', projectId: p.id, itemId: photo2.id });
  await store.updateItem(photo2.id, (i) => { i.media.original = p2orig; });

  const video = await store.createItem(p.id, {
    type: 'video', levelId: l1, title: 'Walk the east wall', duration: 12.5, mimeType: 'video/webm;codecs=vp9', pose: POSE, createdAt: at + 120000,
    track: [{ t: 0, x: 100, y: 100, lat: 38.58161, lng: -121.49444, heading: 90, planHeading: 78, pitch: 0, acc: 3, e: 1, n: 2 },
      { t: 6000, x: 300.123456, y: 120, lat: 38.58162, lng: -121.49440, heading: 95, planHeading: 83, pitch: -5, acc: 3, e: 5, n: 2 },
      { t: 12000, x: 500, y: 140, lat: 38.58163, lng: -121.49436, heading: 100, planHeading: 88, pitch: -2, acc: 3.5, e: 9, n: 2 }],
  });
  const vid = await store.putMedia(blob(200000, 10, 'video/webm;codecs=vp9'), { kind: 'video', projectId: p.id, itemId: video.id });
  const poster = await store.putMedia(blob(1500, 11, 'image/jpeg'), { kind: 'poster', projectId: p.id, itemId: video.id });
  const vthumb = await store.putMedia(blob(1200, 12, 'image/jpeg'), { kind: 'thumb', projectId: p.id, itemId: video.id });
  await store.updateItem(video.id, (i) => { i.media.original = vid; i.media.poster = poster; i.media.thumb = vthumb; });

  const note = await store.createItem(p.id, { type: 'note', levelId: l1, text: 'Missing blocking at stair 2', tags: ['Blocking'], pose: { ...POSE, plan: { x: 700, y: 500 } }, createdAt: at + 180000 });

  const gone = await store.createItem(p.id, { type: 'photo', levelId: l1, title: 'Blurry', createdAt: at + 240000 });
  const goneOrig = await store.putMedia(blob(25000, 13, 'image/jpeg'), { kind: 'original', projectId: p.id, itemId: gone.id });
  await store.updateItem(gone.id, (i) => { i.media.original = goneOrig; });
  await store.softDeleteItem(gone.id);

  // Bytes nothing points at (a removed voice note keeps them until purge).
  const orphan = await store.putMedia(blob(700, 14, 'audio/webm'), { kind: 'voice', projectId: p.id, itemId: photo.id });

  return { p: await store.getProject(p.id), l1, l2, photo, photo2, video, note, gone, m, voice, vid, poster, vthumb, p2orig, goneOrig, orphan, removedVoice, oldAnn, oldAnnThumb };
}

function viewerDataOf(html) {
  const open = '<script type="application/json" id="jobwalk-data">';
  const a = html.indexOf(open);
  assert.ok(a > 0, 'the data element is there');
  const b = html.indexOf('</script>', a);
  return html.slice(a + open.length, b);
}

const asFile = (res) => new File([res.blob], res.fileName, { type: 'application/zip' });

// ---- export ---------------------------------------------------------------------------------

test('export: every file in its place, the manifest, changeSeq from the start, the file name', async () => {
  const f = await makeFixture();
  const before = await store.getProject(f.p.id);
  const seen = [];
  const res = await pkg.exportProject(f.p.id, { onProgress: (x) => seen.push(x) });
  assert.equal(res.changeSeq, before.changeSeq);
  assert.equal(res.fileName, `DCR Job Walk - Riverside Lofts Phase 2 - ${todayISO()}.zip`);
  assert.equal(res.complete, true);
  assert.deepEqual(res.warnings, []);
  assert.equal(seen.at(-1).fraction, 1);
  assert.ok(seen.every((s, i) => i === 0 || s.fraction >= seen[i - 1].fraction - 1e-9), 'progress only moves forward');

  const z = await readZip(res.blob, { verify: true });
  const names = new Set(z.entries.map((e) => e.name));
  const expect = [
    'index.html', 'jobwalk.json', 'README.txt',
    `media/plans/${f.l1}.jpg`, `media/plans/${f.l1}-old-1.png`, `media/plans/${f.l1}-old-1-thumb.jpg`,
    `media/photos/001-${f.photo.id}.jpg`, `media/annotated/001-${f.photo.id}.jpg`,
    `media/thumbs/${f.photo.id}.jpg`, `media/thumbs/${f.photo.id}-markup.jpg`, 'media/voice/v_test1.m4a',
    'media/voice/v_gone1.webm', `media/annotated/001-${f.photo.id}-old-1.jpg`, `media/thumbs/${f.photo.id}-markup-old-1.jpg`,
    `media/photos/002-${f.photo2.id}.jpg`,
    `media/videos/003-${f.video.id}.webm`, `media/thumbs/${f.video.id}-poster.jpg`, `media/thumbs/${f.video.id}.jpg`,
    `media/photos/005-${f.gone.id}.jpg`, `media/other/${f.orphan}.webm`,
  ];
  for (const n of expect) assert.ok(names.has(n), `${n} is in the zip`);
  assert.equal(z.entries.length, expect.length, 'nothing else');

  const man = await z.entry('jobwalk.json').json();
  assert.equal(man.format, 'dcr-jobwalk');
  assert.equal(man.schema, 1);
  assert.equal(man.appVersion, APP_VERSION);
  assert.equal(man.exportedBy, 'Cris Tester');
  assert.equal(man.project.id, f.p.id);
  assert.equal(man.project.name, f.p.name);
  assert.deepEqual(man.items.map((i) => i.seq), [1, 2, 3, 4]);
  assert.deepEqual(man.deletedItems.map((i) => i.id), [f.gone.id]);
  assert.equal(man.complete, true);
  assert.equal(man.media.length, expect.length - 3);
  for (const m of man.media) {
    const e = z.entry(m.path);
    assert.ok(e, `${m.path} listed and present`);
    assert.equal(e.size, m.size);
    await same(await e.blob(), await store.getMediaBlob(m.id));
  }
  const orphan = man.media.find((m) => m.id === f.orphan);
  assert.equal(orphan.role, 'other');
  assert.equal(orphan.kind, 'voice');

  const readme = await z.entry('README.txt').text();
  assert.match(readme, /Open index\.html/);
  assert.match(readme, /Import a job walk/);
  assert.match(readme, /GitHub/);
});

test('the viewer page: CSS, JS and data inlined; a note cannot break out of the data element', async () => {
  const f = await makeFixture('Escapes');
  const res = await pkg.exportProject(f.p.id);
  const z = await readZip(res.blob);
  const html = await z.entry('index.html').text();
  assert.ok(!html.includes('<!--VIEWER_'), 'no placeholder left');
  const css = fs.readFileSync(path.join(ROOT, 'viewer/viewer.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'viewer/viewer.js'), 'utf8');
  assert.ok(html.includes(css.slice(0, 200)), 'viewer.css is inlined');
  assert.ok(html.includes(js.slice(js.length - 300)), 'viewer.js is inlined');
  assert.equal(html.match(/<\/script/gi).length, 2, 'exactly the two real script ends');
  assert.equal(html.match(/<script/gi).length, 2, 'no extra script element');

  const raw = viewerDataOf(html);
  assert.ok(!raw.includes('<'), 'not one "<" inside the data');
  assert.ok(!raw.includes('>') && !raw.includes('&'));
  const data = JSON.parse(raw);
  const photo = data.items.find((i) => i.id === f.photo.id);
  assert.equal(photo.text, EVIL, 'the note survives exactly');
  assert.equal(data.project.notes, 'Bring the <ladder>');
  assert.equal(data.items.length, 4, 'live items only');
  assert.ok(!data.items.some((i) => i.id === f.gone.id), 'Recently Deleted is not shown');
  assert.equal(data.exportedBy, 'Cris Tester');
  assert.equal(data.units, 'imperial');

  // Every path the viewer uses is in the zip.
  const paths = [];
  for (const l of data.levels) if (l.plan?.src) paths.push(l.plan.src);
  for (const i of data.items) {
    for (const v of Object.values(i.src)) if (v) paths.push(v);
    for (const v of i.voiceNotes) if (v.src) paths.push(v.src);
  }
  for (const p of paths) assert.ok(z.entry(p), `${p} exists`);
  assert.equal(photo.src.image, `media/annotated/001-${f.photo.id}.jpg`, 'marked-up copy shown first');
  assert.equal(photo.src.original, `media/photos/001-${f.photo.id}.jpg`);
  assert.equal(photo.src.thumb, `media/thumbs/${f.photo.id}-markup.jpg`);
  assert.equal(photo.hasMarkup, true);
  const video = data.items.find((i) => i.id === f.video.id);
  assert.equal(video.src.video, `media/videos/003-${f.video.id}.webm`);
  assert.equal(video.track[1].x, 300.1, 'track compacted');
  const l1 = data.levels.find((l) => l.id === f.l1);
  assert.deepEqual([l1.plan.width, l1.plan.height, l1.pxPerMeter, l1.northAngle], [1600, 1000, 25, 12]);
  assert.equal(data.levels.find((l) => l.id === f.l2).plan, null, 'map mode level');
});

test('jsonForHtml and buildViewerHtml: escaping, one pass, placeholders checked', () => {
  assert.equal(pkg.jsonForHtml('</script>&'), '"\\u003c/script\\u003e\\u0026"');
  assert.equal(JSON.parse(pkg.jsonForHtml({ a: '</script><!--\u2028' })).a, '</script><!--\u2028');
  const tpl = '<style><!--VIEWER_CSS--></style><script type="application/json" id="jobwalk-data"><!--VIEWER_DATA--></script><script><!--VIEWER_JS--></script>';
  const out = pkg.buildViewerHtml({ html: tpl, css: 'b{}', js: 'var s = "<!--VIEWER_DATA-->"; var t = "</script>"; var d = "$&$1";' }, { x: 1 });
  assert.ok(out.includes('var s = "<!--VIEWER_DATA-->"'), 'text inside the JS is not treated as a placeholder');
  assert.ok(out.includes('"<\\/script>"'), '</script inside the JS is neutralised');
  assert.ok(out.includes('"$&$1"'), 'no $-pattern substitution');
  assert.ok(out.includes('>{"x":1}</script>'));
  assert.throws(() => pkg.buildViewerHtml({ html: '<style><!--VIEWER_CSS--></style>', css: '', js: '' }, {}), /VIEWER_JS/);
  assert.throws(() => pkg.buildViewerHtml({ html: tpl + tpl, css: '', js: '' }, {}), /exactly once/);
  const real = fs.readFileSync(path.join(ROOT, 'viewer/viewer.html'), 'utf8');
  assert.doesNotThrow(() => pkg.buildViewerHtml({ html: real, css: '', js: '' }, {}));
});

test('viewer.js holds nothing that could end its own script element', () => {
  const js = fs.readFileSync(path.join(ROOT, 'viewer/viewer.js'), 'utf8');
  assert.ok(!/<\/script/i.test(js));
  assert.ok(!js.includes('<!--'));
  assert.ok(!js.includes('VIEWER_DATA'), 'no placeholder name inside the script');
  const css = fs.readFileSync(path.join(ROOT, 'viewer/viewer.css'), 'utf8');
  assert.ok(!/<\/style/i.test(css));
});

test('export can be cancelled before and during packing', async () => {
  const f = await makeFixture('Cancel');
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(pkg.exportProject(f.p.id, { signal: ac.signal }), (e) => e.name === 'AbortError');
  const ac2 = new AbortController();
  await assert.rejects(pkg.exportProject(f.p.id, {
    signal: ac2.signal,
    onProgress: (p) => { if (p.phase === 'zip') ac2.abort(); },
  }), (e) => e.name === 'AbortError');
  await assert.rejects(pkg.exportProject('p_nope'), /not on this phone/);
});

// ---- import ---------------------------------------------------------------------------------------

test('export → import as a copy: every record and byte, under new ids that all fit together', async () => {
  const f = await makeFixture();
  const res = await pkg.exportProject(f.p.id);
  const file = asFile(res);

  const info = await pkg.inspectPackage(file);
  assert.deepEqual(info.counts, { photos: 2, videos: 1, notes: 1, voice: 1, plans: 1, levels: 2, deleted: 1 });
  assert.equal(info.exists, true);
  assert.equal(info.existing.id, f.p.id);
  assert.equal(info.appVersion, APP_VERSION);
  assert.equal(info.complete, true);
  assert.equal(info.missingFiles, 0);
  assert.equal(info.sizeBytes, res.blob.size);
  assert.equal(info.project.name, f.p.name);

  const seen = [];
  const pid = await pkg.importPackage(file, { mode: 'copy', onProgress: (x) => seen.push(x) });
  assert.equal(seen.at(-1).fraction, 1);
  assert.notEqual(pid, f.p.id);
  assert.match(pid, /^p_/);

  const src = await store.getProject(f.p.id);
  const np = await store.getProject(pid);
  assert.equal(np.name, `${src.name} (copy)`);
  assert.equal(np.deletedAt, null);
  assert.equal(np.importedFrom.sourceId, f.p.id);
  assert.equal(np.importedFrom.originId, f.p.id);
  assert.equal(store.backupState(np).needed, false, 'the file it came from is its backup');
  for (const k of ['address', 'gc', 'number', 'walkDate', 'notes', 'nextSeq', 'changeSeq']) assert.deepEqual(np[k], src[k], k);
  assert.equal(np.levels.length, 2);
  const levelMap = new Map(src.levels.map((l, i) => [l.id, np.levels[i].id]));
  for (const [i, l] of src.levels.entries()) {
    const n = np.levels[i];
    assert.notEqual(n.id, l.id);
    assert.equal(n.name, l.name);
    assert.deepEqual(n.calibration, l.calibration);
  }
  assert.equal(np.activeLevelId, levelMap.get(src.activeLevelId));
  const nl1 = np.levels[0];
  const ol1 = src.levels[0];
  await same(await store.getMediaBlob(nl1.plan.mediaId), await store.getMediaBlob(ol1.plan.mediaId));
  assert.deepEqual({ ...nl1.plan, mediaId: 0, thumbId: 0 }, { ...ol1.plan, mediaId: 0, thumbId: 0 });
  assert.equal(nl1.planHistory.length, 1);
  await same(await store.getMediaBlob(nl1.planHistory[0].mediaId), await store.getMediaBlob(ol1.planHistory[0].mediaId));
  await same(await store.getMediaBlob(nl1.planHistory[0].thumbId), await store.getMediaBlob(ol1.planHistory[0].thumbId));
  assert.deepEqual(nl1.planHistory[0].calibration, ol1.planHistory[0].calibration);

  const oldItems = await store.listItems(f.p.id, { includeDeleted: true });
  const newItems = await store.listItems(pid, { includeDeleted: true });
  assert.equal(newItems.length, oldItems.length);
  const bySeq = new Map(newItems.map((i) => [i.seq, i]));
  const oldIds = new Set([f.p.id, ...src.levels.map((l) => l.id), ...oldItems.map((i) => i.id)]);
  for (const o of oldItems) {
    const n = bySeq.get(o.seq);
    assert.ok(n, `item #${o.seq} came back`);
    assert.ok(!oldIds.has(n.id), 'a new item id');
    assert.equal(n.projectId, pid);
    assert.equal(n.levelId, levelMap.get(o.levelId), 'on the matching new level');
    for (const k of ['type', 'title', 'text', 'tags', 'pose', 'track', 'annotations', 'createdAt', 'width', 'height', 'duration', 'mimeType', 'capturedBy', 'source']) {
      assert.deepEqual(n[k], o[k], `#${o.seq} ${k}`);
    }
    assert.equal(!!n.deletedAt, !!o.deletedAt, 'Recently Deleted stays deleted');
    for (const [slot, id] of Object.entries(o.media)) {
      if (!id) { assert.equal(n.media[slot], null, `${slot} stays empty`); continue; }
      assert.notEqual(n.media[slot], id, 'new media id');
      await same(await store.getMediaBlob(n.media[slot]), await store.getMediaBlob(id));
      const rec = await store.getMediaRecord(n.media[slot]);
      assert.equal(rec.projectId, pid);
      assert.equal(rec.itemId, n.id, 'media points at the new item');
      assert.equal(rec.kind, (await store.getMediaRecord(id)).kind);
    }
    assert.equal(n.voiceNotes.length, o.voiceNotes.length);
    for (const [k, v] of o.voiceNotes.entries()) {
      const nv = n.voiceNotes[k];
      assert.notEqual(nv.id, v.id);
      assert.match(nv.id, /^v_/);
      assert.equal(nv.transcript, v.transcript);
      assert.equal(nv.duration, v.duration);
      await same(await store.getMediaBlob(nv.mediaId), await store.getMediaBlob(v.mediaId));
    }
  }
  // A removed voice note and an earlier markup version come back, pointing at their copied bytes.
  const nph = bySeq.get(1);
  assert.equal(nph.removedVoiceNotes.length, 1);
  assert.notEqual(nph.removedVoiceNotes[0].id, 'v_gone1');
  await same(await store.getMediaBlob(nph.removedVoiceNotes[0].mediaId), await store.getMediaBlob(f.removedVoice));
  await same(await store.getMediaBlob(nph.annotationHistory[0].mediaId), await store.getMediaBlob(f.oldAnn));
  await same(await store.getMediaBlob(nph.annotationHistory[0].thumbId), await store.getMediaBlob(f.oldAnnThumb));

  // Not one old id is left anywhere in the new records (only importedFrom names the source, on purpose).
  const oldMediaIds = (await store.listMediaForProject(f.p.id)).map((x) => x.id);
  const everyOld = [...oldIds, ...oldMediaIds, 'v_test1', 'v_gone1'];
  const { importedFrom, ...npRest } = np;
  assert.equal(importedFrom.sourceId, f.p.id);
  const text = JSON.stringify([npRest, newItems]);
  for (const id of everyOld) assert.ok(!text.includes(`"${id}"`), `old id ${id} is not referenced`);

  // Every byte, the orphan included, belongs to the new project; the old one is untouched.
  const newMedia = await store.listMediaForProject(pid);
  const oldMedia = await store.listMediaForProject(f.p.id);
  assert.equal(newMedia.length, oldMedia.length);
  assert.ok(newMedia.every((m) => !oldMedia.some((o) => o.id === m.id)));
  const orphanCopy = newMedia.find((m) => m.size === 700);
  assert.equal(orphanCopy.kind, 'voice');
  assert.equal(orphanCopy.itemId, bySeq.get(1).id, 'tied to the copy of its item');
  assert.equal((await store.listItems(f.p.id, { includeDeleted: true })).length, 5);
  assert.equal((await store.getProject(f.p.id)).deletedAt, null);
});

test('import replace: the copy on this phone goes to Recently Deleted, nothing is overwritten', async () => {
  const f = await makeFixture('Replace me');
  const file = asFile(await pkg.exportProject(f.p.id));
  const pid = await pkg.importPackage(file, { mode: 'replace' });
  const old = await store.getProject(f.p.id);
  assert.ok(old.deletedAt, 'old copy is in Recently Deleted');
  assert.ok((await store.listTrash()).projects.some((p) => p.id === f.p.id));
  assert.equal((await store.listItems(f.p.id, { includeDeleted: true })).length, 5, 'old records kept');
  assert.ok(await store.getMediaBlob(f.m.original), 'old bytes kept');
  const np = await store.getProject(pid);
  assert.equal(np.name, 'Replace me', 'no "(copy)"');
  assert.equal(np.deletedAt, null);
  // The same file now matches the imported copy (same original), not the deleted one.
  const info = await pkg.inspectPackage(file);
  assert.equal(info.exists, true);
  assert.equal(info.existing.id, pid);
  assert.equal(info.existing.deleted, false);
  // And it can be restored from Recently Deleted.
  await store.restoreProject(f.p.id);
  assert.equal((await store.getProject(f.p.id)).deletedAt, null);
});

test('a backup made on another phone imports without "(copy)"', async () => {
  const f = await makeFixture('Fresh phone');
  const file = asFile(await pkg.exportProject(f.p.id));
  await store.softDeleteProject(f.p.id);
  await store.purgeProject(f.p.id);
  const info = await pkg.inspectPackage(file);
  assert.equal(info.exists, false);
  const pid = await pkg.importPackage(file, { mode: 'copy' });
  assert.equal((await store.getProject(pid)).name, 'Fresh phone');
  assert.equal((await store.listItems(pid, { includeDeleted: true })).length, 5);
});

test('without videos: a shared copy, not complete; the video item keeps its path and poster', async () => {
  const f = await makeFixture('No videos');
  const res = await pkg.exportProject(f.p.id, { includeVideos: false });
  assert.equal(res.complete, false);
  const z = await readZip(res.blob);
  assert.ok(!z.entries.some((e) => e.name.startsWith('media/videos/')));
  const man = await z.entry('jobwalk.json').json();
  assert.equal(man.complete, false);
  assert.ok(man.omitted.some((o) => o.id === f.vid && o.reason === 'videos-not-included'));
  assert.match(await z.entry('README.txt').text(), /not a full backup/);
  const file = asFile(res);
  assert.equal((await pkg.inspectPackage(file)).complete, false);
  const pid = await pkg.importPackage(file);
  const v = (await store.listItems(pid)).find((i) => i.type === 'video');
  assert.equal(v.media.original, null);
  await same(await store.getMediaBlob(v.media.poster), await store.getMediaBlob(f.poster));
  assert.deepEqual(v.track, (await store.getItem(f.video.id)).track);
});

test('without originals: a marked-up photo becomes the photo on import, its shapes dropped', async () => {
  const f = await makeFixture('No originals');
  const res = await pkg.exportProject(f.p.id, { includeOriginals: false });
  const z = await readZip(res.blob);
  assert.equal(z.entry(`media/photos/001-${f.photo.id}.jpg`), null, 'original with markup left out');
  assert.ok(z.entry(`media/photos/002-${f.photo2.id}.jpg`), 'a photo without markup keeps its original');
  const data = JSON.parse(viewerDataOf(await z.entry('index.html').text()));
  assert.equal(data.items.find((i) => i.id === f.photo.id).src.original, null);
  const pid = await pkg.importPackage(asFile(res));
  const ph = (await store.listItems(pid)).find((i) => i.seq === 1);
  await same(await store.getMediaBlob(ph.media.original), await store.getMediaBlob(f.m.annotated));
  await same(await store.getMediaBlob(ph.media.thumb), await store.getMediaBlob(f.m.annotatedThumb));
  assert.equal(ph.media.annotated, null);
  assert.equal(ph.annotations, null);
});

test('a backup someone unzipped and zipped again (in a folder, deflated, with __MACOSX) still imports', async () => {
  const f = await makeFixture('Rezipped');
  const res = await pkg.exportProject(f.p.id);
  const z = await readZip(res.blob);
  const w = createZipWriter();
  w.add('__MACOSX/My Job/._jobwalk.json', 'junk');
  for (const e of z.entries) w.add(`My Job/${e.name}`, await e.blob(), { compress: true });
  const again = new File([await w.finish()], 'My Job.zip');
  const info = await pkg.inspectPackage(again);
  assert.equal(info.counts.photos, 2);
  assert.equal(info.missingFiles, 0);
  const pid = await pkg.importPackage(again);
  const ph = (await store.listItems(pid)).find((i) => i.seq === 1);
  await same(await store.getMediaBlob(ph.media.original), await store.getMediaBlob(f.m.original));
});

test('files that are not a job walk are refused with plain words', async () => {
  await assert.rejects(pkg.inspectPackage(new File([bytes(5000, 1)], 'x.zip')), /not a DCR Job Walk file/);
  const photosOnly = createZipWriter();
  photosOnly.add('001 - Level 1.jpg', bytes(100, 2));
  photosOnly.add('photos.csv', 'seq,file');
  await assert.rejects(pkg.inspectPackage(new File([await photosOnly.finish()], 'p.zip')), /Photos only/);
  const noData = createZipWriter();
  noData.add('hello.txt', 'hi');
  await assert.rejects(pkg.importPackage(new File([await noData.finish()], 'h.zip')), /no jobwalk\.json/);
  const newer = createZipWriter();
  newer.add('jobwalk.json', JSON.stringify({ format: 'dcr-jobwalk', schema: 99, appVersion: '9.0.0', project: { id: 'p_x', levels: [] }, items: [] }));
  await assert.rejects(pkg.inspectPackage(new File([await newer.finish()], 'n.zip')), /newer DCR Job Walk/);
  const other = createZipWriter();
  other.add('jobwalk.json', JSON.stringify({ format: 'something-else', schema: 1 }));
  await assert.rejects(pkg.inspectPackage(new File([await other.finish()], 'o.zip')), /not a DCR Job Walk export/);
  const broken = createZipWriter();
  broken.add('jobwalk.json', '{"format": "dcr-jobwalk", ');
  await assert.rejects(pkg.inspectPackage(new File([await broken.finish()], 'b.zip')), /damaged/);
  await assert.rejects(pkg.importPackage(new File([bytes(10, 1)], 'x.zip'), { mode: 'merge' }), /copy' or 'replace/);
});

test('a damaged photo stops the import and leaves no stray bytes behind', async () => {
  const f = await makeFixture('Damaged');
  const res = await pkg.exportProject(f.p.id);
  const z = await readZip(res.blob);
  const e = z.entry(`media/photos/001-${f.photo.id}.jpg`);
  const all = new Uint8Array(await res.blob.arrayBuffer());
  const hv = new DataView(all.buffer, e.offset, 30);
  const dataStart = e.offset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
  all[dataStart + 1000] ^= 0x5a;
  const mediaBefore = (await db.getAll('media')).length;
  const partsBefore = (await db.getAllKeys('parts')).length;
  const projectsBefore = (await store.listProjects()).length;
  await assert.rejects(pkg.importPackage(new File([all], 'bad.zip')), /damaged.*nothing was imported/s);
  assert.equal((await db.getAll('media')).length, mediaBefore, 'files saved before the damage was found are removed again');
  assert.equal((await db.getAllKeys('parts')).length, partsBefore, 'and their bytes');
  assert.equal((await store.listProjects()).length, projectsBefore);
});

test('an import can be cancelled, and nothing of it is left', async () => {
  const f = await makeFixture('Cancel import');
  const file = asFile(await pkg.exportProject(f.p.id));
  const mediaBefore = (await db.getAll('media')).length;
  const partsBefore = (await db.getAllKeys('parts')).length;
  const ac = new AbortController();
  let n = 0;
  await assert.rejects(pkg.importPackage(file, {
    signal: ac.signal,
    onProgress: (p) => { if (p.phase === 'media' && ++n === 3) ac.abort(); },
  }), (e) => e.name === 'AbortError');
  assert.equal((await db.getAll('media')).length, mediaBefore);
  assert.equal((await db.getAllKeys('parts')).length, partsBefore);
});

// ---- photos only ---------------------------------------------------------------------------------

test('photos only: flat JPEGs named number - level - tag - time, and a safe CSV', async () => {
  const f = await makeFixture('Photos');
  const res = await pkg.exportPhotos(f.p.id);
  assert.equal(res.fileName, `DCR Job Walk - Photos - photos - ${todayISO()}.zip`);
  assert.equal(res.count, 2);
  const z = await readZip(res.blob, { verify: true });
  const names = z.entries.map((e) => e.name);
  assert.deepEqual(names, ['001 - Level 1 - Headers Beams - 2026-11-02 10.32.jpg', '002 - Level 2 - 2026-11-02 10.33.jpg', 'photos.csv']);
  await same(await z.entries[0].blob(), await store.getMediaBlob(f.m.annotated));
  const csv = await z.entry('photos.csv').text();
  const rawCsv = new Uint8Array(await (await z.entry('photos.csv').blob()).arrayBuffer());
  assert.deepEqual([...rawCsv.slice(0, 3)], [0xEF, 0xBB, 0xBF], 'UTF-8 byte-order mark for Excel');
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
  assert.equal(lines[0], 'seq,file,level,date,time,lat,lng,accuracy (ft),heading,tilt,tags,title,notes');
  assert.ok(lines[1].startsWith('1,001 - Level 1 - Headers Beams - 2026-11-02 10.32.jpg,Level 1,2026-11-02,10:32,38.5816123,-121.4944456,10.5,42,-12,Headers/Beams; Issue/RFI,Header at grid B,"Check </script>'));
  assert.ok(csv.includes('""x""'), 'quotes doubled');
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`), 'a formula is defused');

  const originals = await pkg.exportPhotos(f.p.id, { annotated: false });
  const z2 = await readZip(originals.blob);
  await same(await z2.entries[0].blob(), await store.getMediaBlob(f.m.original));

  const empty = await store.createProject({ name: 'Empty' });
  await assert.rejects(pkg.exportPhotos(empty.id), /no photos/);
});

test('remapIds swaps every known id wherever it is, nulls missing files, keeps everything else', () => {
  const map = new Map([['m_a', 'm_A'], ['i_x', 'i_X'], ['v_1', 'v_9']]);
  const gone = new Set(['m_gone']);
  const lookup = (s) => (map.has(s) ? map.get(s) : gone.has(s) ? null : undefined);
  const rec = {
    id: 'i_x', title: 'm_a is my note', media: { original: 'm_a', thumb: 'm_gone', poster: null },
    voiceNotes: [{ id: 'v_1', mediaId: 'm_a' }], future: { deep: [['m_a']] }, n: 3, ok: true, when: null,
  };
  const out = pkg.remapIds(rec, lookup);
  assert.deepEqual(out, {
    id: 'i_X', title: 'm_a is my note', media: { original: 'm_A', thumb: null, poster: null },
    voiceNotes: [{ id: 'v_9', mediaId: 'm_A' }], future: { deep: [['m_A']] }, n: 3, ok: true, when: null,
  });
  assert.equal(rec.media.original, 'm_a', 'the source record is not changed');
});

test('CSV cells, file names, extensions, stamp lines', () => {
  assert.equal(pkg.csvCell('plain'), 'plain');
  assert.equal(pkg.csvCell('a,b'), '"a,b"');
  assert.equal(pkg.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(pkg.csvCell('two\nlines'), '"two\nlines"');
  assert.equal(pkg.csvCell('=1+1'), "'=1+1");
  assert.equal(pkg.csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(pkg.csvCell('-x'), "'-x");
  assert.equal(pkg.csvCell(-12.5), '-12.5');
  assert.equal(pkg.csvCell(null), '');
  assert.equal(pkg.csvCell(NaN), '');
  assert.equal(pkg.toCsv([['a', 'b'], [1, 'c,d']]), 'a,b\r\n1,"c,d"\r\n');

  const when = new Date(2026, 10, 2, 9, 5).getTime();
  assert.equal(pkg.photoFileName({ seq: 12, tags: ['Walls'], createdAt: when }, 'Level 1'), '012 - Level 1 - Walls - 2026-11-02 09.05.jpg');
  assert.equal(pkg.photoFileName({ seq: 7, tags: [], createdAt: when }, 'Roof: "A"/B'), '007 - Roof A B - 2026-11-02 09.05.jpg');
  assert.equal(pkg.photoFileName({ seq: 1234, tags: ['Issue/RFI'], createdAt: when }, '', 'png'), '1234 - Issue RFI - 2026-11-02 09.05.png');

  assert.equal(pkg.extFor('video/webm;codecs=vp9'), 'webm');
  assert.equal(pkg.extFor('audio/mp4'), 'm4a');
  assert.equal(pkg.extFor('', 'plan.PDF'), 'pdf');
  assert.equal(pkg.extFor('', '', 'thumb'), 'jpg');
  assert.equal(pkg.extFor('application/x-weird'), 'bin');

  const s = pkg.stampLines({ seq: 12, createdAt: when, pose: POSE }, { project: { name: 'Lofts' }, level: { name: 'Level 1' }, units: 'imperial', company: 'DCR Framing' });
  assert.equal(s.top, '#12 · Lofts · Level 1');
  assert.match(s.bottom, /Position fair ±10 ft · Facing NE 42°$/);
  assert.equal(s.brand, 'DCR Framing · DCR Job Walk');
  assert.match(pkg.stampLines({ seq: 1, createdAt: when, pose: null }, {}).bottom, /No position/);
  assert.equal(pkg.poseAccuracy({ planAcc: 50 }, { calibration: { pxPerMeter: 25 } }), 2);
  assert.equal(pkg.canDrawImages(), false, 'Node: no canvas, so no stamping');
});

test('estimateExport counts what a backup holds', async () => {
  const f = await makeFixture('Estimate');
  const est = await pkg.estimateExport(f.p.id);
  assert.deepEqual(est.counts, { photos: 2, videos: 1, notes: 1, voice: 1, plans: 1, levels: 2, deleted: 1 });
  assert.equal(est.bytes.videos, 200000);
  assert.ok(est.bytes.total > est.bytes.withoutVideos);
  assert.equal(est.bytes.total - est.bytes.withoutVideos, 200000);
});

// ---- the viewer's own logic, run without a page -------------------------------------------------------

test('viewer helpers: safe paths, formats, playback interpolation, filters', () => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'viewer/viewer.js'), 'utf8'), ctx, { filename: 'viewer.js' });
  const V = ctx.JobWalkViewer;
  assert.ok(V, 'the viewer exposes its helpers when there is no document');
  assert.equal(V.safeSrc('media/photos/001-i_abc.jpg'), 'media/photos/001-i_abc.jpg');
  for (const bad of ['javascript:alert(1)', 'media/../index.html', '../media/x.jpg', 'https://evil.example/x.jpg', '/media/x.jpg', 'media/x.jpg"><script>', 'media//x', null, 42]) {
    assert.equal(V.safeSrc(bad), null, String(bad));
  }
  assert.equal(V.mapsUrl(38.5, -121.25), 'https://www.google.com/maps/search/?api=1&query=38.5000000%2C-121.2500000');
  assert.equal(V.mapsUrl(NaN, 1), null);
  assert.equal(V.mapsUrl(91, 1), null);
  assert.equal(V.fmtAccuracy(1.2192, 'imperial'), '±4.0 ft');
  assert.equal(V.fmtAccuracy(1.2, 'metric'), '±1.2 m');
  assert.equal(V.fmtLength(3.81, 'imperial'), `12' 6"`);
  assert.equal(V.fmtTilt(-12.4), '12° down');
  assert.equal(V.fmtTilt(1), 'level');
  assert.equal(V.fmtTilt(-89), 'straight down');
  assert.equal(V.fmtHeading(42.4), 'NE 42°');
  assert.equal(V.fmtHeading(359.7), 'N 0°');
  assert.equal(V.fmtDuration(92), '1:32');
  const pts = [{ t: 0, x: 0, y: 0, h: 350 }, { t: 1000, x: 10, y: 20, h: 10 }];
  const mid = V.trackAt(pts, 500);
  assert.equal(mid.x, 5);
  assert.equal(mid.y, 10);
  assert.ok(Math.abs(mid.h - 0) < 1e-9 || Math.abs(mid.h - 360) < 1e-9, 'heading interpolates across north');
  assert.equal(V.trackAt(pts, -5).x, 0);
  assert.equal(V.trackAt(pts, 99999).x, 10);
  assert.equal(V.planHeadingOf({ heading: 30 }, { northAngle: 40 }), 350);
  assert.equal(V.planHeadingOf({ planHeading: 12, heading: 30 }, { northAngle: 40 }), 12);
  assert.equal(V.accuracyOf({ planAcc: 50 }, { pxPerMeter: 25 }), 2);
  const item = { seq: 12, type: 'photo', levelId: 'l1', title: 'Header', text: 'Beam at B', tags: ['Walls'], voiceNotes: [{ transcript: 'second floor' }] };
  assert.equal(V.matches(item, { type: 'all', levelId: 'l1', q: '#12' }), true);
  assert.equal(V.matches(item, { type: 'all', q: 'second beam' }), true);
  assert.equal(V.matches(item, { type: 'video' }), false);
  assert.equal(V.matches(item, { tag: 'Walls' }), true);
  assert.equal(V.matches(item, { tag: 'Demo' }), false);
  assert.equal(V.matches(item, { levelId: 'l2' }), false);
  assert.equal(V.itemLabel({ type: 'note', text: 'First line\nsecond' }), 'First line');
  assert.equal(V.itemLabel({ type: 'photo', tags: ['Walls', 'Demo'] }), 'Walls, Demo');
});
