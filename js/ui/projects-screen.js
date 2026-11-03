// projects-screen.js — the home screen (#/): every job walk on this phone.
//
// What it is for, in order of importance:
//  1. Keep the person's work safe: each job walk says whether it is backed
//     up ("Backed up Nov 2" / "12 changes not backed up"), the storage line
//     says whether the browser may clear the app's data and offers to
//     protect it, and on an iPhone that has not installed the app a card
//     explains Add to Home Screen (Safari can clear website data of sites
//     that are not installed; installed apps keep it).
//  2. Start a job walk: New job walk asks the job details, then where the
//     floor plan comes from (or the satellite map for now), then opens it.
//  3. Bring one in: Import a job walk (.zip made by Back up & export, from
//     this or another device), with a clear choice when it is already here.
//
// The list refreshes itself on every committed write (store:change), so a
// photo taken in another tab or an import shows up without a reload.

import { el, iconButton, toast, formDialog, confirmDialog, alertDialog, choose, busy, pickFiles } from './shell.js';
import { icon } from './icons.js';
import { choosePlanAndSave } from './plan-import-dialog.js';
import { backupState } from '../core/store.js';
import { formatDate, formatTime, formatBytes, todayISO, isIOS, isStandalone, debounce } from '../core/util.js';

// ---- pure helpers (tested) -------------------------------------------------------------

/** "Nov 2" (this year), "Nov 2, 2025" (another year), "today 3:41 PM". */
export function shortDate(ms, now = Date.now()) {
  if (!ms) return '';
  const d = new Date(ms), n = new Date(now);
  if (d.toDateString() === n.toDateString()) return `today ${formatTime(ms)}`;
  const sameYear = d.getFullYear() === n.getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Counts by type and the media id of the cover picture (the first photo,
 * else the first video) of a job walk's items.
 */
export function summarizeItems(items) {
  const out = { photos: 0, videos: 0, notes: 0, total: 0, coverId: null };
  let coverPhoto = null, coverVideo = null;
  const sorted = [...(items || [])].filter((i) => i && !i.deletedAt).sort((a, b) => (a.seq || 0) - (b.seq || 0));
  for (const i of sorted) {
    out.total++;
    const thumb = i.media?.annotatedThumb || i.media?.thumb || i.media?.poster || null;
    if (i.type === 'photo') { out.photos++; if (!coverPhoto && thumb) coverPhoto = thumb; }
    else if (i.type === 'video') { out.videos++; if (!coverVideo && thumb) coverVideo = thumb; }
    else if (i.type === 'note') out.notes++;
  }
  out.coverId = coverPhoto || coverVideo || null;
  return out;
}

/** The plan thumbnail to use as a cover: the active level's, else the first level with one. */
export function planCoverId(project) {
  const levels = project?.levels || [];
  const active = levels.find((l) => l.id === project?.activeLevelId);
  return active?.plan?.thumbId || levels.find((l) => l.plan?.thumbId)?.plan?.thumbId || null;
}

/**
 * The backup badge of a job walk: {cls: 'ok'|'warn'|'', icon, text}.
 * hasItems: whether it holds any photo, video or note yet.
 */
export function backupBadge(project, { hasItems = true, now = Date.now() } = {}) {
  const st = backupState(project);
  if (!st.needed && st.lastAt) return { cls: 'ok', icon: 'check', text: `Backed up ${shortDate(st.lastAt, now)}` };
  if (!st.lastAt && !hasItems) return { cls: '', icon: 'archive', text: 'Not backed up yet' };
  if (st.needed) {
    const n = st.changesSince;
    return { cls: 'warn', icon: 'warning', text: `${n} change${n === 1 ? '' : 's'} not backed up` };
  }
  return { cls: '', icon: 'archive', text: 'Not backed up yet' };
}

const COUNT_LABELS = [
  ['photos', 'photo', 'photos'], ['photo', 'photo', 'photos'],
  ['videos', 'video', 'videos'], ['video', 'video', 'videos'],
  ['notes', 'note', 'notes'], ['note', 'note', 'notes'],
  ['voiceNotes', 'voice note', 'voice notes'], ['voice', 'voice note', 'voice notes'],
  ['levels', 'level', 'levels'], ['plans', 'plan', 'plans'],
];

/** "24 photos, 2 videos, 5 notes" from a package's counts (any of the usual keys). */
export function countsText(counts = {}) {
  const parts = [];
  const seen = new Set();
  for (const [key, one, many] of COUNT_LABELS) {
    const n = Number(counts?.[key]);
    if (!Number.isFinite(n) || n <= 0 || seen.has(many)) continue;
    seen.add(many);
    parts.push(`${n} ${n === 1 ? one : many}`);
  }
  return parts.join(', ') || 'No photos, videos or notes';
}

/** Whatever shape a progress callback uses → {text, fraction}. */
export function progressOf(a, b) {
  if (typeof a === 'number') return { fraction: a > 1 ? a / 100 : a, text: typeof b === 'string' ? b : null };
  if (typeof a === 'string') return { text: a, fraction: typeof b === 'number' ? (b > 1 ? b / 100 : b) : null };
  if (a && typeof a === 'object') {
    const done = a.done ?? a.loaded ?? a.n ?? a.current;
    const fraction = a.fraction ?? a.progress ?? (a.total && done != null ? done / a.total : null);
    return { fraction, text: a.label || a.text || a.message || a.stage || null };
  }
  return { text: null, fraction: null };
}

// ---- the screen ----------------------------------------------------------------------------

function safeSession(key, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    sessionStorage.setItem(key, value);
  } catch { /* private mode */ }
  return null;
}

