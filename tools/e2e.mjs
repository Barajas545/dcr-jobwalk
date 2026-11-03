// e2e.mjs — walk the whole app in a real (headless) Chrome with a fake camera and microphone.
//
//   node tools/serve.mjs 8795 &   (or the 'jobwalk' launch config)
//   node tools/e2e.mjs [--url http://127.0.0.1:8795/] [--out <folder>] [--chrome <path>]
//
// What it proves, end to end, on the real code: a PDF plan is imported
// through the file picker; the plan is calibrated; photos taken with the
// camera are saved with a position, heading and tilt on the plan; a video
// is recorded with its path; notes, a tag, markup and a voice note are
// saved; the job walk exports to a .zip whose viewer opens from disk with
// no errors; and the .zip imports back with every photo byte for byte.
// Positions come from Demo mode (simulated GPS and compass). Screenshots of
// each step go to --out (default: a temp folder) for a person to look at.

import { launch, newPage, sleep } from './cdp.mjs';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('--url', 'http://127.0.0.1:8795/');
const OUT = resolve(arg('--out', join(tmpdir(), 'jobwalk-e2e')));
mkdirSync(OUT, { recursive: true });

const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const { cdp, proc } = await launch(arg('--chrome'));
let page;
try {
  page = await newPage(cdp, 'phone', OUT, false);
  await page.size(390, 844, true);
  await page.call('Page.setInterceptFileChooserDialog', { enabled: true });
  await page.call('Browser.grantPermissions', { permissions: ['geolocation', 'videoCapture', 'audioCapture', 'clipboardReadWrite', 'clipboardSanitizedWrite'], origin: new URL(BASE).origin }).catch(() => {});

  /** Next file chooser gets this file. */
  const chooseFile = (path) => new Promise((res) => {
    const h = async (m) => {
      if (m.sessionId !== page.s || m.method !== 'Page.fileChooserOpened') return;
      cdp.handlers.delete(h);
      await page.call('DOM.setFileInputFiles', { files: [path], backendNodeId: m.params.backendNodeId });
      res();
    };
    cdp.handlers.add(h);
  });

  /** Run in the page with a user gesture (taps that need one: camera, share, sensors). */
  const gesture = async (expression) => {
    const r = await page.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  /** Tap the first visible button/option whose text contains `text`. */
  const tap = (text, within = 'document') => gesture(`(() => {
    const els = [...${within}.querySelectorAll('button, [role=button], a, .choose-opt, label')].filter((b) => b.offsetParent !== null || b.getClientRects().length);
    const t = ${JSON.stringify(text)}.toLowerCase();
    const el = els.find((b) => (b.innerText || b.getAttribute('aria-label') || '').trim().toLowerCase() === t)
      || els.find((b) => (b.innerText || b.getAttribute('aria-label') || '').toLowerCase().includes(t));
    if (!el) return false;
    el.click();
    return true;
  })()`);
  const tapOrFail = async (text) => { if (!(await tap(text))) throw new Error(`no button "${text}"`); };
  const mod = (path) => `(await import(${JSON.stringify(new URL(path, BASE).href)}))`;
  const errorsSoFar = () => page.log.filter((l) => (l.level === 'error' || l.level === 'exception') && !/favicon|wakeLock|Wake Lock|NotAllowedError: The request is not allowed|net::ERR_|tile|arcgisonline|openstreetmap|nominatim/i.test(l.text));

  // ---- start -------------------------------------------------------------------------------
  await page.goto(BASE, 1500);
  await page.until(`document.querySelector('.screen') && /DCR Job Walk/.test(document.body.innerText)`, 15000);
  await page.eval(`(async () => { const s = ${mod('js/core/settings.js')}; await s.updateSettings({ userName: 'E2E Tester', onboarded: true, simulate: true }); })()`);
  await page.goto(BASE, 1200);
  await page.shot('01-home.png');
  check('home opens without errors', errorsSoFar().length === 0, errorsSoFar().map((e) => e.text).join(' | '));

  // ---- new job walk with a PDF plan ---------------------------------------------------------
  await tapOrFail('New job walk');
  await page.until(`document.querySelector('.modal input')`);
  await page.eval(`(() => { const i = document.querySelectorAll('.modal input'); i[0].value = 'E2E Riverside Lofts'; i[1].value = '915 I St, Sacramento, CA'; i[2].value = 'Acme Builders'; i[3].value = 'A267'; })()`);
  await tapOrFail('Next');
  await page.until(`/Upload a PDF or picture/.test(document.body.innerText)`);
  const chosen = chooseFile(join(ROOT, 'tests', 'fixtures', 'plan.pdf'));
  await tapOrFail('Upload a PDF or picture');
  await chosen;
  await page.until(`/page/i.test(document.querySelector('.sheet')?.innerText || '')`, 20000);
  await sleep(1500);
  await page.shot('02-pdf-pages.png');
  // pick page 1 when a page picker is shown
  await gesture(`(() => { const b = [...document.querySelectorAll('.sheet button')].find((x) => /\\b1\\b/.test(x.innerText) && /page/i.test(x.innerText + (x.getAttribute('aria-label') || ''))); if (b) b.click(); return !!b; })()`);
  await page.until(`/Use this plan/.test(document.body.innerText)`, 30000);
  await page.shot('03-plan-preview.png');
  await tapOrFail('Use this plan');
  await page.until(`/#\\/p\\/[^/]+$/.test(location.hash) && document.querySelector('canvas')`, 20000);
  await sleep(1500);
  const pid = await page.eval(`location.hash.split('/')[2]`);
  const level = await page.eval(`(async () => { const s = ${mod('js/core/store.js')}; const p = await s.getProject(${JSON.stringify(pid)}); return s.activeLevel(p); })()`);
  check('PDF plan saved on Level 1', level?.plan?.width > 1000 && level.plan.source === 'pdf', JSON.stringify(level?.plan));
  await page.shot('04-project.png');

  // ---- calibrate (known geometry, as if three points were measured) ------------------------
  const cal = await page.eval(`(async () => {
    const store = ${mod('js/core/store.js')}; const C = ${mod('js/core/calibration.js')};
    const p = await store.getProject(${JSON.stringify(pid)}); const l = store.activeLevel(p);
    const ppm = l.plan.width / 13.0; const cx = l.plan.width / 2, cy = l.plan.height / 2;
    const toPlan = (e, n) => ({ x: cx + e * ppm, y: cy - n * ppm });
    const pairs = [[-5, 4], [5, 4], [5, -4]].map(([e, n]) => ({ plan: toPlan(e, n), enu: { e, n }, sigma: 2 }));
    const cal = C.solveCalibration({ pairs, scaleLine: null, method: 'gps' });
    cal.planMediaId = l.plan.mediaId;
    await store.setCalibration(p.id, l.id, cal);
    return { ppm: cal.pxPerMeter, north: cal.northAngle };
  })()`);
  check('calibration saved', Math.abs(cal.north) < 0.5 || Math.abs(cal.north - 360) < 0.5, JSON.stringify(cal));

  // ---- camera: photos ---------------------------------------------------------------------
  await gesture(`location.hash = '#/p/${pid}/camera?mode=photo'`);
  await sleep(1500);
  await tap('Start camera');
  await page.until(`(() => { const v = document.querySelector('video'); return v && v.videoWidth > 0; })()`, 20000);
  await sleep(2500);
  await page.shot('05-camera.png');
  const shutter = `(() => { const b = document.querySelector('.cam-shutter, [aria-label*="Take photo" i], [aria-label*="shutter" i]'); if (b) { b.click(); return true; } return false; })()`;
  for (let i = 0; i < 3; i++) {
    check(`shutter ${i + 1} pressed`, await gesture(shutter));
    await sleep(900);
  }
  await page.until(`(async () => { const s = ${mod('js/core/store.js')}; return (await s.listItems(${JSON.stringify(pid)})).filter((i) => i.type === 'photo').length >= 3; })()`, 30000).catch(() => {});
  await sleep(1500);
  await page.shot('06-after-photos.png');
  const photos = await page.eval(`(async () => {
    const s = ${mod('js/core/store.js')};
    const items = (await s.listItems(${JSON.stringify(pid)})).filter((i) => i.type === 'photo');
    const out = [];
    for (const i of items) {
      const b = await s.getMediaBlob(i.media.original);
      out.push({ id: i.id, seq: i.seq, size: b?.size, w: i.width, h: i.height, plan: i.pose?.plan, heading: i.pose?.heading, planHeading: i.pose?.planHeading, pitch: i.pose?.pitch, acc: i.pose?.geo?.acc, thumb: !!i.media.thumb, by: i.capturedBy });
    }
    return out;
  })()`);
  check('3 photos saved with their bytes', photos.length === 3 && photos.every((p) => p.size > 1000), JSON.stringify(photos.map((p) => p.size)));
  check('each photo has position, heading and tilt', photos.every((p) => p.plan && p.heading != null && p.pitch != null && p.planHeading != null), JSON.stringify(photos[0]));
  check('each photo has a thumbnail and credit', photos.every((p) => p.thumb && p.by === 'E2E Tester'));

  // ---- camera: video ----------------------------------------------------------------------
  await tap('Video');
  await sleep(1200);
  check('recording started', await gesture(shutter));
  await sleep(5000);
  await page.shot('07-recording.png');
  check('recording stopped', await gesture(shutter));
  await page.until(`(async () => { const s = ${mod('js/core/store.js')}; return (await s.listItems(${JSON.stringify(pid)})).some((i) => i.type === 'video'); })()`, 30000).catch(() => {});
  await sleep(1000);
  const video = await page.eval(`(async () => {
    const s = ${mod('js/core/store.js')};
    const v = (await s.listItems(${JSON.stringify(pid)})).find((i) => i.type === 'video');
    if (!v) return null;
    const b = await s.getMediaBlob(v.media.original);
    const recs = await s.listRecordings();
    return { size: b?.size, type: b?.type, duration: v.duration, track: v.track?.length, withPlan: v.track?.filter((t) => t.x != null).length, poster: !!(v.media.poster || v.media.thumb), leftover: recs.length };
  })()`);
  check('video saved with its path', video && video.size > 10000 && video.track >= 10 && video.withPlan >= 10, JSON.stringify(video));
  check('video duration measured (~5 s)', video && video.duration > 3 && video.duration < 9, String(video?.duration));
  check('no recording left half-done', video && video.leftover === 0);

  // ---- item: notes, tag, voice note ---------------------------------------------------------
  const first = photos[0];
  await gesture(`location.hash = '#/p/${pid}/i/${first.id}'`);
  await page.until(`document.querySelector('textarea')`, 15000);
  await sleep(800);
  await page.eval(`(() => { const t = document.querySelector('textarea'); t.focus(); t.value = 'Header over garage door: verify 4x12 vs LVL. Price blocking at 16" o.c.'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(1800);
  await tap('Walls');
  await sleep(800);
  const voiceStarted = await tap('Record');
  await sleep(2500);
  if (voiceStarted) await tap('Stop');
  await sleep(2500);
  await page.shot('08-item.png');
  const itemNow = await page.eval(`(async () => { const s = ${mod('js/core/store.js')}; const i = await s.getItem(${JSON.stringify(first.id)}); return { text: i.text, tags: i.tags, voice: i.voiceNotes.length }; })()`);
  check('typed note saved', /4x12 vs LVL/.test(itemNow.text), itemNow.text);
  check('tag saved', itemNow.tags.includes('Walls'), JSON.stringify(itemNow.tags));
  check('voice note saved', itemNow.voice === 1, `voice notes: ${itemNow.voice} (record button found: ${voiceStarted})`);

  // ---- markup -------------------------------------------------------------------------------
  await gesture(`location.hash = '#/p/${pid}/i/${first.id}/annotate'`);
  await page.until(`document.querySelector('canvas')`, 15000);
  await sleep(1500);
  const box = await page.eval(`(() => { const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0]; const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const drag = async (x0, y0, x1, y1) => {
    const steps = 8;
    await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 });
    for (let i = 1; i <= steps; i++) await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps, button: 'left' });
    await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 });
  };
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  await tap('Arrow');
  await drag(cx - 80, cy + 60, cx + 40, cy - 40);
  await tap('Cloud');
  await drag(cx - 60, cy - 70, cx + 70, cy + 20);
  await sleep(500);
  await page.shot('09-markup.png');
  await tapOrFail('Save');
  await page.until(`(async () => { const s = ${mod('js/core/store.js')}; const i = await s.getItem(${JSON.stringify(first.id)}); return !!i.media.annotated; })()`, 20000).catch(() => {});
  const marked = await page.eval(`(async () => { const s = ${mod('js/core/store.js')}; const i = await s.getItem(${JSON.stringify(first.id)}); const o = await s.getMediaBlob(i.media.original); return { shapes: i.annotations?.shapes?.length || 0, annotated: !!i.media.annotated, originalSize: o?.size }; })()`);
  check('markup saved as shapes + flattened copy', marked.shapes >= 2 && marked.annotated, JSON.stringify(marked));
  check('original photo untouched by markup', marked.originalSize === first.size, `${marked.originalSize} vs ${first.size}`);

  // ---- project screen with everything on it ------------------------------------------------
  await gesture(`location.hash = '#/p/${pid}'`);
  await sleep(2500);
  await page.shot('10-plan-with-items.png');

  // ---- export, open the viewer from disk, import back ---------------------------------------
  const exp = await page.eval(`(async () => {
    const P = ${mod('js/core/package.js')};
    const r = await P.exportProject(${JSON.stringify(pid)}, { includeVideos: true });
    const buf = new Uint8Array(await r.blob.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { fileName: r.fileName, size: r.blob.size, b64: btoa(s), complete: r.complete };
  })()`);
  check('export made a .zip', exp.size > 50000 && /\.zip$/.test(exp.fileName), `${exp.fileName} ${exp.size} bytes`);
  const zipPath = join(OUT, 'export.zip');
  writeFileSync(zipPath, Buffer.from(exp.b64, 'base64'));
  const { readZip } = await import(pathToFileURL(join(ROOT, 'js/core/zip.js')).href);
  const zip = await readZip(new Blob([Buffer.from(exp.b64, 'base64')]));
  const names = zip.entries.map((e) => e.name);
  check('zip has the viewer, data and media', names.includes('index.html') && names.includes('jobwalk.json') && names.some((n) => n.startsWith('media/photos/')) && names.some((n) => n.startsWith('media/videos/')), names.slice(0, 12).join(', '));
  const viewerDir = join(OUT, 'viewer');
  for (const e of zip.entries) {
    if (e.name.endsWith('/')) continue;
    const dest = join(viewerDir, ...e.name.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(await (await e.blob()).arrayBuffer()));
  }
  const viewer = await newPage(cdp, 'viewer', OUT, false);
  await viewer.size(1280, 900, false);
  await viewer.goto(pathToFileURL(join(viewerDir, 'index.html')).href, 2500);
  await viewer.shot('11-viewer.png');
  const vText = await viewer.eval(`document.body.innerText.slice(0, 2000)`);
  const vErr = viewer.log.filter((l) => (l.level === 'error' || l.level === 'exception') && !/unpkg|arcgisonline|leaflet|net::ERR_/i.test(l.text));
  check('viewer opens from disk with the job walk', /E2E Riverside Lofts/.test(vText) && vErr.length === 0, vErr.map((e) => e.text).join(' | ').slice(0, 400));
  const vImgs = await viewer.eval(`[...document.images].filter((i) => i.complete && i.naturalWidth > 0).length`);
  check('viewer shows the photos', vImgs >= 3, `${vImgs} images loaded`);
  await viewer.eval(`(() => { const b = document.querySelector('[data-item], .vw-item, .item-card, .grid button, .card'); b && b.click(); })()`).catch(() => {});
  await sleep(1200);
  await viewer.shot('12-viewer-item.png');

  const imp = await page.eval(`(async () => {
    const P = ${mod('js/core/package.js')}; const s = ${mod('js/core/store.js')};
    const bin = atob(${JSON.stringify(exp.b64)}); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const file = new File([u], 'export.zip', { type: 'application/zip' });
    const info = await P.inspectPackage(file);
    const newId = await P.importPackage(file, { mode: 'copy' });
    const a = await s.listItems(${JSON.stringify(pid)}); const b = await s.listItems(newId);
    const pa = a.filter((i) => i.type === 'photo').sort((x, y) => x.seq - y.seq); const pb = b.filter((i) => i.type === 'photo').sort((x, y) => x.seq - y.seq);
    let same = pa.length === pb.length;
    for (let k = 0; same && k < pa.length; k++) {
      const x = new Uint8Array(await (await s.getMediaBlob(pa[k].media.original)).arrayBuffer());
      const y = new Uint8Array(await (await s.getMediaBlob(pb[k].media.original)).arrayBuffer());
      same = x.length === y.length && x.every((v, i) => v === y[i]);
    }
    const vb = b.find((i) => i.type === 'video');
    return { counts: info.counts, exists: info.exists, newId, itemsA: a.length, itemsB: b.length, photosIdentical: same, videoTrack: vb?.track?.length, notes: pb[0]?.text, voice: pb[0]?.voiceNotes?.length, shapes: pb[0]?.annotations?.shapes?.length };
  })()`);
  check('import recognises the job walk', imp.exists === true, JSON.stringify(imp.counts));
  check('import brings every item back', imp.itemsA === imp.itemsB && imp.newId !== pid, `${imp.itemsA} → ${imp.itemsB}`);
  check('imported photos are byte-for-byte the originals', imp.photosIdentical === true);
  check('imported notes, voice note, markup and video path', /4x12/.test(imp.notes || '') && imp.voice === 1 && imp.shapes >= 2 && imp.videoTrack >= 10, JSON.stringify(imp));

  // ---- Recently Deleted keeps what was deleted -----------------------------------------------
  const trash = await page.eval(`(async () => { const s = ${mod('js/core/store.js')}; const it = (await s.listItems(${JSON.stringify(pid)}))[1]; await s.softDeleteItem(it.id); const t = await s.listTrash(); await s.restoreItem(it.id); return t.items.some((x) => x.id === it.id) && !!(await s.getMediaBlob(it.media.original)); })()`);
  check('deleting goes to Recently Deleted with its bytes kept', trash);

  check('no errors in the app console', errorsSoFar().length === 0, errorsSoFar().map((e) => e.text).join(' | ').slice(0, 800));
} catch (err) {
  failed++;
  console.log('FAIL  run stopped:', err.message);
  try { await page?.shot('zz-failure.png'); } catch { /* page gone */ }
  if (page) console.log(page.log.slice(-15).map((l) => `  [${l.level}] ${l.text}`).join('\n'));
} finally {
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  try { proc.kill(); } catch { /* gone */ }
  console.log(`\n${results.length - failed + (failed && results.every((r) => r.ok) ? 0 : 0)} checks, ${failed} failed. Screenshots: ${OUT}`);
  process.exit(failed ? 1 : 0);
}
