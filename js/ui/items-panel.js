// items-panel.js — every photo, video and note of a job walk, in one panel.
//
// Opened from the job walk's bottom bar (Items). A bottom sheet with a grid
// or a list, filters (type, tags, level, has notes), a search over titles,
// notes, tags and voice-note transcripts, and three sort orders. Thumbnails
// load only as they scroll into view, through one URL scope that is released
// when the panel closes, so a job walk with 800 photos stays light.
//
// The pure parts (labels, filtering, sorting) are exported and tested in Node.

import { el, iconButton, openSheet } from './shell.js';
import { icon } from './icons.js';
import * as store from '../core/store.js';
import { formatDateTime, formatDuration, formatAccuracy } from '../core/util.js';

/** Framing estimating tags offered on every item (docs/SPEC.md §4.5). Custom tags are added per item. */
export const DEFAULT_TAGS = Object.freeze([
  'Walls', 'Headers/Beams', 'Floor framing', 'Roof/Trusses', 'Sheathing', 'Shear/Hold-downs', 'Blocking',
  'Stairs', 'Decks/Balconies', 'Hardware', 'Existing conditions', 'Demo', 'Access/Site', 'Issue/RFI', 'Safety',
]);

const TYPE_LABEL = { photo: 'Photo', video: 'Video', note: 'Note' };
const TYPE_ICON = { photo: 'camera', video: 'video', note: 'note' };

/** "Photo #12", "Video #3", "Note #5". */
export function itemLabel(item) {
  const t = TYPE_LABEL[item?.type] || 'Item';
  return item?.seq ? `${t} #${item.seq}` : t;
}

/** The icon name (js/ui/icons.js) for an item's type. */
export function itemIconName(item) {
  return TYPE_ICON[item?.type] || 'file';
}

/** The media id of the best small picture of an item (markup first), or null for a note. */
export function itemThumbId(item) {
  const m = item?.media || {};
  return m.annotatedThumb || m.thumb || m.poster || null;
}

/** True when the item carries typed notes or voice notes. */
export function hasNotes(item) {
  return !!(String(item?.text || '').trim() || item?.voiceNotes?.length);
}

/** The first words of an item's title or note, on one line. */
export function noteExcerpt(item, max = 90) {
  const parts = [item?.title, item?.text].map((s) => String(s || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  let s = parts.join(' — ');
  if (!s) {
    const tr = (item?.voiceNotes || []).map((v) => v.transcript).find((t) => t && t.trim());
    if (tr) s = `Voice note: ${tr.replace(/\s+/g, ' ').trim()}`;
  }
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Everything a search looks through, lower-cased. */
export function itemSearchText(item) {
  return [
    itemLabel(item), `#${item?.seq ?? ''}`, item?.title, item?.text,
    ...(item?.tags || []),
    ...(item?.voiceNotes || []).map((v) => v.transcript),
    item?.capturedBy,
  ].filter(Boolean).join(' \n ').toLowerCase();
}

/**
 * The items matching the filters.
 * {type: 'all'|'photo'|'video'|'note', tags: [] (any of them), levelId (null = all levels), hasNotes, query}
 */
export function filterItems(items, { type = 'all', tags = [], levelId = null, hasNotes: notesOnly = false, query = '' } = {}) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const want = new Set(tags || []);
  return (items || []).filter((i) => {
    if (!i || i.deletedAt) return false;
    if (type !== 'all' && i.type !== type) return false;
    if (levelId && i.levelId !== levelId) return false;
    if (want.size && !(i.tags || []).some((t) => want.has(t))) return false;
    if (notesOnly && !hasNotes(i)) return false;
    if (words.length) {
      const hay = itemSearchText(i);
      // "#12" or "12" finds item 12 exactly, not 112.
      for (const w of words) {
        const num = w.replace(/^#/, '');
        if (/^\d+$/.test(num) && String(i.seq) === num) continue;
        if (!hay.includes(w)) return false;
      }
    }
    return true;
  });
}

/** A sorted copy: 'new' (newest first), 'old' (oldest first) or 'seq' (by #). */
export function sortItems(items, sort = 'new') {
  const a = [...(items || [])];
  if (sort === 'seq') a.sort((x, y) => (x.seq || 0) - (y.seq || 0));
  else if (sort === 'old') a.sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0) || (x.seq || 0) - (y.seq || 0));
  else a.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0) || (y.seq || 0) - (x.seq || 0));
  return a;
}

