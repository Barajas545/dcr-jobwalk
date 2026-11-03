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

test('recording chunk seqs are listed in order', async () => {
  const rec = await store.beginRecording({ projectId: 'p_y', levelId: 'l_y', mimeType: 'video/mp4' });
  for (const s of [2, 0, 1]) await store.putChunk(rec.recId, s, new Blob([String(s)], { type: 'video/mp4' }));
  assert.deepEqual(await store.getRecordingChunkSeqs(rec.recId), [0, 1, 2]);
  const chunks = await store.getRecordingChunks(rec.recId);
  assert.equal(chunks[0].type, 'video/mp4');
  assert.equal(chunks[2].seq, 2);
  await store.endRecording(rec.recId);
});
