// plan-import-dialog.js — "Where does the plan come from?"
//
// One bottom sheet that walks the person from a file to a plan image:
//
//   1. Source: Upload a PDF or picture, Take a photo of a printed sheet,
//      Paste a screenshot (Clipboard API button, the paste event, and on
//      phones a box to long-press → Paste), drag and drop on a desktop, or
//      Use the map for now.
//   2. PDF only: pick the sheet from page thumbnails (drawn lazily, one at a
//      time, so a 200-page plan set stays light), then render it in full
//      detail with pdf.js (js/core/plan-import.js).
//   3. Preview: rotate 90° either way and crop with a draggable rectangle.
//      Edits are kept as numbers and applied in ONE pass at "Use this plan",
//      so the image is re-encoded once at most.
//
// choosePlan() only returns the image; choosePlanAndSave() also stores it on
// the level (store.setLevelPlan keeps any plan it replaces), and when the
// save fails it offers Try again or Download, so a prepared plan is never
// just dropped.

import { el, toast, openSheet, busy, pickFiles, promptDialog, choose, saveBlob } from './shell.js';
import { icon } from './icons.js';
import * as store from '../core/store.js';
import { formatBytes, safeFileName, isIOS } from '../core/util.js';
import * as PI from '../core/plan-import.js';

const isMobile = () => isIOS() || (typeof navigator !== 'undefined' && /Android|Mobi/i.test(navigator.userAgent || ''));

/** Bigger than this and the file is not even read (a phone would run out of memory first). */
const maxFileBytes = () => (isMobile() ? 200 : 600) * 1024 * 1024;

/** Below this many pixels on the long side, zooming into the plan gets blurry. */
const LOW_RES_SIDE = 1600;

const defaultName = (source) => ({ camera: 'Photo of plan', paste: 'Pasted screenshot' }[source] || 'Plan image');

function sheetSize(sheet) {
  if (!sheet || !(sheet.widthIn > 0) || !(sheet.heightIn > 0)) return '';
  const r = (v) => (Math.abs(v - Math.round(v)) < 0.15 ? String(Math.round(v)) : v.toFixed(1));
  return `${r(sheet.widthIn)}″ × ${r(sheet.heightIn)}″`;
}

const nf = (n) => Number(n).toLocaleString();

/**
 * Ask where the plan for `level` comes from and prepare it.
 * Resolves {blob, width, height, source, fileName, page, thumbBlob}, or
 * 'map' (the person chose to use the satellite map for now), or null
 * (closed without choosing). opts.signal closes it (resolving null), e.g.
 * when the screen that opened it is left.
 */
