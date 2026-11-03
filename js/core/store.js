// store.js — the job walk's records, on top of db.js.
//
// Every screen reads and writes through here, so the rules that keep
// pictures and notes safe live in one place:
//
//  1. Bytes first. A photo's bytes are written AND READ BACK (putMedia
//     verifies the size and that the bytes are readable) before the item
//     that points at them is created. An item never points at nothing.
//  2. Nothing is erased by a normal delete. Deleting a job walk, photo,
//     video or note moves it to Recently Deleted (deletedAt); only
//     purgeItem / purgeProject — reached from Recently Deleted, after a
//     confirmation — removes bytes.
//  3. The original photo is never modified. Markup is kept as shapes next to
//     it, with a separate flattened copy.
//  4. Each project counts its changes (changeSeq). A backup records the count
//     it covered, so the app can say "12 changes are not backed up yet".
//
// After every committed write the store emits 'store:change' on the bus
// ({kind, action, id, projectId}) and tells other open tabs of the app.

import * as db from './db.js';
import { bus } from './bus.js';
import { uid, todayISO } from './util.js';

export const SCHEMA = 1;

// ---- change events ---------------------------------------------------------------

let channel = null;
try {
  channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('dcr-jobwalk') : null;
  if (channel) channel.onmessage = (e) => bus.emit('store:change', { ...e.data, remote: true });
  channel?.unref?.(); // Node (tests): an open channel would keep the process alive
} catch { channel = null; }

function changed(kind, action, id, projectId) {
  const ev = { kind, action, id, projectId };
  bus.emit('store:change', ev);
  try { channel?.postMessage(ev); } catch { /* tab closing */ }
}

// ---- storage -------------------------------------------------------------------------

/** How much the app is using, how much the browser will allow, and whether storage is protected. */
export async function storageInfo() {
  const out = { usage: null, quota: null, persisted: null, canPersist: false };
  try {
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      out.usage = e.usage ?? null;
      out.quota = e.quota ?? null;
    }
    if (navigator.storage?.persisted) out.persisted = await navigator.storage.persisted();
    out.canPersist = !!navigator.storage?.persist;
  } catch { /* not supported */ }
  return out;
}

/**
 * Ask the browser to never clear this app's storage on its own (it would
 * otherwise be allowed to under storage pressure). Safe to call often.
 */
export async function requestPersist() {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return false; }
}

// ---- small values ------------------------------------------------------------------------

export async function getKV(key, fallback = null) {
  const rec = await db.get('kv', key);
  return rec ? rec.value : fallback;
}

export async function setKV(key, value) {
  await db.put('kv', { key, value });
}

// ---- media ---------------------------------------------------------------------------------
//
// A media record says what a file is; its bytes are in `parts` (db.js
// explains why bytes are never stored as Blobs). Saving is:
//   1. each part written in its own small transaction (iOS aborts long
//      transactions when it suspends the app), with the SHA-256 of its bytes;
//   2. the media record written last — so a media record always means
//      "all of its parts are there";
//   3. every part read back and its length and SHA-256 compared.
// Only then does putMedia resolve. A crash in step 1 leaves parts without a
// record; recoverOrphans() removes those at the next start.

async function writeParts(mediaId, blob) {
  const count = Math.max(1, Math.ceil(blob.size / db.PART_SIZE));
  const parts = [];
  for (let seq = 0; seq < count; seq++) {
    const buf = await blob.slice(seq * db.PART_SIZE, Math.min(blob.size, (seq + 1) * db.PART_SIZE)).arrayBuffer();
    const sha = await db.sha256(buf);
    await db.put('parts', { mediaId, seq, data: buf, size: buf.byteLength, sha, at: Date.now() });
    parts.push({ size: buf.byteLength, sha });
  }
  return parts;
}

async function deleteParts(mediaId) {
  await db.run(['parts'], 'readwrite', (tx) => { tx.objectStore('parts').delete(db.rangeFor(mediaId)); });
}

/**
 * Save bytes and prove they are saved. Resolves with the media id only after
 * every part is committed, read back and checked. Rejects (and the caller
 * must tell the user, keeping the data) otherwise.
 *
 * kind: 'original' | 'thumb' | 'annotated' | 'annotatedThumb' | 'poster' |
 *       'video' | 'voice' | 'plan' | 'planThumb'
 * meta: optional facts saved WITH the bytes (e.g. the photo's pose and level),
 *       so the photo can be rebuilt if the item record never got written.
 */