/** Open the home screen. */
export async function open(ctx) {
  const { root, app } = ctx;
  const { store, bus } = app;
  const scope = store.createUrlScope();     // cover pictures; ids never change, so one scope for the screen's life
  const offs = [];
  const leaving = new AbortController();    // closes the plan dialog if the person leaves mid-way
  let renderToken = 0;
  let closed = false;

  // ---- layout ----
  const sub = el('div', { class: 'sub' });
  const topbar = el('header', { class: 'topbar brand home-topbar' },
    el('span', { class: 'home-mark', html: icon('building', { size: 24 }) }),
    el('div', { class: 'topbar-title' }, el('h1', {}, 'DCR Job Walk'), sub),
    iconButton('settings', { title: 'Settings', onclick: () => ctx.navigate('settings') }));
  const welcomeHost = el('div', { class: 'home-slot' });
  const installHost = el('div', { class: 'home-slot' });
  const storageHost = el('div', { class: 'home-storage' });
  const listHost = el('div', { class: 'home-list', 'aria-live': 'polite' }, el('div', { class: 'home-loading muted' }, el('div', { class: 'spinner' }), 'Loading job walks…'));
  const trashLink = el('button', { type: 'button', class: 'list-row home-trash', onclick: () => ctx.navigate('trash') });
  const body = el('main', { class: 'screen-body narrow home' },
    welcomeHost,
    installHost,
    el('div', { class: 'home-actions' },
      el('button', { type: 'button', class: 'btn btn-primary btn-lg btn-block', onclick: newJobWalk }, el('span', { html: icon('plus', { size: 22 }) }), 'New job walk'),
      el('button', { type: 'button', class: 'btn btn-outline btn-block', onclick: importZip }, el('span', { html: icon('upload', { size: 20 }) }), 'Import a job walk (.zip)')),
    storageHost,
    listHost,
    el('div', { class: 'list home-links' }, trashLink),
    el('p', { class: 'home-version faint small' }, `DCR Job Walk ${app.version || ''} · everything is saved on this device`));
  root.append(topbar, body);

  function renderSub() {
    const s = app.getSettings();
    sub.textContent = [s.company || 'DCR Framing', s.userName].filter(Boolean).join(' · ');
  }

  // ---- first run ----
  let nameInput = null;
  const saveNameSoon = debounce(async (name) => {
    try { await app.updateSettings({ userName: name }); } catch (err) { console.warn('[home] name autosave', err); }
  }, 800);
  const flushName = () => {
    if (nameInput && nameInput.value.trim() && nameInput.value.trim() !== app.getSettings().userName) saveNameSoon.flush(nameInput.value.trim());
  };

  function renderWelcome() {
    const s = app.getSettings();
    if (s.onboarded) { welcomeHost.replaceChildren(); nameInput = null; return; }
    if (nameInput && welcomeHost.contains(nameInput)) return; // keep what is being typed
    nameInput = el('input', {
      class: 'input', type: 'text', autocomplete: 'name', autocapitalize: 'words', enterkeyhint: 'done',
      placeholder: 'First and last name', 'aria-label': 'Your name (for photo credits)',
    });
    nameInput.value = s.userName || '';
    nameInput.addEventListener('input', () => { const v = nameInput.value.trim(); if (v) saveNameSoon(v); });
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finishWelcome(false); } });
    welcomeHost.replaceChildren(el('section', { class: 'card home-welcome' },
      el('div', { class: 'home-welcome-head' },
        el('span', { class: 'home-welcome-ic', html: icon('walk', { size: 26 }) }),
        el('h2', {}, 'Welcome to DCR Job Walk')),
      el('ul', { class: 'home-welcome-list' },
        el('li', {}, 'Load the floor plan for each level: a PDF, a picture or a screenshot.'),
        el('li', {}, 'Walk the job: every photo, video and note lands on the plan where you took it, with the direction the camera faced.'),
        el('li', {}, 'Everything stays on this device. Back up & export makes one .zip that opens in any browser.')),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Your name (for photo credits)'), nameInput),
      el('div', { class: 'row home-welcome-btns' },
        el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => finishWelcome(true) }, 'Skip'),
        el('span', { class: 'spacer' }),
        el('button', { type: 'button', class: 'btn btn-primary', onclick: () => finishWelcome(false) }, 'Get started'))));
  }

  async function finishWelcome(skip) {
    const name = nameInput?.value.trim() || '';
    if (!skip && !name) {
      nameInput?.focus();
      toast('Type your name, or tap Skip.', { type: 'warn' });
      return;
    }
    saveNameSoon.cancel();
    try {
      await app.updateSettings(skip && !name ? { onboarded: true } : { userName: name, onboarded: true });
    } catch (err) {
      toast(`That was not saved: ${err.message}`, { type: 'err' });
      return;
    }
    toast(name ? `Thanks, ${name}. Your photos will say "Taken by ${name}".` : 'You can add your name any time in Settings.', { type: 'ok', ms: 4000 });
    nameInput = null;
    renderWelcome();
    renderSub();
  }

  // ---- iPhone: install to the Home Screen ----
  function renderInstall(projectCount = 0) {
    if (!isIOS() || isStandalone() || safeSession('jw.hideInstall') === '1') { installHost.replaceChildren(); return; }
    installHost.replaceChildren(el('section', { class: 'card home-install' },
      el('div', { class: 'home-install-head' },
        el('span', { class: 'home-install-ic', html: icon('phone', { size: 24 }) }),
        el('h2', {}, 'Add to Home Screen so Safari never clears your photos')),
      el('p', { class: 'muted' }, 'Safari can clear the data of websites that are not installed. Installed, the app keeps its storage.'),
      el('ol', { class: 'home-steps' },
        el('li', {}, 'Tap the Share button ', el('span', { class: 'home-inline-ic', html: icon('share', { size: 16 }) }), ' in Safari\'s toolbar.'),
        el('li', {}, 'Scroll down, tap ', el('b', {}, 'Add to Home Screen'), ', then ', el('b', {}, 'Add'), '.'),
        el('li', {}, 'Open ', el('b', {}, 'Job Walk'), ' from the new icon, and use it from there.')),
      el('p', { class: 'small muted' }, projectCount
        ? `The installed app starts empty: job walks saved here in Safari stay in Safari. Back each one up first (open it → More → Back up & export), then import the .zip in the installed app.`
        : 'The installed app has its own storage, separate from Safari, so install it before your first walk.'),
      el('div', { class: 'row' }, el('span', { class: 'spacer' }),
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { safeSession('jw.hideInstall', '1'); renderInstall(); } }, 'Hide for now'))));
  }

  // ---- storage ----
  async function renderStorage() {
    let info;
    try { info = await store.storageInfo(); } catch { info = {}; }
    if (closed) return;
    const parts = [];
    if (info.usage != null) parts.push(`Using ${formatBytes(info.usage)}`);
    const free = info.quota != null && info.usage != null ? Math.max(0, info.quota - info.usage) : null;
    if (free != null) parts.push(`about ${formatBytes(free)} free`);
    const low = free != null && free < 500 * 1024 * 1024;
    const kids = [el('span', { class: 'home-storage-ic', html: icon(info.persisted ? 'shield' : 'info', { size: 18 }) })];
    const text = el('span', { class: 'home-storage-text' }, parts.join(' · '));
    kids.push(text);
    if (info.persisted) {
      text.append(parts.length ? ' · ' : '', el('b', { class: 'home-ok' }, 'Storage protected ✓'));
    } else if (info.canPersist) {
      text.append(parts.length ? ' · ' : '', el('span', {}, 'Storage not protected'));
      kids.push(el('button', { type: 'button', class: 'btn btn-sm btn-outline', onclick: protect }, 'Protect storage'));
    } else {
      text.append(parts.length ? ' · ' : '', el('span', {}, 'Back up after every walk'));
    }
    storageHost.className = `home-storage${low ? ' low' : ''}${info.persisted ? ' protected' : ''}`;
    storageHost.replaceChildren(...kids);
    if (low) storageHost.append(el('div', { class: 'home-storage-low' }, 'Space is getting low. Back up finished job walks and move them to Recently Deleted, then erase them there.'));
  }

  async function protect() {
    const ok = await store.requestPersist();
    if (ok) {
      toast('Storage is protected. The browser will not clear it on its own.', { type: 'ok', ms: 4000 });
    } else {
      const advice = isIOS()
        ? (isStandalone()
          ? 'Safari decides this by itself. As an installed app your data is already kept; back up after each walk to be safe.'
          : 'Safari decides this by itself. Add the app to your Home Screen: installed apps keep their storage.')
        : /Android/i.test(navigator.userAgent || '')
          ? 'Chrome grants this to apps you install or use often. Install the app (Chrome ⋮ → Install app or Add to Home screen), open it from its icon, and tap Protect storage again.'
          : 'The browser said no for now. Bookmark or install the app, use it a few times, and try again. Back up after each walk either way.';
      await alertDialog({ title: 'Storage is not protected yet', message: advice });
    }
    renderStorage();
  }

  // ---- the list ----
  async function renderList() {
    const t = ++renderToken;
    let projects;
    try {
      projects = await store.listProjects();
    } catch (err) {
      if (t !== renderToken || closed) return;
      listHost.replaceChildren(el('div', { class: 'banner err' }, el('span', { html: icon('warning', { size: 20 }) }),
        el('span', {}, `The job walks could not be read: ${err.message}`)));
      return;
    }
    const rows = await Promise.all(projects.map(async (p) => {
      let items = [];
      try { items = await store.listItems(p.id); } catch { /* shown without counts */ }
      return { p, sum: summarizeItems(items) };
    }));
    if (t !== renderToken || closed) return;
    renderInstall(projects.length);
    if (!rows.length) {
      listHost.replaceChildren(el('div', { class: 'empty home-empty' },
        el('div', { html: icon('plan', { size: 44 }) }),
        el('h2', {}, 'No job walks yet'),
        el('p', {}, 'Tap New job walk to start one. You can add the floor plan now or later.')));
      return;
    }
    listHost.replaceChildren(
      el('h2', { class: 'section-title' }, `Job walks (${rows.length})`),
      ...rows.map(projectCard));
  }

  function projectCard({ p, sum }) {
    const coverId = sum.coverId || planCoverId(p);
    const ph = el('span', { class: 'jw-cover-ph', html: icon(sum.coverId ? 'image' : coverId ? 'plan' : 'building', { size: 30 }) });
    const cover = el('div', { class: 'jw-cover' }, ph);
    if (coverId) {
      scope.url(coverId).then((u) => {
        if (!u || closed) return;
        const img = el('img', { alt: '', decoding: 'async', src: u });
        img.addEventListener('load', () => ph.remove(), { once: true });
        cover.append(img);
      }).catch(() => { /* placeholder stays */ });
    }
    const meta = [p.walkDate ? formatDate(p.walkDate) : null, p.number ? `Job ${p.number}` : null, p.gc || null].filter(Boolean).join(' · ');
    const count = (ic, n, one, many) => el('span', { class: 'jw-count', title: `${n} ${n === 1 ? one : many}` }, el('span', { html: icon(ic, { size: 15 }) }), String(n));
    const counts = sum.total
      ? el('div', { class: 'jw-counts', 'aria-label': `${sum.photos} photos, ${sum.videos} videos, ${sum.notes} notes` },
        count('camera', sum.photos, 'photo', 'photos'), count('video', sum.videos, 'video', 'videos'), count('note', sum.notes, 'note', 'notes'))
      : el('div', { class: 'jw-counts faint' }, 'Nothing captured yet');
    const bk = backupBadge(p, { hasItems: sum.total > 0 });
    const main = el('button', { type: 'button', class: 'jw-main', onclick: () => ctx.navigate(`p/${p.id}`) },
      cover,
      el('div', { class: 'jw-info' },
        el('div', { class: 'jw-name' }, p.name || 'Job walk'),
        p.address ? el('div', { class: 'jw-addr' }, p.address) : null,
        meta ? el('div', { class: 'jw-meta' }, meta) : null,
        counts,
        el('div', { class: 'jw-foot' }, el('span', { class: `badge ${bk.cls}` }, el('span', { html: icon(bk.icon, { size: 13 }) }), bk.text))));
    const more = iconButton('more', { title: `More for ${p.name}`, cls: 'icon-btn jw-more', onclick: () => cardMenu(p) });
    return el('div', { class: 'jw-card' }, main, more);
  }

  async function cardMenu(p) {
    const v = await choose({
      title: p.name,
      options: [
        { value: 'open', label: 'Open', icon: 'forward' },
        { value: 'export', label: 'Back up & export', icon: 'archive', detail: 'One .zip with every photo, video and note' },
        { value: 'delete', label: 'Move to Recently Deleted', icon: 'trash', danger: true, detail: 'Kept there until you erase it' },
      ],
    });
    if (v === 'open') ctx.navigate(`p/${p.id}`);
    else if (v === 'export') ctx.navigate(`p/${p.id}/export`);
    else if (v === 'delete') deleteProject(p);
  }

  async function deleteProject(p) {
    const ok = await confirmDialog({
      title: `Move "${p.name}" to Recently Deleted?`,
      message: 'Its plans, photos, videos and notes are kept in Recently Deleted until you erase them there. You can restore it at any time.',
      okText: 'Move to Recently Deleted',
      danger: true,
    });
    if (!ok) return;
    try {
      await store.softDeleteProject(p.id);
    } catch (err) {
      toast(`It was not moved: ${err.message}`, { type: 'err' });
      return;
    }
    toast(`"${p.name}" is in Recently Deleted.`, {
      type: 'ok', ms: 7000,
      action: { label: 'Undo', onclick: () => store.restoreProject(p.id).then(() => toast('Restored.', { type: 'ok' })).catch((e) => toast(`Not restored: ${e.message}`, { type: 'err' })) },
    });
  }

  async function renderTrashLink() {
    let n = 0;
    try {
      const t = await store.listTrash();
      n = t.projects.length + t.items.length;
    } catch { /* show the link without a count */ }
    if (closed) return;
    trashLink.replaceChildren(
      el('span', { html: icon('trash', { size: 22 }) }),
      el('span', { class: 'grow' }, el('span', { class: 't' }, 'Recently Deleted'),
        el('span', { class: 's' }, n ? `${n} job walk${n === 1 ? '' : 's'} or items you can restore` : 'Nothing is erased until you say so')),
      n ? el('span', { class: 'badge' }, String(n)) : null,
      el('span', { html: icon('forward', { size: 20 }) }));
  }

  // ---- new job walk ----
  async function newJobWalk() {
    let values = { name: '', address: '', gc: '', number: '', walkDate: todayISO() };
    for (;;) {
      const r = await formDialog({
        title: 'New job walk',
        okText: 'Next',
        fields: [
          { name: 'name', label: 'Job name', value: values.name, placeholder: 'e.g. Riverside Lofts' },
          { name: 'address', label: 'Address', value: values.address, placeholder: 'Street, city' },
          { name: 'gc', label: 'GC / client', value: values.gc, placeholder: 'General contractor or owner' },
          { name: 'number', label: 'DCR job #', value: values.number, placeholder: 'e.g. A302' },
          { name: 'walkDate', label: 'Walk date', type: 'date', value: values.walkDate },
        ],
      });
      if (!r) return;
      values = r;
      if (r.name || r.address) break;
      toast('Give the job walk a name (or an address).', { type: 'warn' });
    }
    let project;
    try {
      project = await store.createProject({
        ...values,
        name: values.name || values.address,
        walkDate: values.walkDate || todayISO(),
        createdBy: app.getSettings().userName || '',
      });
    } catch (err) {
      toast(`The job walk was not created: ${err.message}`, { type: 'err' });
      return;
    }
    toast(`"${project.name}" created.`, { type: 'ok' });
    const level = store.activeLevel(project);
    try {
      await choosePlanAndSave({ project, level, allowMap: true, signal: leaving.signal });
    } catch (err) {
      // The job walk exists either way; the plan can be added from Levels & plans.
      toast(`The plan was not added: ${err.message}`, { type: 'err' });
    }
    if (!closed && ctx.isCurrent()) ctx.navigate(`p/${project.id}`);
  }

  // ---- import ----
  async function importZip() {
    const [file] = await pickFiles({ accept: '.zip,application/zip,application/x-zip-compressed' });
    if (!file || closed) return;
    let pkg;
    try {
      pkg = await import('../core/package.js');
    } catch (err) {
      toast(`The import tool could not be loaded: ${err.message}`, { type: 'err' });
      return;
    }
    let info;
    const b = busy('Reading the file…');
    try {
      info = await pkg.inspectPackage(file);
    } catch (err) {
      b.done();
      await alertDialog({ title: 'This file cannot be imported', message: `${err.message || err}\n\nChoose a .zip made with Back up & export in DCR Job Walk.` });
      return;
    }
    b.done();
    const mode = await confirmImport(info);
    if (!mode || closed) return;
    const name = info.project?.name || 'the job walk';
    const b2 = busy(`Importing ${name}… keep this screen open.`);
    let id;
    try {
      id = await pkg.importPackage(file, {
        mode,
        onProgress: (a, c) => { const p = progressOf(a, c); b2.update(p.text, p.fraction); },
      });
    } catch (err) {
      b2.done();
      await alertDialog({ title: 'The import did not finish', message: `${err.message || err}\n\nThe .zip file itself is unchanged, so you can try again.` });
      return;
    }
    b2.done();
    toast(`Imported "${name}".`, { type: 'ok' });
    const pid = typeof id === 'string' ? id : id?.id || id?.projectId;
    if (pid && !closed && ctx.isCurrent()) ctx.navigate(`p/${pid}`);
  }

  /**
   * Confirm an import; when the job walk is already here, ask Keep both or
   * Replace. → 'copy' | 'replace' | null. (package.js gives the import new
   * ids either way; Replace then moves the copy on this device to Recently
   * Deleted, only after the import is completely saved.)
   */
  async function confirmImport(info) {
    const p = info?.project || {};
    const what = countsText(info?.counts || {});
    const extra = [];
    if (info?.counts?.deleted) extra.push(`(plus ${info.counts.deleted} in its Recently Deleted)`);
    if (info?.complete === false) extra.push(`Warning: ${info.missingFiles?.length || 'some'} file(s) listed in it are missing from the .zip; the rest can still be imported.`);
    const lines = [what, ...extra, p.address, p.walkDate ? `Walk date ${formatDate(p.walkDate)}` : null].filter(Boolean).join('\n');
    if (!info?.exists) {
      const ok = await confirmDialog({ title: `Import "${p.name || 'job walk'}"?`, message: `${lines}\n\nIt will be added to this device.`, okText: 'Import' });
      return ok ? 'copy' : null;
    }
    let local = info.existing || null;
    if (!local) { try { local = await store.getProject(p.id); } catch { local = null; } }
    const newerHere = (local?.changeSeq || 0) > (p.changeSeq || 0);
    const inTrash = !!(local?.deleted || local?.deletedAt);
    const v = await choose({
      title: `"${local?.name || p.name || 'This job walk'}" is already on this device${inTrash ? ' (in Recently Deleted)' : ''}`,
      options: [
        { value: 'copy', label: 'Keep both', icon: 'layers', detail: `Import the file as a separate copy (${what}). Nothing on this device changes.` },
        {
          value: 'replace', label: 'Replace the one on this device', icon: 'swap', danger: true,
          detail: newerHere
            ? 'Careful: the copy on this device has changes that are newer than this file.'
            : 'Use the file\'s version. The one here moves to Recently Deleted, so it can be restored.',
        },
      ],
    });
    if (v !== 'replace') return v;
    const ok = await confirmDialog({
      title: 'Replace the job walk on this device?',
      message: newerHere
        ? `The job walk on this device has ${(local.changeSeq || 0) - (p.changeSeq || 0)} change(s) made after this file was saved. After replacing, they are only in the old copy, which moves to Recently Deleted.\n\nTo be safe, choose Keep both instead.`
        : 'The file\'s version is imported first. Then the one on this device moves to Recently Deleted, where you can restore it.',
      okText: 'Replace',
      danger: true,
    });
    return ok ? 'replace' : null;
  }

  // ---- live updates ----
  const refresh = debounce(() => { if (!closed) { renderList(); renderTrashLink(); } }, 300);
  const refreshStorage = debounce(() => { if (!closed) renderStorage(); }, 2000);
  offs.push(bus.on('store:change', (ev) => {
    if (ev.kind === 'media') { refreshStorage(); return; }
    refresh();
    refreshStorage();
  }));
  offs.push(bus.on('settings:change', () => { renderSub(); renderWelcome(); }));
  const onHide = () => { if (document.visibilityState === 'hidden') flushName(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flushName);
  offs.push(() => document.removeEventListener('visibilitychange', onHide));
  offs.push(() => window.removeEventListener('pagehide', flushName));

  renderSub();
  renderWelcome();
  renderInstall(0);
  renderStorage();
  renderTrashLink();
  await renderList();

  return () => {
    flushName();
    closed = true;
    leaving.abort();
    refresh.cancel();
    refreshStorage.cancel();
    for (const off of offs) { try { off(); } catch { /* fine */ } }
    scope.release();
  };
}
