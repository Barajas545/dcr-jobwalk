// trash-screen.js — Recently Deleted (#/trash).
//
// The only place anything is erased. A deleted job walk, photo, video or
// note waits here (store: deletedAt) until the person restores it or erases
// it; nothing is purged automatically, ever. Every "Delete forever" says in
// plain words exactly what will be lost — the item, its markup, its typed
// notes and voice notes, or a whole job walk with its counts and whether it
// was ever backed up — before anything happens.

import { el, iconButton, toast, confirmDialog, busy } from './shell.js';
import { icon } from './icons.js';
import { itemLabel, itemIconName, itemThumbId } from './items-panel.js';
import { summarizeItems, planCoverId } from './projects-screen.js';
import { backupState } from '../core/store.js';
import { formatDateTime, formatDuration, formatDate, debounce, isIOS } from '../core/util.js';

// ---- pure helpers (tested) ------------------------------------------------------------

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "a, b and c" — with two it reads "a and b". */
function andList(parts) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * What erasing one item loses, in a sentence:
 * "Photo #12 from Riverside Lofts and its markup and 2 voice notes will be
 * erased from this phone. This cannot be undone."
 */
export function describeItemLoss(item, projectName = 'this job walk', { device = 'phone' } = {}) {
  let what = itemLabel(item);
  if (item?.type === 'video' && item.duration) what += ` (${formatDuration(item.duration)})`;
  const extras = [];
  if (item?.annotations?.shapes?.length || item?.media?.annotated) extras.push('its markup');
  if (String(item?.text || '').trim() && item?.type !== 'note') extras.push('its typed notes');
  const v = item?.voiceNotes?.length || 0;
  if (v) extras.push(plural(v, 'voice note'));
  const tail = extras.length === 2 ? ` and ${extras[0]} and ${extras[1]}` : extras.length ? ` and ${andList(extras)}` : '';
  return `${what} from ${projectName}${tail} will be erased from this ${device}. This cannot be undone.`;
}

/** Counts of what a job walk holds (deleted items included — they go with it). */
export function projectContents(project, items) {
  const c = { photos: 0, videos: 0, notes: 0, voice: 0, plans: 0 };
  for (const i of items || []) {
    if (i.type === 'photo') c.photos++;
    else if (i.type === 'video') c.videos++;
    else if (i.type === 'note') c.notes++;
    c.voice += i.voiceNotes?.length || 0;
  }
  for (const l of project?.levels || []) c.plans += (l.plan ? 1 : 0) + (l.planHistory?.length || 0);
  return c;
}

/** "24 photos, 2 videos and 5 notes" (or "nothing captured"). */
export function contentsText(c, { withPlans = false } = {}) {
  const parts = [];
  if (c.photos) parts.push(plural(c.photos, 'photo'));
  if (c.videos) parts.push(plural(c.videos, 'video'));
  if (c.notes) parts.push(plural(c.notes, 'note'));
  if (c.voice) parts.push(plural(c.voice, 'voice note'));
  if (withPlans && c.plans) parts.push(plural(c.plans, 'plan'));
  return parts.length ? andList(parts) : 'nothing captured';
}

/** What erasing a whole job walk loses, including whether it was ever backed up. */
export function describeProjectLoss(project, contents, { device = 'phone' } = {}) {
  const name = project?.name || 'This job walk';
  const what = contentsText(contents, { withPlans: true });
  const st = backupState(project);
  let backup;
  if (!st.lastAt) backup = 'It was never backed up.';
  else if (st.needed) backup = `It was last backed up ${formatDate(st.lastAt)}; ${plural(st.changesSince, 'change')} since then are not in any backup.`;
  else backup = `It was backed up ${formatDate(st.lastAt)}${project?.backup?.fileName ? ` (${project.backup.fileName})` : ''}.`;
  return `"${name}" and everything in it (${what}) will be erased from this ${device}. ${backup} This cannot be undone.`;
}

