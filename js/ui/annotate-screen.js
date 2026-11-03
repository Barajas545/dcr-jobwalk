// annotate-screen.js — the markup editor (route #/p/:pid/i/:iid/annotate).
//
// The photo fills a dark screen. One finger draws with the chosen tool; two
// fingers always zoom and move the photo (on a computer: the wheel zooms,
// Space + drag or the middle button moves it). Tools: select/move, pen,
// highlighter, arrow, line, box, circle, revision cloud, text, dimension,
// numbered callout and eraser — six colours, three sizes, undo and redo.
//
// Keeping the markup safe (the owner: "It is important not to lose any
// pictures or notes"):
//  - The original photo is only read, never written. Save makes a NEW
//    flattened JPEG and thumbnail (store.putMedia verifies the bytes), and
//    only then points the item at them, in one updateItem. An earlier
//    marked-up copy is never deleted: its ids move to item.annotationHistory.
//  - While editing, the shapes are copied to item.annotationsDraft every few
//    seconds, whenever the app goes to the background, and right before the
//    heavy "burn the markup into the photo" step. If the phone kills the app
//    (out of memory on a 12 MP photo, a call, a flat battery), reopening the
//    editor offers to continue that markup.
//  - Leaving with unsaved changes asks first: Save, Discard or Keep editing.
//
// Drawing uses two stacked canvases: the photo underneath (redrawn only when
// the view moves) and the markup on top (redrawn while drawing), both sized
// for the screen's pixel density. Shapes are immutable values (see
// js/core/annotations.js), so undo/redo just keeps earlier arrays.

import { el, iconButton, toast, busy, choose, confirmDialog, promptDialog, saveBlob } from './shell.js';
import { icon } from './icons.js';
import * as A from '../core/annotations.js';
import { clamp, formatDateTime, safeFileName, todayISO } from '../core/util.js';

const TOOLS = [
  { id: 'select', icon: 'select', label: 'Select', key: 'v' },
  { id: 'pen', icon: 'pen', label: 'Pen', key: 'p' },
  { id: 'highlight', icon: 'highlighter', label: 'Highlight', key: 'h' },
  { id: 'arrow', icon: 'arrow', label: 'Arrow', key: 'a' },
  { id: 'line', icon: 'line', label: 'Line', key: 'l' },
  { id: 'rect', icon: 'rect', label: 'Box', key: 'r' },
  { id: 'ellipse', icon: 'ellipse', label: 'Circle', key: 'e' },
  { id: 'cloud', icon: 'cloud', label: 'Cloud', key: 'c' },
  { id: 'text', icon: 'text', label: 'Text', key: 't' },
  { id: 'dimension', icon: 'dimension', label: 'Dimension', key: 'd' },
  { id: 'badge', icon: 'badge', label: 'Number', key: 'n' },
  { id: 'eraser', icon: 'eraser', label: 'Eraser', key: 'x' },
];
const TOOL_IDS = new Set(TOOLS.map((t) => t.id));
const DRAG_TOOLS = new Set(['line', 'arrow', 'rect', 'ellipse', 'cloud', 'dimension']);
const BOX_TOOLS = new Set(['rect', 'ellipse', 'cloud']);
const EDITABLE = new Set(['text', 'dimension', 'badge']);
const SIZE_NAMES = { S: 'Small', M: 'Medium', L: 'Large' };
const SHAPE_NOUN = { line: 'a line', arrow: 'an arrow', rect: 'a box', ellipse: 'a circle', cloud: 'a cloud', dimension: 'a dimension' };

const PREFS_KEY = 'jw.annotate.prefs';
const DRAFT_EVERY_MS = 3000;
const UNDO_LIMIT = 200;
const MAX_DPR = 3;
const HIT_TOL = 12;          // CSS px: how close a finger must be to a mark to pick it
const HANDLE_HIT = 26;       // CSS px around a drag handle
const ERASE_RADIUS = 14;     // CSS px
const PEN_MIN_STEP = 1.5;    // CSS px between kept pen points
const PEN_SIMPLIFY = 0.45;   // CSS px of allowed deviation when a stroke is finished
const MIN_SHAPE_PX = 6;      // CSS px: a shorter drag is treated as a slip
const SEL_COLOR = '#4da3ff';

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const roundPt = (p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });

/**
 * Open the markup editor for one photo. Returns the cleanup the router
 * runs when the person leaves (it keeps an unsaved draft, frees the decoded
 * photo and the canvases, and removes every listener).
 */
export async function open(ctx) {
  const { store } = ctx.app;
  const { pid, iid } = ctx.params;
  const itemPath = `p/${pid}/i/${iid}`;
  const root = ctx.root;
  root.classList.add('annot');

  let editor = null;
  let image = null;
  let closed = false;
  let onBack = () => ctx.back(itemPath);

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    try { await editor?.destroy(); } catch (err) { console.error('[annotate] cleanup failed', err); }
    image?.close();
    image = null;
  };

  const title = el('h1', {}, 'Mark up');
  const sub = el('div', { class: 'sub' }, '');
  const top = el('header', { class: 'annot-top' },
    iconButton('back', { title: 'Back', onclick: () => onBack() }),
    el('div', { class: 'topbar-title' }, title, sub));
  const stage = el('div', { class: 'annot-stage' });
  const cover = el('div', { class: 'annot-cover' });
  stage.append(cover);
  root.append(top, stage);

  const showCover = (...children) => { cover.replaceChildren(...children); cover.hidden = false; };
  const showLoading = (text) => showCover(el('div', { class: 'spinner' }), el('p', { class: 'annot-cover-text' }, text));
  const backAction = (label = 'Back') => ({ label, primary: true, onclick: () => ctx.back(itemPath) });
  const showMessage = ({ ic = 'info', heading, text, actions = [backAction()] }) => showCover(
    el('div', { class: 'annot-msg' },
      el('span', { class: 'annot-msg-ic', html: icon(ic, { size: 30 }) }),
      el('h2', {}, heading),
      el('p', {}, text),
      el('div', { class: 'annot-msg-btns' }, actions.map((a) => el('button', {
        type: 'button', class: a.primary ? 'btn btn-primary' : 'btn btn-outline annot-btn-dark', onclick: a.onclick,
      }, a.label)))));
  const retry = { label: 'Try again', onclick: () => ctx.navigate(`${itemPath}/annotate`, { replace: true }) };

  showLoading('Opening the photo…');

  // ---- load the item and its photo --------------------------------------------------
  let item;
  try {
    item = await store.getItem(iid);
  } catch (err) {
    if (ctx.isCurrent()) showMessage({ ic: 'warning', heading: 'The photo could not be opened', text: err.message, actions: [retry, backAction()] });
    return cleanup;
  }
  if (!ctx.isCurrent()) return cleanup;
  if (!item || item.projectId !== pid) {
    showMessage({ ic: 'warning', heading: 'This photo is not on this phone', text: 'It may have been deleted for good, or it belongs to another job walk.', actions: [{ label: 'Go to the job walk', primary: true, onclick: () => ctx.navigate(`p/${pid}`, { replace: true }) }] });
    return cleanup;
  }
  title.textContent = item.seq ? `Mark up #${item.seq}` : 'Mark up';
  sub.textContent = item.title || 'Photo';
  if (item.type === 'video') {
    showMessage({ ic: 'video', heading: 'Markup is for photos', text: 'A video cannot be marked up. On the video’s page you can add text notes, voice notes and tags instead.', actions: [backAction('Back to the video')] });
    return cleanup;
  }
  if (item.type !== 'photo') {
    showMessage({ ic: 'note', heading: 'There is no photo to mark up', text: 'This is a note. Notes can have text, tags and voice notes on their page.', actions: [backAction('Back to the note')] });
    return cleanup;
  }

  let originalBlob = null;
  try {
    originalBlob = await store.getMediaBlob(item.media?.original);
  } catch (err) {
    if (ctx.isCurrent()) showMessage({ ic: 'warning', heading: 'The photo could not be read', text: err.message, actions: [retry, backAction()] });
    return cleanup;
  }
  if (!ctx.isCurrent()) return cleanup;
  if (!originalBlob) {
    showMessage({ ic: 'warning', heading: 'The photo file is missing', text: 'This photo has no picture saved on this phone, so there is nothing to mark up. Its notes and position are still kept.' });
    return cleanup;
  }

  try {
    image = await openPhoto(originalBlob);
  } catch (err) {
    console.error('[annotate] decode failed', err);
    if (ctx.isCurrent()) {
      showMessage({ ic: 'warning', heading: 'The photo could not be opened', text: `${err.message} If the phone is low on memory, close other apps and try again.`, actions: [retry, backAction()] });
    }
    return cleanup;
  }
  if (!ctx.isCurrent()) return cleanup;

  try {
    editor = createEditor({ ctx, root, top, sub, stage, item, image, originalBlob, itemPath });
  } catch (err) {
    console.error('[annotate] editor failed to start', err);
    showMessage({ ic: 'warning', heading: 'The markup tools could not start', text: `${err.message || err} The photo is safe and unchanged.`, actions: [retry, backAction()] });
    return cleanup;
  }
  cover.hidden = true;
  onBack = () => editor.requestLeave();
  // Not awaited: the router should get the cleanup now, even while the
  // "continue your markup?" question is on screen.
  editor.offerDraft().catch((err) => console.warn('[annotate] draft offer failed', err));
  return cleanup;
}