export async function putMedia(blob, { kind, projectId, itemId = null, name = '', meta = null, id = null } = {}) {
  if (!(blob instanceof Blob)) throw new Error('putMedia needs a Blob');
  if (!blob.size) throw new Error('That file is empty — nothing was saved.');
  const mediaId = id || uid('m_');
  const type = blob.type || '';
  let parts;
  try {
    parts = await writeParts(mediaId, blob);
    await db.put('media', {
      id: mediaId, projectId, itemId, kind, name, type, size: blob.size,
      partCount: parts.length, createdAt: Date.now(), meta: meta || null,
    });
    await verifyMedia(mediaId, blob.size, parts);
  } catch (err) {
    // Leave nothing half-written behind; the caller still has the bytes.
    try { await db.del('media', mediaId); await deleteParts(mediaId); } catch { /* best effort */ }
    throw err;
  }
  changed('media', 'create', mediaId, projectId);
  return mediaId;
}

/** Read a media file back part by part and check it holds exactly the bytes it should. */
export async function verifyMedia(id, expectedSize, expectedParts = null) {
  const rec = await db.get('media', id);
  if (!rec) throw new Error('The phone did not keep the file that was just saved. Try again; if it keeps happening, back up and free some space.');
  let total = 0;
  for (let seq = 0; seq < rec.partCount; seq++) {
    const part = await db.get('parts', [id, seq]);
    const buf = await db.bytesOf(part);
    if (!buf) throw new Error(`Part ${seq + 1} of the file that was just saved is missing. Try again.`);
    total += buf.byteLength;
    const want = expectedParts?.[seq]?.sha || part.sha;
    if (want && (await db.sha256(buf)) !== want) throw new Error('The file that was just saved did not read back the same. Try again; if it keeps happening, back up and restart the phone.');
  }
  if (total !== expectedSize) {
    throw new Error(`The phone kept ${total} of ${expectedSize} bytes of the file that was just saved. Try again; if it keeps happening, back up and free some space.`);
  }
  return true;
}

/** The file's bytes as a Blob (null when there is no such file). */
export async function getMediaBlob(id) {
  if (!id) return null;
  const rec = await db.get('media', id);
  if (!rec) return null;
  // Records are read from the store by key range, never through an index
  // (an iOS 18.4 bug killed Safari reading byte records through an index).
  const parts = await db.getAll('parts', db.rangeFor(id));
  if (parts.length !== rec.partCount) {
    console.error(`[store] media ${id} has ${parts.length} of ${rec.partCount} parts`);
    if (!parts.length) return null;
  }
  return db.blobFromRecords(parts, rec.type);
}

/** What a media file is (kind, type, size, meta) without reading its bytes. */
export async function getMediaRecord(id) {
  return id ? db.get('media', id) : null;
}

export async function listMediaForProject(projectId) {
  return db.getAllByIndex('media', 'projectId', projectId);
}

/** Hard delete of one media file. Only for bytes nothing points at anymore. */
export async function deleteMedia(id) {
  if (!id) return;
  const rec = await db.get('media', id);
  await db.run(['media', 'parts'], 'readwrite', (tx) => {
    tx.objectStore('media').delete(id);
    tx.objectStore('parts').delete(db.rangeFor(id));
  });
  changed('media', 'delete', id, rec?.projectId);
}

/**
 * Object URLs for media, released together. Each screen makes a scope and
 * calls release() when it closes, so the phone does not keep every photo
 * decoded in memory.
 */
export function createUrlScope() {
  const urls = new Map();
  return {
    async url(id) {
      if (!id) return null;
      if (urls.has(id)) return urls.get(id);
      const b = await getMediaBlob(id);
      if (!b) return null;
      const u = URL.createObjectURL(b);
      urls.set(id, u);
      return u;
    },
    release() {
      for (const u of urls.values()) URL.revokeObjectURL(u);
      urls.clear();
    },
  };
}

// ---- projects -----------------------------------------------------------------------------

export function newLevel(name = 'Level 1', order = 0) {
  return { id: uid('l_'), name, order, plan: null, planHistory: [], calibration: null };
}

