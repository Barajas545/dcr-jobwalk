// export-screen.js — Back up & share (route p/:pid/export).
//
// The one place a job walk leaves the phone, so it is built around the
// owner's rule, "It is important not to lose any pictures or notes":
//
//  - The backup status is the first thing on the page: never backed up,
//    N changes since the last backup, or backed up ✓.
//  - "Save backup" makes ONE .zip with everything (js/core/package.js) and
//    then hands it over. The job walk is marked backed up only once the file
//    was saved or shared, or the person says a download arrived (a download
//    is only STARTED: iPhone asks first, and the person can say no) — never
//    when the person cancels or the browser refused (it wanted a fresh tap)
//    — and with the change count read when the export STARTED, so a photo
//    taken meanwhile still shows as not backed up. A copy without videos is
//    a shared copy and is never counted as a backup.
//  - How it is handed over depends on the browser (docs/RESEARCH.md,
//    "Storage durability"):
//      iPhone / iPad / Mac Safari   the share sheet (Save to Files, OneDrive,
//                                   Drive, Mail) — WebKit takes any file;
//      Chrome / Edge                "Save to…" (showSaveFilePicker): written
//                                   straight to a file the person picks and
//                                   read back, no size limit. Chrome's share
//                                   sheet refuses .zip files, so it is not
//                                   offered there;
//      everything else              a download.
//    The share sheet and the file picker only open from a tap (the browser
//    refuses them a few seconds after one), and making the zip uses that
//    time up, so a "Backup ready" sheet asks for one more tap.
//  - WebKit reads a shared file into memory whole, so for big backups the
//    page says so and puts Download first.
//  - "Photos only" is a convenience copy (JPEGs and a spreadsheet); it is not
//    a backup and never marks one.

import { el, iconButton, toast, alertDialog, confirmDialog, busy, saveBlob, releaseDownloads, openSheet } from './shell.js';
import { icon } from './icons.js';
import * as store from '../core/store.js';
import { exportProject, exportPhotos, estimateExport, SHARE_SHEET_COMFORT_BYTES } from '../core/package.js';
import { formatBytes, formatDateTime, debounce, isIOS } from '../core/util.js';
import { APP_VERSION } from '../version.js';

const PREF_VIDEOS = 'jw.export.includeVideos';
const PREF_MARKUP = 'jw.export.photosWithMarkup';
/** Past about this, an iPhone may not have the memory to build the zip at all (bytes are held as ArrayBuffers). */
const IOS_MEMORY_RISK_BYTES = 1.5 * 1024 ** 3;

function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function writePref(key, on) {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* private browsing: not remembered */ }
}

/**
 * The share sheet takes a .zip only in WebKit (every browser on iPhone and
 * iPad, and Safari on a Mac). Chrome says it can (canShare is true) and then
 * refuses .zip files, so it is not offered there.
 */