export function choosePlan({ project = null, level = null, allowMap = true, signal } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(null); return; }
    const levelName = level?.name || 'this level';
    const sh = openSheet({ title: `Floor plan · ${levelName}`, cls: 'pi-sheet', onClose: () => finish(null) });
    const titleEl = sh.el.querySelector('.sheet-title');
    const backdrop = sh.el.parentElement;   // covers the whole screen: a drop lands anywhere

    let done = false;
    let step = 'source';
    let token = 0;               // bumps on every step change; async work checks it
    const urls = new Set();      // object URLs of page thumbnails
    let pdf = null;              // {doc, fileName, numPages, labels}
    let base = null;             // {blob, width, height, source, fileName, page}
    let preview = null;          // a ≤ 2048 px canvas of base, for the screen
    let rotation = 0;            // clockwise degrees, applied at the end
    let crop = null;             // {x, y, w, h} in 0–1 of the rotated image, or null
    let cropping = false;
    let io = null;
    let ro = null;
    let abort = null;
    let errorBox = null;
    let working = false;         // a file is being read or rendered: ignore new ones

    // ---- lifecycle ---------------------------------------------------------------

    function finish(value) {
      if (done) return;
      done = true;
      teardown();
      resolve(value);
    }

    function closeWith(value) {
      sh.close(true);
      finish(value);
    }

    function teardown() {
      signal?.removeEventListener('abort', onAbort);
      document.removeEventListener('paste', onPaste);
      backdrop?.removeEventListener('dragover', onDragOver);
      backdrop?.removeEventListener('dragleave', onDragLeave);
      backdrop?.removeEventListener('drop', onDrop);
      abort?.abort();
      io?.disconnect();
      ro?.disconnect();
      for (const u of urls) URL.revokeObjectURL(u);
      urls.clear();
      destroyPdf();
      freePreview();
    }

    function destroyPdf() {
      if (!pdf) return;
      try { pdf.doc.destroy(); } catch { /* already destroyed */ }
      pdf = null;
    }

    function freePreview() {
      if (preview) { preview.width = 0; preview.height = 0; }
      preview = null;
    }

    function setStep(s) {
      step = s;
      token++;
      io?.disconnect(); io = null;
      ro?.disconnect(); ro = null;
      cropping = false;
      sh.body.scrollTop = 0;
    }

    function makeErrorBox(message = '') {
      const box = el('div', { class: 'banner err pi-error', role: 'alert', hidden: !message },
        el('span', { html: icon('warning', { size: 20 }) }),
        el('span', { class: 'pi-error-msg' }, message));
      return box;
    }

    function showError(message) {
      if (done) return;
      if (!errorBox || !errorBox.isConnected) {
        toast(message, { type: 'err' });
        return;
      }
      errorBox.querySelector('.pi-error-msg').textContent = message;
      errorBox.hidden = false;
      errorBox.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }

    function hideError() {
      if (errorBox) errorBox.hidden = true;
    }

    // ---- step 1: where from ---------------------------------------------------------

    function option(ic, label, detail, onclick, cls = '') {
      return el('button', { type: 'button', class: `pi-opt ${cls}`, onclick },
        el('span', { class: 'pi-opt-ic', html: icon(ic, { size: 26 }) }),
        el('span', { class: 'pi-opt-txt' }, el('span', { class: 'pi-opt-label' }, label), el('span', { class: 'pi-opt-detail' }, detail)));
    }

    function showSource(message = '') {
      setStep('source');
      titleEl.textContent = `Floor plan · ${levelName}`;
      const canClipboard = typeof navigator !== 'undefined' && !!navigator.clipboard?.read;
      const pasteBox = el('div', {
        class: 'pi-paste-box', contenteditable: 'true', inputmode: 'none', role: 'textbox',
        'aria-label': 'Paste a screenshot here', spellcheck: 'false', autocorrect: 'off',
        'data-hint': 'Or long-press here and tap Paste',
      });
      // Nothing is ever typed into the box; it only exists so a phone offers "Paste".
      pasteBox.addEventListener('beforeinput', (e) => e.preventDefault());
      pasteBox.addEventListener('drop', (e) => e.preventDefault());
      errorBox = makeErrorBox(message);
      sh.body.replaceChildren(
        el('p', { class: 'pi-intro' }, 'Where is the plan? A PDF from the architect gives the sharpest plan; a screenshot or a photo of a printed sheet works too.'),
        errorBox,
        el('div', { class: 'pi-options' },
          option('upload', 'Upload a PDF or picture', 'From Files, Drive, OneDrive, email or Photos', () => pick('upload')),
          option('camera', 'Take a photo of the plan', 'A printed sheet: lay it flat and hold the phone straight above it', () => pick('camera')),
          canClipboard ? option('clipboard', 'Paste a screenshot', 'Copied from an email, a website or a plans app', pasteFromClipboard) : null),
        el('div', { class: 'pi-paste' },
          el('div', { class: 'pi-paste-touch' }, pasteBox),
          el('p', { class: 'pi-paste-desk small muted' }, 'Or press Ctrl+V (⌘V on a Mac) to paste a screenshot.')),
        el('div', { class: 'pi-drop' }, el('span', { html: icon('download', { size: 22 }) }), el('span', {}, 'Or drop a PDF or picture anywhere on this panel')),
        allowMap ? el('div', { class: 'pi-later' },
          option('map', 'Use the map for now', 'Start on the satellite map. Add the plan later from Levels & plans; photos taken meanwhile keep their GPS position.', () => closeWith('map'), 'pi-opt-map')) : null);
    }

    async function pick(kind) {
      if (working) return;
      const files = await pickFiles(kind === 'camera'
        ? { accept: 'image/*', capture: 'environment' }
        : { accept: 'application/pdf,.pdf,image/*' });
      if (done || !files.length) return;
      handleFile(files[0], kind === 'camera' ? 'camera' : null);
    }

    async function pasteFromClipboard() {
      if (working) return;
      hideError();
      try {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          const type = it.types.find((t) => /^image\//.test(t));
          if (type) {
            const blob = await it.getType(type);
            if (done) return;
            handleFile(blob, 'paste', 'Pasted screenshot');
            return;
          }
        }
        showError('There is no picture on the clipboard. Take a screenshot of the plan (or copy the image), then tap Paste again.');
      } catch (err) {
        if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
          showError('The browser did not allow reading the clipboard. Long-press the box below and tap Paste (or press Ctrl+V on a computer).');
        } else {
          showError(`The clipboard could not be read (${err?.message || err}). Long-press the box below and tap Paste instead.`);
        }
      }
    }

    // ---- reading a file --------------------------------------------------------------

    async function handleFile(file, source = null, nameHint = '') {
      if (done || working) return;
      hideError();
      const fileName = file.name || nameHint || '';
      if (file.size > maxFileBytes()) {
        showError(`This file is ${formatBytes(file.size)}, too big to open on this ${isMobile() ? 'phone' : 'computer'}. Use a PDF with just the floor plan sheets, or a screenshot of the plan.`);
        return;
      }
      if (!file.size) {
        showError('That file is empty. If it is in iCloud, OneDrive or Drive, open it there first so it downloads, then try again.');
        return;
      }
      let head;
      try {
        head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
      } catch {
        showError('That file could not be read. If it is in iCloud, OneDrive or Drive, make sure it has finished downloading, then try again.');
        return;
      }
      const kind = PI.classifyFile(file, head);
      if (kind === 'pdf') { await openPdfFile(file, fileName || 'Plan.pdf'); return; }
      if (kind === 'unknown') {
        showError('That is not a PDF or a picture. Choose a PDF, JPG or PNG of the plan, or a screenshot.');
        return;
      }
      working = true;
      const b = busy('Preparing the picture…');
      try {
        const out = await PI.normalizeImage(file);
        if (done) return;
        destroyPdf();
        base = { blob: out.blob, width: out.width, height: out.height, source: source || 'image', fileName: fileName || defaultName(source), page: null };
        rotation = 0;
        crop = null;
        b.done();
        await showPreview();
      } catch (err) {
        if (!done) showError(err.message || 'That picture could not be opened.');
      } finally {
        b.done();
        working = false;
      }
    }

    async function openPdfFile(file, fileName) {
      working = true;
      let b = busy('Opening the PDF…');
      let doc = null;
      try {
        const buf = await file.arrayBuffer();
        let password;
        while (!doc) {
          try {
            doc = await PI.openPdf(buf, { password });
          } catch (err) {
            if (err.code !== 'pdf-password' && err.code !== 'pdf-password-wrong') throw err;
            b.done();
            b = null;
            const pw = await promptDialog({
              title: 'This PDF is locked',
              label: err.code === 'pdf-password-wrong' ? 'That password did not work. Type it again:' : 'Type its password to open it:',
              type: 'password',
              okText: 'Open',
            });
            if (done) return;
            if (!pw) {
              showError('The PDF is locked with a password, so it was not opened. Ask for an unlocked copy, or take a screenshot of the plan and paste it.');
              return;
            }
            password = pw;
            b = busy('Opening the PDF…');
          }
        }
        if (done) { try { doc.destroy(); } catch { /* fine */ } return; }
        const labels = await PI.pdfPageLabels(doc);
        destroyPdf();
        pdf = { doc, fileName, numPages: doc.numPages, labels };
        doc = null;
      } catch (err) {
        if (doc) { try { doc.destroy(); } catch { /* fine */ } }
        if (!done) showError(err.message || 'This PDF could not be opened.');
        return;
      } finally {
        b?.done();
        working = false;
      }
      if (done) return;
      if (pdf.numPages === 1) await renderPage(1);
      else showPages();
    }

    // ---- step 2: which page -------------------------------------------------------------

    function showPages(message = '') {
      setStep('pages');
      const t = token;
      titleEl.textContent = 'Choose the sheet';
      const grid = el('div', { class: 'pi-pages' });
      const tiles = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const label = (pdf.labels?.[n - 1] || '').trim();
        const img = el('img', { alt: '', hidden: true, decoding: 'async' });
        const ph = el('div', { class: 'pi-page-ph' }, el('div', { class: 'spinner' }));
        const size = el('span', { class: 'pi-page-size' });
        const tile = el('button', {
          type: 'button', class: 'pi-page', dataset: { n: String(n) },
          'aria-label': `Page ${n}${label ? ` (${label})` : ''}`,
          onclick: () => renderPage(n),
        },
        el('div', { class: 'pi-page-img' }, ph, img),
        el('div', { class: 'pi-page-cap' },
          el('b', {}, `Page ${n}`),
          label && label !== String(n) ? el('span', { class: 'pi-page-label' }, label) : null,
          size));
        tiles.push({ n, tile, img, ph, size, state: 'idle' });
        grid.append(tile);
      }
      errorBox = makeErrorBox(message);
      sh.body.replaceChildren(
        el('p', { class: 'pi-intro' }, `${pdf.fileName} has ${pdf.numPages} pages. Tap the floor plan for ${levelName}.`),
        errorBox,
        grid,
        el('div', { class: 'pi-actions' },
          el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { destroyPdf(); showSource(); } }, 'Choose a different file')));

      // One thumbnail at a time, only for pages on (or near) the screen.
      const queue = [];
      let running = false;
      const pump = async () => {
        if (running) return;
        running = true;
        try {
          while (queue.length && t === token && !done && pdf) {
            const tl = queue.shift();
            if (tl.state !== 'queued') continue;
            tl.state = 'loading';
            try {
              const dpr = Math.min(2, window.devicePixelRatio || 1);
              const th = await PI.renderPdfPageThumbnail(pdf.doc, tl.n, Math.round(170 * dpr));
              if (t !== token || done) return;
              const u = URL.createObjectURL(th.blob);
              urls.add(u);
              tl.img.src = u;
              tl.img.hidden = false;
              tl.ph.remove();
              tl.size.textContent = sheetSize(th.sheet);
              tl.state = 'done';
            } catch {
              if (t !== token || done) return;
              tl.state = 'failed';
              tl.ph.replaceChildren(el('span', { class: 'small muted' }, 'No preview'));
            }
          }
        } finally {
          running = false;
        }
      };
      const enqueue = (tl) => { if (tl.state === 'idle') { tl.state = 'queued'; queue.push(tl); } };
      if (typeof IntersectionObserver === 'function') {
        io = new IntersectionObserver((entries) => {
          for (const e of entries) if (e.isIntersecting) enqueue(tiles[Number(e.target.dataset.n) - 1]);
          pump();
        }, { root: sh.body, rootMargin: '300px 0px' });
        tiles.forEach((tl) => io.observe(tl.tile));
      } else {
        tiles.slice(0, 40).forEach(enqueue);
        pump();
      }
    }

    async function renderPage(n) {
      if (done || working || !pdf) return;
      hideError();
      working = true;
      const ac = new AbortController();
      abort = ac;
      const b = busy(`Preparing page ${n} in full detail…`, { cancellable: true, onCancel: () => ac.abort() });
      try {
        const out = await PI.renderPdfPage(pdf.doc, n, { signal: ac.signal });
        if (done) return;
        base = { blob: out.blob, width: out.width, height: out.height, source: 'pdf', fileName: pdf.fileName, page: n };
        rotation = 0;
        crop = null;
        b.done();
        await showPreview();
      } catch (err) {
        if (done || err.code === 'cancelled') return;
        showError(err.message || 'That page could not be prepared.');
      } finally {
        b.done();
        if (abort === ac) abort = null;
        working = false;
      }
    }

    // ---- step 3: rotate, crop, use -------------------------------------------------------

    async function showPreview() {
      let pv;
      try {
        pv = await PI.previewCanvas(base.blob, 2048);
      } catch (err) {
        throw PI.planError('decode', 'The plan was prepared but this phone could not show it. Try a smaller page, or a screenshot of the plan.', err);
      }
      if (done) { pv.width = 0; pv.height = 0; return; }
      freePreview();
      preview = pv;
      setStep('preview');
      titleEl.textContent = 'Check the plan';

      const canvas = el('canvas', { class: 'pi-canvas', 'aria-label': 'The plan, as it will be saved' });
      const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((m) => el('span', { class: `pi-h pi-h-${m}`, dataset: { mode: m } }));
      const rect = el('div', { class: 'pi-crop-rect' }, handles);
      const layer = el('div', { class: 'pi-crop-layer', hidden: true }, rect);
      const frame = el('div', { class: 'pi-frame' }, canvas, layer);
      const stage = el('div', { class: 'pi-stage' }, frame);
      const info = el('p', { class: 'pi-info' });
      const lowRes = el('div', { class: 'banner warn pi-lowres', hidden: true },
        el('span', { html: icon('warning', { size: 20 }) }),
        el('span', {}, 'This picture is small, so the plan will look blurry when you zoom in. A PDF from the architect gives a sharper plan.'));
      const cropBtn = el('button', { type: 'button', class: 'btn btn-outline pi-tool', onclick: toggleCrop });
      const resetBtn = el('button', { type: 'button', class: 'btn btn-ghost pi-tool', onclick: () => { crop = null; cropping = false; draw(); } }, 'Undo crop');
      const hint = el('p', { class: 'pi-hint small muted', hidden: true }, 'Drag the corners or edges to keep just the floor plan. Drag inside the box to move it.');
      errorBox = makeErrorBox();
      const backTo = pdf && pdf.numPages > 1 ? 'pages' : 'source';
      sh.body.replaceChildren(
        errorBox,
        stage,
        info,
        lowRes,
        el('div', { class: 'pi-tools' },
          el('button', { type: 'button', class: 'btn btn-outline pi-tool', 'aria-label': 'Turn left', onclick: () => turn(-1), html: `${icon('undo', { size: 20 })}<span>Turn left</span>` }),
          el('button', { type: 'button', class: 'btn btn-outline pi-tool', 'aria-label': 'Turn right', onclick: () => turn(1), html: `${icon('redo', { size: 20 })}<span>Turn right</span>` }),
          cropBtn,
          resetBtn),
        hint,
        el('div', { class: 'pi-actions' },
          el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => (backTo === 'pages' ? showPages() : showSource()) }, backTo === 'pages' ? 'Other page' : 'Other file'),
          el('button', { type: 'button', class: 'btn btn-primary btn-lg pi-use', onclick: usePlan }, el('span', { html: icon('check', { size: 20 }) }), 'Use this plan')));

      // Dragging the crop box: pointer events with capture, in 0–1 units of the frame.
      const onDown = (e) => {
        if (!cropping || !crop) return;
        const mode = e.target.dataset.mode || 'move';
        e.preventDefault();
        e.stopPropagation();
        const r0 = { ...crop };
        const x0 = e.clientX, y0 = e.clientY;
        const W = frame.clientWidth || 1, H = frame.clientHeight || 1;
        const full = PI.rotatedSize(base.width, base.height, rotation);
        const min = Math.max(0.03, 64 / Math.min(full.width, full.height));
        const target = e.currentTarget;
        try { target.setPointerCapture(e.pointerId); } catch { /* old browser */ }
        const move = (ev) => {
          crop = PI.adjustCrop(r0, mode, (ev.clientX - x0) / W, (ev.clientY - y0) / H, min);
          placeCrop();
        };
        const up = () => {
          target.removeEventListener('pointermove', move);
          target.removeEventListener('pointerup', up);
          target.removeEventListener('pointercancel', up);
          updateInfo();
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', up);
        target.addEventListener('pointercancel', up);
      };
      rect.addEventListener('pointerdown', onDown);

      function placeCrop() {
        const show = !!crop;
        layer.hidden = !show;
        layer.classList.toggle('editing', cropping);
        if (!show) return;
        rect.style.left = `${crop.x * 100}%`;
        rect.style.top = `${crop.y * 100}%`;
        rect.style.width = `${crop.w * 100}%`;
        rect.style.height = `${crop.h * 100}%`;
      }

      function updateInfo() {
        const full = PI.rotatedSize(base.width, base.height, rotation);
        const px = PI.cropToPixels(crop, full.width, full.height);
        const what = base.source === 'pdf' ? `Page ${base.page} of ${base.fileName}` : base.fileName;
        const edited = rotation || !PI.isFullCrop(crop);
        info.textContent = `${what} · ${nf(px.width)} × ${nf(px.height)} px${edited ? '' : ` · ${formatBytes(base.blob.size)}`}`;
        lowRes.hidden = Math.max(px.width, px.height) >= LOW_RES_SIDE;
        cropBtn.replaceChildren(el('span', { html: icon(cropping ? 'check' : 'crop', { size: 20 }) }), el('span', {}, cropping ? 'Done' : 'Crop'));
        cropBtn.classList.toggle('on', cropping);
        resetBtn.hidden = !crop;
        hint.hidden = !cropping;
      }

      let lastW = 0;
      function draw() {
        if (step !== 'preview' || !preview) return;
        const R = PI.rotatedSize(preview.width, preview.height, rotation);
        const maxW = stage.clientWidth || 320;
        const maxH = Math.max(220, Math.min(window.innerHeight * 0.52, 680));
        const aspect = R.width / R.height;
        const cssW = Math.max(40, Math.min(maxW, maxH * aspect));
        const cssH = cssW / aspect;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.max(1, Math.round(cssW * dpr));
        canvas.height = Math.max(1, Math.round(cssH * dpr));
        frame.style.width = `${cssW}px`;
        frame.style.height = `${cssH}px`;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          const s = canvas.width / R.width;
          ctx.scale(s, s);
          ctx.transform(...PI.rotationMatrix(rotation, preview.width, preview.height));
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(preview, 0, 0);
        }
        placeCrop();
        updateInfo();
      }

      function turn(dir) {
        rotation = PI.normalizeRotation(rotation + 90 * dir);
        crop = PI.rotateNormRect(crop, dir);
        draw();
      }

      function toggleCrop() {
        cropping = !cropping;
        if (cropping && !crop) crop = { x: 0.06, y: 0.06, w: 0.88, h: 0.88 };
        if (!cropping && PI.isFullCrop(crop)) crop = null;
        placeCrop();
        updateInfo();
      }

      draw();
      if (typeof ResizeObserver === 'function') {
        ro = new ResizeObserver(() => {
          const w = stage.clientWidth;
          if (w && w !== lastW) { lastW = w; draw(); }
        });
        ro.observe(stage);
      }
    }

    async function usePlan() {
      if (working || !base) return;
      working = true;
      const b = busy('Getting the plan ready…');
      try {
        let out = { blob: base.blob, width: base.width, height: base.height };
        if (rotation || !PI.isFullCrop(crop)) out = await PI.applyEdits(base.blob, { rotation, crop });
        if (done) return;
        let thumbBlob = null;
        try {
          thumbBlob = await PI.makePlanThumb(out.blob);
        } catch (err) {
          console.warn('[plan] thumbnail failed; the plan is saved without one', err);
        }
        if (done) return;
        closeWith({
          blob: out.blob, width: out.width, height: out.height,
          source: base.source, fileName: base.fileName, page: base.page, thumbBlob,
        });
      } catch (err) {
        if (!done) showError(err.message || 'The plan could not be prepared.');
      } finally {
        b.done();
        working = false;
      }
    }

    // ---- paste and drop (any step) ---------------------------------------------------

    function onPaste(e) {
      // A dialog on top (the PDF password) or work in progress: leave the paste alone.
      if (done || working || document.querySelector('.modal-back, .busy-back')) return;
      const dt = e.clipboardData;
      if (!dt) return;
      let file = null;
      for (const it of dt.items || []) {
        if (it.kind === 'file' && /^image\/|pdf/i.test(it.type)) { file = it.getAsFile(); if (file) break; }
      }
      if (!file) file = [...(dt.files || [])][0] || null;
      e.preventDefault();
      if (!file) {
        showError('There is no picture on the clipboard. Take a screenshot of the plan (or copy the image), then paste.');
        return;
      }
      handleFile(file, 'paste', 'Pasted screenshot');
    }

    function hasFiles(e) {
      return [...(e.dataTransfer?.types || [])].includes('Files');
    }

    function onDragOver(e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      sh.el.classList.add('pi-dragging');
    }

    function onDragLeave(e) {
      if (!e.relatedTarget || !backdrop.contains(e.relatedTarget)) sh.el.classList.remove('pi-dragging');
    }

    function onDrop(e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      sh.el.classList.remove('pi-dragging');
      const f = e.dataTransfer.files?.[0];
      if (f) handleFile(f, null);
    }

    function onAbort() { closeWith(null); }

    signal?.addEventListener('abort', onAbort, { once: true });
    document.addEventListener('paste', onPaste);
    backdrop?.addEventListener('dragover', onDragOver);
    backdrop?.addEventListener('dragleave', onDragLeave);
    backdrop?.addEventListener('drop', onDrop);
    showSource();
  });
}