export async function createProject(fields = {}) {
  const now = Date.now();
  const level = newLevel('Level 1', 0);
  const p = {
    id: uid('p_'),
    schema: SCHEMA,
    name: (fields.name || '').trim() || 'Job walk',
    address: fields.address || '',
    gc: fields.gc || '',
    number: fields.number || '',
    walkDate: fields.walkDate || todayISO(),
    notes: fields.notes || '',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    origin: null,
    compassOffset: null,
    compassAlignedAt: null,
    mapView: null,
    levels: [level],
    activeLevelId: level.id,
    nextSeq: 1,
    changeSeq: 1,
    backup: { lastAt: null, changeSeq: 0, fileName: '' },
    createdBy: fields.createdBy || '',
  };
  await db.put('projects', p);
  changed('project', 'create', p.id, p.id);
  return p;
}

export async function getProject(id) {
  return id ? db.get('projects', id) : null;
}

export async function listProjects() {
  const all = await db.getAll('projects');
  return all.filter((p) => !p.deletedAt).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listDeletedProjects() {
  const all = await db.getAll('projects');
  return all.filter((p) => p.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
}

/**
 * Change a project. `patch` is an object merged in, or a function that
 * mutates (or returns) the project. Read and write happen in one
 * transaction. Counts as a change for backup purposes unless
 * {quiet: true} (view state such as the last map position).
 */
export async function updateProject(id, patch, { quiet = false } = {}) {
  const p = await db.update('projects', id, (cur) => {
    if (!cur) throw new Error('That job walk no longer exists on this phone.');
    let next = cur;
    if (typeof patch === 'function') next = patch(cur) || cur;
    else Object.assign(next, patch);
    if (!quiet) {
      next.updatedAt = Date.now();
      next.changeSeq = (next.changeSeq || 0) + 1;
    }
    return next;
  });
  changed('project', 'update', id, id);
  return p;
}

/** Set the project's map origin once; later calls keep the first one (ENU coordinates depend on it). */
export async function setOriginOnce(id, { lat, lng }) {
  const p = await db.update('projects', id, (cur) => {
    if (!cur || cur.origin) return undefined;
    cur.origin = { lat, lng, setAt: Date.now() };
    return cur;
  });
  changed('project', 'update', id, id);
  return p;
}

export async function softDeleteProject(id) {
  return updateProject(id, (p) => { p.deletedAt = Date.now(); });
}

export async function restoreProject(id) {
  return updateProject(id, (p) => { p.deletedAt = null; });
}

/** Erase a job walk and every byte that belongs to it. Only from Recently Deleted. */
export async function purgeProject(id) {
  const itemKeys = await db.getKeysByIndex('items', 'projectId', id);
  const mediaKeys = await db.getKeysByIndex('media', 'projectId', id);
  await db.run(['projects', 'items', 'media', 'parts'], 'readwrite', (tx) => {
    const items = tx.objectStore('items');
    const media = tx.objectStore('media');
    const parts = tx.objectStore('parts');
    for (const k of itemKeys) items.delete(k);
    for (const k of mediaKeys) { media.delete(k); parts.delete(db.rangeFor(k)); }
    tx.objectStore('projects').delete(id);
  });
  changed('project', 'purge', id, id);
}

// ---- levels ---------------------------------------------------------------------------------

export function getLevel(project, levelId) {
  return project?.levels?.find((l) => l.id === levelId) || null;
}

export function activeLevel(project) {
  return getLevel(project, project?.activeLevelId) || project?.levels?.[0] || null;
}

export async function addLevel(projectId, name) {
  let made = null;
  await updateProject(projectId, (p) => {
    made = newLevel(name || `Level ${p.levels.length + 1}`, p.levels.length);
    p.levels.push(made);
    p.activeLevelId = made.id;
  });
  return made;
}

export async function updateLevel(projectId, levelId, patch) {
  return updateProject(projectId, (p) => {
    const l = getLevel(p, levelId);
    if (!l) throw new Error('That level no longer exists.');
    if (typeof patch === 'function') patch(l, p); else Object.assign(l, patch);
  });
}

export async function setActiveLevel(projectId, levelId) {
  return updateProject(projectId, { activeLevelId: levelId }, { quiet: true });
}

/** Remove a level. Refused while any photo, video or note (deleted ones included) is on it. */
export async function removeLevel(projectId, levelId) {
  const items = await db.getAllByIndex('items', 'projectId', projectId);
  if (items.some((i) => i.levelId === levelId)) {
    throw new Error('This level has photos, videos or notes on it. Move or delete them first.');
  }
  return updateProject(projectId, (p) => {
    if (p.levels.length <= 1) throw new Error('A job walk needs at least one level.');
    p.levels = p.levels.filter((l) => l.id !== levelId);
    p.levels.forEach((l, i) => { l.order = i; });
    if (p.activeLevelId === levelId) p.activeLevelId = p.levels[0].id;
  });
}

/**
 * Put a floor plan on a level. The image is saved (and verified) first; a
 * plan it replaces is kept in planHistory, never erased. A new plan image
 * clears the level's calibration (it was for the old image's pixels) — the
 * old calibration is kept in the history entry too.
 * meta: {width, height, source, fileName, page, thumbBlob?}
 */
export async function setLevelPlan(projectId, levelId, blob, meta) {
  const mediaId = await putMedia(blob, { kind: 'plan', projectId, name: meta.fileName || '' });
  let thumbId = null;
  if (meta.thumbBlob) thumbId = await putMedia(meta.thumbBlob, { kind: 'planThumb', projectId });
  return updateLevel(projectId, levelId, (l) => {
    if (l.plan) l.planHistory = [...(l.planHistory || []), { ...l.plan, calibration: l.calibration, replacedAt: Date.now() }];
    l.plan = {
      mediaId, thumbId, width: meta.width, height: meta.height,
      source: meta.source || 'image', fileName: meta.fileName || '', page: meta.page ?? null, addedAt: Date.now(),
    };
    l.calibration = null;
  });
}

export async function setCalibration(projectId, levelId, calibration) {
  return updateLevel(projectId, levelId, (l) => {
    if (l.calibration) l.calibrationHistory = [...(l.calibrationHistory || []), l.calibration].slice(-10);
    l.calibration = calibration;
  });
}

// ---- items ----------------------------------------------------------------------------------
//
// type: 'photo' | 'video' | 'note'. See docs/SPEC.md for every field.

export async function createItem(projectId, fields) {
  const now = Date.now();
  const item = {
    id: fields.id || uid('i_'),
    projectId,
    levelId: fields.levelId,
    type: fields.type,
    seq: 0,
    createdAt: fields.createdAt || now,
    updatedAt: now,
    deletedAt: null,
    title: '',
    text: '',
    tags: [],
    media: { original: null, thumb: null, annotated: null, annotatedThumb: null, poster: null },
    width: null,
    height: null,
    duration: null,
    mimeType: '',
    pose: null,
    track: null,
    annotations: null,
    voiceNotes: [],
    source: 'camera',
    capturedBy: '',
    ...fields,
  };
  item.media = { original: null, thumb: null, annotated: null, annotatedThumb: null, poster: null, ...(fields.media || {}) };
  await db.run(['projects', 'items'], 'readwrite', (tx, box, fail) => {
    const ps = tx.objectStore('projects');
    ps.get(projectId).onsuccess = (e) => {
      const p = e.target.result;
      if (!p) { fail(new Error('That job walk no longer exists on this phone.')); return; }
      item.seq = p.nextSeq || 1;
      p.nextSeq = item.seq + 1;
      p.changeSeq = (p.changeSeq || 0) + 1;
      p.updatedAt = now;
      ps.put(p);
      tx.objectStore('items').put(item);
      box.value = item;
    };
  });
  changed('item', 'create', item.id, projectId);
  return item;
}

export async function getItem(id) {
  return id ? db.get('items', id) : null;
}

/** A project's items, oldest first. Deleted ones only with {includeDeleted: true}. */
export async function listItems(projectId, { includeDeleted = false } = {}) {
  const all = await db.getAllByIndex('items', 'projectId', projectId);
  return all.filter((i) => includeDeleted || !i.deletedAt).sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
}

/** Change an item (patch object or mutating function), in one transaction with the project's change count. */
export async function updateItem(id, patch, { quiet = false } = {}) {
  const item = await db.run(['projects', 'items'], 'readwrite', (tx, box, fail) => {
    const is = tx.objectStore('items');
    is.get(id).onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) { fail(new Error('That photo or note no longer exists on this phone.')); return; }
      let next = cur;
      try {
        if (typeof patch === 'function') next = patch(cur) || cur;
        else Object.assign(next, patch);
      } catch (err) { fail(err); return; }
      next.updatedAt = Date.now();
      is.put(next);
      box.value = next;
      if (quiet) return;
      const ps = tx.objectStore('projects');
      ps.get(next.projectId).onsuccess = (e2) => {
        const p = e2.target.result;
        if (!p) return;
        p.changeSeq = (p.changeSeq || 0) + 1;
        p.updatedAt = next.updatedAt;
        ps.put(p);
      };
    };
  });
  changed('item', 'update', id, item.projectId);
  return item;
}

