/* DCR Job Walk — a minimal Chrome DevTools protocol driver for the end-to-end checks (development only).
   Copied from DCR Employee Portal 2 tools/cdp.mjs. Used by tools/e2e.mjs: a local Chrome or Edge, headless, with a
   throw-away profile (no account, no extensions), talked to with Node's own WebSocket. */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const CHROMES = [process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);

/* ── a minimal DevTools protocol client ─────────────────────────────── */
export class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.n = 0;
    this.wait = new Map();
    this.handlers = new Set();
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(typeof m.data === "string" ? m.data : m.data.toString());
      if (msg.id && this.wait.has(msg.id)) {
        const { res, rej } = this.wait.get(msg.id);
        this.wait.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) h(msg);
      }
    };
  }
  send(method, params, sessionId) {
    const id = ++this.n;
    this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
    return new Promise((res, rej) => this.wait.set(id, { res, rej }));
  }
}

export class Page {
  constructor(cdp, sessionId, name) {
    this.cdp = cdp; this.s = sessionId; this.name = name;
    this.log = [];
    this.loaded = null;
    cdp.handlers.add((m) => {
      if (m.sessionId !== this.s) return;
      if (m.method === "Runtime.consoleAPICalled") {
        const text = m.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || "")).join(" ");
        this.log.push({ level: m.params.type, text, url: this.url });
      } else if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        this.log.push({ level: "exception", text: (d.exception && d.exception.description) || d.text, url: this.url });
      } else if (m.method === "Log.entryAdded") {
        const e = m.params.entry;
        this.log.push({ level: e.level, text: e.text + (e.url ? " (" + e.url + ")" : ""), source: e.source, url: this.url });
      } else if (m.method === "Page.loadEventFired" && this.loaded) {
        const r = this.loaded; this.loaded = null; r();
      }
    });
  }
  call(method, params) { return this.cdp.send(method, params, this.s); }
  async size(width, height, mobile) {
    await this.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: !!mobile });
    await this.call("Emulation.setTouchEmulationEnabled", mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  }
  async dark(on) {
    await this.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: on ? "dark" : "light" }] });
  }
  async goto(url, settle) {
    this.url = url;
    const done = new Promise((r) => { this.loaded = r; });
    await this.call("Page.navigate", { url });
    await Promise.race([done, sleep(15000)]);
    await sleep(settle === undefined ? 900 : settle);
  }
  async eval(expression) {
    const r = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("eval: " + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  }
  async until(expression, ms) {
    const end = Date.now() + (ms || 10000);
    for (;;) {
      let v = null;
      try { v = await this.eval(expression); } catch (e) { v = null; }
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out waiting for " + expression);
      await sleep(150);
    }
  }
  async shot(file) {
    const r = await this.call("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(this.out, file), Buffer.from(r.data, "base64"));
    return file;
  }
}

export async function launch(chrome) {
  const exe = [chrome].concat(CHROMES).find((p) => p && existsSync(p));
  if (!exe) throw new Error("no Chrome or Edge found (use --chrome <path>)");
  const profile = mkdtempSync(join(tmpdir(), "jobwalk-chrome-"));
  const proc = spawn(exe, ["--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + profile, "--no-first-run",
    "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--disable-default-apps", "--disable-extensions", "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication",
    "--metrics-recording-only", "--mute-audio", "--password-store=basic",
    // A fake camera and microphone (a test pattern and a beep) that need no permission prompt.
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "about:blank"], { stdio: "ignore" });
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const [port, path] = readFileSync(portFile, "utf8").trim().split(/\r?\n/);
  const cdp = new Cdp("ws://127.0.0.1:" + port + path);
  await cdp.ready;
  return { cdp, proc, profile };
}

/** A new tab. isolated: its own browser context (own storage and sign-in, like another person's
    phone); otherwise the tabs share one profile, as tabs of one browser do. */
export async function newPage(cdp, name, out, isolated) {
  const ctx = isolated ? (await cdp.send("Target.createBrowserContext", { disposeOnDetach: true })).browserContextId : undefined;
  const { targetId } = await cdp.send("Target.createTarget", Object.assign({ url: "about:blank", newWindow: false }, ctx ? { browserContextId: ctx } : {}));
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const p = new Page(cdp, sessionId, name);
  await p.call("Page.enable");
  await p.call("Runtime.enable");
  await p.call("Log.enable");
  await p.call("Page.addScriptToEvaluateOnNewDocument", { source:
    "document.addEventListener('securitypolicyviolation', function (e) { console.error('CSP-VIOLATION ' + e.violatedDirective + ' ' + e.blockedURI + ' ' + (e.sourceFile || '') + ':' + (e.lineNumber || '')); });" });
  p.targetId = targetId;
  p.contextId = ctx;
  p.out = out || tmpdir();
  return p;
}