// ---- the editor -----------------------------------------------------------------------

function createEditor({ ctx, root, top, sub, stage, item, image, originalBlob, itemPath }) {
  const { store } = ctx.app;
  const settings = () => (typeof ctx.app.getSettings === 'function' ? ctx.app.getSettings() : null) || {};
  const iid = item.id;
  const W = image.width;
  const H = image.height;
  const touchFirst = matches('(pointer: coarse)');
  const listeners = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    listeners.push(() => target.removeEventListener(type, fn, opts));
  };

  // ---- state --------------------------------------------------------------------------
  const savedAnn = item.annotations ? A.rescaleAnnotations(item.annotations, W, H) : null;
  let shapes = savedAnn ? savedAnn.shapes : [];
  let savedJson = JSON.stringify(shapes);
  let savedAt = item.annotations?.updatedAt || 0;
  // Saved markup whose picture copy is missing (e.g. from an older import):
  // Save makes the copy even when no shape changed.
  let needsFlatten = shapes.length > 0 && !item.media?.annotated;
  let dirty = false;
  let undoStack = [];
  let redoStack = [];
  let selectedId = null;
  const prefs = loadPrefs();
  let tool = prefs.tool;
  let color = prefs.color;
  let sizeKey = prefs.size;

  let view = { scale: 1, x: 0, y: 0 };
  let atFit = true;
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let stageRect = null;

  const pointers = new Map();   // pointerId → {x, y, type} in stage CSS px
  let gesture = null;           // what the finger / mouse is doing right now
  let liveShapes = null;        // the shapes while a move or erase is in progress
  let draft = null;             // the shape being drawn
  let pendingShape = null;      // a drawn shape waiting for its label dialog
  let eraserAt = null;          // screen point of the eraser ring
  let spaceDown = false;
  let dialogOpen = false;

  let saving = false;
  let leaving = false;
  let discarded = false;
  let destroyed = false;

  // Draft autosave. Writes are queued one after another, so a slow write can
  // never land after a newer one (or after Save cleared the draft).
  let chain = Promise.resolve();
  let storedDraftJson = Array.isArray(item.annotationsDraft?.shapes) ? JSON.stringify(item.annotationsDraft.shapes) : null;
  let draftPending = false;
  let draftKept = false;
  let draftWarned = false;

  // ---- top bar, stage, toolbars -----------------------------------------------------------
  // The canvases first: if this browser cannot draw, nothing else is put on screen.
  const photoCanvas = el('canvas', { class: 'annot-photo', 'aria-hidden': 'true' });
  const inkCanvas = el('canvas', { class: 'annot-ink', role: 'img', 'aria-label': 'The photo with its markup' });
  const pctx = photoCanvas.getContext('2d');
  const ictx = inkCanvas.getContext('2d');
  if (!pctx || !ictx) throw new Error('This browser could not make a drawing area.');

  const undoBtn = iconButton('undo', { title: 'Undo', onclick: () => undo() });
  const redoBtn = iconButton('redo', { title: 'Redo', onclick: () => redo() });
  const saveBtn = el('button', {
    type: 'button', class: 'btn btn-primary annot-save', onclick: () => save({ leave: true }),
    html: `${icon('check', { size: 18 })}<span>Save</span>`,
  });
  top.append(undoBtn, redoBtn, saveBtn);

  const hintEl = el('div', { class: 'annot-hint', role: 'status', 'aria-live': 'polite' });
  const fitBtn = el('button', {
    type: 'button', class: 'annot-fit', title: 'Fit the photo to the screen (0)', 'aria-label': 'Fit the photo to the screen',
    html: icon('fit', { size: 22 }), onclick: () => fit(), hidden: true,
  });
  const editBtn = el('button', { type: 'button', class: 'annot-selbtn', onclick: () => editShape(selectedId), html: `${icon('edit', { size: 20 })}<span>Edit</span>` });
  const deleteBtn = el('button', { type: 'button', class: 'annot-selbtn danger', onclick: () => deleteSelected(), html: `${icon('trash', { size: 20 })}<span>Delete</span>` });
  const selBar = el('div', { class: 'annot-selbar', hidden: true }, editBtn, deleteBtn);
  stage.prepend(photoCanvas, inkCanvas);
  stage.append(hintEl, fitBtn, selBar);
  stage.setAttribute('aria-label', 'Markup area');

  const swatches = A.COLORS.map((c) => el('button', {
    type: 'button', class: 'annot-swatch', title: c.label, 'aria-label': c.label, 'aria-pressed': 'false',
    dataset: { color: c.value }, onclick: () => setColor(c.value),
  }, el('span', { style: { background: c.value } })));
  const sizeBtns = A.SIZE_KEYS.map((k) => el('button', {
    type: 'button', class: 'annot-size', title: SIZE_NAMES[k], 'aria-label': `${SIZE_NAMES[k]} size`, 'aria-pressed': 'false',
    dataset: { size: k }, onclick: () => setSize(k),
  }, el('i', { class: `annot-dot annot-dot-${k}` }), el('span', {}, k)));
  const opts = el('div', { class: 'annot-opts' },
    el('div', { class: 'annot-swatches', role: 'group', 'aria-label': 'Colour' }, swatches),
    el('div', { class: 'annot-sizes', role: 'group', 'aria-label': 'Size' }, sizeBtns));
  const toolBtns = TOOLS.map((t) => el('button', {
    type: 'button', class: 'annot-tool', title: `${t.label} (${t.key.toUpperCase()})`, 'aria-pressed': 'false',
    dataset: { tool: t.id }, onclick: () => setTool(t.id),
    html: `${icon(t.icon, { size: 22 })}<span>${t.label}</span>`,
  }));
  const tools = el('nav', { class: 'annot-tools', 'aria-label': 'Markup tools' }, toolBtns);
  root.append(opts, tools);

  const preview = makePreview(image, W, H);
  const previewRatio = preview ? preview.width / W : 0;

  // ---- coordinates and view ------------------------------------------------------------------
  const toPhoto = (p) => ({ x: (p.x - view.x) / view.scale, y: (p.y - view.y) / view.scale });
  const toScreen = (p) => ({ x: p.x * view.scale + view.x, y: p.y * view.scale + view.y });
  const clampPhoto = (p) => ({ x: clamp(p.x, 0, W), y: clamp(p.y, 0, H) });
  const localPoint = (e) => {
    const r = stageRect || stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function fitScale() {
    const pad = Math.min(12, cssW * 0.03);
    return Math.max(1e-4, Math.min((cssW - pad * 2) / W, (cssH - pad * 2) / H));
  }
  const minScale = () => fitScale() * 0.5;
  const maxScale = () => Math.max(fitScale() * 12, 4);

  function fit() {
    const s = fitScale();
    view = { scale: s, x: (cssW - W * s) / 2, y: (cssH - H * s) / 2 };
    atFit = true;
    fitBtn.hidden = true;
    requestDraw(true);
  }

  /** Keep the photo on screen: centred-ish when it is smaller than the stage, edges within reach when zoomed in. */
  function clampView() {
    const m = 48;
    const pw = W * view.scale;
    const ph = H * view.scale;
    view.x = pw + m * 2 <= cssW ? clamp(view.x, m, cssW - pw - m) : clamp(view.x, cssW - pw - m, m);
    view.y = ph + m * 2 <= cssH ? clamp(view.y, m, cssH - ph - m) : clamp(view.y, cssH - ph - m, m);
  }

  function viewMoved() {
    atFit = false;
    clampView();
    fitBtn.hidden = false;
    requestDraw(true);
  }

  function zoomAt(sx, sy, factor) {
    const s0 = view.scale;
    const s1 = clamp(s0 * factor, minScale(), maxScale());
    if (s1 === s0) return;
    const px = (sx - view.x) / s0;
    const py = (sy - view.y) / s0;
    view.scale = s1;
    view.x = sx - px * s1;
    view.y = sy - py * s1;
    viewMoved();
  }

  function resize() {
    if (destroyed) return;
    const r = stage.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return; // hidden or mid-layout
    stageRect = r;
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    const nd = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    if (w === cssW && h === cssH && nd === dpr) return;
    const prevW = cssW;
    const prevH = cssH;
    cssW = w;
    cssH = h;
    dpr = nd;
    for (const c of [photoCanvas, inkCanvas]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    if (atFit || !prevW) {
      fit();
    } else {
      // Keep whatever was in the middle of the screen in the middle.
      const c = { x: (prevW / 2 - view.x) / view.scale, y: (prevH / 2 - view.y) / view.scale };
      view.scale = clamp(view.scale, minScale(), maxScale());
      view.x = w / 2 - c.x * view.scale;
      view.y = h / 2 - c.y * view.scale;
      clampView();
    }
    // A resized canvas is blank: draw now rather than on the next frame, so it never flickers.
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    needPhoto = true;
    needInk = true;
    drawFrame();
  }

  // ---- drawing ----------------------------------------------------------------------------------
  let raf = 0;
  let needPhoto = true;
  let needInk = true;

  function requestDraw(photoToo = true) {
    if (destroyed) return;
    if (photoToo) needPhoto = true;
    needInk = true;
    if (!raf) raf = requestAnimationFrame(drawFrame);
  }

  function drawFrame() {
    raf = 0;
    if (destroyed || !cssW) return;
    if (needPhoto) drawPhoto();
    if (needInk) drawInk();
    needPhoto = false;
    needInk = false;
  }

  function drawPhoto() {
    const c = pctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, photoCanvas.width, photoCanvas.height);
    c.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);
    c.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in c) c.imageSmoothingQuality = 'high';
    // Zoomed out, the smaller copy looks smoother and draws faster.
    const src = preview && dpr * view.scale <= previewRatio ? preview : image.source;
    c.drawImage(src, 0, 0, W, H);
  }

  function drawInk() {
    const c = ictx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
    c.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);
    // Clip to the photo: what is off the picture would not be in the saved copy either.
    c.save();
    c.beginPath();
    c.rect(0, 0, W, H);
    c.clip();
    A.renderAnnotations(c, current());
    if (pendingShape) A.renderShape(c, pendingShape);
    if (draft) A.renderShape(c, draft);
    c.restore();
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawOverlay(c);
  }

  /** Selection box and handles, and the eraser ring — in screen pixels, so they stay the same size at any zoom. */
  function drawOverlay(c) {
    const sel = tool === 'select' ? selectedShape() : null;
    if (sel) {
      const b = A.shapeBounds(sel);
      const p = toScreen({ x: b.x, y: b.y });
      const pad = 6;
      const x = p.x - pad;
      const y = p.y - pad;
      const w = b.w * view.scale + pad * 2;
      const h = b.h * view.scale + pad * 2;
      c.save();
      c.lineWidth = 3;
      c.strokeStyle = 'rgba(0, 0, 0, 0.5)';
      c.strokeRect(x, y, w, h);
      c.setLineDash([7, 5]);
      c.lineWidth = 1.5;
      c.strokeStyle = SEL_COLOR;
      c.strokeRect(x, y, w, h);
      c.setLineDash([]);
      for (const hd of A.shapeHandles(sel)) {
        const s = toScreen(hd);
        c.beginPath();
        c.arc(s.x, s.y, 9, 0, Math.PI * 2);
        c.fillStyle = '#ffffff';
        c.fill();
        c.lineWidth = 2.5;
        c.strokeStyle = SEL_COLOR;
        c.stroke();
      }
      c.restore();
    }
    if (tool === 'eraser' && eraserAt) {
      c.save();
      c.beginPath();
      c.arc(eraserAt.x, eraserAt.y, ERASE_RADIUS, 0, Math.PI * 2);
      c.lineWidth = 3;
      c.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      c.stroke();
      c.lineWidth = 1.5;
      c.strokeStyle = '#ffffff';
      c.stroke();
      c.restore();
    }
  }

  // ---- shapes, undo, redo ---------------------------------------------------------------------
  const current = () => liveShapes || shapes;
  const selectedShape = () => (selectedId ? current().find((s) => s.id === selectedId) || null : null);
  const replaceShape = (list, s) => list.map((x) => (x.id === s.id ? s : x));
  const alive = () => !destroyed && ctx.isCurrent();

  function commit(next) {
    undoStack.push(shapes);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = [];
    shapes = next;
    afterChange();
  }

  function afterChange() {
    liveShapes = null;
    if (selectedId && !shapes.some((s) => s.id === selectedId)) selectedId = null;
    dirty = JSON.stringify(shapes) !== savedJson;
    draftPending = true;
    draftKept = false;
    refreshUi();
    requestDraw(false);
  }

  function undo() {
    if (saving || dialogOpen || !undoStack.length) return;
    cancelGesture();
    redoStack.push(shapes);
    shapes = undoStack.pop();
    afterChange();
  }

  function redo() {
    if (saving || dialogOpen || !redoStack.length) return;
    cancelGesture();
    undoStack.push(shapes);
    shapes = redoStack.pop();
    afterChange();
  }

  function select(id) {
    selectedId = id;
    refreshUi();
    requestDraw(false);
  }

  function deleteSelected() {
    const s = selectedShape();
    if (!s || saving) return;
    commit(shapes.filter((x) => x.id !== s.id));
    showHint('Deleted. Tap Undo to bring it back.');
  }

  // ---- toolbar state ------------------------------------------------------------------------------
  function subText() {
    if (dirty) return draftKept ? 'Not saved yet · draft kept on this phone' : 'Not saved yet';
    return item.title || 'Photo';
  }

  function cursorFor() {
    if (spaceDown) return 'grab';
    if (tool === 'select') return 'select';
    if (tool === 'eraser') return 'erase';
    if (tool === 'text' || tool === 'badge') return 'place';
    return 'draw';
  }

  function refreshUi() {
    if (destroyed) return;
    undoBtn.disabled = saving || !undoStack.length;
    redoBtn.disabled = saving || !redoStack.length;
    saveBtn.disabled = saving;
    saveBtn.classList.toggle('dirty', dirty);
    for (const b of toolBtns) {
      const isOn = b.dataset.tool === tool;
      b.classList.toggle('on', isOn);
      b.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    }
    const sel = tool === 'select' ? selectedShape() : null;
    const shownColor = String(sel ? sel.color : color).toLowerCase();
    const shownSize = sel ? A.nearestSizeKey(sel, W, H) : sizeKey;
    for (const b of swatches) {
      const isOn = b.dataset.color.toLowerCase() === shownColor;
      b.classList.toggle('on', isOn);
      b.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    }
    for (const b of sizeBtns) {
      const isOn = b.dataset.size === shownSize;
      b.classList.toggle('on', isOn);
      b.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    }
    opts.classList.toggle('off', tool === 'eraser');
    selBar.hidden = !sel;
    editBtn.hidden = !(sel && EDITABLE.has(sel.type));
    stage.dataset.cursor = cursorFor();
    sub.textContent = subText();
  }

  function hintFor(id) {
    switch (id) {
      case 'select': return touchFirst ? 'Tap a mark to select it. Drag it to move it.' : 'Click a mark to select it. Drag it to move it.';
      case 'pen': return touchFirst ? 'Draw with one finger. Two fingers zoom and move.' : 'Drag to draw. Scroll to zoom.';
      case 'highlight': return 'Drag over what you want to highlight.';
      case 'arrow': return 'Drag from the tail to the point.';
      case 'line': return 'Drag to draw a line. Hold Shift for straight angles.';
      case 'rect': return 'Drag to draw a box.';
      case 'ellipse': return 'Drag to draw a circle.';
      case 'cloud': return 'Drag to draw a revision cloud.';
      case 'text': return 'Tap where the text should go.';
      case 'dimension': return 'Drag along the length, then type it.';
      case 'badge': return `Tap to place number ${A.nextBadgeNumber(shapes)}.`;
      case 'eraser': return 'Tap or rub over a mark to erase it.';
      default: return '';
    }
  }

  let hintTimer = 0;
  function showHint(text, ms = 2600) {
    if (!text || destroyed) return;
    hintEl.textContent = text;
    hintEl.classList.add('on');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hintEl.classList.remove('on'), ms);
  }

  function setTool(id) {
    if (!TOOL_IDS.has(id) || saving || dialogOpen) return;
    cancelGesture();
    if (id !== 'select') selectedId = null;
    if (id !== 'eraser') eraserAt = null;
    tool = id;
    savePrefs({ tool, color, size: sizeKey });
    showHint(hintFor(id));
    refreshUi();
    requestDraw(false);
    // Keep the chosen tool in view in the scrolling bar (without scrollIntoView,
    // which can also scroll the whole screen on some phones).
    const b = toolBtns.find((x) => x.dataset.tool === id);
    if (b) {
      const l = b.offsetLeft;
      const r = l + b.offsetWidth;
      if (l < tools.scrollLeft) tools.scrollLeft = l - 8;
      else if (r > tools.scrollLeft + tools.clientWidth) tools.scrollLeft = r - tools.clientWidth + 8;
    }
  }

  function setColor(value) {
    if (saving || dialogOpen) return;
    color = value;
    savePrefs({ tool, color, size: sizeKey });
    const sel = tool === 'select' ? selectedShape() : null;
    if (sel && String(sel.color).toLowerCase() !== value.toLowerCase()) commit(replaceShape(shapes, A.applyColor(sel, value)));
    else refreshUi();
  }

  function setSize(key) {
    if (saving || dialogOpen) return;
    sizeKey = key;
    savePrefs({ tool, color, size: sizeKey });
    const sel = tool === 'select' ? selectedShape() : null;
    if (sel && A.nearestSizeKey(sel, W, H) !== key) commit(replaceShape(shapes, A.applySize(sel, key, W, H)));
    else refreshUi();
  }

  // ---- gestures -------------------------------------------------------------------------------------
  //
  // gesture.type:
  //   draw    a pen stroke or a two-point shape (draft)
  //   tap     text / number tools: becomes a pan if the finger moves
  //   move    dragging a selected shape (liveShapes)
  //   handle  dragging an end or corner of the selected shape
  //   erase   rubbing out (liveShapes without the erased marks)
  //   pan     moving the photo with one finger / Space + drag / middle button
  //   pinch   two fingers: zoom and move together
  //   idle    after a pinch, until every finger is up (so a lingering finger never draws)

  function onPointerDown(e) {
    if (destroyed || saving || dialogOpen) return;
    // The Fit / Edit / Delete buttons sit on the stage: capturing their
    // pointer would send their click to the stage instead.
    if (e.target !== stage && e.target.closest?.('button')) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    // Palm rejection: while a stylus is down, a resting hand is not a pinch.
    if (e.pointerType === 'touch' && [...pointers.values()].some((p) => p.type === 'pen')) return;
    stageRect = stage.getBoundingClientRect();
    const pt = localPoint(e);
    try { stage.setPointerCapture(e.pointerId); } catch { /* not supported */ }
    pointers.set(e.pointerId, { x: pt.x, y: pt.y, type: e.pointerType });
    e.preventDefault();
    if (pointers.size >= 2) {
      startPinch();
      return;
    }
    if (gesture) return;
    if (e.pointerType === 'mouse' && (e.button === 1 || spaceDown)) {
      gesture = { type: 'pan', start: pt, v0: { ...view } };
      stage.dataset.cursor = 'grabbing';
      return;
    }
    startToolGesture(e, pt);
  }

  function startToolGesture(e, pt) {
    const p = clampPhoto(toPhoto(pt));
    const base = { start: pt, t0: performance.now(), slop: e.pointerType === 'mouse' ? 4 : 10, moved: false, v0: { ...view } };
    if (tool === 'select') { startSelect(base, pt, toPhoto(pt)); return; }
    if (tool === 'pen' || tool === 'highlight') {
      const hl = tool === 'highlight';
      draft = A.createShape('pen', {
        color,
        width: hl ? A.highlightWidthFor(sizeKey, W, H) : A.strokeWidthFor(sizeKey, W, H),
        mode: hl ? 'highlight' : 'pen',
        points: [[p.x, p.y]],
      });
      gesture = { ...base, type: 'draw' };
      requestDraw(false);
      return;
    }
    if (DRAG_TOOLS.has(tool)) {
      const fields = { color, width: A.strokeWidthFor(sizeKey, W, H), a: p, b: { ...p } };
      if (tool === 'dimension') { fields.label = ''; fields.size = A.fontSizeFor(sizeKey, W, H); }
      draft = A.createShape(tool, fields);
      gesture = { ...base, type: 'draw' };
      return;
    }
    if (tool === 'text' || tool === 'badge') {
      gesture = { ...base, type: 'tap', photo: p };
      return;
    }
    if (tool === 'eraser') {
      gesture = { ...base, type: 'erase', removed: new Set(), last: toPhoto(pt) };
      eraserAt = pt;
      eraseAlong(gesture, gesture.last, gesture.last);
      requestDraw(false);
    }
  }

  function startSelect(base, pt, p) {
    const sel = selectedShape();
    const tol = HIT_TOL / view.scale;
    if (sel) {
      for (const h of A.shapeHandles(sel)) {
        const hs = toScreen(h);
        if (A.dist(hs, pt) <= HANDLE_HIT) {
          gesture = { ...base, type: 'handle', id: sel.id, handle: h.id, original: sel, offset: { x: h.x - p.x, y: h.y - p.y } };
          return;
        }
      }
    }
    // A mark right under the finger wins (a number inside a selected box can still be picked)…
    const onMark = A.hitShape(shapes, p.x, p.y, tol, { interior: false });
    // …otherwise anywhere in the selected shape's box grabs it: thin strokes are hard to hit twice.
    if (sel && (!onMark || onMark.id === sel.id) && A.pointInRect(p, A.shapeBounds(sel), tol)) {
      gesture = { ...base, type: 'move', id: sel.id, original: sel, bounds: A.shapeBounds(sel), from: p, wasSelected: true };
      return;
    }
    const hit = onMark || A.hitShape(shapes, p.x, p.y, tol);
    if (hit) {
      const wasSelected = hit.id === selectedId;
      select(hit.id);
      gesture = { ...base, type: 'move', id: hit.id, original: hit, bounds: A.shapeBounds(hit), from: p, wasSelected };
      return;
    }
    if (sel) select(null);
    gesture = { ...base, type: 'pan' };
  }

  function startPinch() {
    if (gesture && gesture.type !== 'pinch') abandonGesture();
    const [p1, p2] = [...pointers.values()];
    gesture = { type: 'pinch', d0: Math.max(10, A.dist(p1, p2)), s0: view.scale, anchor: toPhoto(mid(p1, p2)) };
  }

  /**
   * A second finger landed during a gesture: the person wants to zoom. A
   * long pen stroke already drawn is kept; anything else in progress is
   * dropped, so a pinch never leaves a stray mark.
   */
  function abandonGesture() {
    const g = gesture;
    gesture = null;
    if (g?.type === 'draw' && draft?.type === 'pen' && g.moved && performance.now() - g.t0 > 300 && draft.points.length > 3) {
      finishDraw(g, null, false);
    } else {
      draft = null;
    }
    liveShapes = null;
    if (g?.type === 'erase') eraserAt = null;
    requestDraw(false);
  }

  /** Stop whatever is in progress without changing anything (tool change, undo, Escape). */
  function cancelGesture() {
    draft = null;
    liveShapes = null;
    gesture = pointers.size ? { type: 'idle' } : null;
    requestDraw(false);
  }

  function onPointerMove(e) {
    if (destroyed) return;
    const pt = localPoint(e);
    const p = pointers.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse' && tool === 'eraser') { eraserAt = pt; requestDraw(false); }
      return;
    }
    p.x = pt.x;
    p.y = pt.y;
    const g = gesture;
    if (!g) return;
    e.preventDefault();
    switch (g.type) {
      case 'pinch': pinchMove(g); break;
      case 'pan': panMove(g, pt); break;
      case 'draw': drawMove(g, e, pt); break;
      case 'move': moveMove(g, pt); break;
      case 'handle': handleMove(g, pt, e); break;
      case 'erase': {
        const q = toPhoto(pt);
        eraseAlong(g, g.last, q);
        g.last = q;
        eraserAt = pt;
        requestDraw(false);
        break;
      }
      case 'tap':
        if (A.dist(pt, g.start) > g.slop) {
          gesture = { type: 'pan', start: g.start, v0: g.v0 };
          panMove(gesture, pt);
        }
        break;
      default: break;
    }
  }

  function pinchMove(g) {
    if (pointers.size < 2) return;
    const [p1, p2] = [...pointers.values()];
    const m = mid(p1, p2);
    const s = clamp(g.s0 * A.dist(p1, p2) / g.d0, minScale(), maxScale());
    view.scale = s;
    view.x = m.x - g.anchor.x * s;
    view.y = m.y - g.anchor.y * s;
    viewMoved();
  }

  function panMove(g, pt) {
    view.x = g.v0.x + (pt.x - g.start.x);
    view.y = g.v0.y + (pt.y - g.start.y);
    viewMoved();
  }

  function drawMove(g, e, pt) {
    if (!draft) return;
    if (!g.moved && A.dist(pt, g.start) > g.slop) g.moved = true;
    if (draft.type === 'pen') {
      // Coalesced events carry the points between frames: smoother fast strokes.
      const list = (typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents()) || [];
      const minD = PEN_MIN_STEP / view.scale;
      for (const ev of list.length ? list : [e]) {
        const q = clampPhoto(toPhoto(localPoint(ev)));
        const last = draft.points[draft.points.length - 1];
        if (Math.hypot(q.x - last[0], q.y - last[1]) >= minD) draft.points.push([q.x, q.y]);
      }
    } else {
      let b = clampPhoto(toPhoto(pt));
      if (e.shiftKey) b = clampPhoto(BOX_TOOLS.has(draft.type) ? A.squareFrom(draft.a, b) : A.snapAngle(draft.a, b, 45));
      draft.b = b;
    }
    requestDraw(false);
  }

  function moveMove(g, pt) {
    if (!g.moved) {
      if (A.dist(pt, g.start) <= g.slop) return;
      g.moved = true;
    }
    const p = toPhoto(pt);
    const d = A.clampMoveDelta(g.bounds, p.x - g.from.x, p.y - g.from.y, W, H);
    liveShapes = replaceShape(shapes, A.moveShape(g.original, d.dx, d.dy));
    requestDraw(false);
  }

  function handleMove(g, pt, e) {
    if (!g.moved) {
      if (A.dist(pt, g.start) <= g.slop / 2) return;
      g.moved = true;
    }
    const raw = toPhoto(pt);
    let p = clampPhoto({ x: raw.x + g.offset.x, y: raw.y + g.offset.y });
    if (e.shiftKey && (g.handle === 'a' || g.handle === 'b')) {
      p = clampPhoto(A.snapAngle(g.handle === 'a' ? g.original.b : g.original.a, p, 45));
    }
    liveShapes = replaceShape(shapes, A.dragHandle(g.original, g.handle, p));
    requestDraw(false);
  }

  /** Rub out every mark the eraser ring touches between two points (sampled, so a fast swipe skips nothing). */
  function eraseAlong(g, from, to) {
    const tol = ERASE_RADIUS / view.scale;
    const step = Math.max(tol * 0.6, 0.5);
    const n = Math.max(1, Math.ceil(A.dist(from, to) / step));
    let pool = shapes.filter((s) => !g.removed.has(s.id));
    for (let i = 0; i <= n && pool.length; i++) {
      const q = { x: from.x + (to.x - from.x) * (i / n), y: from.y + (to.y - from.y) * (i / n) };
      for (let k = 0; k < 50; k++) {
        const hit = A.hitShape(pool, q.x, q.y, tol, { interior: false });
        if (!hit) break;
        g.removed.add(hit.id);
        pool = pool.filter((s) => s.id !== hit.id);
      }
    }
    liveShapes = g.removed.size ? shapes.filter((s) => !g.removed.has(s.id)) : null;
  }

  function onPointerUp(e) {
    if (!pointers.has(e.pointerId)) return;
    const pt = localPoint(e);
    pointers.delete(e.pointerId);
    try { stage.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    const g = gesture;
    if (!g) return;
    if (g.type === 'pinch' || g.type === 'idle') {
      gesture = pointers.size ? { type: 'idle' } : null;
      return;
    }
    if (pointers.size) return;
    gesture = null;
    // A capture lost without a pointerup (the system took over) counts as a cancel.
    finishGesture(g, pt, e.type === 'pointercancel' || e.type === 'lostpointercapture', e.pointerType);
  }

  function finishGesture(g, pt, cancelled, pointerType) {
    switch (g.type) {
      case 'draw':
        finishDraw(g, pt, cancelled);
        break;
      case 'move':
      case 'handle':
        if (!cancelled && g.moved && liveShapes) {
          commit(liveShapes);
        } else {
          liveShapes = null;
          requestDraw(false);
          // A second tap on an already selected text, dimension or number edits it.
          if (!cancelled && !g.moved && g.type === 'move' && g.wasSelected && EDITABLE.has(g.original.type)) editShape(g.id);
        }
        break;
      case 'erase':
        if (!cancelled && g.removed.size) commit(shapes.filter((s) => !g.removed.has(s.id)));
        else liveShapes = null;
        if (pointerType !== 'mouse') eraserAt = null;
        requestDraw(false);
        break;
      case 'tap':
        if (cancelled) break;
        if (tool === 'text') placeText(g.photo);
        else if (tool === 'badge') placeBadge(g.photo);
        break;
      case 'pan':
        stage.dataset.cursor = cursorFor();
        break;
      default:
        break;
    }
  }

  function finishDraw(g, pt, cancelled) {
    const s = draft;
    draft = null;
    if (!s) return;
    if (s.type === 'pen') {
      if (cancelled && s.points.length < 4) { requestDraw(false); return; }
      if (pt && !cancelled) {
        const q = clampPhoto(toPhoto(pt));
        const last = s.points[s.points.length - 1];
        if (Math.hypot(q.x - last[0], q.y - last[1]) >= PEN_MIN_STEP / view.scale) s.points.push([q.x, q.y]);
      }
      // A stroke smaller than a few screen pixels was a tap: keep it as a dot.
      const b = A.shapeBounds({ ...s, width: 0 });
      if (Math.max(b.w, b.h) * view.scale < 3) s.points = [s.points[0]];
      s.points = A.roundPoints(A.simplifyPath(s.points, PEN_SIMPLIFY / view.scale), 1);
      commit([...shapes, s]);
      return;
    }
    if (cancelled || !g.moved || A.dist(s.a, s.b) * view.scale < MIN_SHAPE_PX) {
      requestDraw(false);
      if (!cancelled) showHint(`Drag to draw ${SHAPE_NOUN[s.type] || 'it'}.`);
      return;
    }
    s.a = roundPt(s.a);
    s.b = roundPt(s.b);
    if (s.type === 'dimension') { askDimensionLabel(s); return; }
    commit([...shapes, s]);
  }

  // ---- dialogs: text, dimensions, numbers ------------------------------------------------------------

  async function ask(fn) {
    dialogOpen = true;
    try { return await fn(); } finally { dialogOpen = false; }
  }

  const units = () => settings().units || 'imperial';
  const dimPlaceholder = () => (units() === 'metric' ? 'e.g. 3.66 m' : 'e.g. 12\' 6"');

  async function askDimensionLabel(s) {
    pendingShape = s;
    requestDraw(false);
    const text = await ask(() => promptDialog({
      title: 'Dimension', label: 'What does it measure? (you can leave it empty)', placeholder: dimPlaceholder(), okText: 'Add',
    }));
    pendingShape = null;
    if (!alive()) return;
    if (text === null) { requestDraw(false); return; } // Cancel: the line is not added
    s.label = A.formatDimensionLabel(text, units());
    commit([...shapes, s]);
  }

  async function placeText(p) {
    // Tapping existing text with the Text tool edits it instead of stacking a new box on it.
    const hit = A.hitShape(shapes, p.x, p.y, HIT_TOL / view.scale, { interior: false });
    if (hit?.type === 'text') { await editShape(hit.id); return; }
    const text = await ask(() => promptDialog({
      title: 'Add text', label: 'Text on the photo', placeholder: 'e.g. Check header size', multiline: true, okText: 'Add',
    }));
    if (!alive() || !text) return;
    let s = A.createShape('text', {
      color, width: A.strokeWidthFor(sizeKey, W, H), at: { x: p.x, y: p.y }, text, size: A.fontSizeFor(sizeKey, W, H), bg: true,
    });
    const b = A.shapeBounds(s);
    s = A.moveShape(s, -b.w / 2, -b.h / 2); // centred on the tap
    const d = A.clampMoveDelta(A.shapeBounds(s), 0, 0, W, H, { allowCurrent: false });
    s = A.moveShape(s, d.dx, d.dy);
    s.at = roundPt(s.at);
    commit([...shapes, s]);
  }

  function placeBadge(p) {
    const hit = A.hitShape(shapes, p.x, p.y, HIT_TOL / view.scale, { interior: false });
    if (hit?.type === 'badge') { editShape(hit.id); return; }
    let s = A.createShape('badge', {
      color, width: A.strokeWidthFor(sizeKey, W, H), at: roundPt(p), n: A.nextBadgeNumber(shapes), size: A.fontSizeFor(sizeKey, W, H),
    });
    const d = A.clampMoveDelta(A.shapeBounds(s), 0, 0, W, H, { allowCurrent: false });
    s = A.moveShape(s, d.dx, d.dy);
    s.at = roundPt(s.at);
    commit([...shapes, s]);
    showHint(`Next tap places number ${A.nextBadgeNumber(shapes)}.`, 1800);
  }

  async function editShape(id) {
    const s = shapes.find((x) => x.id === id);
    if (!s || saving || dialogOpen) return;
    if (s.type === 'text') {
      const text = await ask(() => promptDialog({ title: 'Edit text', label: 'Text on the photo', value: s.text, multiline: true, okText: 'Done' }));
      const cur = alive() && text !== null ? shapes.find((x) => x.id === id) : null;
      if (!cur || text === cur.text) return;
      if (!text) {
        commit(shapes.filter((x) => x.id !== id));
        showHint('Text removed. Tap Undo to bring it back.');
        return;
      }
      commit(replaceShape(shapes, { ...A.cloneShape(cur), text }));
    } else if (s.type === 'dimension') {
      const label = await ask(() => promptDialog({ title: 'Dimension', label: 'What does it measure?', value: s.label || '', placeholder: dimPlaceholder(), okText: 'Done' }));
      const cur = alive() && label !== null ? shapes.find((x) => x.id === id) : null;
      if (!cur) return;
      const next = A.formatDimensionLabel(label, units());
      if (next !== (cur.label || '')) commit(replaceShape(shapes, { ...A.cloneShape(cur), label: next }));
    } else if (s.type === 'badge') {
      const v = await ask(() => promptDialog({ title: 'Callout number', label: 'Number', value: String(s.n), inputmode: 'numeric', okText: 'Done' }));
      const cur = alive() && v !== null ? shapes.find((x) => x.id === id) : null;
      if (!cur) return;
      if (!/^\d{1,3}$/.test(v) || Number(v) < 1) {
        toast('Use a whole number from 1 to 999.', { type: 'warn' });
        return;
      }
      if (Number(v) !== cur.n) commit(replaceShape(shapes, { ...A.cloneShape(cur), n: Number(v) }));
    }
  }

  // ---- mouse wheel and keyboard -------------------------------------------------------------------------

  function onWheel(e) {
    if (destroyed || saving) return;
    e.preventDefault();
    stageRect = stage.getBoundingClientRect();
    const pt = localPoint(e);
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= cssH;
    // ctrlKey is set for a trackpad pinch, which sends small deltas.
    zoomAt(pt.x, pt.y, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)));
  }

  const isTyping = (t) => !!t?.closest?.('input, textarea, select, [contenteditable="true"]');
  const overlayOpen = () => !!document.querySelector('#overlays .modal-back, #overlays .sheet-back, #overlays .busy-back');

  function onKeyDown(e) {
    if (destroyed || e.defaultPrevented || isTyping(e.target) || overlayOpen()) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key || '';
    const k = key.length === 1 ? key.toLowerCase() : key;
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod && k === 's') { e.preventDefault(); save({ leave: true }); return; }
    if (mod || e.altKey) return;
    if (k === ' ') {
      e.preventDefault();
      if (!spaceDown) { spaceDown = true; stage.dataset.cursor = cursorFor(); }
      return;
    }
    if ((k === 'Delete' || k === 'Backspace') && selectedShape()) { e.preventDefault(); deleteSelected(); return; }
    if (k === 'Enter' && selectedShape() && EDITABLE.has(selectedShape().type)) { e.preventDefault(); editShape(selectedId); return; }
    if (k === 'Escape') {
      if (gesture || draft) { e.preventDefault(); cancelGesture(); } else if (selectedId) { e.preventDefault(); select(null); }
      return;
    }
    if (k === '0') { fit(); return; }
    if (k === '+' || k === '=') { zoomAt(cssW / 2, cssH / 2, 1.25); return; }
    if (k === '-' || k === '_') { zoomAt(cssW / 2, cssH / 2, 0.8); return; }
    const t = TOOLS.find((x) => x.key === k);
    if (t) { e.preventDefault(); setTool(t.id); }
  }

  function onKeyUp(e) {
    if (e.key === ' ' && spaceDown) {
      spaceDown = false;
      if (!destroyed) stage.dataset.cursor = cursorFor();
    }
  }

  // ---- drafts (crash safety) ------------------------------------------------------------------------------

  /** Run store writes one after another; a failure never blocks the next one. */
  function queue(fn) {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  }

  /**
   * Copy the current shapes to item.annotationsDraft (a quiet write: it is
   * not a "change" for backups). Back at the saved state, the draft is
   * cleared instead. Skipped when nothing changed since the last write.
   */
  function writeDraft() {
    if (discarded || saving) return chain;
    draftPending = false;
    const json = JSON.stringify(shapes);
    const target = json === savedJson ? null : json;
    if (target === storedDraftJson) {
      draftKept = target !== null;
      if (!destroyed) sub.textContent = subText();
      return chain;
    }
    const payload = target === null ? null : A.makeDraft(W, H, shapes, savedAt || null);
    return queue(() => store.updateItem(iid, (i) => { i.annotationsDraft = payload; }, { quiet: true }))
      .then(() => {
        storedDraftJson = target;
        draftWarned = false;
        if (JSON.stringify(shapes) === json) draftKept = target !== null;
        if (!destroyed) sub.textContent = subText();
      })
      .catch((err) => {
        console.warn('[annotate] draft not kept', err);
        draftPending = true; // try again on the next tick
        if (!draftWarned && !destroyed) {
          draftWarned = true;
          toast(`Your markup could not be copied to the phone as a draft yet: ${err.message} Tap Save to keep it.`, { type: 'warn' });
        }
      });
  }

  const draftTimer = setInterval(() => { if (draftPending && !saving) writeDraft(); }, DRAFT_EVERY_MS);

  async function offerDraft() {
    const ds = A.draftToOffer(item, W, H);
    if (!ds) return;
    const n = ds.shapes.length;
    const what = n ? `${n} mark${n === 1 ? '' : 's'}` : 'all marks removed';
    const when = ds.updatedAt ? formatDateTime(ds.updatedAt) : 'earlier';
    const ok = await ask(() => confirmDialog({
      title: 'Continue your markup?',
      message: `This photo has markup from ${when} that was not saved (${what}).`,
      okText: 'Continue it',
      cancelText: savedAnn?.shapes?.length ? 'Use last saved' : 'Start fresh',
    }));
    if (!ok || !alive()) return;
    cancelGesture();
    commit(ds.shapes); // Undo goes back to the last saved markup
    showHint('Your unsaved markup is back. Tap Save to keep it.', 4000);
  }

  // ---- save ---------------------------------------------------------------------------------------------------

  async function makeThumbnail(flatBlob, ann) {
    // media.js (the camera module) makes every other thumbnail; use it so they
    // all match, but never let a problem there stop markup from saving.
    try {
      const media = await import('../core/media.js');
      if (typeof media.makeThumb === 'function') {
        const t = await media.makeThumb(flatBlob, 400);
        if (t instanceof Blob && t.size) return t;
      }
    } catch (err) {
      console.warn('[annotate] media.makeThumb unavailable; using the built-in thumbnail', err);
    }
    // Built-in: the photo that is already open, with the markup, at 400 px.
    return A.flatten(null, ann, { image, maxSide: 400, quality: 0.8 });
  }

  const jpegQuality = () => {
    const q = settings().photoQuality;
    return q > 0 && q <= 1 ? q : 0.92;
  };
  let lastFlat = null; // {blob, json}: the marked-up JPEG of a save that could not finish

  /**
   * When saving fails (the phone is full, the photo was erased elsewhere),
   * the marked-up photo can still be kept as a file: Share / Download.
   */
  async function downloadCopy() {
    try {
      const snapshot = A.sanitizeShapes(shapes);
      const json = JSON.stringify(snapshot);
      let blob = lastFlat?.json === json ? lastFlat.blob : null;
      if (!blob) {
        if (destroyed) throw new Error('The editor is closed.');
        const b = busy('Making the marked-up photo…');
        try {
          blob = await A.flatten(originalBlob, A.toAnnotations(W, H, snapshot), { image, quality: jpegQuality() });
        } finally {
          b.done();
        }
      }
      const num = item.seq ? String(item.seq).padStart(3, '0') : 'photo';
      await saveBlob(blob, `${safeFileName(`${num} - marked up - ${todayISO()}`)}.jpg`, { title: 'Marked-up photo' });
    } catch (err) {
      toast(`The marked-up photo could not be made: ${err.message || err}`, { type: 'err' });
    }
  }

  /**
   * Save the markup. Order matters: the draft is written first (so a crash
   * while flattening loses nothing), then the flattened JPEG and its
   * thumbnail are saved and verified, then the item is pointed at them.
   * Resolves true once everything is on the phone, false otherwise.
   */
  async function save({ leave = true } = {}) {
    if (saving || destroyed) return false;
    if (dialogOpen) return false;
    cancelGesture();
    if (!dirty && !needsFlatten) {
      if (leave) { leaving = true; ctx.back(itemPath); }
      return true;
    }
    const b = busy('Saving your markup…');
    try {
      await writeDraft();
      await chain;
      saving = true;
      refreshUi();
      const now = Date.now();
      const snapshot = A.sanitizeShapes(shapes);
      const ann = A.toAnnotations(W, H, snapshot, now);
      let annotatedId = null;
      let thumbId = null;
      if (snapshot.length) {
        b.update('Drawing the markup onto the photo…', 0.15);
        // The photo already open in the editor is used (no second decode); the
        // original bytes are only read, never written.
        const flat = await A.flatten(originalBlob, ann, { image, quality: jpegQuality() });
        lastFlat = { blob: flat, json: JSON.stringify(snapshot) };
        b.update('Saving the marked-up photo…', 0.55);
        annotatedId = await store.putMedia(flat, { kind: 'annotated', projectId: item.projectId, itemId: iid, name: `${item.seq || ''}-markup.jpg` });
        b.update('Making the thumbnail…', 0.75);
        try {
          const thumb = await makeThumbnail(flat, ann);
          thumbId = await store.putMedia(thumb, { kind: 'annotatedThumb', projectId: item.projectId, itemId: iid });
        } catch (err) {
          // The marked-up photo itself is saved; lists fall back to the plain thumbnail.
          console.warn('[annotate] thumbnail not saved', err);
        }
      }
      b.update('Saving…', 0.9);
      // One transaction; the previous marked-up copy moves to annotationHistory.
      await queue(() => store.updateItem(iid, (i) => A.applySavedMarkup(i, { annotations: ann, annotatedId, thumbId, at: now })));
      storedDraftJson = null;
      savedJson = JSON.stringify(shapes);
      savedAt = now;
      needsFlatten = false;
      dirty = false;
      draftPending = false;
      draftKept = false;
      lastFlat = null;
      b.done();
      toast(snapshot.length ? 'Markup saved.' : 'Markup removed. The original photo is unchanged.', { type: 'ok' });
      saving = false;
      refreshUi();
      if (leave) { leaving = true; ctx.back(itemPath); }
      return true;
    } catch (err) {
      console.error('[annotate] save failed', err);
      b.done();
      saving = false;
      refreshUi();
      // The marks stay on screen (and in the draft); Save can be tried again,
      // or the marked-up photo kept as a file.
      toast(`The markup was not saved: ${err.message || err} Your marks are still here — try Save again, or download the marked-up photo.`, {
        type: 'err',
        action: shapes.length ? { label: 'Download', onclick: () => downloadCopy() } : undefined,
      });
      return false;
    } finally {
      saving = false;
    }
  }

  // ---- leaving -----------------------------------------------------------------------------------------------------

  function askLeave() {
    return ask(() => choose({
      title: 'Your markup is not saved',
      options: [
        { value: 'save', label: 'Save markup', icon: 'check', detail: 'Keep it with the photo' },
        { value: 'discard', label: 'Discard changes', icon: 'trash', danger: true, detail: 'The photo stays as it was before' },
      ],
      cancelText: 'Keep editing',
    }));
  }

  async function guard() {
    if (leaving || discarded || !dirty || destroyed) return true;
    if (saving) return false;
    const choice = await askLeave();
    if (choice === 'save') return save({ leave: false });
    if (choice === 'discard') { discarded = true; return true; }
    return false;
  }

  async function requestLeave() {
    if (saving || dialogOpen) return;
    if (dirty) {
      const choice = await askLeave();
      if (choice === 'save') { await save({ leave: true }); return; }
      if (choice !== 'discard') return;
      discarded = true;
    }
    leaving = true;
    ctx.back(itemPath);
  }

  ctx.setGuard(guard);

  // ---- wiring ------------------------------------------------------------------------------------------------------

  on(stage, 'pointerdown', onPointerDown);
  on(stage, 'pointermove', onPointerMove);
  on(stage, 'pointerup', onPointerUp);
  on(stage, 'pointercancel', onPointerUp);
  on(stage, 'lostpointercapture', onPointerUp);
  // Windows starts auto-scroll on a middle click; here the middle button pans.
  on(stage, 'mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  on(stage, 'auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
  on(stage, 'pointerleave', (e) => { if (e.pointerType === 'mouse' && !pointers.size && eraserAt) { eraserAt = null; requestDraw(false); } });
  on(stage, 'wheel', onWheel, { passive: false });
  on(stage, 'contextmenu', (e) => e.preventDefault());
  on(stage, 'dblclick', (e) => e.preventDefault());
  // Safari's own page pinch-zoom (touch-action: none covers the rest).
  on(stage, 'gesturestart', (e) => e.preventDefault());
  on(stage, 'gesturechange', (e) => e.preventDefault());
  on(document, 'keydown', onKeyDown);
  on(document, 'keyup', onKeyUp);
  on(window, 'blur', () => { spaceDown = false; });
  on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') writeDraft(); });
  on(window, 'pagehide', () => { writeDraft(); });

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => resize());
    ro.observe(stage);
  } else {
    on(window, 'resize', resize);
  }
  resize();
  refreshUi();
  showHint(touchFirst ? 'One finger draws. Two fingers zoom and move the photo.' : 'Scroll to zoom. Hold Space and drag to move the photo.', 3200);

  async function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearInterval(draftTimer);
    clearTimeout(hintTimer);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    ro?.disconnect();
    while (listeners.length) listeners.pop()();
    try {
      if (discarded) {
        await queue(() => store.updateItem(iid, (i) => { i.annotationsDraft = null; }, { quiet: true }));
      } else if (dirty && !saving) {
        await writeDraft(); // leaving any other way: keep the work as a draft
      }
      await chain;
    } catch (err) {
      console.warn('[annotate] draft on close', err);
    }
    releaseCanvas(photoCanvas);
    releaseCanvas(inkCanvas);
    releaseCanvas(preview);
  }

  return { destroy, requestLeave, offerDraft };
}