export async function softDeleteItem(id) {
  return updateItem(id, (i) => { i.deletedAt = Date.now(); });
}

export async function restoreItem(id) {
  return updateItem(id, (i) => { i.deletedAt = null; });
}

/** Erase an item and its bytes. Only from Recently Deleted. */
export async function purgeItem(id) {
  const item = await db.get('items', id);
  if (!item) return;
  const mediaKeys = await db.getKeysByIndex('media', 'itemId', id);
  await db.run(['items', 'media', 'parts', 'projects'], 'readwrite', (tx) => {
    const media = tx.objectStore('media');
    const parts = tx.objectStore('parts');
    for (const k of mediaKeys) { media.delete(k); parts.delete(db.rangeFor(k)); }
    tx.objectStore('items').delete(id);
    const ps = tx.objectStore('projects');
    ps.get(item.projectId).onsuccess = (e) => {
      const p = e.target.result;
      if (p) { p.changeSeq = (p.changeSeq || 0) + 1; ps.put(p); }
    };
  });
  changed('item', 'purge', id, item.projectId);
}

/** Everything in Recently Deleted: whole job walks, and items deleted from job walks that still exist. */
export async function listTrash() {
  const projects = await db.getAll('projects');
  const items = await db.getAll('items');
  const live = new Map(projects.filter((p) => !p.deletedAt).map((p) => [p.id, p]));
  return {
    projects: projects.filter((p) => p.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt),
    items: items.filter((i) => i.deletedAt && live.has(i.projectId))
      .map((i) => ({ ...i, projectName: live.get(i.projectId).name }))
      .sort((a, b) => b.deletedAt - a.deletedAt),
  };
}

