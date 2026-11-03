// store.test.mjs — the durability rules of js/core/store.js, on a fake IndexedDB.
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../js/core/store.js');
const { bus } = await import('../js/core/bus.js');

test('a project starts with one level, numbering at #1, nothing backed up', async () => {
  const p = await store.createProject({ name: '  Riverside Lofts ' });
  assert.equal(p.name, 'Riverside Lofts');
  assert.equal(p.levels.length, 1);
  assert.equal(p.activeLevelId, p.levels[0].id);
  assert.equal(p.nextSeq, 1);
  assert.equal(store.backupState(p).needed, true);
});

test('items are numbered in order and bump the change count', async () => {
  const p = await store.createProject({ name: 'Seq' });
  const a = await store.createItem(p.id, { type: 'note', levelId: p.activeLevelId, text: 'one' });
  const b = await store.createItem(p.id, { type: 'note', levelId: p.activeLevelId, text: 'two' });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  const after = await store.getProject(p.id);
  assert.equal(after.nextSeq, 3);
  assert.ok(after.changeSeq > p.changeSeq);
});

test('putMedia verifies the bytes and getMediaBlob returns them', async () => {
  const p = await store.createProject({ name: 'Media' });
  const bytes = new Uint8Array(5000).map((_, i) => i % 251);
  const id = await store.putMedia(new Blob([bytes], { type: 'image/jpeg' }), { kind: 'original', projectId: p.id });
  const back = await store.getMediaBlob(id);
  assert.equal(back.size, 5000);
  assert.deepEqual(new Uint8Array(await back.arrayBuffer()), bytes);
});

test('an empty file is refused, not saved', async () => {
  const p = await store.createProject({ name: 'Empty' });
  await assert.rejects(store.putMedia(new Blob([]), { kind: 'original', projectId: p.id }), /empty/);
});

test('delete goes to Recently Deleted; restore brings it back; purge removes its bytes', async () => {
  const p = await store.createProject({ name: 'Trash' });
  const item = await store.createItem(p.id, { type: 'photo', levelId: p.activeLevelId });
  const mid = await store.putMedia(new Blob([new Uint8Array(10)]), { kind: 'original', projectId: p.id, itemId: item.id });
  await store.updateItem(item.id, (i) => { i.media.original = mid; });
  await store.softDeleteItem(item.id);
  assert.equal((await store.listItems(p.id)).length, 0);
  assert.equal((await store.listItems(p.id, { includeDeleted: true })).length, 1);
  const trash = await store.listTrash();
  assert.ok(trash.items.some((i) => i.id === item.id));
  await store.restoreItem(item.id);
  assert.equal((await store.listItems(p.id)).length, 1);
  await store.softDeleteItem(item.id);
  await store.purgeItem(item.id);
  assert.equal(await store.getItem(item.id), undefined);
  assert.equal(await store.getMediaBlob(mid), null);
});

test('replacing a plan keeps the old one in planHistory and clears calibration', async () => {
  const p = await store.createProject({ name: 'Plans' });
  const lid = p.activeLevelId;
  await store.setLevelPlan(p.id, lid, new Blob([new Uint8Array(20)], { type: 'image/png' }), { width: 100, height: 50, source: 'image' });
  await store.setCalibration(p.id, lid, { version: 1, pxPerMeter: 10 });
  await store.setLevelPlan(p.id, lid, new Blob([new Uint8Array(30)], { type: 'image/png' }), { width: 200, height: 80, source: 'pdf' });
  const lvl = store.getLevel(await store.getProject(p.id), lid);
  assert.equal(lvl.plan.width, 200);
  assert.equal(lvl.calibration, null);
  assert.equal(lvl.planHistory.length, 1);
  assert.equal(lvl.planHistory[0].calibration.pxPerMeter, 10);
  assert.ok(await store.getMediaBlob(lvl.planHistory[0].mediaId));
});

test('the origin is set once and never moves', async () => {
  const p = await store.createProject({ name: 'Origin' });
  await store.setOriginOnce(p.id, { lat: 38.5, lng: -121.5 });
  await store.setOriginOnce(p.id, { lat: 10, lng: 10 });
  const after = await store.getProject(p.id);
  assert.equal(after.origin.lat, 38.5);
});