// ---- small helpers -----------------------------------------------------------------------------------

/**
 * Decode the original photo, upright, as {source, width, height, close()}.
 * media.js's decodeImage is preferred: it is what the rest of the app uses
 * (so markup lines up with the photo everywhere) and it catches browsers
 * that silently ignore EXIF rotation. If it is missing or fails, the
 * markup module's own decoder is used.
 */
async function openPhoto(blob) {
  try {
    const media = await import('../core/media.js');
    if (typeof media.decodeImage === 'function') {
      const src = await media.decodeImage(blob);
      const size = typeof media.sourceSize === 'function'
        ? media.sourceSize(src)
        : { width: src?.naturalWidth || src?.width || 0, height: src?.naturalHeight || src?.height || 0 };
      const close = () => {
        try { if (typeof media.releaseImage === 'function') media.releaseImage(src); else src?.close?.(); } catch { /* already closed */ }
      };
      if (size.width && size.height) return { source: src, width: size.width, height: size.height, close };
      close();
    }
  } catch (err) {
    console.warn('[annotate] media.decodeImage unavailable or failed; using the built-in decoder', err);
  }
  return A.decodeImageBlob(blob);
}

function matches(query) {
  try { return !!window.matchMedia?.(query).matches; } catch { return false; }
}

/** A ~2048 px copy of a big photo, drawn when zoomed out (smoother and faster than scaling 12 MP every frame). */
function makePreview(image, W, H) {
  const long = Math.max(W, H);
  if (long <= 2600) return null;
  try {
    const k = 2048 / long;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(W * k));
    c.height = Math.max(1, Math.round(H * k));
    const g = c.getContext('2d');
    if (!g) return null;
    g.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in g) g.imageSmoothingQuality = 'high';
    g.drawImage(image.source, 0, 0, c.width, c.height);
    return c;
  } catch {
    return null;
  }
}

function releaseCanvas(c) {
  if (!c) return;
  try { c.width = 0; c.height = 0; } catch { /* ignore */ }
}

/** The last tool, colour and size (a convenience for this phone only). */
function loadPrefs() {
  const out = { tool: 'pen', color: A.DEFAULT_COLOR, size: 'M' };
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (TOOL_IDS.has(p.tool) && p.tool !== 'eraser') out.tool = p.tool;
    if (A.COLORS.some((c) => c.value === p.color)) out.color = p.color;
    if (A.SIZE_KEYS.includes(p.size)) out.size = p.size;
  } catch { /* storage blocked: use the defaults */ }
  return out;
}

function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage blocked */ }
}