function canShareZip() {
  try {
    if (!navigator.canShare?.({ files: [new File(['x'], 'backup.zip', { type: 'application/zip' })] })) return false;
  } catch {
    return false;
  }
  const ua = navigator.userAgent || '';
  return isIOS() || (/Safari\//.test(ua) && !/(Chrome|Chromium|CriOS|Edg|OPR|Android|Firefox|FxiOS)/.test(ua));
}

/** Chrome and Edge (desktop; Android from 132): write straight to a file the person picks. */
function canPickFile() {
  try {
    return typeof window.showSaveFilePicker === 'function' && window.isSecureContext !== false && window.self === window.top;
  } catch {
    return false;
  }
}

/**
 * Write a Blob to a file the person picks, then read the file's size back.
 * Resolves 'saved' or 'cancelled'. onProgress(fraction).
 */
async function saveToPickedFile(blob, fileName, { onProgress, signal } = {}) {
  let handle;
  try {
    handle = await window.showSaveFilePicker({
      suggestedName: fileName,
      types: [{ description: 'Zip file', accept: { 'application/zip': ['.zip'] } }],
    });
  } catch (err) {
    if (err?.name === 'AbortError') return 'cancelled';
    throw err;
  }
  const writable = await handle.createWritable();
  let done = 0;
  const counter = new TransformStream({
    transform(chunk, ctl) {
      done += chunk.byteLength;
      onProgress?.(blob.size ? done / blob.size : 1);
      ctl.enqueue(chunk);
    },
  });
  try {
    // pipeTo closes the file when every byte is written, or aborts it (nothing kept) on failure.
    await blob.stream().pipeThrough(counter).pipeTo(writable, { signal });
  } catch (err) {
    try { await writable.abort(); } catch { /* already closed */ }
    throw err;
  }
  const written = await handle.getFile();
  if (written.size !== blob.size) {
    throw new Error(`Only ${formatBytes(written.size)} of ${formatBytes(blob.size)} reached the file. Try again, or choose Download.`);
  }
  return 'saved';
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Open the screen. ctx: see docs/SPEC.md §3.
 * @returns {Promise<() => void>} cleanup
 */
export async function open(ctx) {
  const { root, params, back, setGuard, isCurrent, app } = ctx;
  const pid = params.pid;
  let project = await store.getProject(pid);
  if (!project) {
    const err = new Error('That job walk is not on this phone.');
    err.notFound = true;
    throw err;
  }

  const ways = { share: canShareZip(), pick: canPickFile(), ios: isIOS() };
  let includeVideos = readPref(PREF_VIDEOS, true);
  let withMarkup = readPref(PREF_MARKUP, true);
  let estimate = null;
  let estimateError = null;
  let running = null;        // a zip being made, or a file being written: {ac, b}
  let sheet = null;          // the "ready" sheet
  let lastBuilt = null;      // the last zip made here, reused while nothing has changed
  let tapToast = null;       // "tap again" after the browser refused a save
  let closed = false;

  // ---- layout ------------------------------------------------------------------------------

  const sub = el('div', { class: 'sub' }, project.name);
  root.append(el('header', { class: 'topbar' },
    iconButton('back', { title: 'Back', onclick: () => back(`p/${pid}`) }),
    el('div', { class: 'topbar-title' }, el('h1', {}, 'Back up & share'), sub)));
  const body = el('div', { class: 'screen-body narrow export-screen' });
  root.append(body);

  const statusEl = el('div', { class: 'ex-status', 'aria-live': 'polite' });

  const countsEl = el('div', { class: 'ex-counts' });
  const sizeEl = el('div', { class: 'ex-size' });
  const videosSwitch = el('input', { type: 'checkbox', role: 'switch', 'aria-label': 'Include videos' });
  videosSwitch.checked = includeVideos;
  const videosDetail = el('span', { class: 'ex-switch-detail' });
  const videosRow = el('label', { class: 'switch ex-switch' },
    el('span', { class: 'ex-switch-text' }, el('span', { class: 'ex-switch-label' }, 'Include videos'), videosDetail), videosSwitch);
  const bigWarn = el('div', { class: 'banner warn ex-warn', hidden: true });
  const noVideosWarn = el('div', { class: 'banner warn ex-warn', hidden: true },
    el('span', { html: icon('warning', { size: 18 }) }),
    el('span', {}, 'Without videos this is a smaller copy to share, not a full backup — the job walk will still show changes not backed up.'));
  const saveBtn = el('button', { type: 'button', class: 'btn btn-primary btn-lg btn-block', onclick: () => runBackup() },
    el('span', { html: icon(ways.share ? 'share' : 'download', { size: 20 }) }), el('span', {}, 'Save backup (.zip)'));
  const saveHint = el('p', { class: 'ex-hint muted small' });
  const deletedNote = el('p', { class: 'ex-hint muted small', hidden: true });

  const backupCard = el('section', { class: 'card ex-card', 'aria-labelledby': 'ex-backup-h' },
    el('h2', { id: 'ex-backup-h' }, el('span', { class: 'ex-ic', html: icon('archive', { size: 20 }) }), 'Back up & share this job walk'),
    el('p', {}, 'One .zip with everything: the floor plans, every photo (original and marked up), videos, notes, voice notes and where each was taken. It opens in any browser and imports back into DCR Job Walk.'),
    countsEl, sizeEl, videosRow, noVideosWarn, bigWarn,
    el('div', { class: 'ex-actions' }, saveBtn),
    saveHint, deletedNote);

  const markupSwitch = el('input', { type: 'checkbox', role: 'switch', 'aria-label': 'With markup' });
  markupSwitch.checked = withMarkup;
  const markupDetail = el('span', { class: 'ex-switch-detail' });
  const photosBtn = el('button', { type: 'button', class: 'btn btn-block', onclick: () => runPhotos() },
    el('span', { html: icon('image', { size: 20 }) }), el('span', {}, 'Save photos (.zip)'));
  const photosNote = el('p', { class: 'ex-hint muted small', hidden: true }, 'There are no photos in this job walk yet.');
  const photosCard = el('section', { class: 'card ex-card', 'aria-labelledby': 'ex-photos-h' },
    el('h2', { id: 'ex-photos-h' }, el('span', { class: 'ex-ic', html: icon('image', { size: 20 }) }), 'Photos only'),
    el('p', {}, 'Just the photos as JPEG files, named by number, level and tag — like “012 - Level 1 - Walls - 2026-11-02 10.32.jpg” — plus photos.csv, a spreadsheet of when and where each was taken. Handy for an email or a folder; it is not a backup.'),
    el('label', { class: 'switch ex-switch' },
      el('span', { class: 'ex-switch-text' }, el('span', { class: 'ex-switch-label' }, 'With markup'), markupDetail), markupSwitch),
    photosBtn, photosNote);

  const helpCard = el('section', { class: 'card ex-card ex-help', 'aria-labelledby': 'ex-help-h' },
    el('h2', { id: 'ex-help-h' }, el('span', { class: 'ex-ic', html: icon('info', { size: 20 }) }), 'View it on a computer or online'),
    el('ol', {},
      el('li', {}, el('b', {}, 'Unzip the backup. '), 'Windows: right-click it → Extract All. Mac: double-click it.'),
      el('li', {}, el('b', {}, 'Open index.html '), 'in Chrome, Edge, Safari or Firefox: every plan with its pins, the photos, notes, voice notes and video paths, and Print report.'),
      el('li', {}, el('b', {}, 'To share it as a web page, '), 'upload the whole unzipped folder to a website that hosts plain pages, such as GitHub Pages or Netlify. SharePoint, OneDrive and Google Drive only preview or download web pages — the viewer does not run there.'),
      el('li', {}, el('b', {}, 'To keep working on it '), 'on another phone or PC: open DCR Job Walk there, tap Import a job walk and pick the .zip (do not unzip it). Nothing there is overwritten.')),
    el('p', { class: 'muted small' }, 'On an iPhone, the Files app shows web pages without running them. Look at the unzipped folder on a computer, or import the .zip into DCR Job Walk.'));

  body.append(statusEl, backupCard, photosCard, helpCard, el('p', { class: 'ex-foot faint small' }, `DCR Job Walk ${APP_VERSION}`));

  // ---- rendering --------------------------------------------------------------------------

  function renderStatus() {
    const st = store.backupState(project);
    let cls;
    let head;
    let detail;
    if (!st.lastAt) {
      cls = 'warn';
      head = 'Not backed up yet';
      detail = 'Until it is, this job walk lives only on this phone. Save a backup after every walk.';
    } else if (st.needed) {
      cls = 'warn';
      head = `${plural(st.changesSince, 'change')} not backed up`;
      detail = `Last backup ${formatDateTime(st.lastAt)}${project.backup?.fileName ? ` — ${project.backup.fileName}` : ''}.`;
    } else {
      cls = 'ok';
      head = 'Backed up ✓';
      detail = `Last backup ${formatDateTime(st.lastAt)}. Nothing has changed since.`;
    }
    statusEl.replaceChildren(el('div', { class: `banner ${cls}` },
      el('span', { html: icon(cls === 'ok' ? 'shield' : 'warning', { size: 20 }) }),
      el('div', {}, el('b', { class: 'ex-status-head' }, head), el('div', { class: 'small' }, detail))));
  }

  const backupBytes = () => (estimate ? (includeVideos ? estimate.bytes.total : estimate.bytes.withoutVideos) : 0);

  function renderEstimate() {
    const settings = app.getSettings();
    if (estimateError) {
      countsEl.replaceChildren();
      sizeEl.replaceChildren(el('span', { class: 'muted' }, `The size could not be worked out (${estimateError}). You can still save the backup.`));
    } else if (!estimate) {
      countsEl.replaceChildren();
      sizeEl.replaceChildren(el('span', { class: 'muted' }, 'Working out the size…'));
    } else {
      const c = estimate.counts;
      const tile = (n, one, many) => el('div', { class: 'ex-count' }, el('b', {}, String(n)), el('span', {}, n === 1 ? one : many));
      countsEl.replaceChildren(
        tile(c.photos, 'photo', 'photos'), tile(c.videos, 'video', 'videos'), tile(c.notes, 'note', 'notes'),
        tile(c.voice, 'voice note', 'voice notes'), tile(c.plans, 'plan', 'plans'));
      sizeEl.replaceChildren(el('span', {}, 'Size'), el('b', {}, `about ${formatBytes(backupBytes())}`));
      // A video the app has not finished saving is in the backup as its pieces, so it counts here too.
      const vids = c.videos + (c.unsavedVideos || 0);
      videosDetail.textContent = vids
        ? `${plural(vids, 'video')}${c.unsavedVideos ? ` (${c.unsavedVideos} not finished saving)` : ''} · ${formatBytes(estimate.bytes.videos)}`
        : 'No videos in this job walk';
      deletedNote.hidden = !c.deleted;
      deletedNote.textContent = c.deleted
        ? `Also holds the ${plural(c.deleted, 'item')} in Recently Deleted, so restoring the backup loses nothing. The viewer does not show ${c.deleted === 1 ? 'it' : 'them'}.`
        : '';
      photosBtn.disabled = !c.photos;
      photosNote.hidden = !!c.photos;
    }
    const anyVideos = !!(estimate?.counts.videos || estimate?.counts.unsavedVideos);
    videosSwitch.disabled = !!estimate && !anyVideos;
    noVideosWarn.hidden = includeVideos || !anyVideos;
    markupDetail.textContent = !withMarkup
      ? 'The untouched original photos'
      : settings.stampExports ? 'Markup drawn in, with the date and position strip' : 'Markup drawn in (the date stamp is off in Settings)';

    const bytes = backupBytes();
    const shareBig = ways.share && bytes > SHARE_SHEET_COMFORT_BYTES;
    const memoryRisk = ways.ios && bytes > IOS_MEMORY_RISK_BYTES;
    bigWarn.hidden = !shareBig && !memoryRisk;
    if (!bigWarn.hidden) {
      const parts = [`This backup is about ${formatBytes(bytes)}.`];
      if (shareBig) parts.push('The share sheet can fail with a file this big, so choose Download on the next step, then move the file from Files › Downloads to OneDrive, Google Drive or a computer.');
      if (memoryRisk) parts.push('A backup this big may not fit in the phone’s memory. If it fails, turn off “Include videos” to back up the photos and notes first.');
      bigWarn.replaceChildren(el('span', { html: icon('warning', { size: 18 }) }), el('span', {}, parts.join(' ')));
    }
    saveHint.textContent = ways.share
      ? 'Next, pick Save to Files, OneDrive, Google Drive or Mail. Once it is saved, the job walk shows as backed up.'
      : ways.pick
        ? 'Next, pick where to keep it: a folder, Google Drive, OneDrive or a USB drive. Once it is saved, the job walk shows as backed up.'
        : 'The .zip goes to your Downloads folder. Keep it somewhere safe (OneDrive, a server, a USB drive).';
  }

  function render() {
    sub.textContent = project.name;
    renderStatus();
    renderEstimate();
  }

  async function refresh() {
    try {
      const [p, est] = await Promise.all([store.getProject(pid), estimateExport(pid)]);
      if (closed || !isCurrent()) return;
      if (!p) {
        body.replaceChildren(el('div', { class: 'empty' }, el('h2', {}, 'This job walk is no longer on this phone.'), el('p', {}, 'Look in Recently Deleted.')));
        return;
      }
      project = p;
      estimate = est;
      estimateError = null;
    } catch (err) {
      if (closed) return;
      console.warn('[export] estimate failed', err);
      estimateError = err.message || String(err);
    }
    render();
  }

  const refreshSoon = debounce(() => { if (!running) refresh(); }, 600);
  const offChange = app.bus.on('store:change', (ev) => { if (ev.projectId === pid || ev.id === pid) refreshSoon(); });

  videosSwitch.addEventListener('change', () => {
    includeVideos = videosSwitch.checked;
    writePref(PREF_VIDEOS, includeVideos);
    renderEstimate();
  });
  markupSwitch.addEventListener('change', () => {
    withMarkup = markupSwitch.checked;
    writePref(PREF_MARKUP, withMarkup);
    renderEstimate();
  });

  // ---- making the zip -----------------------------------------------------------------------

  /** The last zip made here, when nothing has changed since and it was made the same way. */
  async function reusable(kind, options) {
    if (!lastBuilt || lastBuilt.kind !== kind || lastBuilt.options !== options) return null;
    const p = await store.getProject(pid);
    return p && p.changeSeq === lastBuilt.changeSeq ? lastBuilt : null;
  }

  async function make(kind, run, options) {
    if (running) return null;
    running = {}; // claimed at once, so a second quick tap does not start a second zip
    const ac = new AbortController();
    let b = null;
    try {
      const cached = await reusable(kind, options);
      if (cached) return cached;
      const startSeq = (await store.getProject(pid))?.changeSeq ?? null;
      b = busy(kind === 'backup' ? 'Getting the backup ready…' : 'Getting the photos ready…', {
        cancellable: true,
        onCancel: () => { b.update('Stopping…'); ac.abort(); },
      });
      running = { ac, b };
      if (closed) ac.abort();
      const res = await run({ signal: ac.signal, onProgress: (p) => b.update(p.message, p.fraction) });
      lastBuilt = { ...res, kind, options, changeSeq: res.changeSeq ?? startSeq };
      return lastBuilt;
    } catch (err) {
      // The busy overlay sits above dialogs, so it goes first.
      b?.done();
      b = null;
      running = null;
      if (err?.name === 'AbortError') {
        if (!closed) toast(kind === 'backup' ? 'Backup cancelled. Nothing was changed.' : 'Cancelled.', { type: 'info' });
        return null;
      }
      console.error(`[export] ${kind} failed`, err);
      if (!closed) {
        await alertDialog({
          title: kind === 'backup' ? 'The backup could not be made' : 'The photos could not be saved',
          message: `${err.message || err}\n\nYour photos and notes are still safe on this phone. Try again${kind === 'backup' && includeVideos ? '; if it keeps failing, turn off “Include videos” to make a smaller copy, or free some space on the phone' : ''}.`,
        });
      }
      return null;
    } finally {
      b?.done();
      running = null;
    }
  }

  async function runBackup() {
    const built = await make('backup',
      ({ signal, onProgress }) => exportProject(pid, { includeVideos, onProgress, signal }),
      includeVideos ? 'with-videos' : 'no-videos');
    if (!built || closed || !isCurrent()) return;
    for (const w of built.warnings || []) toast(w, { type: 'warn', ms: 10000 });
    deliver(built);
  }

  async function runPhotos() {
    const built = await make('photos',
      ({ signal, onProgress }) => exportPhotos(pid, { annotated: withMarkup, onProgress, signal }),
      withMarkup ? 'markup' : 'originals');
    if (!built || closed || !isCurrent()) return;
    for (const w of built.warnings || []) toast(w, { type: 'warn', ms: 10000 });
    deliver(built);
  }

  // ---- handing it over ------------------------------------------------------------------------

  /**
   * Download straight away when that is the only way; otherwise the "ready"
   * sheet, whose buttons open the share sheet or the file picker from the tap.
   */
  function deliver(built) {
    if (!ways.share && !ways.pick) {
      save(built, 'download');
      return;
    }
    sheet?.close(true);
    let saved = false;
    const big = built.blob.size > SHARE_SHEET_COMFORT_BYTES;
    const s = openSheet({
      title: built.kind === 'backup' ? (built.complete ? 'Backup ready' : 'Copy ready (without videos)') : 'Photos ready',
      onClose: () => {
        if (!saved && built.kind === 'backup' && !closed) toast('The backup was not saved yet. Tap Save backup when you are ready.', { type: 'warn' });
      },
    });
    sheet = s;
    const go = async (how) => {
      const outcome = await save(built, how, () => go(how));
      if (outcome === 'saved' || outcome === 'shared' || outcome === 'downloaded') {
        saved = true;
        s.close(true);
        if (sheet === s) sheet = null;
      }
    };
    const option = (how, primary) => {
      const spec = {
        pick: ['download', 'Save to…', 'Choose a folder, Google Drive, OneDrive or a USB drive'],
        share: ['share', big ? 'Share anyway' : 'Save or share…', 'Save to Files, OneDrive, Google Drive, Mail…'],
        download: ['download', 'Download', ways.ios ? 'To Files › Downloads' : 'To your Downloads folder'],
      }[how];
      return el('button', { type: 'button', class: `btn ${primary ? 'btn-primary btn-lg' : 'btn-outline'} btn-block ex-way`, onclick: () => go(how) },
        el('span', { html: icon(spec[0], { size: 20 }) }),
        el('span', { class: 'ex-way-text' }, el('span', {}, spec[1]), el('span', { class: 'ex-way-detail' }, spec[2])));
    };
    // The best way first: the file picker (a checked write), else the share
    // sheet — unless the file is too big for it, then Download first.
    const order = ways.pick ? ['pick', 'download'] : big ? ['download', 'share'] : ['share', 'download'];
    const buttons = order.map((how, i) => option(how, i === 0));
    s.body.append(
      el('div', { class: 'ex-ready' },
        el('span', { class: 'ex-ready-ic', html: icon('file', { size: 28 }) }),
        el('div', { class: 'grow' }, el('div', { class: 'ex-ready-name' }, built.fileName), el('div', { class: 'muted small' }, formatBytes(built.blob.size)))),
      big && ways.share && !ways.pick ? el('div', { class: 'banner warn ex-warn' }, el('span', { html: icon('warning', { size: 18 }) }),
        el('span', {}, 'This file is big. The share sheet can fail with files this size — Download is safer.')) : null,
      el('div', { class: 'ex-actions' }, ...buttons),
      el('p', { class: 'ex-hint muted small' }, built.kind === 'backup'
        ? (built.complete ? 'The job walk shows as backed up once the file is saved.' : 'This copy has no videos, so it does not count as a backup.')
        : 'Pick where the photos should go.'));
    requestAnimationFrame(() => buttons[0].focus());
  }

  /**
   * Save one way ('pick' | 'share' | 'download'). A full backup is marked as
   * backed up when the file was saved or shared, or once the person says a
   * download arrived. → the outcome, or null when nothing was saved (the zip
   * is kept, so another way can be tried). `again` repeats this save from a
   * new tap, for when the browser refused this one.
   */
  async function save(built, how, again = null) {
    tapToast?.close();
    tapToast = null;
    let outcome;
    try {
      if (how === 'pick') outcome = await writePicked(built);
      else outcome = await saveBlob(built.blob, built.fileName, { preferShare: how === 'share', title: project.name });
    } catch (err) {
      console.error('[export] save failed', err);
      if (!closed) toast(`The file could not be saved: ${err.message || err}. Try Download.`, { type: 'err' });
      return null;
    }
    if (outcome === 'cancelled') {
      if (!closed) toast('Not saved yet. Pick where to save it, or tap Download.', { type: 'info' });
      return outcome;
    }
    if (outcome !== 'saved' && outcome !== 'shared' && outcome !== 'downloaded') {
      // 'needs-tap': the browser wanted a fresh tap (iPhone: the share sheet
      // refused the first try; Chrome: too long since the tap). No file
      // exists, so nothing is marked and the Ready sheet stays open.
      if (!closed) {
        tapToast = toast('The phone did not open the save screen, so nothing is saved yet. Tap Save to try again.', {
          type: 'warn', ms: 0, action: { label: 'Save', onclick: again || (() => save(built, how)) },
        });
      }
      return null;
    }
    const where = outcome === 'shared' ? 'sent ✓' : outcome === 'saved' ? 'saved ✓' : 'downloading — look in Downloads';
    if (built.kind !== 'backup') {
      if (!closed) toast(`Photos ${where}`, { type: 'ok', ms: 4000 });
      return outcome;
    }
    if (!built.complete) {
      if (!closed) toast(`Copy ${where} (without videos — not a full backup).`, { type: 'ok', ms: 6000 });
      return outcome;
    }
    if (outcome === 'downloaded') {
      // A download was only started: the browser may ask first (iPhone
      // always does) and the person can say no, and the Home Screen app may
      // not download at all. So it counts once the person has seen the file.
      const there = await confirmDialog({
        title: 'Did the backup download?',
        message: ways.ios
          ? `Look in the Files app › Downloads for “${built.fileName}”. If the phone asked whether to download it, tap Download there first.`
          : `Look in your Downloads folder for “${built.fileName}”.`,
        okText: 'Yes, it is there',
        cancelText: 'Not yet',
      });
      if (!there) {
        // (No Ready sheet where a download is the only way: Save backup downloads it again.)
        if (!closed) toast(sheet ? 'Not counted as a backup yet. Tap Download again, or pick another way.' : 'Not counted as a backup yet. Tap Save backup to download it again.', { type: 'warn' });
        return null;
      }
    }
    try {
      await store.markBackedUp(pid, { changeSeq: built.changeSeq, fileName: built.fileName });
      if (!closed) toast(outcome === 'downloaded' ? 'Backed up ✓ — the file is in Downloads.' : 'Backed up ✓', { type: 'ok', ms: 5000 });
    } catch (err) {
      console.error('[export] markBackedUp failed', err);
      if (!closed) toast(`The file was saved, but the app could not note the backup: ${err.message || err}`, { type: 'err' });
    }
    if (!closed) refresh();
    return outcome;
  }

  /** The file picker, with progress while the bytes are written (a big backup takes a while). */
  async function writePicked(built) {
    const ac = new AbortController();
    let b = null;
    try {
      return await saveToPickedFile(built.blob, built.fileName, {
        signal: ac.signal,
        onProgress: (f) => {
          if (!b) {
            b = busy('Saving the file…', { cancellable: true, onCancel: () => { b.update('Stopping…'); ac.abort(); } });
            running = { ac, b };
          }
          b.update(null, f);
        },
      });
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
      throw err;
    } finally {
      b?.done();
      if (running?.ac === ac) running = null;
    }
  }

  // Leaving while a zip is being made: the busy overlay's Cancel stops it.
  setGuard(async () => {
    if (!running?.b) return true;
    running.b.update('Still working — tap Cancel first to stop it.');
    return false;
  });

  render();
  refresh();

  return () => {
    closed = true;
    offChange();
    refreshSoon.cancel();
    if (running) {
      running.ac?.abort();
      running.b?.done();
    }
    sheet?.close(true);
    sheet = null;
    tapToast?.close();
    tapToast = null;
    lastBuilt = null; // drop the zip so its memory can be freed
    releaseDownloads(); // …including the copy a started download still points at
  };
}