// ---- backups --------------------------------------------------------------------------------

/** Remember that a backup covered the project up to `changeSeq` (read when the export started). */
export async function markBackedUp(projectId, { changeSeq, fileName = '' }) {
  return updateProject(projectId, (p) => {
    p.backup = { lastAt: Date.now(), changeSeq, fileName };
  }, { quiet: true });
}

/** {needed, lastAt}: whether anything changed since the last backup. */
export function backupState(project) {
  const covered = project?.backup?.changeSeq || 0;
  const now = project?.changeSeq || 0;
  return { needed: now > covered, lastAt: project?.backup?.lastAt || null, changesSince: Math.max(0, now - covered) };
}

// ---- video write-ahead -----------------------------------------------------------------
//
// A video is written to the phone a second at a time while it records
// (chunks), with its path (track) saved every few seconds. If the app is
// killed mid-recording, the next launch finds the recording and rebuilds the
// video from its chunks (js/core/recorder.js recoverRecordings).

export async function beginRecording(meta) {
  const rec = { recId: meta.recId || uid('r_'), startedAt: Date.now(), chunkCount: 0, track: [], ...meta };
  await db.put('recordings', rec);
  return rec;
}

/** Save one piece of a recording (bytes, not a Blob — see db.js). Resolves once it is on disk. */
export async function putChunk(recId, seq, blob) {
  const data = await blob.arrayBuffer();
  await db.put('chunks', { recId, seq, data, size: data.byteLength, type: blob.type || '', at: Date.now() });
}

export async function updateRecording(recId, patch) {
  return db.update('recordings', recId, (cur) => {
    if (!cur) return undefined;
    return typeof patch === 'function' ? (patch(cur) || cur) : Object.assign(cur, patch);
  });
}

export async function listRecordings() {
  return db.getAll('recordings');
}

/** The chunks of a recording, in seq order, as Blobs. Each Blob also carries `.seq`. */
export async function getRecordingChunks(recId) {
  const rows = await db.getAll('chunks', db.rangeFor(recId));
  return rows.sort((a, b) => a.seq - b.seq).map((r) => {
    const b = new Blob([r.data ?? r.blob], { type: r.type || '' });
    try { Object.defineProperty(b, 'seq', { value: r.seq }); } catch { /* frozen */ }
    return b;
  });
}

/** The seq numbers saved for a recording (cheap: keys only). */
export async function getRecordingChunkSeqs(recId) {
  const keys = await db.getAllKeys('chunks', db.rangeFor(recId));
  return keys.map((k) => k[1]).sort((a, b) => a - b);
}

/** Drop a recording's chunks and row — only after its video is saved and verified as media. */
export async function endRecording(recId) {
  await db.run(['chunks', 'recordings'], 'readwrite', (tx) => {
    tx.objectStore('chunks').delete(db.rangeFor(recId));
    tx.objectStore('recordings').delete(recId);
  });
}

