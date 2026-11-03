// settings-screen.js — Settings (#/settings).
//
// Every preference in DEFAULT_SETTINGS (js/core/settings.js), each with a
// plain explanation, saved the moment it changes (typed fields: ~0.8 s after
// the last key, and again when the field loses focus, the app is hidden or
// the screen closes). A small "Saved ✓" next to the label confirms each save,
// only after it has been written.
//
// Also here, because they keep the work safe: the storage card (how much is
// used and free, whether the browser may clear it, Protect storage, and what
// to do on an iPhone / Android / a computer), a link to Recently Deleted, and
// an honest "How positioning works".

import { el, iconButton, toast, formDialog, alertDialog } from './shell.js';
import { icon } from './icons.js';
import { formatLength, parseLength, formatBytes, debounce, isIOS, isStandalone } from '../core/util.js';

const PHOTO_SIZES = [
  [4032, 'Full size (about 12 MP)'],
  [3264, 'Large (about 8 MP)'],
  [2560, 'Medium (about 5 MP)'],
  [1920, 'Small (about 2 MP)'],
];
const PHOTO_QUALITY = [
  [0.95, 'Best (largest files)'],
  [0.92, 'High (recommended)'],
  [0.85, 'Good'],
  [0.75, 'Smaller files'],
];

/** Step lengths a person can actually have, in meters. */
const STEP_MIN = 0.3;
const STEP_MAX = 1.3;