test('a backup covers the changes up to its changeSeq; later changes need a new one', async () => {
  const p = await store.createProject({ name: 'Backup' });
  await store.createItem(p.id, { type: 'note', levelId: p.activeLevelId });
  const before = await store.getProject(p.id);
  await store.markBackedUp(p.id, { changeSeq: before.changeSeq, fileName: 'x.zip' });
  assert.equal(store.backupState(await store.getProject(p.id)).needed, false);
  await store.createItem(p.id, { type: 'note', levelId: p.activeLevelId });
  assert.equal(store.backupState(await store.getProject(p.id)).needed, true);
});

test('video write-ahead: chunks are kept until endRecording', async () => {
  const rec = await store.beginRecording({ projectId: 'p_x', levelId: 'l_x', mimeType: 'video/webm' });
  await store.putChunk(rec.recId, 1, new Blob(['bbb']));
  await store.putChunk(rec.recId, 0, new Blob(['aa']));
  await store.updateRecording(rec.recId, (r) => { r.track.push({ t: 0 }); });
  const chunks = await store.getRecordingChunks(rec.recId);
  assert.equal(chunks.length, 2);
  assert.equal(await chunks[0].text(), 'aa');
  assert.equal((await store.listRecordings()).find((r) => r.recId === rec.recId).track.length, 1);
  await store.endRecording(rec.recId);
  assert.equal((await store.getRecordingChunks(rec.recId)).length, 0);
  assert.ok(!(await store.listRecordings()).some((r) => r.recId === rec.recId));
});

test('a level with items on it cannot be removed', async () => {
  const p = await store.createProject({ name: 'Levels' });
  const l2 = await store.addLevel(p.id, 'Level 2');
  await store.createItem(p.id, { type: 'note', levelId: l2.id });
  await assert.rejects(store.removeLevel(p.id, l2.id), /photos, videos or notes/);
});

test('every committed write is announced on the bus', async () => {
  const seen = [];
  const off = bus.on('store:change', (e) => seen.push(e.kind + ':' + e.action));
  const p = await store.createProject({ name: 'Events' });
  await store.createItem(p.id, { type: 'note', levelId: p.activeLevelId });
  off();
  assert.deepEqual(seen.slice(0, 2), ['project:create', 'item:create']);
});

test('a file larger than one part is split, verified and rebuilt byte for byte', async () => {
  const db = await import('../js/core/db.js');
  const p = await store.createProject({ name: 'Big' });
  const n = db.PART_SIZE * 2 + 12345;
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i += 4096) bytes[i] = (i / 4096) % 256;
  const id = await store.putMedia(new Blob([bytes], { type: 'video/mp4' }), { kind: 'video', projectId: p.id });
  const rec = await store.getMediaRecord(id);
  assert.equal(rec.partCount, 3);
  assert.equal(rec.size, n);
  const back = new Uint8Array(await (await store.getMediaBlob(id)).arrayBuffer());
  assert.equal(back.length, n);
  for (let i = 0; i < n; i += 4096) assert.equal(back[i], bytes[i]);
  assert.equal((await store.getMediaBlob(id)).type, 'video/mp4');
});

test('verifyMedia catches a part that changed on disk', async () => {
  const db = await import('../js/core/db.js');
  const p = await store.createProject({ name: 'Corrupt' });
  const id = await store.putMedia(new Blob([new Uint8Array(100).fill(7)]), { kind: 'original', projectId: p.id });
  const part = await db.get('parts', [id, 0]);
  new Uint8Array(part.data)[5] = 9;
  await db.put('parts', part);
  await assert.rejects(store.verifyMedia(id, 100), /did not read back the same/);
});

test('deleting media removes its parts too', async () => {
  const db = await import('../js/core/db.js');
  const p = await store.createProject({ name: 'Del' });
  const id = await store.putMedia(new Blob([new Uint8Array(10)]), { kind: 'thumb', projectId: p.id });
  await store.deleteMedia(id);
  assert.equal((await db.getAllKeys('parts', db.rangeFor(id))).length, 0);
});