// ---- import -------------------------------------------------------------------------------------

/**
 * Write a whole project from an imported package in one go: records only
 * (media must already have been saved with putMediaWithId). Used by
 * js/core/package.js.
 */
export async function putProjectRecords(project, items) {
  await db.run(['projects', 'items'], 'readwrite', (tx) => {
    tx.objectStore('projects').put(project);
    const is = tx.objectStore('items');
    for (const i of items) is.put(i);
  });
  changed('project', 'import', project.id, project.id);
}

/** Save bytes under a given id (package import keeps ids stable). Verified like putMedia. */
export async function putMediaWithId(id, blob, { kind, projectId, itemId = null, name = '', meta = null } = {}) {
  if (!blob?.size) throw new Error('An empty file cannot be imported.');
  return putMedia(blob, { id, kind, projectId, itemId, name, meta });
}

// ---- recovery --------------------------------------------------------------------------------
//
// Run once at start (main.js), after videos are recovered:
//  - parts left by a save that never finished (no media record, older than
//    10 minutes) are removed — the photo they belonged to was never
//    reported as saved;
//  - a photo or video whose bytes were saved but whose item was never
//    written (the app died in between) becomes a "Recovered" item, using
//    the facts saved with its bytes (meta), so it shows up again.

const RECOVER_AFTER_MS = 10 * 60 * 1000;

export async function recoverOrphans({ now = Date.now() } = {}) {
  const out = { partsRemoved: 0, items: [] };
  const media = await db.getAll('media');
  const known = new Set(media.map((m) => m.id));
  const partKeys = await db.getAllKeys('parts');
  const strays = [...new Set(partKeys.filter((k) => !known.has(k[0])).map((k) => k[0]))];
  for (const mediaId of strays) {
    const first = await db.get('parts', [mediaId, 0]);
    if (first && now - (first.at || 0) < RECOVER_AFTER_MS) continue;
    await deleteParts(mediaId);
    out.partsRemoved++;
  }

  const items = await db.getAll('items');
  const referenced = new Set();
  const itemIds = new Set(items.map((i) => i.id));
  for (const i of items) {
    for (const v of Object.values(i.media || {})) if (v) referenced.add(v);
    for (const v of i.voiceNotes || []) referenced.add(v.mediaId);
    for (const v of i.removedVoiceNotes || []) referenced.add(v.mediaId);
    for (const h of i.annotationHistory || []) { referenced.add(h.mediaId); referenced.add(h.thumbId); }
  }
  const projects = new Map((await db.getAll('projects')).map((p) => [p.id, p]));
  // Bytes of a job walk that was never created (an import the phone killed
  // midway): nothing can point at them, and the .zip still has them.
  out.mediaRemoved = 0;
  for (const m of media) {
    if (projects.has(m.projectId) || now - (m.createdAt || 0) < RECOVER_AFTER_MS) continue;
    await deleteMedia(m.id);
    out.mediaRemoved++;
  }
  for (const m of media) {
    if (m.kind !== 'original' && m.kind !== 'video') continue;
    if (referenced.has(m.id) || now - (m.createdAt || 0) < RECOVER_AFTER_MS) continue;
    if (m.itemId && itemIds.has(m.itemId)) continue;
    const p = projects.get(m.projectId);
    if (!p) continue;
    const meta = m.meta || {};
    const levelId = p.levels.some((l) => l.id === meta.levelId) ? meta.levelId : (p.activeLevelId || p.levels[0]?.id);
    const fields = {
      type: m.kind === 'video' ? 'video' : 'photo',
      levelId,
      createdAt: meta.createdAt || m.createdAt,
      media: { original: m.id },
      width: meta.width ?? null,
      height: meta.height ?? null,
      duration: meta.duration ?? null,
      mimeType: m.type,
      pose: meta.pose ?? null,
      track: meta.track ?? null,
      source: 'recovered',
      title: m.kind === 'video' ? 'Recovered video' : 'Recovered photo',
      capturedBy: meta.capturedBy || '',
    };
    if (m.itemId && !itemIds.has(m.itemId)) fields.id = m.itemId;
    const item = await createItem(p.id, fields);
    await db.update('media', m.id, (rec) => { if (rec) rec.itemId = item.id; return rec; });
    itemIds.add(item.id);
    out.items.push(item);
  }
  return out;
}