/** Open the settings screen. */
export async function open(ctx) {
  const { root, app } = ctx;
  const { store } = app;
  const S = () => app.getSettings();
  const flushers = new Set();
  const timers = new Set();
  let closed = false;

  root.append(
    el('header', { class: 'topbar' },
      iconButton('back', { title: 'Back', onclick: () => ctx.back('') }),
      el('div', { class: 'topbar-title' }, el('h1', {}, 'Settings'), el('div', { class: 'sub' }, 'Saved on this device as you change them'))));
  const body = el('main', { class: 'screen-body narrow settings' });
  root.append(body);

  // ---- saving ----

  function tickEl() {
    return el('span', { class: 'st-saved', 'aria-live': 'polite' });
  }

  function showTick(tick) {
    if (!tick) return;
    tick.textContent = 'Saved ✓';
    tick.classList.add('on');
    clearTimeout(tick._t);
    tick._t = setTimeout(() => { tick.classList.remove('on'); }, 1600);
    timers.add(tick._t);
  }

  async function save(patch, tick) {
    try {
      await app.updateSettings(patch);
      showTick(tick);
      return true;
    } catch (err) {
      toast(`That setting was not saved: ${err.message}`, { type: 'err' });
      return false;
    }
  }

  /** A debounced saver for a typed field, flushed on blur / hide / leave. */
  function typedSaver(fn) {
    const d = debounce(fn, 800);
    flushers.add(() => d.flush());
    return d;
  }

  const flushAll = () => { for (const f of flushers) { try { f(); } catch { /* keep going */ } } };
  const onVis = () => { if (document.visibilityState === 'hidden') flushAll(); };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', flushAll);

  // ---- building blocks ----

  let fieldN = 0;
  const fid = () => `st-f${++fieldN}`;

  function section(title, ...children) {
    return el('section', { class: 'st-section' },
      el('h2', { class: 'section-title' }, title),
      el('div', { class: 'card st-card' }, ...children));
  }

  function help(text) {
    return el('p', { class: 'st-help' }, text);
  }

  function field(label, control, { helpText = '', tick = tickEl(), id } = {}) {
    if (id && /^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName)) control.id = id;
    return el('div', { class: 'st-field' },
      el('div', { class: 'st-field-head' }, el('label', { class: 'st-label', for: id || null }, label), tick),
      control,
      helpText ? help(helpText) : null);
  }

  function switchRow(key, label, helpText) {
    const tick = tickEl();
    const input = el('input', { type: 'checkbox', role: 'switch' });
    input.checked = !!S()[key];
    input.addEventListener('change', async () => {
      const want = input.checked;
      if (!(await save({ [key]: want }, tick))) input.checked = !want;
    });
    return el('div', { class: 'st-field st-switch' },
      el('label', { class: 'switch' }, el('span', { class: 'st-switch-text' }, el('span', { class: 'st-label' }, label), tick), input),
      helpText ? help(helpText) : null);
  }

  function seg(options, current, onPick, label) {
    const box = el('div', { class: 'seg st-seg', role: 'group', 'aria-label': label });
    const paint = (v) => {
      for (const b of box.children) {
        const on = b.dataset.v === String(v);
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      }
    };
    for (const [v, text] of options) {
      box.append(el('button', { type: 'button', dataset: { v: String(v) }, onclick: async () => { if (await onPick(v)) paint(v); } }, text));
    }
    paint(current);
    return box;
  }

  function selectField(key, label, options, helpText) {
    const tick = tickEl();
    const sel = el('select', { class: 'input' });
    const cur = S()[key];
    const opts = [...options];
    if (!opts.some(([v]) => v === cur)) opts.push([cur, String(cur)]);
    for (const [v, text] of opts) sel.append(el('option', { value: String(v) }, text));
    sel.value = String(cur);
    sel.addEventListener('change', () => {
      const pick = opts.find(([v]) => String(v) === sel.value);
      if (pick) save({ [key]: pick[0] }, tick);
    });
    return field(label, sel, { helpText, tick, id: fid() });
  }

  function keyField(key, label, placeholder, helpText) {
    const tick = tickEl();
    const input = el('input', {
      class: 'input st-key', type: 'password', placeholder, autocomplete: 'off', autocapitalize: 'off',
      autocorrect: 'off', spellcheck: 'false', inputmode: 'text',
    });
    input.value = S()[key] || '';
    const saver = typedSaver(() => {
      const v = input.value.trim();
      if (v !== (S()[key] || '')) save({ [key]: v }, tick);
    });
    input.addEventListener('input', () => saver());
    input.addEventListener('blur', () => saver.flush());
    const eye = iconButton('eye', { title: 'Show the key', cls: 'icon-btn st-eye' });
    eye.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      eye.innerHTML = icon(show ? 'eyeOff' : 'eye', { size: 22 });
      eye.setAttribute('aria-label', show ? 'Hide the key' : 'Show the key');
    });
    const id = fid();
    input.id = id;
    return field(label, el('div', { class: 'st-key-row' }, input, eye), { helpText, tick, id });
  }

  // ---- you ----

  function textField(key, label, { placeholder = '', helpText = '', autocomplete = 'off' } = {}) {
    const tick = tickEl();
    const input = el('input', { class: 'input', type: 'text', placeholder, autocomplete, autocapitalize: 'words', enterkeyhint: 'done' });
    input.value = S()[key] || '';
    const saver = typedSaver(() => {
      const v = input.value.trim();
      if (v !== (S()[key] || '')) save({ [key]: v }, tick);
    });
    input.addEventListener('input', () => saver());
    input.addEventListener('blur', () => saver.flush());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    return field(label, input, { helpText, tick, id: fid() });
  }

  body.append(section('You',
    textField('userName', 'Your name', { placeholder: 'First and last name', autocomplete: 'name', helpText: 'Shown on photos and exports as "Taken by".' }),
    textField('company', 'Company', { placeholder: 'DCR Framing', autocomplete: 'organization', helpText: 'Printed on exports and the report.' })));

  // ---- units and positioning ----

  const unitsTick = tickEl();
  const stepTick = tickEl();
  const stepInput = el('input', { class: 'input', type: 'text', inputmode: 'text', autocomplete: 'off', enterkeyhint: 'done' });
  const stepMsg = help('');
  const showStep = () => {
    stepInput.value = formatLength(S().stepLength, S().units, { precisionIn: 0.5 });
    stepMsg.textContent = 'How far one normal walking step goes. Used to move your dot between GPS updates. Most people: 2\' 2" to 2\' 8" (0.65–0.8 m).';
    stepMsg.classList.remove('st-bad');
  };
  const stepSaver = typedSaver(() => {
    const m = parseLength(stepInput.value, S().units);
    if (m == null || m < STEP_MIN || m > STEP_MAX) {
      if (stepInput.value.trim()) {
        stepMsg.textContent = `Type a step length between ${formatLength(STEP_MIN, S().units)} and ${formatLength(STEP_MAX, S().units)}, like ${S().units === 'metric' ? '0.72 m' : '2\' 4"'}.`;
        stepMsg.classList.add('st-bad');
      }
      return;
    }
    stepMsg.classList.remove('st-bad');
    if (Math.abs(m - S().stepLength) > 0.001) save({ stepLength: Math.round(m * 1000) / 1000 }, stepTick);
  });
  stepInput.addEventListener('input', () => stepSaver());
  stepInput.addEventListener('blur', () => { stepSaver.flush(); if (!stepMsg.classList.contains('st-bad')) showStep(); });
  stepInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); stepInput.blur(); } });

  async function measureStep() {
    const metric = S().units === 'metric';
    const r = await formDialog({
      title: 'Measure my step',
      intro: 'Walk 10 normal steps in a straight line, then measure how far you went (a tape, or a wall of known length).',
      okText: 'Use it',
      fields: [{ name: 'dist', label: 'Distance for 10 steps', placeholder: metric ? 'e.g. 7.2 m' : 'e.g. 23\' 6"', inputmode: 'text' }],
    });
    if (!r?.dist) return;
    const total = parseLength(r.dist, S().units);
    const step = total != null ? total / 10 : null;
    if (step == null || step < STEP_MIN || step > STEP_MAX) {
      await alertDialog({ title: 'That does not look right', message: `10 steps of ${r.dist} would be a step of ${step != null ? formatLength(step, S().units) : '?'}. Measure again — 10 steps are usually ${metric ? '6.5–8 m' : '21–27 ft'}.` });
      return;
    }
    if (await save({ stepLength: Math.round(step * 1000) / 1000 }, stepTick)) {
      showStep();
      toast(`Your step is ${formatLength(step, S().units, { precisionIn: 0.5 })}.`, { type: 'ok' });
    }
  }

  // Declination: east (+) / west (−) as a toggle, because a phone's number pad often has no minus key.
  const decTick = tickEl();
  const decInput = el('input', { class: 'input st-dec', type: 'text', inputmode: 'decimal', placeholder: 'Not set', autocomplete: 'off', enterkeyhint: 'done' });
  const decMsg = help('Only used until the compass is aligned on the plan (Calibrate → Align compass), which is more accurate because it also corrects this phone\'s own compass error. Around Sacramento it is about 13° East.');
  let decSign = (S().declination ?? 0) < 0 ? -1 : 1;
  if (S().declination != null) decInput.value = String(Math.abs(S().declination));
  const decSaver = typedSaver(() => {
    const raw = decInput.value.trim().replace(',', '.').replace(/°/g, '');
    if (!raw) { if (S().declination != null) save({ declination: null }, decTick); decMsg.classList.remove('st-bad'); return; }
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0 || v > 60) {
      decMsg.classList.add('st-bad');
      return;
    }
    decMsg.classList.remove('st-bad');
    const val = Math.round(decSign * v * 10) / 10;
    if (val !== S().declination) save({ declination: val }, decTick);
  });
  decInput.addEventListener('input', () => decSaver());
  decInput.addEventListener('blur', () => decSaver.flush());
  const decSeg = seg([[1, 'East'], [-1, 'West']], decSign, async (v) => { decSign = v; decSaver(); decSaver.flush(); return true; }, 'East or west');

  const demoInput = el('input', { type: 'checkbox', role: 'switch' });
  demoInput.checked = !!S().simulate;
  const demoTick = tickEl();
  const demoNote = el('div', { class: 'banner warn st-demo-warn', hidden: !S().simulate },
    el('span', { html: icon('warning', { size: 18 }) }),
    el('span', {}, 'Demo mode is on: positions and compass are made up. Turn it off before a real job walk, or photos get fake positions.'));
  demoInput.addEventListener('change', async () => {
    const want = demoInput.checked;
    if (await save({ simulate: want }, demoTick)) demoNote.hidden = !want;
    else demoInput.checked = !want;
  });

  body.append(section('Units and positioning',
    field('Units', seg([['imperial', 'Feet & inches'], ['metric', 'Meters']], S().units, async (v) => {
      const ok = await save({ units: v }, unitsTick);
      if (ok) showStep();
      return ok;
    }, 'Units'), { tick: unitsTick, helpText: 'How lengths and accuracy are shown. Everything is stored in meters, so switching never changes your data.' }),
    el('div', { class: 'st-field' },
      el('div', { class: 'st-field-head' }, el('label', { class: 'st-label', for: 'st-step' }, 'Step length'), stepTick),
      el('div', { class: 'st-inline' }, Object.assign(stepInput, { id: 'st-step' }),
        el('button', { type: 'button', class: 'btn btn-outline', onclick: measureStep }, el('span', { html: icon('walk', { size: 20 }) }), 'Measure my step')),
      stepMsg),
    el('div', { class: 'st-field' },
      el('div', { class: 'st-field-head' }, el('label', { class: 'st-label', for: 'st-dec' }, 'Compass declination (degrees)'), decTick),
      el('div', { class: 'st-inline' }, Object.assign(decInput, { id: 'st-dec' }), decSeg),
      decMsg),
    el('div', { class: 'st-field st-switch' },
      el('label', { class: 'switch' }, el('span', { class: 'st-switch-text' }, el('span', { class: 'st-label' }, 'Demo mode'), demoTick), demoInput),
      help('Makes up GPS and compass readings (walking a loop) so you can try the app indoors or on a computer.'),
      demoNote),
    el('details', { class: 'st-how' },
      el('summary', {}, el('span', { html: icon('info', { size: 18 }) }), 'How positioning works'),
      el('div', { class: 'st-how-body' },
        el('p', {}, 'Phone GPS is usually within 3–5 m (10–16 ft) under open sky, and worse next to tall walls, under a roof or a metal deck. The chip on the plan always shows the current accuracy, for example "±12 ft".'),
        el('p', {}, 'Between GPS updates the app counts your steps and reads the compass, so your dot moves smoothly as you walk. Standing still, it stays put.'),
        el('p', {}, 'Calibrating a plan on site (3 spots you can stand on, as far apart as the site allows) ties the plan to GPS. With phone GPS, expect a few feet of error and a few degrees of rotation.'),
        el('p', {}, 'Two optional steps make it better: a known dimension (a wall you know the length of) makes the plan\'s scale exact, and aligning the compass along a wall makes camera directions match the plan.'),
        el('p', {}, 'Tap "I\'m here" whenever you stand on a spot you can find on the plan — a corner, a column, a door. It snaps your position there, and the next few minutes of photos are more accurate too.'),
        el('p', {}, 'Every photo also keeps its raw GPS reading, so a pin can be re-placed after a better calibration, and you can always move a pin by hand.')))));

  // ---- photos and video ----

  const videoTick = tickEl();
  body.append(section('Photos and video',
    selectField('photoMaxSize', 'Photo size', PHOTO_SIZES, 'Bigger shows more detail when you zoom in, and uses more space. Full size is best for reading labels and hardware.'),
    selectField('photoQuality', 'Photo quality', PHOTO_QUALITY, 'JPEG quality of saved photos. The original is never changed by markup.'),
    field('Video quality', seg([['high', '1080p'], ['standard', '720p']], S().videoQuality, (v) => save({ videoQuality: v }, videoTick), 'Video quality'),
      { tick: videoTick, helpText: '1080p is sharper and uses about twice the space of 720p (roughly 100 MB vs 50 MB a minute).' }),
    switchRow('shutterSound', 'Shutter sound'),
    switchRow('vibrate', 'Vibrate on capture', 'A short buzz when a photo is saved (Android phones).'),
    switchRow('keepAwake', 'Keep the screen on', 'While a job walk is open. GPS stops when the screen turns off, so this keeps your position ready.')));

  // ---- map ----

  const providerTick = tickEl();
  const providerBox = el('div', { class: 'st-providers', role: 'radiogroup', 'aria-label': 'Map' });
  const esriKey = keyField('esriKey', 'Esri API key (optional)', 'Paste an ArcGIS Location Platform key',
    'With a key, the map uses your free ArcGIS Location Platform account (2 million tiles a month). Stored only on this device.');
  const googleKey = keyField('googleMapsKey', 'Google Maps key', 'Paste a key with the Map Tiles API enabled',
    'Stored only on this device. Restrict the key to the Map Tiles API and set a daily quota in the Google Cloud console — anyone with this device could read it.');
  const googleWarn = el('div', { class: 'banner warn', hidden: true },
    el('span', { html: icon('warning', { size: 18 }) }),
    el('span', {}, 'Google needs a key. Until one is entered, the map cannot show Google imagery.'));
  const PROVIDERS = [
    ['esri', 'Esri satellite', 'Aerial photos (the default). Works without a key; Esri\'s terms expect an ArcGIS account for business use — a free ArcGIS Location Platform account gives you a key for the box below.'],
    ['osm', 'OpenStreetMap streets', 'A street map made by volunteers. No aerial photos. Fine for occasional use.'],
    ['google', 'Google satellite', 'Needs your own Google Maps Platform key with the Map Tiles API and billing on: 100,000 tiles a month free, then $0.60 per 1,000; 15,000 tiles a day by default. Google\'s terms do not allow mixing it with other maps or keeping tiles for offline use, so with Google it is the only map, and it needs signal.'],
  ];
  function paintProviders() {
    const cur = S().mapProvider;
    for (const b of providerBox.children) {
      const on = b.dataset.v === cur;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    esriKey.hidden = cur !== 'esri';
    googleKey.hidden = cur !== 'google';
    googleWarn.hidden = !(cur === 'google' && !S().googleMapsKey);
  }
  for (const [v, label, detail] of PROVIDERS) {
    providerBox.append(el('button', {
      type: 'button', class: 'st-provider', role: 'radio', dataset: { v },
      onclick: async () => { if (await save({ mapProvider: v }, providerTick)) paintProviders(); },
    },
    el('span', { class: 'st-radio' }),
    el('span', { class: 'st-provider-txt' }, el('span', { class: 'st-provider-label' }, label), el('span', { class: 'st-provider-detail' }, detail))));
  }
  const offSettings = app.bus.on('settings:change', () => paintProviders());
  paintProviders();
  body.append(section('Map (when a level has no plan yet)',
    el('div', { class: 'st-field' },
      el('div', { class: 'st-field-head' }, el('span', { class: 'st-label' }, 'Base map'), providerTick),
      providerBox),
    googleWarn,
    esriKey,
    googleKey,
    help('The map is only a backdrop: positions are saved from GPS whatever map is shown. Tiles you have looked at are kept for a while so the map of the site shows without signal (not Google\'s).')));

  // ---- backups and exports ----

  body.append(section('Backups and exports',
    switchRow('stampExports', 'Stamp exported photos', 'Prints the date, job and position on the copies in an export. The originals on this device are never changed.'),
    switchRow('backupReminder', 'Remind me to back up', 'Shows a reminder on the job walk when many changes are not backed up yet, or the last backup is more than a day old.')));

  // ---- storage ----

  const storageCard = el('div', { class: 'st-storage' }, el('div', { class: 'row muted' }, el('div', { class: 'spinner' }), 'Checking storage…'));
  async function renderStorage() {
    let info = {};
    try { info = await store.storageInfo(); } catch { /* unknown */ }
    if (closed) return;
    const free = info.quota != null && info.usage != null ? Math.max(0, info.quota - info.usage) : null;
    const used = info.usage != null ? formatBytes(info.usage) : 'unknown';
    const pct = info.quota ? Math.min(100, (info.usage / info.quota) * 100) : null;
    const meter = pct != null ? el('div', { class: 'st-meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-label': 'Storage used' },
      el('div', { class: 'st-meter-fill', style: { width: `${Math.max(1, pct)}%` } })) : null;
    const state = info.persisted
      ? el('div', { class: 'banner ok' }, el('span', { html: icon('shield', { size: 20 }) }), el('span', {}, el('b', {}, 'Storage protected ✓'), ' The browser will not clear the app\'s data on its own.'))
      : el('div', { class: 'banner warn' }, el('span', { html: icon('warning', { size: 20 }) }),
        el('span', {}, el('b', {}, 'Storage not protected. '), info.canPersist ? 'The browser may clear the app\'s data when the device is short of space.' : 'This browser cannot protect storage; back up after every walk.'));
    const platform = isIOS()
      ? (isStandalone()
        ? 'iPhone, installed: the app keeps its storage. Back up after each walk anyway (Back up & export), and do not delete the app — that erases its data.'
        : 'iPhone in Safari: add the app to your Home Screen (Share → Add to Home Screen). Safari can clear the data of websites that are not installed. Note the installed app has its own storage: back up job walks from Safari and import them there.')
      : /Android/i.test(navigator.userAgent || '')
        ? 'Android: install the app (Chrome ⋮ → Install app / Add to Home screen) and tap Protect storage. Do not clear Chrome\'s data for this site — that is where the photos live until you back them up.'
        : 'Computer: tap Protect storage, and do not clear the browser\'s data for this site. Back up after each walk.';
    storageCard.replaceChildren(
      el('div', { class: 'st-storage-nums' },
        el('div', {}, el('span', { class: 'st-big' }, used), el('span', { class: 'muted' }, ' used')),
        free != null ? el('div', {}, el('span', { class: 'st-big' }, formatBytes(free)), el('span', { class: 'muted' }, ' available')) : null),
      meter,
      state,
      !info.persisted && info.canPersist ? el('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: protect }, el('span', { html: icon('shield', { size: 20 }) }), 'Protect storage') : null,
      help(platform));
  }
  async function protect() {
    const ok = await store.requestPersist();
    if (ok) toast('Storage is protected. The browser will not clear it on its own.', { type: 'ok', ms: 4000 });
    else {
      await alertDialog({
        title: 'Not protected yet',
        message: isIOS()
          ? 'Safari decides this by itself. Installing the app to the Home Screen is what keeps its storage on an iPhone.'
          : 'The browser said no for now. It usually agrees once the app is installed or used regularly. Back up after each walk either way.',
      });
    }
    renderStorage();
  }

  body.append(section('Storage on this device', storageCard));
  body.append(el('div', { class: 'list st-links' },
    el('button', { type: 'button', class: 'list-row', onclick: () => ctx.navigate('trash') },
      el('span', { html: icon('trash', { size: 22 }) }),
      el('span', { class: 'grow' }, el('span', { class: 't' }, 'Recently Deleted'), el('span', { class: 's' }, 'Restore or erase deleted job walks, photos and notes')),
      el('span', { html: icon('forward', { size: 20 }) }))));

  // ---- about ----

  async function checkUpdate() {
    try {
      const reg = await navigator.serviceWorker?.getRegistration?.();
      if (!reg) { toast('Updates arrive when you reload the page.', { type: 'info' }); return; }
      await reg.update();
      if (reg.installing || reg.waiting) toast('A new version is downloading. It is ready the next time you open the app.', { type: 'ok', ms: 5000 });
      else toast('You have the latest version.', { type: 'ok' });
    } catch (err) {
      toast(`Could not check for updates (${err.message}). Try again with signal.`, { type: 'warn' });
    }
  }

  body.append(section('About',
    el('div', { class: 'st-about' },
      el('div', {}, el('b', {}, 'DCR Job Walk'), ` version ${app.version || ''}`),
      el('div', { class: 'muted small' }, 'Photos, videos and notes placed on the floor plan, for DCR Framing estimators. Everything stays on this device until you export it.')),
    el('button', { type: 'button', class: 'btn btn-outline', onclick: checkUpdate }, el('span', { html: icon('restore', { size: 20 }) }), 'Check for updates')));

  showStep();
  renderStorage();

  return () => {
    flushAll();
    closed = true;
    offSettings();
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('pagehide', flushAll);
    for (const t of timers) clearTimeout(t);
  };
}