test('a saved photo whose item was never written comes back as a Recovered photo', async () => {
  const p = await store.createProject({ name: 'Orphan' });
  const pose = { plan: { x: 10, y: 20 }, heading: 90 };
  const mid = await store.putMedia(new Blob([new Uint8Array(50)], { type: 'image/jpeg' }), {
    kind: 'original', projectId: p.id, itemId: 'i_lost1', meta: { levelId: p.activeLevelId, pose, width: 4, height: 3 },
  });
  // too recent: left alone (it may still be in the middle of being saved)
  assert.ok(!(await store.recoverOrphans()).items.some((i) => i.id === 'i_lost1'));
  const out = await store.recoverOrphans({ now: Date.now() + 11 * 60 * 1000 });
  // (other tests in this file leave unreferenced originals too; they are recovered the same way)
  assert.ok(out.items.some((i) => i.id === 'i_lost1'));
  const item = await store.getItem('i_lost1');
  assert.equal(item.source, 'recovered');
  assert.equal(item.media.original, mid);
  assert.deepEqual(item.pose, pose);
  // running again finds nothing new
  assert.equal((await store.recoverOrphans({ now: Date.now() + 11 * 60 * 1000 })).items.length, 0);
});

test('parts left by an unfinished save are cleaned up later, not right away', async () => {
  const db = await import('../js/core/db.js');
  await db.put('parts', { mediaId: 'm_stray', seq: 0, data: new ArrayBuffer(8), size: 8, sha: '', at: Date.now() });
  assert.equal((await store.recoverOrphans()).partsRemoved, 0);
  assert.equal((await store.recoverOrphans({ now: Date.now() + 11 * 60 * 1000 })).partsRemoved, 1);
  assert.equal((await db.getAllKeys('parts', db.rangeFor('m_stray'))).length, 0);
});

test('Delete forever keeps what was restored meanwhile (another window)', async () => {
  const p = await store.createProject({ name: 'Restored meanwhile' });
  const item = await store.createItem(p.id, { type: 'photo', levelId: p.activeLevelId });
  const mid = await store.putMedia(new Blob([new Uint8Array(10)]), { kind: 'original', projectId: p.id, itemId: item.id });
  const shown = (await store.softDeleteItem(item.id)).deletedAt;   // what Recently Deleted showed
  await store.restoreItem(item.id);
  await assert.rejects(store.purgeItem(item.id, { deletedAt: shown }), (err) => err.kept === true && /restored/.test(err.message));
  await assert.rejects(store.purgeItem(item.id), (err) => err.kept === true, 'a live item is never erased');
  // Restored and deleted again since: not the deletion that was confirmed.
  await store.updateItem(item.id, (i) => { i.deletedAt = shown + 5; });
  await assert.rejects(store.purgeItem(item.id, { deletedAt: shown }), (err) => err.kept === true);
  assert.ok(await store.getItem(item.id));
  assert.ok(await store.getMediaBlob(mid));
  // Still deleted from the moment shown: erased with its bytes.
  await store.purgeItem(item.id, { deletedAt: shown + 5 });
  assert.equal(await store.getItem(item.id), undefined);
  assert.equal(await store.getMediaBlob(mid), null);
  await store.purgeItem(item.id); // already gone: nothing to do

  const q = await store.createProject({ name: 'Walk restored meanwhile' });
  const qi = await store.createItem(q.id, { type: 'photo', levelId: q.activeLevelId });
  const qm = await store.putMedia(new Blob([new Uint8Array(10)]), { kind: 'original', projectId: q.id, itemId: qi.id });
  const qShown = (await store.softDeleteProject(q.id)).deletedAt;
  await store.restoreProject(q.id);
  await assert.rejects(store.purgeProject(q.id, { deletedAt: qShown }), (err) => err.kept === true && /Walk restored meanwhile/.test(err.message));
  assert.ok(await store.getProject(q.id));
  assert.ok(await store.getItem(qi.id));
  assert.ok(await store.getMediaBlob(qm));
  const again = (await store.softDeleteProject(q.id)).deletedAt;
  await store.purgeProject(q.id, { deletedAt: again });
  assert.equal(await store.getProject(q.id), undefined);
  assert.equal(await store.getItem(qi.id), undefined);
  assert.equal(await store.getMediaBlob(qm), null);
});