/** A file name for downloading a plan image that could not be saved. */
function planFileName(project, level, r) {
  const ext = /png/.test(r.blob.type) ? 'png' : 'jpg';
  return `${safeFileName(`${project?.name || 'Job walk'} - ${level?.name || 'Level'} plan`, 'plan')}.${ext}`;
}

/**
 * choosePlan(), then store the plan on the level (the plan it replaces is
 * kept in the level's history). On a failed save it offers Try again or
 * Download the image, and never silently drops the prepared plan.
 * Resolves 'saved', 'map' or null.
 */
export async function choosePlanAndSave({ project, level, allowMap = true, signal } = {}) {
  const r = await choosePlan({ project, level, allowMap, signal });
  if (!r || r === 'map') return r;
  let attempt = true;
  let lastErr = null;
  for (;;) {
    if (attempt) {
      const b = busy('Saving the plan on this phone…');
      try {
        await store.setLevelPlan(project.id, level.id, r.blob, {
          width: r.width, height: r.height, source: r.source, fileName: r.fileName, page: r.page, thumbBlob: r.thumbBlob,
        });
        b.done();
        toast(`Plan saved for ${level.name}.`, { type: 'ok' });
        return 'saved';
      } catch (err) {
        b.done();
        lastErr = err;
        console.error('[plan] save failed', err);
      }
    }
    const next = await choose({
      title: 'The plan was not saved',
      options: [
        { value: 'retry', label: 'Try again', icon: 'restore', detail: lastErr?.message || 'The phone did not keep the plan.' },
        { value: 'download', label: 'Download the plan image', icon: 'download', detail: 'Keep a copy of the prepared plan, so it is not lost' },
      ],
      cancelText: 'Not now',
    });
    if (next === 'retry') { attempt = true; continue; }
    if (next === 'download') {
      const name = planFileName(project, level, r);
      const save = async () => {
        try {
          const how = await saveBlob(r.blob, name, { title: name });
          if (how === 'needs-tap') toast('Tap Save to keep the plan image.', { type: 'warn', ms: 0, action: { label: 'Save', onclick: save } });
          else if (how !== 'cancelled') toast('The plan image was saved.', { type: 'ok' });
        } catch (err) {
          toast(`The plan image was not saved: ${err.message}`, { type: 'err' });
        }
      };
      await save();
      attempt = false;
      continue;
    }
    return null;
  }
}
