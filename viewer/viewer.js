/* viewer.js — the exported job walk viewer (inlined into index.html).
 *
 * Opens the job walk straight from the unzipped folder (file://) or from any
 * static web host, with no signal: the data is the JSON in
 * #jobwalk-data, the photos are files next to the page (media/...). So it
 * is a classic script — no modules and no fetch, both of which browsers
 * block for file:// pages.
 *
 * What it shows: the job info; a tab per level; the floor plan with the
 * same numbered pins, camera wedges and video paths as the app (pan and
 * zoom with a finger, the mouse wheel or the keyboard); a grid of every
 * photo, video and note with filters; a detail view (markup / original,
 * notes, voice notes, where and which way, the video with its path played
 * back on the plan); and Print report (a cover with the plans, then one card
 * per item). Levels without a floor plan show the satellite map when online
 * (Leaflet from unpkg, checked with SRI) and a list of coordinates offline.
 *
 * Every string from the data is put on the page as text (textContent,
 * attributes), never as HTML: notes are typed by people, and a page like
 * this may be uploaded to a website. File paths are only used when they are
 * plain relative paths inside media/.
 */
(function () {
  'use strict';

  const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  const LEAFLET_JS_SRI = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
  const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  const LEAFLET_CSS_SRI = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
  const ESRI_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const ESRI_ATTRIBUTION = 'Powered by Esri | Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community';
  const COLOR = { photo: '#c8371f', video: '#7b3fd1', note: '#d98a00', me: '#1a73e8' };
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const M_PER_FT = 0.3048;
  const TYPE_LABEL = { photo: 'Photo', video: 'Video', note: 'Note' };
  const SOURCE_LABEL = {
    'device-camera': "Taken with the phone's own camera app",
    import: "Imported from the phone's photos",
    recovered: 'Recovered after the app closed while recording',
  };

  // ---- pure helpers (Node-tested through JobWalkViewer) -----------------------------------

  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const pad2 = (n) => String(n).padStart(2, '0');

  function normDeg(d) {
    const r = d % 360;
    return r < 0 ? r + 360 : r;
  }

  function deltaDeg(a, b) {
    let d = normDeg(b - a);
    if (d > 180) d -= 360;
    return d;
  }

  function compassPoint(deg) {
    return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(normDeg(deg) / 45) % 8];
  }

  /** "NE 42°" */
  function fmtHeading(deg) {
    return isNum(deg) ? `${compassPoint(deg)} ${Math.round(normDeg(deg)) % 360}°` : '';
  }

  /** 3.81 m → 12' 6" (imperial) or 3.81 m — the same rules as js/core/util.js formatLength. */
  function fmtLength(meters, units) {
    if (!isNum(meters)) return '';
    if (units === 'metric') {
      const a = Math.abs(meters);
      return a >= 100 ? `${meters.toFixed(0)} m` : a >= 10 ? `${meters.toFixed(1)} m` : `${meters.toFixed(2)} m`;
    }
    const neg = meters < 0;
    let totalIn = Math.round(Math.abs(meters) / M_PER_FT * 12);
    let ft = Math.floor(totalIn / 12);
    let inch = totalIn - ft * 12;
    if (inch >= 12) { ft += 1; inch = 0; }
    const s = ft ? (inch ? `${ft}' ${inch}"` : `${ft}'`) : `${inch}"`;
    return neg ? `-${s}` : s;
  }

  /** ±4.0 ft / ±1.2 m */
  function fmtAccuracy(meters, units) {
    if (!isNum(meters)) return '';
    if (units === 'metric') return `±${meters < 10 ? meters.toFixed(1) : Math.round(meters)} m`;
    const ft = meters / M_PER_FT;
    return `±${ft < 10 ? ft.toFixed(1) : Math.round(ft)} ft`;
  }

  /** Camera tilt: "level", "12° down", "straight down". */
  function fmtTilt(pitch) {
    if (!isNum(pitch)) return '';
    const a = Math.round(Math.abs(pitch));
    if (a <= 2) return 'level';
    if (pitch <= -85) return 'straight down';
    if (pitch >= 85) return 'straight up';
    return `${a}° ${pitch > 0 ? 'up' : 'down'}`;
  }

  function fmtDuration(seconds) {
    if (!isNum(seconds)) return '';
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h ? `${h}:${pad2(m)}:${pad2(r)}` : `${m}:${pad2(r)}`;
  }

  function fmtDateTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    if (isNaN(d)) return '';
    try {
      return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      return d.toISOString();
    }
  }

  function fmtShortDateTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    if (isNaN(d)) return '';
    try {
      return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      return d.toISOString();
    }
  }

  /** 'YYYY-MM-DD' (a calendar day, no time zone) or ms → "Nov 2, 2026". */
  function fmtDate(v) {
    if (!v) return '';
    const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00`) : new Date(v);
    if (isNaN(d)) return String(v);
    try {
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) {
      return String(v);
    }
  }

  /**
   * A path from the data that is safe to load: relative, inside media/,
   * plain characters only. Anything else (a javascript: URL, "../", an
   * absolute URL) is refused, so even a hand-edited data block cannot point
   * the page somewhere else.
   */
  function safeSrc(p) {
    if (typeof p !== 'string') return null;
    if (!/^media\/[A-Za-z0-9._\-/]+$/.test(p)) return null;
    if (p.split('/').some((part) => part === '..' || part === '.' || part === '')) return null;
    return p;
  }

  function mapsUrl(lat, lng) {
    if (!isNum(lat) || !isNum(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(7)}%2C${lng.toFixed(7)}`;
  }

  function accuracyOf(pose, level) {
    if (!pose) return null;
    if (pose.geo && isNum(pose.geo.acc)) return pose.geo.acc;
    if (isNum(pose.planAcc) && level && isNum(level.pxPerMeter) && level.pxPerMeter > 0) return pose.planAcc / level.pxPerMeter;
    return null;
  }

  /** Camera direction on the plan, degrees clockwise from plan up. */
  function planHeadingOf(pose, level) {
    if (!pose) return null;
    if (isNum(pose.planHeading)) return pose.planHeading;
    if (isNum(pose.heading) && level && isNum(level.northAngle)) return normDeg(pose.heading - level.northAngle);
    return null;
  }

  /** A video's path on the plan: [{t, x, y, h}] (points without plan coordinates dropped). */
  function trackPoints(item, level) {
    const out = [];
    for (const p of item.track || []) {
      if (!p || !isNum(p.x) || !isNum(p.y)) continue;
      let hd = isNum(p.planHeading) ? p.planHeading : null;
      if (hd == null && isNum(p.heading) && level && isNum(level.northAngle)) hd = normDeg(p.heading - level.northAngle);
      out.push({ t: isNum(p.t) ? p.t : 0, x: p.x, y: p.y, h: hd });
    }
    return out;
  }

  /** The same for the map: [{t, lat, lng, h}] (true heading). */
  function trackGeo(item) {
    const out = [];
    for (const p of item.track || []) {
      if (!p || !isNum(p.lat) || !isNum(p.lng)) continue;
      out.push({ t: isNum(p.t) ? p.t : 0, lat: p.lat, lng: p.lng, h: isNum(p.heading) ? p.heading : null });
    }
    return out;
  }

  /** Where along a path the camera was at time t (ms since the start), interpolated. */
  function trackAt(points, t, keys) {
    if (!points.length) return null;
    const kx = keys ? keys[0] : 'x';
    const ky = keys ? keys[1] : 'y';
    if (t <= points[0].t) return { x: points[0][kx], y: points[0][ky], h: points[0].h };
    const last = points[points.length - 1];
    if (t >= last.t) return { x: last[kx], y: last[ky], h: last.h };
    let lo = 0;
    let hi = points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid].t <= t) lo = mid; else hi = mid;
    }
    const a = points[lo];
    const b = points[hi];
    const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    let hd = a.h;
    if (isNum(a.h) && isNum(b.h)) hd = normDeg(a.h + deltaDeg(a.h, b.h) * k);
    else if (!isNum(a.h)) hd = b.h;
    return { x: a[kx] + (b[kx] - a[kx]) * k, y: a[ky] + (b[ky] - a[ky]) * k, h: hd };
  }

  /** Where an item sits on its level's plan, or null. */
  function planPoint(item) {
    const p = item.pose && item.pose.plan;
    if (p && isNum(p.x) && isNum(p.y)) return { x: p.x, y: p.y };
    for (const t of item.track || []) if (t && isNum(t.x) && isNum(t.y)) return { x: t.x, y: t.y };
    return null;
  }

  function geoPoint(item) {
    const g = item.pose && item.pose.geo;
    if (g && isNum(g.lat) && isNum(g.lng)) return { lat: g.lat, lng: g.lng, acc: g.acc };
    for (const t of item.track || []) if (t && isNum(t.lat) && isNum(t.lng)) return { lat: t.lat, lng: t.lng, acc: t.acc };
    return null;
  }

  function itemLabel(item) {
    if (item.title && item.title.trim()) return item.title.trim();
    if (item.type === 'note' && item.text && item.text.trim()) {
      const first = item.text.trim().split('\n')[0];
      return first.length > 60 ? `${first.slice(0, 57)}…` : first;
    }
    if (item.tags && item.tags.length) return item.tags.join(', ');
    return TYPE_LABEL[item.type] || 'Item';
  }

  function searchText(item) {
    const parts = [`#${item.seq}`, String(item.seq), item.title, item.text, (item.tags || []).join(' '), item.capturedBy];
    for (const v of item.voiceNotes || []) parts.push(v.transcript);
    return parts.filter(Boolean).join(' \n ').toLowerCase();
  }

  /** f: {type: 'all'|'photo'|'video'|'note', tag, q, levelId (null = all levels)} */
  function matches(item, f) {
    if (f.levelId && item.levelId !== f.levelId) return false;
    if (f.type && f.type !== 'all' && item.type !== f.type) return false;
    if (f.tag && !(item.tags || []).includes(f.tag)) return false;
    const q = (f.q || '').trim().toLowerCase();
    if (q) {
      const text = searchText(item);
      for (const word of q.split(/\s+/)) if (!text.includes(word)) return false;
    }
    return true;
  }

  const api = {
    normDeg, compassPoint, fmtHeading, fmtLength, fmtAccuracy, fmtTilt, fmtDuration, fmtDate, safeSrc, mapsUrl,
    accuracyOf, planHeadingOf, trackPoints, trackAt, planPoint, geoPoint, itemLabel, matches,
  };
  if (typeof document === 'undefined') {
    globalThis.JobWalkViewer = api;
    return;
  }

  // ---- DOM helpers -------------------------------------------------------------------------

  const SVGNS = 'http://www.w3.org/2000/svg';

  /** h('div', {class, text, onclick, …attributes}, …children). Strings become text, never HTML. */
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of kids.flat(Infinity)) {
      if (c == null || c === false) continue;
      n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return n;
  }

  function svg(tag, attrs) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k of Object.keys(attrs || {})) if (attrs[k] != null) n.setAttribute(k, String(attrs[k]));
    return n;
  }

  // Constant icon shapes (Lucide style, ISC) — never data.
  const ICONS = {
    print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    close: '<path d="M18 6L6 18M6 6l12 12"/>',
    prev: '<path d="M15 18l-6-6 6-6"/>',
    next: '<path d="M9 18l6-6-6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
    play: '<path d="M7 4l13 8-13 8z"/>',
    note: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
    pin: '<path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>',
    pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  };

  function icon(name, cls) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('class', `ic ${cls || ''}`);
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = ICONS[name] || '';
    return s;
  }

  function iconButton(name, label, onclick, cls) {
    return h('button', { type: 'button', class: cls || 'icon-btn', 'aria-label': label, title: label, onclick }, icon(name));
  }

  function link(text, href, attrs) {
    if (!href) return document.createTextNode(text);
    return h('a', Object.assign({ href, target: '_blank', rel: 'noopener noreferrer' }, attrs || {}), text);
  }

  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  // ---- data ------------------------------------------------------------------------------------

  function readData() {
    const node = document.getElementById('jobwalk-data');
    if (!node) return null;
    try {
      const d = JSON.parse(node.textContent);
      return d && typeof d === 'object' && Array.isArray(d.items) && Array.isArray(d.levels) ? d : null;
    } catch (e) {
      return null;
    }
  }

  const D = readData();
  const app = document.getElementById('app');
  if (!D) {
    app.replaceChildren(h('div', { class: 'boot' },
      'This page has no job walk in it. Open the index.html that DCR Job Walk exported, from the unzipped folder.'));
    return;
  }

  const units = D.units === 'metric' ? 'metric' : 'imperial';
  const project = D.project || {};
  const levels = D.levels.filter((l) => l && typeof l.id === 'string');
  if (!levels.length) levels.push({ id: '_', name: 'Job walk', plan: null });
  const levelById = new Map(levels.map((l) => [l.id, l]));
  const items = D.items
    .filter((i) => i && typeof i.id === 'string')
    .map((i) => Object.assign({}, i, {
      levelId: levelById.has(i.levelId) ? i.levelId : levels[0].id,
      tags: Array.isArray(i.tags) ? i.tags.filter((t) => typeof t === 'string') : [],
      src: i.src || {},
      voiceNotes: Array.isArray(i.voiceNotes) ? i.voiceNotes : [],
    }))
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));

  const state = {
    levelId: (levels.find((l) => items.some((i) => i.levelId === l.id)) || levels[0]).id,
    type: 'all',
    tag: '',
    q: '',
    allLevels: false,
    showOriginal: false,
  };

  function scopeFilter(overrides) {
    return Object.assign({ type: state.type, tag: state.tag, q: state.q, levelId: state.allLevels ? null : state.levelId }, overrides || {});
  }
  const listItems = () => items.filter((i) => matches(i, scopeFilter()));
  const planItems = () => items.filter((i) => matches(i, scopeFilter({ levelId: state.levelId })));

  document.title = `${project.name || 'Job walk'} — DCR Job Walk`;

  // ---- page skeleton --------------------------------------------------------------------------------

  const tabsEl = h('nav', { class: 'tabs', 'aria-label': 'Levels' });
  const planWrap = h('section', { class: 'plan-wrap', 'aria-label': 'Floor plan' });
  const listPanel = h('section', { class: 'list-panel', 'aria-label': 'Photos, videos and notes' });
  const mainEl = h('main', { class: 'main split' }, planWrap, listPanel);
  app.replaceChildren(renderHeader(), tabsEl, mainEl, renderFooter());

  function renderHeader() {
    const meta = h('div', { class: 'vh-meta' });
    const add = (label, value) => { if (value) meta.append(h('span', null, `${label} `, h('b', null, value))); };
    if (project.address) meta.append(h('span', null, project.address));
    add('GC', project.gc);
    add('DCR job #', project.number);
    add('Walk', fmtDate(project.walkDate));
    const counts = countText(items);
    const sub = [counts, D.exportedAt ? `Exported ${fmtDateTime(D.exportedAt)}${D.exportedBy ? ` by ${D.exportedBy}` : ''}` : ''].filter(Boolean).join(' · ');
    const head = h('header', { class: 'vh' },
      h('div', { class: 'vh-row' },
        h('div', { class: 'logo', 'aria-label': 'DCR Job Walk' },
          h('div', { class: 'logo-mark', 'aria-hidden': 'true' }, 'DCR'),
          h('div', { class: 'logo-text' }, 'Job Walk', h('small', null, D.company || 'DCR Framing'))),
        h('div', { class: 'vh-title' }, h('h1', null, project.name || 'Job walk'), meta, h('div', { class: 'vh-sub' }, sub)),
        h('div', { class: 'vh-actions' },
          h('button', { type: 'button', class: 'btn', onclick: () => startPrint(), title: 'Print a report: the plans with every pin, then one card per item' },
            icon('print'), h('span', null, 'Print report')))));
    if (project.notes) head.append(h('div', { class: 'vh-notes' }, project.notes));
    return head;
  }

  function renderFooter() {
    return h('footer', { class: 'foot' },
      `Made with DCR Job Walk${D.appVersion ? ` ${D.appVersion}` : ''}. All the data is in jobwalk.json next to this page; import the .zip into DCR Job Walk to keep working on it.`);
  }

  function countText(list) {
    const n = { photo: 0, video: 0, note: 0 };
    for (const i of list) if (n[i.type] != null) n[i.type]++;
    const parts = [];
    if (n.photo) parts.push(`${n.photo} photo${n.photo > 1 ? 's' : ''}`);
    if (n.video) parts.push(`${n.video} video${n.video > 1 ? 's' : ''}`);
    if (n.note) parts.push(`${n.note} note${n.note > 1 ? 's' : ''}`);
    return parts.join(' · ') || 'No photos, videos or notes';
  }

  // ---- level tabs ------------------------------------------------------------------------------------

  function renderTabs() {
    tabsEl.replaceChildren(...levels.map((l) => {
      const n = items.filter((i) => i.levelId === l.id).length;
      return h('button', {
        type: 'button', class: `tab${l.id === state.levelId ? ' on' : ''}`, 'aria-pressed': l.id === state.levelId ? 'true' : 'false',
        onclick: () => { if (state.levelId !== l.id) { state.levelId = l.id; renderTabs(); renderPlan(); renderList(); } },
      }, l.name || 'Level', h('span', { class: 'n' }, String(n)));
    }));
  }

  // ---- plan / map panel ---------------------------------------------------------------------------------

  let mainView = null;
  let unplacedEl = null;

  function renderPlan() {
    if (mainView) { mainView.destroy(); mainView = null; }
    const lvl = levelById.get(state.levelId);
    const stage = h('div', { class: 'plan-stage' });
    const legend = h('div', { class: 'legend', 'aria-hidden': 'true' },
      h('span', null, h('i', { class: 'photo' }), 'Photo'), h('span', null, h('i', { class: 'video' }), 'Video path'), h('span', null, h('i', { class: 'note' }), 'Note'));
    const countEl = h('span', { class: 'muted' });
    const panel = h('div', { class: 'plan-panel' },
      h('div', { class: 'plan-head' }, h('h2', null, lvl.name || 'Level'), countEl, legend), stage);
    unplacedEl = h('div', { class: 'unplaced', hidden: true });
    panel.append(unplacedEl);
    planWrap.replaceChildren(panel);

    if (lvl.plan && safeSrc(lvl.plan.src)) {
      mainView = createPlanView(stage, lvl, { onTap: (it) => openItem(it, planItems()) });
      stage.append(
        h('div', { class: 'plan-tools' },
          iconButton('plus', 'Zoom in', () => mainView && mainView.zoom(1.6)),
          iconButton('minus', 'Zoom out', () => mainView && mainView.zoom(1 / 1.6)),
          iconButton('fit', 'Show the whole plan', () => mainView && mainView.fit())),
        h('div', { class: 'plan-hint' }, 'Drag to move · pinch or scroll to zoom · tap a pin'));
    } else if (lvl.plan) {
      stage.append(h('div', { class: 'pv-msg' }, 'The floor plan for this level is not in this folder. Keep index.html next to the media folder it came with.'));
    } else {
      mainView = createMapView(stage, lvl, { onTap: (it) => openItem(it, planItems()) });
    }
    updatePlanItems(countEl);
  }

  function updatePlanItems(countEl) {
    const lvl = levelById.get(state.levelId);
    const list = planItems();
    if (mainView) mainView.setItems(list);
    const head = countEl || planWrap.querySelector('.plan-head .muted');
    if (head) head.textContent = countText(list);
    if (!unplacedEl) return;
    const loose = lvl.plan ? list.filter((i) => !planPoint(i)) : list.filter((i) => !geoPoint(i));
    unplacedEl.hidden = !loose.length;
    if (loose.length) {
      unplacedEl.replaceChildren(
        h('div', null, lvl.plan
          ? `${loose.length} item${loose.length > 1 ? 's have' : ' has'} no spot on this plan (taken before the plan was calibrated, or without a position):`
          : `${loose.length} item${loose.length > 1 ? 's have' : ' has'} no position:`),
        h('div', { class: 'chips' }, loose.map((i) => h('button', { type: 'button', class: 'chip', onclick: () => openItem(i, loose) }, `#${i.seq} ${itemLabel(i)}`))));
    }
  }

  // ---- canvas plan view ---------------------------------------------------------------------------------
  //
  // The plan image is drawn with a transform (screen = plan × s + offset); pins,
  // wedges and paths are drawn on top in screen pixels so they stay the same
  // size at any zoom. Redrawn only when something changes (one rAF).

  function createPlanView(host, level, opts) {
    opts = opts || {};
    const interactive = opts.interactive !== false;
    const wrap = h('div', { class: 'pv' });
    const canvas = h('canvas', {
      class: 'pv-canvas', role: 'img',
      'aria-label': interactive ? `Floor plan, ${level.name || 'level'}. Drag to move, pinch or scroll to zoom, tap a pin to open it. Keys: + and − zoom, arrows move, 0 shows the whole plan.` : `Where on ${level.name || 'the plan'}`,
    });
    if (interactive) canvas.tabIndex = 0;
    const msg = h('div', { class: 'pv-msg' }, 'Loading the floor plan…');
    wrap.append(canvas, msg);
    host.append(wrap);
    const ctx = canvas.getContext('2d');
    let W = level.plan.width || 0;
    let H = level.plan.height || 0;
    const img = new Image();
    let loaded = false;
    const view = { s: 1, x: 0, y: 0 };
    let fitS = 1;
    let cssW = 0;
    let cssH = 0;
    let dpr = 1;
    let touched = false;
    let list = [];
    let selectedId = null;
    let play = null;
    let raf = 0;
    let destroyed = false;
    const box = opts.box || null;

    img.decoding = 'async';
    img.onload = () => {
      if (destroyed) return;
      loaded = true;
      if (!W || !H) { W = img.naturalWidth; H = img.naturalHeight; }
      msg.remove();
      if (!touched) fit();
      schedule();
    };
    img.onerror = () => {
      if (destroyed) return;
      msg.textContent = 'The floor plan image is missing from this folder. Keep index.html next to the media folder it came with.';
      schedule();
    };
    const src = safeSrc(level.plan.src);
    if (src) img.src = src; else img.onerror();

    function schedule() {
      if (!raf && !destroyed) raf = requestAnimationFrame(() => { raf = 0; draw(); });
    }

    function resize() {
      const r = wrap.getBoundingClientRect();
      if (!r.width || !r.height) return;
      cssW = r.width;
      cssH = r.height;
      dpr = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      if (!touched) fit(); else schedule();
    }

    function fit() {
      if (!cssW || !cssH || !W || !H) return;
      const b = box || { x0: 0, y0: 0, x1: W, y1: H };
      const bw = Math.max(1, b.x1 - b.x0);
      const bh = Math.max(1, b.y1 - b.y0);
      const pad = Math.min(24, cssW * 0.04);
      fitS = Math.max(1e-4, Math.min((cssW - pad * 2) / bw, (cssH - pad * 2) / bh));
      view.s = fitS;
      view.x = (cssW - bw * fitS) / 2 - b.x0 * fitS;
      view.y = (cssH - bh * fitS) / 2 - b.y0 * fitS;
      touched = false;
      schedule();
    }

    const clampS = (s) => Math.max(fitS * 0.5, Math.min(Math.max(fitS * 40, 4), s));

    function zoomAt(px, py, f) {
      const ns = clampS(view.s * f);
      const k = ns / view.s;
      view.x = px - (px - view.x) * k;
      view.y = py - (py - view.y) * k;
      view.s = ns;
      touched = true;
      schedule();
    }

    const toScreen = (p) => ({ x: p.x * view.s + view.x, y: p.y * view.s + view.y });

    function draw() {
      if (destroyed || !cssW) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      if (!W || !H) return;
      ctx.save();
      ctx.translate(view.x, view.y);
      ctx.scale(view.s, view.s);
      if (loaded) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, W, H);
      } else {
        ctx.fillStyle = 'rgba(128, 128, 128, 0.10)';
        ctx.fillRect(0, 0, W, H);
      }
      ctx.restore();
      const sel = list.find((i) => i.id === selectedId) || null;
      for (const it of list) if (it.type === 'video') drawVideoItem(it, it.id === selectedId || (play && play.item.id === it.id));
      for (const it of list) if (it.type !== 'video' && it !== sel) drawPinItem(it, false);
      if (sel && sel.type !== 'video') drawPinItem(sel, true);
      if (play) drawPlayhead();
    }

    function drawPinItem(it, selected) {
      const p = planPoint(it);
      if (!p) return;
      const s = toScreen(p);
      if (it.type === 'note') drawNotePin(ctx, s.x, s.y, it.seq, selected);
      else drawPhotoPin(ctx, s.x, s.y, planHeadingOf(it.pose, level), it.seq, selected, it.type === 'video' ? COLOR.video : COLOR.photo, it.type === 'photo' && !!it.hasMarkup);
    }

    function drawVideoItem(it, selected) {
      const pts = trackPoints(it, level).map(toScreen);
      if (pts.length < 2) { drawPinItem(it, selected); return; }
      drawVideoPath(ctx, pts, it.seq, selected);
    }

    function drawPlayhead() {
      const at = trackAt(trackPoints(play.item, level), play.t);
      if (!at) return;
      const s = toScreen(at);
      drawPlayheadMark(ctx, s.x, s.y, at.h, COLOR.video);
    }

    function hit(px, py) {
      let best = null;
      let bestD = 20;
      for (const it of list) {
        if (it.type === 'video') {
          const pts = trackPoints(it, level).map(toScreen);
          if (pts.length >= 2) {
            const d0 = Math.hypot(px - pts[0].x, py - pts[0].y);
            if (d0 < bestD) { best = it; bestD = d0; }
            for (let k = 1; k < pts.length; k++) {
              const d = segDist(px, py, pts[k - 1], pts[k]);
              if (d < 10 && d < bestD) { best = it; bestD = d; }
            }
            continue;
          }
        }
        const p = planPoint(it);
        if (!p) continue;
        const s = toScreen(p);
        const d = Math.hypot(px - s.x, py - s.y);
        if (d < bestD) { best = it; bestD = d; }
      }
      return best;
    }

    // ---- gestures: one finger pans, two pinch, the wheel zooms, a tap opens a pin

    const pointers = new Map();
    let gesture = null;
    let lastTap = null;

    function local(e) {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function startGesture(afterMulti) {
      const ps = [...pointers.values()];
      if (ps.length === 1) {
        gesture = { kind: 'pan', x0: ps[0].x, y0: ps[0].y, vx: view.x, vy: view.y, moved: !!afterMulti, t: Date.now() };
      } else if (ps.length >= 2) {
        const a = ps[0];
        const b = ps[1];
        gesture = {
          kind: 'pinch', d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
          s0: view.s, vx: view.x, vy: view.y,
        };
      } else {
        gesture = null;
      }
    }

    function onDown(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
      pointers.set(e.pointerId, local(e));
      startGesture(pointers.size > 1);
      e.preventDefault();
    }

    function onMove(e) {
      if (!pointers.has(e.pointerId)) {
        if (e.pointerType === 'mouse') {
          const p = local(e);
          const it = hit(p.x, p.y);
          canvas.classList.toggle('over-pin', !!it);
          canvas.title = it ? `#${it.seq} ${itemLabel(it)}` : '';
        }
        return;
      }
      pointers.set(e.pointerId, local(e));
      const g = gesture;
      if (!g) return;
      if (g.kind === 'pan') {
        const p = pointers.values().next().value;
        const dx = p.x - g.x0;
        const dy = p.y - g.y0;
        if (!g.moved && Math.hypot(dx, dy) > 6) { g.moved = true; canvas.classList.add('dragging'); }
        if (g.moved) {
          view.x = g.vx + dx;
          view.y = g.vy + dy;
          touched = true;
          schedule();
        }
      } else if (pointers.size >= 2) {
        const ps = [...pointers.values()];
        const a = ps[0];
        const b = ps[1];
        const d = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const ns = clampS(g.s0 * d / g.d0);
        const planX = (g.mx - g.vx) / g.s0;
        const planY = (g.my - g.vy) / g.s0;
        view.s = ns;
        view.x = mx - planX * ns;
        view.y = my - planY * ns;
        touched = true;
        schedule();
      }
    }

    function onUp(e) {
      if (!pointers.has(e.pointerId)) return;
      const g = gesture;
      pointers.delete(e.pointerId);
      canvas.classList.remove('dragging');
      if (g && g.kind === 'pan' && !g.moved && e.type === 'pointerup' && Date.now() - g.t < 600) tap(g.x0, g.y0);
      startGesture(true);
    }

    function tap(x, y) {
      const it = hit(x, y);
      if (it) { lastTap = null; if (opts.onTap) opts.onTap(it); return; }
      const now = Date.now();
      if (lastTap && now - lastTap.t < 330 && Math.hypot(x - lastTap.x, y - lastTap.y) < 30) {
        zoomAt(x, y, 2);
        lastTap = null;
      } else {
        lastTap = { x, y, t: now };
      }
    }

    function onWheel(e) {
      e.preventDefault();
      const p = local(e);
      const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0015;
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * unit));
    }

    function onKey(e) {
      const step = 60;
      let used = true;
      if (e.key === '+' || e.key === '=') zoomAt(cssW / 2, cssH / 2, 1.4);
      else if (e.key === '-' || e.key === '_') zoomAt(cssW / 2, cssH / 2, 1 / 1.4);
      else if (e.key === '0') fit();
      else if (e.key === 'ArrowLeft') { view.x += step; touched = true; schedule(); }
      else if (e.key === 'ArrowRight') { view.x -= step; touched = true; schedule(); }
      else if (e.key === 'ArrowUp') { view.y += step; touched = true; schedule(); }
      else if (e.key === 'ArrowDown') { view.y -= step; touched = true; schedule(); }
      else used = false;
      if (used) e.preventDefault();
    }

    if (interactive) {
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointercancel', onUp);
      canvas.addEventListener('lostpointercapture', onUp);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.addEventListener('keydown', onKey);
    }
    let ro = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => resize());
      ro.observe(wrap);
    } else {
      window.addEventListener('resize', resize);
    }
    requestAnimationFrame(resize);

    return {
      setItems(next, o) {
        list = next || [];
        if (o && 'selectedId' in o) selectedId = o.selectedId;
        schedule();
      },
      select(id) { selectedId = id; schedule(); },
      setPlayback(item, t) { play = item ? { item, t: t || 0 } : null; schedule(); },
      fit,
      zoom(f) { zoomAt(cssW / 2, cssH / 2, f); },
      centerOn(item) {
        const p = planPoint(item);
        if (!p || !cssW) return;
        const ns = clampS(Math.max(view.s, fitS * 3));
        view.s = ns;
        view.x = cssW / 2 - p.x * ns;
        view.y = cssH / 2 - p.y * ns;
        touched = true;
        selectedId = item.id;
        schedule();
      },
      destroy() {
        destroyed = true;
        if (raf) cancelAnimationFrame(raf);
        if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
        img.onload = null;
        img.onerror = null;
        img.removeAttribute('src');
        wrap.remove();
      },
    };
  }

  function tracePath(c, pts) {
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (let k = 1; k < pts.length; k++) c.lineTo(pts[k].x, pts[k].y);
  }

  // The pin drawing below is a copy of js/ui/markers.js (the viewer cannot
  // import modules), so a pin looks the same here as in the app: sizes in CSS
  // pixels, a soft offset disc instead of shadowBlur (fast with many pins),
  // a 60° camera wedge, numbers that grow into a pill past two digits.

  const WEDGE_HALF = 30 * Math.PI / 180;
  const MARKUP_DOT = '#ffd23f';
  const canvasAngle = (deg) => (deg - 90) * Math.PI / 180;
  const widthCache = new Map();

  function textWidth(c, text, font) {
    const key = `${font}|${text}`;
    let w = widthCache.get(key);
    if (w == null) {
      c.font = font;
      w = c.measureText(text).width || 0;
      if (widthCache.size > 2000) widthCache.clear();
      widthCache.set(key, w);
    }
    return w;
  }

  function disc(c, x, y, r, fill, ring, ringColor) {
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fillStyle = fill;
    c.fill();
    if (ring) {
      c.lineWidth = ring;
      c.strokeStyle = ringColor || '#fff';
      c.stroke();
    }
  }

  /** Small white chevrons along a video path every `spacing` px, pointing the way it was walked. */
  function drawChevrons(c, points, spacing, size) {
    let carry = spacing * 0.6;
    c.beginPath();
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.01) continue;
      const ux = dx / len;
      const uy = dy / len;
      let at = carry;
      while (at <= len) {
        const px = a.x + ux * at;
        const py = a.y + uy * at;
        c.moveTo(px - ux * size - uy * size, py - uy * size + ux * size);
        c.lineTo(px + ux * size * 0.6, py + uy * size * 0.6);
        c.lineTo(px - ux * size + uy * size, py - uy * size - ux * size);
        at += spacing;
      }
      carry = at - len;
    }
    c.lineWidth = 1.8;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    c.stroke();
  }

  /** A video's path: purple with a white casing, chevrons, the number at the start, a ring at the end. */
  function drawVideoPath(c, pts, n, selected) {
    c.save();
    c.lineJoin = 'round';
    c.lineCap = 'round';
    tracePath(c, pts);
    c.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    c.lineWidth = selected ? 9.5 : 6.5;
    c.stroke();
    c.strokeStyle = COLOR.video;
    c.lineWidth = selected ? 6 : 3.6;
    c.stroke();
    drawChevrons(c, pts, selected ? 64 : 84, selected ? 3.6 : 2.8);
    const e = pts[pts.length - 1];
    disc(c, e.x, e.y, selected ? 6.5 : 5.2, '#fff', 3, COLOR.video);
    drawBody(c, pts[0].x, pts[0].y, n, COLOR.video, selected ? 1.15 : 0.95, selected, 'circle');
    c.restore();
  }

  /** Where the camera was at this moment of the video, and which way it looked. */
  function drawPlayheadMark(c, x, y, hdeg, color) {
    c.save();
    if (isNum(hdeg)) {
      const a = canvasAngle(hdeg);
      const g = c.createRadialGradient(x, y, 0, x, y, 70);
      g.addColorStop(0, rgba(color, 0.6));
      g.addColorStop(1, rgba(color, 0));
      c.beginPath();
      c.moveTo(x, y);
      c.arc(x, y, 70, a - WEDGE_HALF, a + WEDGE_HALF);
      c.closePath();
      c.fillStyle = g;
      c.fill();
    }
    disc(c, x, y + 1.2, 12, 'rgba(0, 0, 0, 0.22)');
    disc(c, x, y, 10, color, 3);
    disc(c, x, y, 3.2, '#fff');
    c.restore();
  }

  function segDist(px, py, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }

  /** A translucent wedge from (x, y) toward hdeg (degrees clockwise from plan up), fading with distance. */
  function drawWedge(c, x, y, hdeg, radius, color, alpha) {
    const a = canvasAngle(hdeg);
    const g = c.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, rgba(color, alpha));
    g.addColorStop(1, rgba(color, alpha * 0.15));
    c.beginPath();
    c.moveTo(x, y);
    c.arc(x, y, radius, a - WEDGE_HALF, a + WEDGE_HALF);
    c.closePath();
    c.fillStyle = g;
    c.fill();
    c.lineWidth = 1.25;
    c.strokeStyle = rgba(color, Math.min(1, alpha + 0.25));
    c.stroke();
  }

  function roundRectPath(c, x, y, w, hgt, r) {
    const rr = Math.max(0, Math.min(r, w / 2, hgt / 2));
    c.beginPath();
    c.moveTo(x + rr, y);
    c.lineTo(x + w - rr, y);
    c.arcTo(x + w, y, x + w, y + rr, rr);
    c.lineTo(x + w, y + hgt - rr);
    c.arcTo(x + w, y + hgt, x + w - rr, y + hgt, rr);
    c.lineTo(x + rr, y + hgt);
    c.arcTo(x, y + hgt, x, y + hgt - rr, rr);
    c.lineTo(x, y + rr);
    c.arcTo(x, y, x + rr, y, rr);
    c.closePath();
  }

  /** The outline of a pin body: a circle (a pill for long numbers), or a note's dog-eared square. */
  function bodyPath(c, shape, x, y, halfW, r) {
    if (shape === 'note') {
      const f = r * 0.62;
      const x0 = x - halfW;
      const x1 = x + halfW;
      const y0 = y - r;
      const y1 = y + r;
      const k = 3;
      c.beginPath();
      c.moveTo(x0 + k, y0);
      c.lineTo(x1 - f, y0);
      c.lineTo(x1, y0 + f);
      c.lineTo(x1, y1 - k);
      c.arcTo(x1, y1, x1 - k, y1, k);
      c.lineTo(x0 + k, y1);
      c.arcTo(x0, y1, x0, y1 - k, k);
      c.lineTo(x0, y0 + k);
      c.arcTo(x0, y0, x0 + k, y0, k);
      c.closePath();
    } else if (halfW > r + 0.5) {
      roundRectPath(c, x - halfW, y - r, halfW * 2, r * 2, r);
    } else {
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
    }
  }

  /** The numbered body of a pin; returns its half width and radius (for the markup dot). */
  function drawBody(c, x, y, label, color, k, selected, shape) {
    const text = label == null || label === '' ? '' : String(label);
    const fs = Math.round((text.length >= 3 ? 10.5 : 12) * k);
    const font = `700 ${fs}px ${FONT}`;
    const r = 12 * k;
    const tw = text ? textWidth(c, text, font) : 0;
    const halfW = shape === 'note' ? Math.max(r, tw / 2 + 5 * k) : Math.max(r, tw / 2 + 6 * k);
    bodyPath(c, shape, x, y + 1.6 * k, halfW + 1.4, r + 1.4);
    c.fillStyle = 'rgba(0, 0, 0, 0.24)';
    c.fill();
    if (selected) {
      bodyPath(c, shape, x, y, halfW + 6 * k, r + 6 * k);
      c.fillStyle = rgba(color, 0.3);
      c.fill();
    }
    bodyPath(c, shape, x, y, halfW, r);
    c.fillStyle = color;
    c.fill();
    c.lineWidth = selected ? 3 : 2.25;
    c.strokeStyle = '#fff';
    c.stroke();
    if (shape === 'note') {
      const f = r * 0.62;
      c.beginPath();
      c.moveTo(x + halfW - f, y - r);
      c.lineTo(x + halfW - f, y - r + f);
      c.lineTo(x + halfW, y - r + f);
      c.closePath();
      c.fillStyle = 'rgba(255, 255, 255, 0.75)';
      c.fill();
    }
    if (text) {
      c.font = font;
      c.fillStyle = '#fff';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(text, x, y + 0.5 * k);
    }
    return { halfW, r };
  }

  /** A photo: a numbered circle and a 60° wedge where the camera looked; a yellow dot when it has markup. */
  function drawPhotoPin(c, x, y, hdeg, n, selected, color, annotated) {
    const k = selected ? 1.2 : 1;
    c.save();
    if (isNum(hdeg)) drawWedge(c, x, y, hdeg, 46 * k, color, selected ? 0.62 : 0.46);
    const { halfW, r } = drawBody(c, x, y, n, color, k, selected, 'circle');
    if (annotated) disc(c, x + Math.max(halfW - 3 * k, r * 0.72), y - r * 0.72, 4.6 * k, MARKUP_DOT, 1.6);
    c.restore();
  }

  /** A note: a numbered amber square with a folded corner. */
  function drawNotePin(c, x, y, n, selected) {
    c.save();
    drawBody(c, x, y, n, COLOR.note, selected ? 1.2 : 1, selected, 'note');
    c.restore();
  }

  // ---- satellite map (levels without a floor plan) ------------------------------------------------------

  let leafletPromise = null;

  /** Leaflet from unpkg, checked against its published SHA-256 (SRI). Rejects offline or on failure. */
  function loadLeaflet() {
    if (window.L && typeof window.L.map === 'function') return Promise.resolve(window.L);
    if (leafletPromise) return leafletPromise;
    if (navigator.onLine === false) return Promise.reject(new Error('offline'));
    leafletPromise = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = LEAFLET_CSS;
      css.integrity = LEAFLET_CSS_SRI;
      css.crossOrigin = 'anonymous';
      document.head.append(css);
      const s = document.createElement('script');
      s.src = LEAFLET_JS;
      s.integrity = LEAFLET_JS_SRI;
      s.crossOrigin = 'anonymous';
      const timer = setTimeout(() => reject(new Error('timeout')), 15000);
      s.onload = () => {
        clearTimeout(timer);
        if (window.L && typeof window.L.map === 'function') resolve(window.L); else reject(new Error('no Leaflet'));
      };
      s.onerror = () => { clearTimeout(timer); reject(new Error('failed')); };
      document.head.append(s);
    });
    leafletPromise.catch(() => { leafletPromise = null; });
    return leafletPromise;
  }

  function mapPinElement(it) {
    const el = h('div', { class: `mv-pin ${it.type}` });
    const hd = it.pose && isNum(it.pose.heading) ? it.pose.heading : null;
    if (hd != null && it.type !== 'note') {
      const s = svg('svg', { viewBox: '-40 -40 80 80', 'aria-hidden': 'true' });
      const a = (hd - 90) * Math.PI / 180;
      const half = WEDGE_HALF;
      const R = 38;
      const p1 = [R * Math.cos(a - half), R * Math.sin(a - half)];
      const p2 = [R * Math.cos(a + half), R * Math.sin(a + half)];
      const color = it.type === 'video' ? COLOR.video : COLOR.photo;
      s.append(svg('path', { d: `M0 0 L${p1[0].toFixed(1)} ${p1[1].toFixed(1)} A${R} ${R} 0 0 1 ${p2[0].toFixed(1)} ${p2[1].toFixed(1)} Z`, fill: rgba(color, 0.32), stroke: rgba(color, 0.75), 'stroke-width': 1.5 }));
      el.append(s);
    }
    el.append(h('b', null, String(it.seq)));
    return el;
  }

  function createMapView(host, level, opts) {
    const wrap = h('div', { class: 'mv' });
    const msg = h('div', { class: 'pv-msg' }, 'Loading the satellite map…');
    wrap.append(msg);
    host.append(wrap);
    let map = null;
    let layer = null;
    let L = null;
    let list = [];
    let fellBack = null;
    let destroyed = false;
    let bounds = null;
    let ro = null;

    function fallback(reason) {
      if (destroyed) return;
      fellBack = reason || 'offline';
      wrap.replaceChildren(geoList(list, fellBack, opts.onTap));
    }

    loadLeaflet().then((Lx) => {
      if (destroyed) return;
      L = Lx;
      msg.remove();
      map = L.map(wrap, { maxZoom: 22, zoomSnap: 0.5, attributionControl: true });
      L.tileLayer(ESRI_TILES, { maxZoom: 22, maxNativeZoom: 19, crossOrigin: true, attribution: ESRI_ATTRIBUTION }).addTo(map);
      layer = L.layerGroup().addTo(map);
      render(true);
      if (typeof ResizeObserver === 'function') {
        ro = new ResizeObserver(() => map && map.invalidateSize());
        ro.observe(wrap);
      }
    }, () => fallback(navigator.onLine === false ? 'offline' : 'failed'));

    function render(refit) {
      if (!map) { if (fellBack) fallback(fellBack); return; }
      layer.clearLayers();
      const pts = [];
      for (const it of list) {
        const open = () => opts.onTap && opts.onTap(it);
        if (it.type === 'video') {
          const g = trackGeo(it);
          if (g.length >= 2) {
            const ll = g.map((p) => [p.lat, p.lng]);
            L.polyline(ll, { color: '#ffffff', weight: 8, opacity: 0.85 }).addTo(layer);
            L.polyline(ll, { color: COLOR.video, weight: 4.5 }).on('click', open).addTo(layer);
            pts.push(...ll);
          }
        }
        const p = geoPoint(it);
        if (!p) continue;
        const pinIcon = L.divIcon({ className: 'mv-pin-host', html: mapPinElement(it), iconSize: [30, 30], iconAnchor: [15, 15] });
        L.marker([p.lat, p.lng], { icon: pinIcon, title: `#${it.seq} ${itemLabel(it)}`, keyboard: true }).on('click', open).addTo(layer);
        pts.push([p.lat, p.lng]);
      }
      if (refit || !bounds) {
        if (pts.length) {
          bounds = L.latLngBounds(pts);
          map.fitBounds(bounds, { padding: [40, 40], maxZoom: 20 });
        } else if (project.origin && isNum(project.origin.lat) && isNum(project.origin.lng)) {
          map.setView([project.origin.lat, project.origin.lng], 18);
        } else {
          map.setView([39.5, -98.35], 4);
        }
      }
    }

    return {
      setItems(next) { list = next || []; render(false); },
      select() {},
      setPlayback() {},
      fit() { if (map && bounds) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 20 }); },
      zoom(f) { if (map) map.setZoom(map.getZoom() + (f > 1 ? 1 : -1)); },
      centerOn(item) { const p = geoPoint(item); if (map && p) map.setView([p.lat, p.lng], Math.max(map.getZoom(), 19)); },
      destroy() {
        destroyed = true;
        if (ro) ro.disconnect();
        if (map) map.remove();
        wrap.remove();
      },
    };
  }

  /** The offline stand-in for the map: every item with its coordinates and a Google Maps link. */
  function geoList(list, reason, onTap) {
    const box = h('div', { class: 'geo-list' },
      h('h3', null, 'No floor plan for this level'),
      h('p', null, reason === 'offline'
        ? 'The satellite map needs an internet connection. Here is where each item was taken:'
        : 'The satellite map could not be loaded. Here is where each item was taken:'));
    if (!list.length) box.append(h('p', null, 'Nothing on this level matches.'));
    for (const it of list) {
      const p = geoPoint(it);
      box.append(h('div', { class: 'geo-row' },
        h('button', { type: 'button', class: 'chip', onclick: () => onTap && onTap(it) }, `#${it.seq}`),
        h('div', { class: 'grow' },
          h('div', null, itemLabel(it)),
          h('div', { class: 'mono' }, p ? `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}${isNum(p.acc) ? `  ${fmtAccuracy(p.acc, units)}` : ''}` : 'No position')),
        p ? link('Google Maps', mapsUrl(p.lat, p.lng)) : null));
    }
    return box;
  }

  // ---- filters and grid ---------------------------------------------------------------------------------

  const typeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' });
  const tagSelect = h('select', { class: 'input', 'aria-label': 'Tag' });
  const searchInput = h('input', { class: 'input search', type: 'search', placeholder: 'Search notes, titles, tags, #', 'aria-label': 'Search', autocomplete: 'off', enterkeyhint: 'search' });
  const allLevelsBox = h('input', { type: 'checkbox' });
  const countLine = h('p', { class: 'count', 'aria-live': 'polite' });
  const gridEl = h('div', { class: 'grid' });
  const filtersEl = h('div', { class: 'filters' }, typeSeg, tagSelect, searchInput,
    levels.length > 1 ? h('label', { class: 'check' }, allLevelsBox, 'All levels') : null);
  listPanel.append(filtersEl, countLine, gridEl);

  tagSelect.addEventListener('change', () => { state.tag = tagSelect.value; renderList(); updatePlanItems(); });
  let searchTimer = 0;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = searchInput.value; renderList(); updatePlanItems(); }, 150);
  });
  allLevelsBox.addEventListener('change', () => { state.allLevels = allLevelsBox.checked; renderList(); });

  function renderFilters() {
    const scope = items.filter((i) => matches(i, scopeFilter({ type: 'all' })));
    const n = { all: scope.length, photo: 0, video: 0, note: 0 };
    for (const i of scope) if (n[i.type] != null) n[i.type]++;
    typeSeg.replaceChildren(...[['all', 'All'], ['photo', 'Photos'], ['video', 'Videos'], ['note', 'Notes']].map(([k, label]) =>
      h('button', {
        type: 'button', class: state.type === k ? 'on' : '', 'aria-pressed': state.type === k ? 'true' : 'false',
        onclick: () => { state.type = k; renderList(); updatePlanItems(); },
      }, label, h('span', { class: 'n' }, String(n[k])))));
    const tagCounts = new Map();
    for (const i of items.filter((x) => matches(x, scopeFilter({ tag: '' })))) for (const t of i.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    if (state.tag && !tagCounts.has(state.tag)) tagCounts.set(state.tag, 0);
    const tags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    tagSelect.replaceChildren(h('option', { value: '' }, 'All tags'), ...tags.map(([t, c]) => h('option', { value: t }, `${t} (${c})`)));
    tagSelect.value = state.tag;
    tagSelect.hidden = !tags.length;
  }

  function renderList() {
    renderFilters();
    const list = listItems();
    const lvl = levelById.get(state.levelId);
    const scopeName = state.allLevels || levels.length < 2 ? '' : ` on ${lvl.name}`;
    const total = state.allLevels ? items.length : items.filter((i) => i.levelId === state.levelId).length;
    countLine.textContent = list.length === total ? `${list.length} item${list.length === 1 ? '' : 's'}${scopeName}` : `Showing ${list.length} of ${total}${scopeName}`;
    if (!list.length) {
      gridEl.replaceChildren(h('div', { class: 'empty' }, items.length ? 'Nothing matches. Clear the search or pick another tag.' : 'This job walk has no photos, videos or notes yet.'));
      gridEl.classList.remove('grid');
      return;
    }
    gridEl.classList.add('grid');
    gridEl.replaceChildren(...list.map((it) => card(it, list)));
  }

  function placeholder(name) {
    return h('div', { class: 'ph' }, icon(name));
  }

  function card(it, list) {
    const thumb = h('div', { class: 'ci-thumb' });
    if (it.type === 'note') {
      thumb.append(h('div', { class: 'ci-note' }, it.text || it.title || 'Note'));
    } else {
      const src = safeSrc(it.src.thumb) || (it.type === 'photo' ? safeSrc(it.src.image) : safeSrc(it.src.poster));
      if (src) {
        const im = h('img', { alt: '', loading: 'lazy', decoding: 'async', src });
        im.addEventListener('error', () => { im.replaceWith(placeholder(it.type === 'video' ? 'play' : 'image')); }, { once: true });
        thumb.append(im);
      } else {
        thumb.append(placeholder(it.type === 'video' ? 'play' : 'image'));
      }
    }
    thumb.append(h('span', { class: 'ci-n' }, `#${it.seq}`));
    if (it.type === 'video') thumb.append(h('span', { class: 'ci-kind' }, icon('play'), fmtDuration(it.duration) || 'Video'));
    else if (it.voiceNotes.length) thumb.append(h('span', { class: 'ci-kind' }, icon('mic'), String(it.voiceNotes.length)));
    else if (it.type === 'photo' && it.hasMarkup) thumb.append(h('span', { class: 'ci-kind' }, icon('pen'), 'Markup'));
    const lvl = levelById.get(it.levelId);
    const sub = [state.allLevels && levels.length > 1 && lvl ? lvl.name : '', fmtShortDateTime(it.createdAt)].filter(Boolean).join(' · ');
    const tags = it.tags.length ? h('div', { class: 'tags' }, it.tags.slice(0, 3).map((t) => h('span', { class: 'tag' }, t)), it.tags.length > 3 ? h('span', { class: 'tag' }, `+${it.tags.length - 3}`) : null) : null;
    return h('button', {
      type: 'button', class: 'card-item', 'aria-label': `${TYPE_LABEL[it.type] || 'Item'} #${it.seq}: ${itemLabel(it)}`,
      onclick: () => openItem(it, list),
    }, thumb, h('div', { class: 'ci-body' }, h('div', { class: 'ci-title' }, itemLabel(it)), h('div', { class: 'ci-sub' }, sub), tags));
  }

  // ---- detail ---------------------------------------------------------------------------------------------

  const lb = { el: null, list: [], index: 0, cleanups: [], pushed: false, prevFocus: null, refs: null };

  function openItem(it, list) {
    lb.list = list && list.includes(it) ? list : [it];
    lb.index = Math.max(0, lb.list.indexOf(it));
    if (!lb.el) buildLightbox();
    renderDetail();
  }

  function buildLightbox() {
    lb.prevFocus = document.activeElement;
    const title = h('div', { class: 'lb-title' });
    const pos = h('div', { class: 'lb-pos' });
    const prev = iconButton('prev', 'Previous (left arrow)', () => step(-1));
    const next = iconButton('next', 'Next (right arrow)', () => step(1));
    const close = iconButton('close', 'Close (Esc)', () => closeLightbox());
    const media = h('div', { class: 'lb-media' });
    const info = h('aside', { class: 'lb-info' });
    const el = h('div', { class: 'lb', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Item details' },
      h('div', { class: 'lb-bar' }, prev, next, title, pos, close),
      h('div', { class: 'lb-body' }, media, info));
    lb.el = el;
    lb.refs = { title, pos, prev, next, close, media, info };
    document.body.append(el);
    document.documentElement.style.overflow = 'hidden';
    document.addEventListener('keydown', onLightboxKey, true);
    try {
      history.pushState({ jwViewer: 1 }, '');
      lb.pushed = true;
    } catch (e) {
      lb.pushed = false;
    }
    close.focus();
  }

  function closeLightbox(fromHistory) {
    if (!lb.el) return;
    runCleanups();
    document.removeEventListener('keydown', onLightboxKey, true);
    lb.el.remove();
    lb.el = null;
    lb.refs = null;
    document.documentElement.style.overflow = '';
    if (lb.pushed && !fromHistory) {
      lb.pushed = false;
      try { history.back(); } catch (e) { /* nothing to go back to */ }
    }
    lb.pushed = false;
    try { if (lb.prevFocus && lb.prevFocus.focus) lb.prevFocus.focus(); } catch (e) { /* gone */ }
  }

  window.addEventListener('popstate', () => { if (lb.el) { lb.pushed = false; closeLightbox(true); } });

  function onLightboxKey(e) {
    const tag = e.target && e.target.tagName;
    if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); return; }
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'VIDEO' || tag === 'AUDIO') return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  }

  function step(d) {
    const n = lb.index + d;
    if (n < 0 || n >= lb.list.length) return;
    lb.index = n;
    renderDetail();
  }

  function runCleanups() {
    const list = lb.cleanups;
    lb.cleanups = [];
    for (const fn of list) { try { fn(); } catch (e) { /* keep going */ } }
  }

  function renderDetail() {
    runCleanups();
    const it = lb.list[lb.index];
    const lvl = levelById.get(it.levelId);
    const r = lb.refs;
    r.title.replaceChildren(h('span', { class: `k ${it.type}` }, `${TYPE_LABEL[it.type] || 'Item'} #${it.seq}`), itemLabel(it));
    r.pos.textContent = lb.list.length > 1 ? `${lb.index + 1} of ${lb.list.length}` : '';
    r.prev.disabled = lb.index <= 0;
    r.next.disabled = lb.index >= lb.list.length - 1;
    r.media.replaceChildren();
    r.info.replaceChildren();
    r.info.scrollTop = 0;

    let video = null;
    if (it.type === 'photo') renderPhotoMedia(it, r.media);
    else if (it.type === 'video') video = renderVideoMedia(it, r.media);
    else r.media.append(h('div', { class: 'lb-stage' }, h('div', { class: 'lb-note' }, it.text || it.title || 'This note is empty.')));
    addSwipe(r.media.querySelector('.lb-stage'));

    // Info column.
    const info = r.info;
    info.append(h('h2', null, itemLabel(it)));
    if (it.tags.length) info.append(h('div', { class: 'tags' }, it.tags.map((t) => h('span', { class: 'tag' }, t))));
    // A note's text is already the big panel on the left.
    if (it.text && it.type !== 'note') info.append(h('h3', null, 'Notes'), h('div', { class: 'notes' }, it.text));
    if (it.voiceNotes.length) {
      info.append(h('h3', null, `Voice note${it.voiceNotes.length > 1 ? 's' : ''}`));
      const box = h('div', { class: 'voice' });
      it.voiceNotes.forEach((v, k) => {
        const src = safeSrc(v.src);
        const row = h('div', { class: 'voice-row' },
          h('div', { class: 's' }, [`Voice note ${k + 1}`, fmtDuration(v.duration), fmtShortDateTime(v.createdAt)].filter(Boolean).join(' · ')),
          src ? h('audio', { controls: true, preload: 'none', src }) : h('div', { class: 's' }, 'The recording is not in this folder.'),
          v.transcript ? h('div', { class: 't' }, v.transcript) : null);
        box.append(row);
      });
      info.append(box);
      lb.cleanups.push(() => { for (const a of box.querySelectorAll('audio')) { a.pause(); a.removeAttribute('src'); a.load(); } });
    }
    info.append(h('h3', null, 'Details'), factsList(it, lvl));
    renderWhere(it, lvl, info, video);

    // Warm the next photo so arrows feel instant.
    const nextItem = lb.list[lb.index + 1];
    if (nextItem && nextItem.type === 'photo') {
      const src = safeSrc(state.showOriginal && nextItem.src.original ? nextItem.src.original : nextItem.src.image);
      if (src) { const pre = new Image(); pre.src = src; }
    }
  }

  function missingNote(what) {
    return h('div', { class: 'lb-missing' }, `This ${what} is not in this folder. Keep index.html next to the media folder it came with.`);
  }

  function renderPhotoMedia(it, host) {
    const stage = h('div', { class: 'lb-stage' });
    const tools = h('div', { class: 'lb-tools' });
    host.append(stage, tools);
    const shown = safeSrc(it.src.image);
    const original = safeSrc(it.src.original);
    const both = shown && original && shown !== original;
    const current = () => (both && state.showOriginal ? original : shown || original);
    const show = () => {
      const src = current();
      stage.classList.remove('zoomed');
      if (!src) { stage.replaceChildren(missingNote('photo')); return; }
      const im = h('img', { src, alt: `Photo #${it.seq}${it.title ? `: ${it.title}` : ''}`, draggable: 'false' });
      im.addEventListener('error', () => stage.replaceChildren(missingNote('photo')), { once: true });
      im.addEventListener('click', (e) => {
        if (stage.dataset.swiped) return;
        const zoom = !stage.classList.contains('zoomed');
        stage.classList.toggle('zoomed', zoom);
        if (zoom) {
          const rx = e.offsetX / (im.clientWidth || 1);
          const ry = e.offsetY / (im.clientHeight || 1);
          requestAnimationFrame(() => {
            stage.scrollLeft = Math.max(0, im.naturalWidth * rx - stage.clientWidth / 2);
            stage.scrollTop = Math.max(0, im.naturalHeight * ry - stage.clientHeight / 2);
          });
        }
      });
      stage.replaceChildren(im);
      fullLink.setAttribute('href', src);
    };
    const fullLink = h('a', { href: current() || '#', target: '_blank', rel: 'noopener' }, 'Open full size');
    if (both) {
      const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Version' });
      const mk = (label, orig) => h('button', {
        type: 'button', class: state.showOriginal === orig ? 'on' : '', 'aria-pressed': state.showOriginal === orig ? 'true' : 'false',
        onclick: () => {
          state.showOriginal = orig;
          for (const b of seg.children) { const on = b === btns[orig ? 1 : 0]; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
          show();
        },
      }, label);
      const btns = [mk(it.hasMarkup ? 'With markup' : 'With date stamp', false), mk('Original', true)];
      seg.append(...btns);
      tools.append(seg);
    }
    if (current()) tools.append(fullLink);
    if (original) tools.append(h('a', { href: original, download: '' }, 'Download original'));
    show();
  }

  function renderVideoMedia(it, host) {
    const stage = h('div', { class: 'lb-stage' });
    const tools = h('div', { class: 'lb-tools' });
    host.append(stage, tools);
    const src = safeSrc(it.src.video);
    if (!src) {
      stage.append(h('div', { class: 'lb-missing' },
        'This video file is not in this folder (it may have been left out to make the file smaller). Its path is shown on the plan.'));
      return null;
    }
    const video = h('video', { controls: true, playsinline: true, preload: 'metadata', src, poster: safeSrc(it.src.poster) });
    video.addEventListener('error', () => stage.replaceChildren(h('div', { class: 'lb-missing' },
      'This browser cannot play this video, or the file is missing. Try Chrome, or open it from the media/videos folder.')), { once: true });
    stage.append(video);
    tools.append(h('a', { href: src, download: '' }, 'Download video'));
    lb.cleanups.push(() => { video.pause(); video.removeAttribute('src'); video.load(); });
    return video;
  }

  /** Swipe left/right on the photo or note to move to the next one (touch screens). */
  function addSwipe(stage) {
    if (!stage) return;
    let start = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || stage.classList.contains('zoomed')) return;
      start = { x: e.clientX, y: e.clientY, t: Date.now() };
    });
    stage.addEventListener('pointerup', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const quick = Date.now() - start.t < 700;
      start = null;
      if (quick && Math.abs(dx) > 60 && Math.abs(dy) < 50) {
        stage.dataset.swiped = '1';
        setTimeout(() => { delete stage.dataset.swiped; }, 50);
        step(dx < 0 ? 1 : -1);
      }
    });
    stage.addEventListener('pointercancel', () => { start = null; });
  }

  /** Label/value rows for the detail view and the printed card. */
  function facts(it, lvl) {
    const pose = it.pose || {};
    const rows = [];
    rows.push(['Taken', fmtDateTime(it.createdAt)]);
    if (it.capturedBy) rows.push(['By', it.capturedBy]);
    if (lvl && levels.length > 1) rows.push(['Level', lvl.name]);
    if (it.type === 'video' && isNum(it.duration)) rows.push(['Length', fmtDuration(it.duration)]);
    const acc = accuracyOf(pose, lvl);
    if (pose.planLocked) rows.push(['Position', `Placed by hand${acc != null ? ` (GPS was ${fmtAccuracy(acc, units)})` : ''}`]);
    else if (pose.quality && pose.quality !== 'none') {
      rows.push(['Position', `${pose.quality[0].toUpperCase()}${pose.quality.slice(1)}${acc != null ? ` · ${fmtAccuracy(acc, units)}` : ''}${pose.source === 'sim' ? ' (demo mode)' : ''}`]);
    } else if (pose.geo || pose.plan) rows.push(['Position', acc != null ? fmtAccuracy(acc, units) : 'Approximate']);
    else rows.push(['Position', 'Not recorded']);
    if (isNum(pose.heading)) rows.push(['Facing', `${fmtHeading(pose.heading)}${pose.facing === 'top' ? ' (top of the phone — it was held flat)' : ''}`]);
    if (isNum(pose.pitch)) rows.push(['Tilt', fmtTilt(pose.pitch)]);
    if (pose.geo && isNum(pose.geo.alt)) rows.push(['Altitude', `${fmtLength(pose.geo.alt, units)} (GPS, approximate)`]);
    const g = geoPoint(it);
    if (g) {
      const u = mapsUrl(g.lat, g.lng);
      rows.push(['Coordinates', u ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, `${g.lat.toFixed(6)}, ${g.lng.toFixed(6)}`) : `${g.lat}, ${g.lng}`]);
    }
    if (it.type !== 'note' && isNum(it.width) && isNum(it.height)) rows.push(['Size', `${it.width} × ${it.height}`]);
    if (SOURCE_LABEL[it.source]) rows.push(['Source', SOURCE_LABEL[it.source]]);
    return rows;
  }

  function factsList(it, lvl) {
    const dl = h('dl', { class: 'facts' });
    for (const [k, v] of facts(it, lvl)) {
      if (v == null || v === '') continue;
      dl.append(h('dt', null, k), h('dd', null, v));
    }
    return dl;
  }

  /** "Where": a small plan centred on the item (with the video played back), or a small map. */
  function renderWhere(it, lvl, info, video) {
    const pp = planPoint(it);
    const gp = geoPoint(it);
    const actions = h('div', { class: 'where-actions' });
    if (lvl && lvl.plan && safeSrc(lvl.plan.src) && pp) {
      info.append(h('h3', null, 'Where'));
      const where = h('div', { class: 'where' });
      info.append(where, actions);
      const W = lvl.plan.width || 1000;
      const H = lvl.plan.height || 1000;
      const pts = trackPoints(it, lvl);
      const xs = pts.length ? pts.map((p) => p.x) : [pp.x];
      const ys = pts.length ? pts.map((p) => p.y) : [pp.y];
      const span = Math.max(W, H) * 0.14;
      const box = { x0: Math.min(...xs) - span / 2, x1: Math.max(...xs) + span / 2, y0: Math.min(...ys) - span / 2, y1: Math.max(...ys) + span / 2 };
      const mini = createPlanView(where, lvl, { interactive: false, box });
      mini.setItems([it], { selectedId: it.id });
      lb.cleanups.push(() => mini.destroy());
      if (video && pts.length) syncPlayback(video, (t) => mini.setPlayback(it, t));
      actions.append(h('button', { type: 'button', class: 'btn btn-sm', onclick: () => showOnPlan(it) }, icon('pin'), 'Show on the plan'));
    } else if (gp && window.L && typeof window.L.map === 'function') {
      info.append(h('h3', null, 'Where'));
      const where = h('div', { class: 'where' });
      info.append(where, actions);
      const L = window.L;
      const map = L.map(where, { zoomControl: false, attributionControl: true, maxZoom: 22, dragging: true, scrollWheelZoom: false });
      L.tileLayer(ESRI_TILES, { maxZoom: 22, maxNativeZoom: 19, crossOrigin: true, attribution: ESRI_ATTRIBUTION }).addTo(map);
      const g = trackGeo(it);
      if (g.length >= 2) {
        const ll = g.map((p) => [p.lat, p.lng]);
        L.polyline(ll, { color: '#fff', weight: 7, opacity: 0.85 }).addTo(map);
        L.polyline(ll, { color: COLOR.video, weight: 4 }).addTo(map);
        map.fitBounds(L.latLngBounds(ll), { padding: [20, 20], maxZoom: 20 });
        if (video) {
          const dot = L.circleMarker(ll[0], { radius: 7, color: '#fff', weight: 3, fillColor: COLOR.me, fillOpacity: 1 }).addTo(map);
          syncPlayback(video, (t) => { const at = trackAt(g, t, ['lat', 'lng']); if (at) dot.setLatLng([at.x, at.y]); });
        }
      } else {
        map.setView([gp.lat, gp.lng], 19);
      }
      L.marker([gp.lat, gp.lng], { icon: L.divIcon({ className: 'mv-pin-host', html: mapPinElement(it), iconSize: [30, 30], iconAnchor: [15, 15] }) }).addTo(map);
      lb.cleanups.push(() => map.remove());
    }
    if (gp) actions.append(link('Open in Google Maps', mapsUrl(gp.lat, gp.lng), { class: 'btn btn-sm' }));
    if (!actions.parentNode && actions.childNodes.length) info.append(h('h3', null, 'Where'), actions);
  }

  /** Keep a marker in step with a playing video (smoothly while playing, at once on seek). */
  function syncPlayback(video, apply) {
    let raf = 0;
    const tick = () => {
      apply(video.currentTime * 1000);
      raf = !video.paused && !video.ended ? requestAnimationFrame(tick) : 0;
    };
    const kick = () => { if (raf) cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); };
    const now = () => apply(video.currentTime * 1000);
    video.addEventListener('play', kick);
    video.addEventListener('seeked', now);
    video.addEventListener('timeupdate', now);
    video.addEventListener('loadedmetadata', now);
    apply(0);
    lb.cleanups.push(() => {
      if (raf) cancelAnimationFrame(raf);
      video.removeEventListener('play', kick);
      video.removeEventListener('seeked', now);
      video.removeEventListener('timeupdate', now);
      video.removeEventListener('loadedmetadata', now);
    });
  }

  function showOnPlan(it) {
    closeLightbox();
    if (state.levelId !== it.levelId) {
      state.levelId = it.levelId;
      renderTabs();
      renderPlan();
      renderList();
    }
    if (!planItems().includes(it)) {
      state.type = 'all'; state.tag = ''; state.q = ''; searchInput.value = '';
      renderList();
      updatePlanItems();
    }
    planWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    requestAnimationFrame(() => mainView && mainView.centerOn(it));
  }

  // ---- print report ----------------------------------------------------------------------------------------

  const printRoot = document.getElementById('print-root');

  function startPrint() {
    const shown = listItems();
    const filtered = shown.length !== items.length;
    if (!filtered) { printList(items); return; }
    // A small choice: everything, or only what the filters show.
    const back = h('div', { class: 'lb', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Print report', style: 'align-items:center;justify-content:center;padding:20px' });
    const done = (list) => { back.remove(); document.removeEventListener('keydown', esc, true); if (list) printList(list); };
    const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    const box = h('div', { class: 'lb-info', style: 'width:min(420px,100%);max-width:none;border-radius:14px' },
      h('h2', null, 'Print report'),
      h('p', { class: 'muted' }, 'A cover page with the job info and the plans with every pin, then one card per item with its photo, notes and position.'),
      h('div', { class: 'where-actions', style: 'flex-direction:column' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => done(items) }, `All ${items.length} items`),
        h('button', { type: 'button', class: 'btn', onclick: () => done(shown) }, `Only the ${shown.length} shown now`),
        h('button', { type: 'button', class: 'btn', onclick: () => done(null) }, 'Cancel')));
    back.append(box);
    back.addEventListener('click', (e) => { if (e.target === back) done(null); });
    document.addEventListener('keydown', esc, true);
    document.body.append(back);
    box.querySelector('button').focus();
  }

  function printList(list) {
    buildPrint(list);
    const msg = h('div', { class: 'printing-msg', role: 'status' }, 'Preparing the report…');
    document.body.append(msg);
    waitForImages(printRoot, 20000).then(() => {
      msg.remove();
      window.print();
    });
  }

  window.addEventListener('beforeprint', () => { if (!printRoot.dataset.built) buildPrint(items); });
  window.addEventListener('afterprint', () => { delete printRoot.dataset.built; });

  function waitForImages(root, ms) {
    const imgs = [...root.querySelectorAll('img')];
    const each = imgs.map((im) => (im.complete ? Promise.resolve() : new Promise((res) => {
      im.addEventListener('load', res, { once: true });
      im.addEventListener('error', res, { once: true });
    })));
    return Promise.race([Promise.all(each), new Promise((res) => setTimeout(res, ms))]);
  }

  function buildPrint(list) {
    printRoot.replaceChildren(printCover(list), printItems(list));
    printRoot.dataset.built = '1';
  }

  function printCover(list) {
    const sec = h('section', { class: 'p-cover' });
    sec.append(h('div', { class: 'p-brand' },
      h('div', { class: 'logo-mark' }, 'DCR'),
      h('div', { class: 't' }, 'Job walk report'),
      h('div', { class: 's' }, D.company || 'DCR Framing')));
    sec.append(h('h1', null, project.name || 'Job walk'));
    const table = h('table', { class: 'p-info' });
    const row = (k, v) => { if (v) table.append(h('tr', null, h('th', null, k), h('td', null, v))); };
    row('Address', project.address);
    row('GC / client', project.gc);
    row('DCR job #', project.number);
    row('Walk date', fmtDate(project.walkDate));
    row('In this report', countText(list));
    row('Exported', D.exportedAt ? `${fmtDateTime(D.exportedAt)}${D.exportedBy ? ` by ${D.exportedBy}` : ''}` : '');
    sec.append(table);
    if (project.notes) sec.append(h('div', { class: 'p-notes' }, project.notes));
    for (const lvl of levels) {
      const onLevel = list.filter((i) => i.levelId === lvl.id);
      if (!onLevel.length && !lvl.plan) continue;
      const src = lvl.plan ? safeSrc(lvl.plan.src) : null;
      const fig = h('figure', { class: 'p-plan' }, h('figcaption', null, `${lvl.name || 'Level'} — ${countText(onLevel)}`));
      if (src && lvl.plan.width && lvl.plan.height) {
        fig.append(h('div', { class: 'p-plan-wrap' }, h('img', { src, alt: `Floor plan, ${lvl.name}` }), planSvg(lvl, onLevel)));
      } else if (onLevel.length) {
        const t = h('table', { class: 'p-geo' }, h('tr', null, h('th', null, '#'), h('th', null, 'Item'), h('th', null, 'Coordinates'), h('th', null, 'Accuracy')));
        for (const it of onLevel) {
          const g = geoPoint(it);
          t.append(h('tr', null, h('td', null, String(it.seq)), h('td', null, itemLabel(it)),
            h('td', null, g ? `${g.lat.toFixed(6)}, ${g.lng.toFixed(6)}` : '—'), h('td', null, g && isNum(g.acc) ? fmtAccuracy(g.acc, units) : '')));
        }
        fig.append(h('p', null, 'No floor plan for this level; positions are GPS coordinates.'), t);
      }
      sec.append(fig);
    }
    return sec;
  }

  /** The plan's pins as SVG over the plan image: sharp at any print size. */
  function planSvg(lvl, list) {
    const W = lvl.plan.width;
    const H = lvl.plan.height;
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    const R = Math.max(W, H) * 0.0105;
    const font = `font-family:${FONT.replace(/"/g, "'")};font-weight:700`;
    const pinNode = (x, y, n, color, square) => {
      const g = svg('g', {});
      g.append(square
        ? svg('rect', { x: x - R, y: y - R, width: R * 2, height: R * 2, rx: R * 0.45, fill: color, stroke: '#fff', 'stroke-width': R * 0.22 })
        : svg('circle', { cx: x, cy: y, r: R, fill: color, stroke: '#fff', 'stroke-width': R * 0.22 }));
      const t = svg('text', { x, y, 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: '#fff', 'font-size': R * (String(n).length > 2 ? 0.8 : 1.0), style: font });
      t.textContent = String(n);
      g.append(t);
      return g;
    };
    const wedge = (x, y, hdeg, color) => {
      const a = (hdeg - 90) * Math.PI / 180;
      const half = WEDGE_HALF;
      const Rw = R * 3.4;
      const p1 = [x + Rw * Math.cos(a - half), y + Rw * Math.sin(a - half)];
      const p2 = [x + Rw * Math.cos(a + half), y + Rw * Math.sin(a + half)];
      return svg('path', { d: `M${x} ${y} L${p1[0]} ${p1[1]} A${Rw} ${Rw} 0 0 1 ${p2[0]} ${p2[1]} Z`, fill: rgba(color, 0.3), stroke: rgba(color, 0.8), 'stroke-width': R * 0.12 });
    };
    for (const it of list.filter((i) => i.type === 'video')) {
      const pts = trackPoints(it, lvl);
      if (pts.length < 2) continue;
      const d = pts.map((p) => `${p.x},${p.y}`).join(' ');
      s.append(svg('polyline', { points: d, fill: 'none', stroke: '#fff', 'stroke-width': R * 0.75, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      s.append(svg('polyline', { points: d, fill: 'none', stroke: COLOR.video, 'stroke-width': R * 0.4, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      s.append(pinNode(pts[0].x, pts[0].y, it.seq, COLOR.video, false));
    }
    for (const it of list.filter((i) => i.type !== 'video' || trackPoints(i, lvl).length < 2)) {
      const p = planPoint(it);
      if (!p) continue;
      const hd = it.type === 'note' ? null : planHeadingOf(it.pose, lvl);
      const color = it.type === 'note' ? COLOR.note : it.type === 'video' ? COLOR.video : COLOR.photo;
      if (hd != null) s.append(wedge(p.x, p.y, hd, color));
      s.append(pinNode(p.x, p.y, it.seq, color, it.type === 'note'));
    }
    return s;
  }

  function printItems(list) {
    const sec = h('section', { class: 'p-items' }, h('h2', null, 'Items'));
    for (const it of list) {
      const lvl = levelById.get(it.levelId);
      const img = it.type === 'photo' ? safeSrc(it.src.image) || safeSrc(it.src.original) : it.type === 'video' ? safeSrc(it.src.poster) || safeSrc(it.src.thumb) : null;
      const art = h('article', { class: `p-card${img ? '' : ' note-only'}` });
      if (img) art.append(h('div', { class: 'p-img' }, h('img', { src: img, alt: '' })));
      const txt = h('div', { class: 'p-txt' }, h('h3', null, h('span', { class: `k ${it.type}` }, `${TYPE_LABEL[it.type] || 'Item'} #${it.seq}`), itemLabel(it)));
      if (it.tags.length) txt.append(h('div', { class: 'tags' }, it.tags.map((t) => h('span', { class: 'tag' }, t))));
      if (it.text) txt.append(h('div', { class: 'notes' }, it.text));
      for (const v of it.voiceNotes) {
        txt.append(h('div', { class: 'p-voice' }, `Voice note${isNum(v.duration) ? ` (${fmtDuration(v.duration)})` : ''}${v.transcript ? `: ${v.transcript}` : ' — in the media/voice folder'}`));
      }
      txt.append(factsList(it, lvl));
      art.append(txt);
      sec.append(art);
    }
    return sec;
  }

  // ---- start --------------------------------------------------------------------------------------------------

  renderTabs();
  renderPlan();
  renderList();
})();