/** The tags used on these items: the standard ones in their usual order, then custom ones A–Z. */
export function tagsInUse(items) {
  const used = new Set();
  for (const i of items || []) for (const t of i?.tags || []) if (t) used.add(t);
  const std = DEFAULT_TAGS.filter((t) => used.has(t));
  const custom = [...used].filter((t) => !DEFAULT_TAGS.includes(t)).sort((a, b) => a.localeCompare(b));
  return [...std, ...custom];
}

/** How many items of each type. */
export function countTypes(items) {
  const c = { all: 0, photo: 0, video: 0, note: 0 };
  for (const i of items || []) {
    if (!i || i.deletedAt) continue;
    c.all++;
    if (c[i.type] != null) c[i.type]++;
  }
  return c;
}

// ---- the panel ------------------------------------------------------------------------

const PREFS_KEY = 'jw.itemsPanel';

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; }
}

function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private mode: fine */ }
}

/**
 * Open the items panel. items: the job walk's (not deleted) items, any level.
 * onOpen(item) runs when one is tapped (the panel closes first).
 * Returns {close()}.
 */
export function openItemsPanel({ project, items = [], onOpen, units = 'imperial' } = {}) {
  const prefs = loadPrefs();
  const levels = project?.levels || [];
  const levelName = new Map(levels.map((l) => [l.id, l.name]));
  const multiLevel = levels.length > 1;
  const state = {
    view: prefs.view === 'list' ? 'list' : 'grid',
    sort: ['new', 'old', 'seq'].includes(prefs.sort) ? prefs.sort : 'new',
    type: 'all',
    tags: new Set(),
    notesOnly: false,
    level: multiLevel ? 'this' : 'all',
    query: '',
  };
  const all = (items || []).filter((i) => i && !i.deletedAt);
  let scope = store.createUrlScope();
  let io = null;
  let closed = false;

  const sh = openSheet({ title: 'Photos, videos & notes', cls: 'ip-sheet', onClose: cleanup });

  function cleanup() {
    if (closed) return;
    closed = true;
    io?.disconnect();
    clearTimeout(searchTimer);
    scope.release();
  }

  // ---- controls ----
  const search = el('input', {
    class: 'input ip-search-input', type: 'search', placeholder: 'Search notes, tags, #number…',
    autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search', 'aria-label': 'Search',
  });
  let searchTimer = null;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = search.value; renderResults(); }, 140);
  });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search.blur(); } });

  const gridBtn = iconButton('grid', { title: 'Show as a grid', onclick: () => setView('grid') });
  const listBtn = iconButton('list', { title: 'Show as a list', onclick: () => setView('list') });
  const typeSeg = el('div', { class: 'seg ip-types', role: 'group', 'aria-label': 'Type' });
  const levelSeg = multiLevel ? el('div', { class: 'seg ip-levels', role: 'group', 'aria-label': 'Level' }) : null;
  const sortSel = el('select', { class: 'input ip-sort', 'aria-label': 'Sort' },
    el('option', { value: 'new' }, 'Newest first'),
    el('option', { value: 'old' }, 'Oldest first'),
    el('option', { value: 'seq' }, 'By number'));
  sortSel.value = state.sort;
  sortSel.addEventListener('change', () => { state.sort = sortSel.value; savePrefs({ view: state.view, sort: state.sort }); renderResults(); });
  const chipRow = el('div', { class: 'ip-chips' });
  const summary = el('div', { class: 'ip-summary' });
  const results = el('div', { class: 'ip-results' });

  const controls = el('div', { class: 'ip-controls' },
    el('div', { class: 'ip-row' },
      el('label', { class: 'ip-search' }, el('span', { class: 'ip-search-ic', html: icon('search', { size: 18 }) }), search),
      el('div', { class: 'ip-viewtoggle' }, gridBtn, listBtn)),
    el('div', { class: 'ip-row ip-row-wrap' }, typeSeg, levelSeg, sortSel),
    chipRow);
  sh.body.append(controls, summary, results);

  function setView(v) {
    state.view = v;
    savePrefs({ view: state.view, sort: state.sort });
    renderResults();
  }

  function visibleBase() {
    // The level filter applies before the counts, so "Photos 12" means 12 on this level.
    return state.level === 'this' ? all.filter((i) => i.levelId === project?.activeLevelId) : all;
  }

  function renderControls() {
    const base = visibleBase();
    const c = countTypes(base);
    typeSeg.replaceChildren(...[['all', 'All'], ['photo', 'Photos'], ['video', 'Videos'], ['note', 'Notes']].map(([v, label]) =>
      el('button', {
        type: 'button', class: state.type === v ? 'on' : '', 'aria-pressed': String(state.type === v),
        onclick: () => { state.type = v; renderControls(); renderResults(); },
      }, `${label} ${c[v]}`)));
    if (levelSeg) {
      const active = levelName.get(project.activeLevelId) || 'This level';
      levelSeg.replaceChildren(...[['this', active], ['all', 'All levels']].map(([v, label]) =>
        el('button', {
          type: 'button', class: state.level === v ? 'on' : '', 'aria-pressed': String(state.level === v),
          onclick: () => { state.level = v; renderControls(); renderResults(); },
        }, label)));
    }
    const tags = tagsInUse(base);
    for (const t of [...state.tags]) if (!tags.includes(t)) state.tags.delete(t);
    const chip = (label, on, onclick, ic) => el('button', { type: 'button', class: `chip${on ? ' on' : ''}`, 'aria-pressed': String(on), onclick },
      ic ? el('span', { html: icon(ic, { size: 15 }) }) : null, label);
    chipRow.replaceChildren(
      chip('Has notes', state.notesOnly, () => { state.notesOnly = !state.notesOnly; renderControls(); renderResults(); }, 'note'),
      ...tags.map((t) => chip(t, state.tags.has(t), () => {
        if (state.tags.has(t)) state.tags.delete(t); else state.tags.add(t);
        renderControls();
        renderResults();
      })));
    gridBtn.classList.toggle('on', state.view === 'grid');
    listBtn.classList.toggle('on', state.view === 'list');
  }

  function filtersOn() {
    return state.type !== 'all' || state.tags.size || state.notesOnly || state.query.trim();
  }

  function clearFilters() {
    state.type = 'all';
    state.tags.clear();
    state.notesOnly = false;
    state.query = '';
    search.value = '';
    renderControls();
    renderResults();
  }

  function renderResults() {
    if (closed) return;
    io?.disconnect();
    // A fresh scope per render keeps memory flat when filters change a lot.
    const old = scope;
    scope = store.createUrlScope();
    const base = visibleBase();
    const shown = sortItems(filterItems(base, {
      type: state.type, tags: [...state.tags], hasNotes: state.notesOnly, query: state.query,
    }), state.sort);

    summary.replaceChildren();
    if (!all.length) {
      results.replaceChildren(el('div', { class: 'empty' },
        el('div', { html: icon('camera', { size: 40 }) }),
        el('h2', {}, 'Nothing here yet'),
        el('p', {}, 'Take a photo or a video, or add a note — they show up here and on the plan.')));
      old.release();
      return;
    }
    const tagText = state.tags.size ? ` tagged ${[...state.tags].join(' or ')}` : '';
    summary.append(el('span', {}, filtersOn() || state.level === 'this'
      ? `${shown.length} of ${all.length}${tagText}`
      : `${all.length} item${all.length === 1 ? '' : 's'}`));
    if (filtersOn()) summary.append(el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: clearFilters }, 'Clear filters'));

    if (!shown.length) {
      results.replaceChildren(el('div', { class: 'empty' },
        el('div', { html: icon('search', { size: 36 }) }),
        el('h2', {}, 'No matches'),
        el('p', {}, state.level === 'this' && multiLevel ? 'Nothing on this level matches. Try All levels, or clear the filters.' : 'Try other words, or clear the filters.')));
      old.release();
      return;
    }

    const lazy = [];
    const container = state.view === 'grid'
      ? el('div', { class: 'thumb-grid ip-grid' }, shown.map((i) => gridTile(i, lazy)))
      : el('div', { class: 'list ip-list' }, shown.map((i) => listRow(i, lazy)));
    results.replaceChildren(container);
    old.release();
    observe(lazy);
  }

  function observe(lazy) {
    const load = async (img) => {
      const id = img.dataset.mid;
      if (!id || img.dataset.loaded) return;
      img.dataset.loaded = '1';
      try {
        const u = await scope.url(id);
        if (u && !closed && img.isConnected) { img.src = u; img.hidden = false; }
      } catch { /* missing thumbnail: the icon stays */ }
    };
    if (typeof IntersectionObserver !== 'function') { lazy.slice(0, 120).forEach(load); return; }
    io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); load(e.target); }
    }, { root: sh.body, rootMargin: '400px 0px' });
    lazy.forEach((img) => io.observe(img));
  }

  function openItem(item) {
    sh.close(true);
    cleanup();
    onOpen?.(item);
  }

  function badges(item) {
    const out = [];
    if (item.annotations?.shapes?.length || item.media?.annotated) out.push(el('span', { class: 'ip-flag', title: 'Marked up', html: icon('pen', { size: 13 }) }));
    if (item.voiceNotes?.length) out.push(el('span', { class: 'ip-flag', title: 'Voice notes', html: `${icon('mic', { size: 13 })}<b>${item.voiceNotes.length}</b>` }));
    if (String(item.text || '').trim() && item.type !== 'note') out.push(el('span', { class: 'ip-flag', title: 'Has notes', html: icon('note', { size: 13 }) }));
    return out;
  }

  function gridTile(item, lazy) {
    const tid = itemThumbId(item);
    const label = itemLabel(item);
    let inner;
    if (tid) {
      const img = el('img', { alt: '', hidden: true, decoding: 'async', dataset: { mid: tid } });
      lazy.push(img);
      inner = [el('span', { class: 'ip-ph', html: icon(itemIconName(item), { size: 28 }) }), img];
    } else {
      inner = [el('span', { class: 'ip-note-tile' }, el('span', { html: icon(itemIconName(item), { size: 18 }) }), el('span', { class: 'ip-note-text' }, noteExcerpt(item, 70) || 'Empty note'))];
    }
    return el('button', { type: 'button', class: `thumb ip-tile ip-${item.type}`, 'aria-label': `${label}${noteExcerpt(item) ? `: ${noteExcerpt(item)}` : ''}`, onclick: () => openItem(item) },
      ...inner,
      el('span', { class: 'thumb-n' }, `#${item.seq ?? ''}`),
      item.type === 'video' ? el('span', { class: 'thumb-kind', html: `${icon('play', { size: 11 })}${item.duration ? formatDuration(item.duration) : ''}` }) : null,
      el('span', { class: 'ip-flags' }, badges(item)));
  }

  function listRow(item, lazy) {
    const tid = itemThumbId(item);
    const img = tid ? el('img', { alt: '', hidden: true, decoding: 'async', dataset: { mid: tid } }) : null;
    if (img) lazy.push(img);
    const acc = item.pose?.geo?.acc;
    const meta = [
      formatDateTime(item.createdAt),
      multiLevel ? levelName.get(item.levelId) : null,
      item.type === 'video' && item.duration ? formatDuration(item.duration) : null,
      acc != null ? formatAccuracy(acc, units) : null,
    ].filter(Boolean).join(' · ');
    const excerpt = noteExcerpt(item, 110);
    return el('button', { type: 'button', class: 'list-row ip-row-item', onclick: () => openItem(item) },
      el('span', { class: 'ip-list-thumb' }, el('span', { class: 'ip-ph', html: icon(itemIconName(item), { size: 22 }) }), img),
      el('span', { class: 'grow' },
        el('span', { class: 't ip-list-title' }, itemLabel(item), (item.tags || []).length ? el('span', { class: 'ip-list-tags' }, ` · ${item.tags.join(', ')}`) : null),
        excerpt ? el('span', { class: 's ip-list-excerpt' }, excerpt) : null,
        el('span', { class: 's ip-list-meta' }, meta)),
      el('span', { class: 'ip-flags ip-flags-list' }, badges(item)));
  }

  renderControls();
  renderResults();
  return {
    close() {
      sh.close(true);
      cleanup();
    },
  };
}