/** The confirmation for Empty: the totals. */
export function emptyAllText(projectCount, itemCount, { device = 'phone' } = {}) {
  const parts = [];
  if (projectCount) parts.push(plural(projectCount, 'job walk'));
  if (itemCount) parts.push(plural(itemCount, 'photo, video or note', 'photos, videos and notes'));
  return `Everything in Recently Deleted — ${andList(parts)} — will be erased from this ${device}. This cannot be undone.`;
}

// ---- the screen ----------------------------------------------------------------------------

const deviceWord = () => (isIOS() || (typeof navigator !== 'undefined' && /Android|Mobi/i.test(navigator.userAgent || '')) ? 'phone' : 'device');

/** Open Recently Deleted. */
export async function open(ctx) {
  const { root, app } = ctx;
  const { store, bus } = app;
  const scope = store.createUrlScope();
  let closed = false;
  let token = 0;
  let data = { projects: [], items: [] };   // what is shown, for Empty
  let working = false;

  const emptyBtn = el('button', { type: 'button', class: 'btn btn-sm btn-outline tr-empty-btn', hidden: true, onclick: emptyAll }, 'Empty');
  root.append(el('header', { class: 'topbar' },
    iconButton('back', { title: 'Back', onclick: () => ctx.back('') }),
    el('div', { class: 'topbar-title' }, el('h1', {}, 'Recently Deleted'), el('div', { class: 'sub' }, 'Nothing here is erased until you say so')),
    emptyBtn));
  const content = el('div', { class: 'tr-content' }, el('div', { class: 'home-loading muted' }, el('div', { class: 'spinner' }), 'Loading…'));
  const body = el('main', { class: 'screen-body narrow trash' },
    el('div', { class: 'banner tr-intro' }, el('span', { html: icon('info', { size: 20 }) }),
      el('span', {}, 'Deleted job walks, photos, videos and notes wait here until you restore them or erase them. Nothing is removed automatically.')),
    content);
  root.append(body);

  function thumbBox(mediaId, fallbackIcon) {
    const ph = el('span', { class: 'tr-ph', html: icon(fallbackIcon, { size: 24 }) });
    const box = el('div', { class: 'tr-thumb' }, ph);
    if (mediaId) {
      scope.url(mediaId).then((u) => {
        if (!u || closed) return;
        const img = el('img', { alt: '', decoding: 'async', src: u });
        img.addEventListener('load', () => ph.remove(), { once: true });
        box.append(img);
      }).catch(() => { /* placeholder stays */ });
    }
    return box;
  }

  async function render() {
    const t = ++token;
    let trash;
    try {
      trash = await store.listTrash();
    } catch (err) {
      if (t !== token || closed) return;
      content.replaceChildren(el('div', { class: 'banner err' }, el('span', { html: icon('warning', { size: 20 }) }), el('span', {}, `Recently Deleted could not be read: ${err.message}`)));
      return;
    }
    const projRows = await Promise.all(trash.projects.map(async (p) => {
      let items = [];
      try { items = await store.listItems(p.id, { includeDeleted: true }); } catch { /* counts unknown */ }
      return { p, items, contents: projectContents(p, items), coverId: summarizeItems(items).coverId || planCoverId(p) };
    }));
    if (t !== token || closed) return;
    data = { projects: projRows, items: trash.items };
    emptyBtn.hidden = !(projRows.length || trash.items.length);

    if (!projRows.length && !trash.items.length) {
      content.replaceChildren(el('div', { class: 'empty' },
        el('div', { html: icon('trash', { size: 44 }) }),
        el('h2', {}, 'Nothing deleted'),
        el('p', {}, 'When you delete a job walk, photo, video or note, it waits here so you can bring it back.')));
      return;
    }
    const parts = [];
    if (projRows.length) {
      parts.push(el('h2', { class: 'section-title' }, `Job walks (${projRows.length})`),
        el('div', { class: 'tr-list' }, projRows.map(projectRow)));
    }
    if (trash.items.length) {
      parts.push(el('h2', { class: 'section-title' }, `Photos, videos and notes (${trash.items.length})`),
        el('div', { class: 'tr-list' }, trash.items.map(itemRow)));
    }
    content.replaceChildren(...parts);
  }

  function actions(onRestore, onErase, name) {
    return el('div', { class: 'tr-actions' },
      el('button', { type: 'button', class: 'btn btn-sm btn-outline', 'aria-label': `Restore ${name}`, onclick: onRestore },
        el('span', { html: icon('restore', { size: 17 }) }), 'Restore'),
      el('button', { type: 'button', class: 'btn btn-sm btn-ghost tr-erase', 'aria-label': `Delete ${name} forever`, onclick: onErase },
        el('span', { html: icon('trash', { size: 17 }) }), 'Delete forever'));
  }

  function projectRow({ p, contents, coverId }) {
    const st = backupState(p);
    const backup = !st.lastAt ? 'Never backed up' : st.needed ? `${st.changesSince} changes not backed up` : `Backed up ${formatDate(st.lastAt)}`;
    return el('article', { class: 'tr-row' },
      thumbBox(coverId, 'building'),
      el('div', { class: 'tr-info' },
        el('div', { class: 'tr-name' }, p.name || 'Job walk'),
        el('div', { class: 'tr-sub' }, [contentsText(contents), p.address].filter(Boolean).join(' · ')),
        el('div', { class: 'tr-when' }, `Deleted ${formatDateTime(p.deletedAt)} · `, el('span', { class: st.needed ? 'tr-warn' : '' }, backup)),
        actions(() => restoreProject(p), () => eraseProject(p, contents), p.name)));
  }

  function itemRow(item) {
    const excerpt = [item.title, item.text].map((s) => String(s || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' — ');
    return el('article', { class: 'tr-row' },
      thumbBox(itemThumbId(item), itemIconName(item)),
      el('div', { class: 'tr-info' },
        el('div', { class: 'tr-name' }, itemLabel(item), item.tags?.length ? el('span', { class: 'tr-tags' }, ` · ${item.tags.join(', ')}`) : null),
        el('div', { class: 'tr-sub' }, `from ${item.projectName}`, excerpt ? ` · ${excerpt.length > 80 ? `${excerpt.slice(0, 79)}…` : excerpt}` : ''),
        el('div', { class: 'tr-when' }, `Deleted ${formatDateTime(item.deletedAt)}`),
        actions(() => restoreItem(item), () => eraseItem(item), itemLabel(item))));
  }

  // ---- actions ----

  async function restoreProject(p) {
    if (working) return;
    working = true;
    try {
      await store.restoreProject(p.id);
      toast(`"${p.name}" is back in your job walks.`, { type: 'ok', action: { label: 'Open', onclick: () => ctx.navigate(`p/${p.id}`) } });
    } catch (err) {
      toast(`It was not restored: ${err.message}`, { type: 'err' });
    } finally {
      working = false;
    }
  }

  async function restoreItem(item) {
    if (working) return;
    working = true;
    try {
      await store.restoreItem(item.id);
      toast(`${itemLabel(item)} is back in ${item.projectName}.`, { type: 'ok', action: { label: 'Open', onclick: () => ctx.navigate(`p/${item.projectId}/i/${item.id}`) } });
    } catch (err) {
      toast(`It was not restored: ${err.message}`, { type: 'err' });
    } finally {
      working = false;
    }
  }

  async function eraseItem(item) {
    if (working) return;
    const ok = await confirmDialog({
      title: `Erase ${itemLabel(item)} forever?`,
      message: describeItemLoss(item, item.projectName, { device: deviceWord() }),
      okText: 'Erase forever',
      danger: true,
    });
    if (!ok) return;
    working = true;
    try {
      // With the deletedAt shown: restored meanwhile (another window), it is kept.
      await store.purgeItem(item.id, { deletedAt: item.deletedAt });
      toast(`${itemLabel(item)} was erased.`, { type: 'ok' });
    } catch (err) {
      if (err.kept) toast(err.message, { type: 'info' });
      else toast(`It was not erased: ${err.message}`, { type: 'err' });
    } finally {
      working = false;
    }
  }

  async function eraseProject(p, contents) {
    if (working) return;
    // A video still being rebuilt from its pieces belongs to the job walk too.
    let unfinished = 0;
    try { unfinished = (await store.listRecordings()).filter((r) => r.projectId === p.id).length; } catch { /* none known */ }
    const ok = await confirmDialog({
      title: `Erase "${p.name}" forever?`,
      message: describeProjectLoss(p, contents, { device: deviceWord() })
        + (unfinished ? ` That includes ${unfinished === 1 ? 'a video' : `${unfinished} videos`} still being saved from ${unfinished === 1 ? 'its' : 'their'} pieces.` : ''),
      okText: 'Erase forever',
      danger: true,
    });
    if (!ok) return;
    working = true;
    const b = busy(`Erasing ${p.name}…`);
    try {
      await store.purgeProject(p.id, { deletedAt: p.deletedAt });
      toast(`"${p.name}" was erased.`, { type: 'ok' });
    } catch (err) {
      if (err.kept) toast(err.message, { type: 'info' });
      else toast(`It was not erased: ${err.message}`, { type: 'err' });
    } finally {
      b.done();
      working = false;
    }
  }

  async function emptyAll() {
    if (working) return;
    const { projects, items } = data;
    if (!projects.length && !items.length) return;
    const ok = await confirmDialog({
      title: 'Empty Recently Deleted?',
      message: emptyAllText(projects.length, items.length, { device: deviceWord() }) +
        (projects.some(({ p }) => backupState(p).needed) ? '\n\nSome of these job walks have changes that are not in any backup.' : ''),
      okText: 'Erase everything',
      danger: true,
    });
    if (!ok) return;
    working = true;
    const confirmed = projects.length + items.length;
    let total = confirmed;
    let n = 0;
    const b = busy('Erasing…');
    // One the store refuses because it was restored a moment ago (err.kept) is skipped, not an error.
    const erase = async (purge) => {
      try { await purge(); n++; } catch (err) { if (!err.kept) throw err; }
    };
    try {
      // The list shown can be a moment old (it is redrawn shortly after a
      // Restore, and another window may restore something): erase only what
      // was confirmed AND is still in Recently Deleted from the same moment.
      const fresh = await store.listTrash();
      const stillItems = new Map(fresh.items.map((i) => [i.id, i.deletedAt]));
      const stillProjects = new Map(fresh.projects.map((p) => [p.id, p.deletedAt]));
      const todoItems = items.filter((it) => stillItems.get(it.id) === it.deletedAt);
      const todoProjects = projects.filter(({ p }) => stillProjects.get(p.id) === p.deletedAt);
      total = todoItems.length + todoProjects.length;
      for (const it of todoItems) {
        b.update(`Erasing ${itemLabel(it)}…`, n / total);
        await erase(() => store.purgeItem(it.id, { deletedAt: it.deletedAt }));
      }
      for (const { p } of todoProjects) {
        b.update(`Erasing ${p.name}…`, n / total);
        await erase(() => store.purgeProject(p.id, { deletedAt: p.deletedAt }));
      }
      if (n < confirmed) toast(`Erased ${n} of ${confirmed}. The rest was restored in the meantime, so it was kept.`, { type: 'ok' });
      else toast('Recently Deleted is empty.', { type: 'ok' });
    } catch (err) {
      toast(`Stopped after ${n} of ${total}: ${err.message}`, { type: 'err' });
    } finally {
      b.done();
      working = false;
      render();
    }
  }

  const refresh = debounce(() => { if (!closed) render(); }, 250);
  const off = bus.on('store:change', (ev) => { if (ev.kind !== 'media') refresh(); });
  await render();

  return () => {
    closed = true;
    off();
    refresh.cancel();
    scope.release();
  };
}