test('replacing a plan takes pins off the old image; a pin placed by hand keeps its ground spot', async () => {
  const { reprojectItems } = await import('../js/core/calibration.js');
  const p = await store.createProject({ name: 'Plan swap' });
  const lid = p.activeLevelId;
  const other = await store.addLevel(p.id, 'Level 2');
  await store.setLevelPlan(p.id, lid, new Blob([new Uint8Array(20)], { type: 'image/png' }), { width: 100, height: 50 });
  // 10 px per meter, plan y down = north up.
  const cal = { version: 1, pxPerMeter: 10, northAngle: 0, toPlan: [10, 0, 0, -10, 0, 0], toEnu: [0.1, 0, 0, -0.1, 0, 0] };
  await store.setCalibration(p.id, lid, cal);
  const oldPlanId = store.getLevel(await store.getProject(p.id), lid).plan.mediaId;
  const gps = await store.createItem(p.id, { type: 'photo', levelId: lid, pose: { plan: { x: 10, y: 20 }, planAcc: 5, planHeading: 30, planLocked: false, enu: { e: 1, n: -2 }, heading: 30 } });
  const hand = await store.createItem(p.id, { type: 'note', levelId: lid, pose: { plan: { x: 30, y: 40 }, planLocked: true, enu: { e: 9, n: 9 }, planAuto: { x: 1, y: 1 } } });
  const video = await store.createItem(p.id, { type: 'video', levelId: lid, pose: { plan: null }, track: [{ t: 0, x: 1, y: 2, e: 0.1, n: -0.2, planHeading: 5 }, { t: 1000, x: null, y: null }] });
  const elsewhere = await store.createItem(p.id, { type: 'photo', levelId: other.id, pose: { plan: { x: 7, y: 7 } } });
  const seen = [];
  const off = bus.on('store:change', (e) => { if (e.kind === 'item') seen.push(e.id); });
  await store.setLevelPlan(p.id, lid, new Blob([new Uint8Array(30)], { type: 'image/png' }), { width: 200, height: 80 });
  off();

  const g = await store.getItem(gps.id);
  assert.equal(g.pose.plan, null, 'no spot in the new image until it is calibrated');
  assert.deepEqual({ ...g.pose.planPrev, at: 0 }, { mediaId: oldPlanId, at: 0, x: 10, y: 20, planAcc: 5, planHeading: 30, planLocked: false });
  assert.deepEqual(g.pose.enu, { e: 1, n: -2 }, 'its GPS position is untouched');

  const h = await store.getItem(hand.id);
  assert.equal(h.pose.plan, null);
  assert.equal(h.pose.planLocked, false, 'so the new calibration places it');
  assert.deepEqual(h.pose.enu, { e: 3, n: -4 }, 'the hand-placed spot, on the ground (old calibration)');
  assert.deepEqual(h.pose.planPrev.enu, { e: 9, n: 9 }, 'the position it had is kept');
  assert.deepEqual(h.pose.planPrev.planAuto, { x: 1, y: 1 });
  assert.equal('planAuto' in h.pose, false);

  const v = await store.getItem(video.id);
  assert.equal(v.track[0].x, null);
  assert.equal(v.track[0].e, 0.1);
  assert.deepEqual(v.pose.planPrev.track, [{ t: 0, x: 1, y: 2, planHeading: 5 }]);

  assert.deepEqual((await store.getItem(elsewhere.id)).pose.plan, { x: 7, y: 7 }, 'other levels are not touched');
  assert.deepEqual(seen.sort(), [gps.id, hand.id, video.id].sort());

  // Once the new plan is calibrated, the hand-placed pin lands where it was put.
  const cal2 = { version: 1, pxPerMeter: 20, northAngle: 0, toPlan: [20, 0, 0, -20, 0, 0], toEnu: [0.05, 0, 0, -0.05, 0, 0] };
  await store.setCalibration(p.id, lid, cal2);
  const level = store.getLevel(await store.getProject(p.id), lid);
  const moved = reprojectItems([h, g], level, null);
  assert.deepEqual(moved.find((m) => m.id === hand.id).pose.plan, { x: 60, y: 80 });
  assert.deepEqual(moved.find((m) => m.id === gps.id).pose.plan, { x: 20, y: 40 });

  // A third plan keeps the spots of the second inside the new planPrev.
  await store.updateItem(hand.id, (i) => { i.pose.plan = { x: 60, y: 80 }; });
  await store.setLevelPlan(p.id, lid, new Blob([new Uint8Array(40)], { type: 'image/png' }), { width: 300, height: 90 });
  const h3 = await store.getItem(hand.id);
  assert.deepEqual([h3.pose.planPrev.x, h3.pose.planPrev.before.x], [60, 30]);
});

test('a plan put on a level whose plan image did not come through an import takes its pins off too', async () => {
  const p = await store.createProject({ name: 'Plan lost in import' });
  const lid = p.activeLevelId;
  // As importPackage leaves it: no plan, the lost one (and its calibration) in planHistory.
  const cal = { version: 1, pxPerMeter: 10, northAngle: 0, toPlan: [10, 0, 0, -10, 0, 0], toEnu: [0.1, 0, 0, -0.1, 0, 0], planMediaId: null };
  await store.updateLevel(p.id, lid, (l) => {
    l.plan = null;
    l.planHistory = [{ mediaId: null, width: 100, height: 50, calibration: cal, replacedAt: 1 }];
  });
  const hand = await store.createItem(p.id, { type: 'note', levelId: lid, pose: { plan: { x: 30, y: 40 }, planLocked: true } });
  await store.setLevelPlan(p.id, lid, new Blob([new Uint8Array(20)], { type: 'image/png' }), { width: 200, height: 80 });
  const h = await store.getItem(hand.id);
  assert.equal(h.pose.plan, null, 'not drawn at the lost image\'s pixels on the new one');
  assert.deepEqual(h.pose.enu, { e: 3, n: -4 }, 'placed again by the new calibration');
  assert.equal(h.pose.planPrev.x, 30);
  assert.equal(store.getLevel(await store.getProject(p.id), lid).planHistory.length, 1, 'the lost plan is not listed twice');
});

test('a URL scope released while a file is still being read makes no URL (nothing would revoke it)', async () => {
  const p = await store.createProject({ name: 'Scope' });
  const id = await store.putMedia(new Blob([new Uint8Array(64)], { type: 'image/jpeg' }), { kind: 'thumb', projectId: p.id });
  const made = [];
  const real = URL.createObjectURL;
  URL.createObjectURL = (b) => { const u = real(b); made.push(u); return u; };
  try {
    const scope = store.createUrlScope();
    const a = scope.url(id);
    const b = scope.url(id);
    scope.release();
    assert.deepEqual([await a, await b], [null, null]);
    assert.equal(made.length, 0);
    assert.equal(await scope.url(id), null, 'a released scope stays released');
    // Many asking at once: one read, one URL.
    const s2 = store.createUrlScope();
    const [u1, u2] = await Promise.all([s2.url(id), s2.url(id)]);
    assert.ok(u1);
    assert.equal(u1, u2);
    assert.equal(made.length, 1);
    assert.equal(await s2.url(id), u1);
    s2.release();
  } finally {
    URL.createObjectURL = real;
    for (const u of made) URL.revokeObjectURL(u);
  }
});

test('files of a job walk still being imported are left alone while the import runs', { skip: globalThis.navigator?.locks?.query ? false : 'no Web Locks in this Node' }, async () => {
  const mid = await store.putMedia(new Blob([new Uint8Array(20)], { type: 'image/jpeg' }), { kind: 'original', projectId: 'p_importing', itemId: 'i_importing' });
  const later = Date.now() + 11 * 60 * 1000;
  const inside = await store.withImportLock(async () => {
    const out = await store.recoverOrphans({ now: later });
    return { removed: out.mediaRemoved, kept: !!(await store.getMediaRecord(mid)) };
  });
  assert.deepEqual(inside, { removed: 0, kept: true });
  // The import died without writing its job walk: a later start cleans up.
  await store.recoverOrphans({ now: later });
  assert.equal(await store.getMediaRecord(mid), undefined);
});

test('recording chunk seqs are listed in order', async () => {
  const rec = await store.beginRecording({ projectId: 'p_y', levelId: 'l_y', mimeType: 'video/mp4' });
  for (const s of [2, 0, 1]) await store.putChunk(rec.recId, s, new Blob([String(s)], { type: 'video/mp4' }));
  assert.deepEqual(await store.getRecordingChunkSeqs(rec.recId), [0, 1, 2]);
  const chunks = await store.getRecordingChunks(rec.recId);
  assert.equal(chunks[0].type, 'video/mp4');
  assert.equal(chunks[2].seq, 2);
  await store.endRecording(rec.recId);
});
