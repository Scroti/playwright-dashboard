import express from 'express';
import { chromium, devices } from 'playwright';
import { WebSocketServer } from 'ws';
import cron from 'node-cron';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execP = promisify(exec);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const SHOTS_DIR = path.join(DATA_DIR, 'screenshots');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const FLOWS_FILE = path.join(DATA_DIR, 'flows.json');
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

async function ensureDirs() {
  await fs.mkdir(SHOTS_DIR, { recursive: true });
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}
async function loadJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}
async function saveJSON(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));

// --- Cloaking classifier (educational; toggle via settings.cloakEnabled) ---
const CLOAK_BOT_UAS = [
  /bot/i, /crawl/i, /spider/i, /slurp/i,
  /curl/i, /wget/i, /python/i, /libwww/i, /go-http/i, /java\//i,
  /headless/i, /phantomjs/i, /puppeteer/i, /playwright/i,
  /googlebot/i, /bingbot/i, /yandex/i, /baiduspider/i, /duckduckbot/i,
  /facebookexternalhit/i, /semrush/i, /ahrefs/i, /mj12bot/i, /dotbot/i,
];
function classifyRequest(req) {
  const reasons = [];
  const ua = req.headers['user-agent'] || '';
  if (!ua) reasons.push('empty user-agent');
  else if (CLOAK_BOT_UAS.some((r) => r.test(ua))) reasons.push('user-agent matches bot pattern');
  if (!req.headers['accept-language']) reasons.push('missing Accept-Language');
  if (!req.headers['accept-encoding']) reasons.push('missing Accept-Encoding');
  const accept = req.headers['accept'] || '';
  if (!accept.includes('text/html') && !accept.includes('*/*')) reasons.push('non-browser Accept header');
  const secChUa = req.headers['sec-ch-ua'];
  const secFetchSite = req.headers['sec-fetch-site'];
  if (!secChUa && !secFetchSite && ua.toLowerCase().includes('chrome')) reasons.push('claims Chrome but missing Sec-* headers');
  return { bucket: reasons.length ? 'crawler' : 'target', reasons, ua, ip: req.ip };
}

// Debug endpoint — always exposes the classifier's decision (never cloaked)
app.get('/whoami', (req, res) => {
  res.type('application/json').send(JSON.stringify({
    classification: classifyRequest(req),
    cloakEnabled: !!settings.cloakEnabled,
    headers: req.headers,
  }, null, 2));
});

app.use((req, res, next) => {
  if (!settings.cloakEnabled) return next();
  // Only classify top-level HTML navigations; assets, APIs, webhooks pass through
  const accept = req.headers['accept'] || '';
  if (!accept.includes('text/html')) return next();
  if (req.path.startsWith('/api/')) return next();
  if (req.path.startsWith('/screenshots/')) return next();
  if (req.path === '/whoami') return next();
  // Rescue bypass so you can never lock yourself out: /?bypass=<token>
  const bypass = settings.cloakBypass || 'demo';
  if (req.query.bypass === bypass) return next();

  const c = classifyRequest(req);
  console.log(`[cloak] ${c.bucket} ${req.method} ${req.path} ip=${c.ip} ua="${c.ua.slice(0, 60)}"${c.reasons.length ? ' — ' + c.reasons.join('; ') : ''}`);

  if (c.bucket === 'crawler') {
    return res.type('text/html').send(`<!doctype html>
<html><head><title>Hello</title></head>
<body><h1>Hello world</h1><p>Welcome. This is a static page.</p></body></html>`);
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(SHOTS_DIR));

const state = {
  running: false,
  currentRunId: null,
  stopRequested: false,
  logs: [],
};

let settings = {};
async function loadSettings() { settings = await loadJSON(SETTINGS_FILE, {}); }

// --- Optional single password protect (settings.password) ---
app.use((req, res, next) => {
  if (!settings.password) return next();
  if (req.path.startsWith('/api/trigger/')) return next();
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Playwright Dashboard"');
    return res.sendStatus(401);
  }
  const decoded = Buffer.from(auth.slice(6), 'base64').toString();
  const pass = decoded.split(':').slice(1).join(':');
  if (pass !== settings.password) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Playwright Dashboard"');
    return res.sendStatus(401);
  }
  next();
});

// --- WebSocket broadcast ---
const wsClients = new Set();
function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const c of wsClients) {
    try { c.send(str); } catch {}
  }
}

function log(msg) {
  const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
  state.logs.push(entry);
  if (state.logs.length > 500) state.logs.shift();
  console.log(entry);
  broadcast({ type: 'log', text: entry });
}

// --- Notifications (Discord + Slack + Telegram) ---
async function notify(text) {
  const cfg = settings;
  const tasks = [];
  if (cfg.discordWebhook) {
    tasks.push(fetch(cfg.discordWebhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    }));
  }
  if (cfg.slackWebhook) {
    tasks.push(fetch(cfg.slackWebhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }));
  }
  if (cfg.telegramBotToken && cfg.telegramChatId) {
    tasks.push(fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.telegramChatId, text }),
    }));
  }
  const results = await Promise.allSettled(tasks);
  results.forEach((r, i) => { if (r.status === 'rejected') log(`Notify #${i} failed: ${r.reason?.message || r.reason}`); });
}

// --- Live preview via CDP screencast ---
async function startPreview(page) {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 60, maxWidth: 900, maxHeight: 700, everyNthFrame: 2,
    });
    cdp.on('Page.screencastFrame', async (frame) => {
      broadcast({ type: 'preview-frame', data: frame.data });
      try { await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }); } catch {}
    });
    return cdp;
  } catch (e) {
    log(`Preview unavailable: ${e.message}`);
    return null;
  }
}

// --- Step executor ---
function substitute(step, row) {
  if (!row) return step;
  const json = JSON.stringify(step);
  const out = json.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
    const v = row[k];
    if (v === undefined || v === null) return '';
    return JSON.stringify(String(v)).slice(1, -1);
  });
  try { return JSON.parse(out); } catch { return step; }
}

async function humanPause(page, ctx) {
  if (!ctx.humanLike) return;
  await page.waitForTimeout(200 + Math.floor(Math.random() * 800));
}

async function executeStep(page, step, ctx) {
  if (state.stopRequested) return;
  await humanPause(page, ctx);
  switch (step.type) {
    case 'goto':
      log(`→ goto ${step.url}`);
      await page.goto(step.url, { waitUntil: 'domcontentloaded' });
      break;
    case 'click': {
      const count = Math.max(1, Number(step.count) || 1);
      const delay = Number(step.delayMs) || 0;
      for (let i = 0; i < count; i++) {
        if (state.stopRequested) return;
        await page.waitForSelector(step.selector, { timeout: 5000 });
        await page.click(step.selector);
        log(`  click ${i + 1}/${count} "${step.selector}"`);
        if (delay) await page.waitForTimeout(delay);
      }
      break;
    }
    case 'type':
      log(`→ type into "${step.selector}"`);
      await page.fill(step.selector, step.text ?? '');
      break;
    case 'wait':
      log(`→ wait ${step.ms}ms`);
      await page.waitForTimeout(Number(step.ms) || 0);
      break;
    case 'waitFor':
      log(`→ waitFor "${step.selector}"`);
      await page.waitForSelector(step.selector, { timeout: Number(step.timeoutMs) || 10000 });
      break;
    case 'screenshot': {
      const name = (step.name || 'shot').replace(/[^a-z0-9-_]/gi, '_');
      const file = `${ctx.runId}__${ctx.shotIndex++}__${name}.png`;
      const abs = path.join(SHOTS_DIR, file);
      await page.screenshot({ path: abs, fullPage: !!step.fullPage });
      ctx.screenshots.push(`/screenshots/${file}`);
      log(`→ screenshot ${file}`);
      break;
    }
    case 'extract': {
      const el = await page.$(step.selector);
      const text = el ? (await el.innerText()).trim() : null;
      ctx.extracted[step.name || step.selector] = text;
      log(`→ extract "${step.selector}" = ${JSON.stringify(text)}`);
      break;
    }
    case 'if': {
      const exists = await page.$(step.selector);
      let cond = !!exists;
      if (cond && step.text) {
        const t = (await exists.innerText()).trim();
        cond = t.includes(step.text);
      }
      log(`? if "${step.selector}" → ${cond ? 'then' : 'else'}`);
      const branch = cond ? (step.then || []) : (step.else || []);
      for (const s of branch) {
        if (state.stopRequested) return;
        try { await executeStep(page, s, ctx); }
        catch (e) { log(`  ✖ ${s.type} failed: ${e.message.split('\n')[0]}`); ctx.errored = true; }
      }
      break;
    }
    case 'try': {
      for (const s of (step.steps || [])) {
        if (state.stopRequested) return;
        try { await executeStep(page, s, ctx); }
        catch (e) { log(`  (try caught ${s.type}: ${e.message.split('\n')[0]})`); }
      }
      break;
    }
    case 'retry': {
      const times = Math.max(1, Number(step.times) || 3);
      let lastErr;
      for (let attempt = 1; attempt <= times; attempt++) {
        if (state.stopRequested) return;
        let ok = true;
        for (const s of (step.steps || [])) {
          if (state.stopRequested) return;
          try { await executeStep(page, s, ctx); }
          catch (e) { ok = false; lastErr = e; log(`  ↻ attempt ${attempt}/${times} failed: ${e.message.split('\n')[0]}`); break; }
        }
        if (ok) { log(`  ↻ retry succeeded on attempt ${attempt}`); return; }
        if (attempt < times) await page.waitForTimeout(1000 * attempt);
      }
      throw new Error(`Retry exhausted after ${times} attempts: ${lastErr?.message}`);
    }
    case 'expect': {
      const check = step.check || 'exists';
      let ok = false, actual = '';
      if (check === 'url-contains') { actual = page.url(); ok = actual.includes(step.text || ''); }
      else if (check === 'url-equals') { actual = page.url(); ok = actual === (step.text || ''); }
      else {
        const el = await page.$(step.selector);
        if (check === 'exists') ok = !!el;
        else if (check === 'not-exists') ok = !el;
        else {
          actual = el ? (await el.innerText()).trim() : '';
          if (check === 'text-contains') ok = actual.includes(step.text || '');
          else if (check === 'text-equals') ok = actual === (step.text || '');
        }
      }
      if (!ok) throw new Error(`Assertion failed: ${check} ${step.selector || ''} "${step.text || ''}" (actual: "${actual}")`);
      log(`  ✓ expect ${check} passed`);
      break;
    }
    case 'callFlow': {
      const flows = await loadJSON(FLOWS_FILE, []);
      const sub = flows.find((f) => f.id === step.flowId);
      if (!sub) { log(`  ! callFlow: flow not found`); break; }
      log(`→ callFlow "${sub.name}"`);
      for (const s of (sub.steps || [])) {
        if (state.stopRequested) return;
        try { await executeStep(page, s, ctx); }
        catch (e) { log(`  ✖ ${s.type} failed: ${e.message.split('\n')[0]}`); ctx.errored = true; }
      }
      break;
    }
    case 'http': {
      const method = (step.method || 'GET').toUpperCase();
      let headers = {};
      try { if (step.headers) headers = JSON.parse(step.headers); } catch { log('  ! invalid JSON headers, ignoring'); }
      const opts = { method, headers };
      if (step.body && method !== 'GET') opts.body = step.body;
      const r = await fetch(step.url, opts);
      const txt = await r.text();
      if (step.saveAs) ctx.extracted[step.saveAs] = txt;
      log(`→ http ${method} ${step.url} → ${r.status}${step.saveAs ? ' (saved as ' + step.saveAs + ')' : ''}`);
      if (!r.ok && step.failOnError !== false) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      break;
    }
    default:
      log(`  ! unknown step type: ${step.type}`);
  }
}

// --- Stealth mode: hide the usual "I'm a headless browser" tells ---
// Applied via addInitScript so it runs in every page (including subframes) before
// any site script. Combined with realistic launch args + context overrides.
const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-site-isolation-trials',
];
const STEALTH_UA_HEADLESS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
function stealthInitScript() {
  // Runs in the page context. Only uses primitives available before any lib loads.
  // Sources: puppeteer-extra-plugin-stealth (evasions/*), simplified to essentials.
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  // Fake plugins + mimeTypes so length > 0
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    ],
  });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  // chrome.runtime — sites check for its presence to distinguish real Chrome
  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {};
  // Permissions API — real Chrome returns 'prompt' for notifications when headless returns 'denied'
  const origQuery = window.navigator.permissions && window.navigator.permissions.query;
  if (origQuery) {
    window.navigator.permissions.query = (params) =>
      params && params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery(params);
  }
  // WebGL vendor + renderer — headless returns "Google Inc." / "SwiftShader"
  const getParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (p) {
    if (p === 37445) return 'Intel Inc.';            // UNMASKED_VENDOR_WEBGL
    if (p === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
    return getParam.apply(this, [p]);
  };
  // Preserve native toString so overrides don't leak "[native code]" mismatches
  const nativeToString = Function.prototype.toString;
  Function.prototype.toString = function () {
    if (this === Function.prototype.toString) return nativeToString.call(nativeToString);
    return nativeToString.call(this);
  };
  // Hairline device — headless leaks: hardwareConcurrency = 1, deviceMemory undefined
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
}

async function runFlow(flow, options = {}) {
  const runId = crypto.randomUUID();
  state.running = true;
  state.currentRunId = runId;
  state.stopRequested = false;
  state.logs = [];
  broadcast({ type: 'status', running: true, currentRunId: runId });
  const startedAt = Date.now();
  const ctx = { runId, shotIndex: 0, screenshots: [], extracted: {}, errored: false, humanLike: !!flow.humanLike };
  let browser, cdp;
  try {
    // On Linux without $DISPLAY we have no X server → force headless regardless of user pref
    const noDisplay = process.platform === 'linux' && !process.env.DISPLAY;
    const headless = !!options.headless || noDisplay;
    const stealth = !!flow.stealth;
    log(`Run "${flow.name}" (headless=${headless}${flow.device ? `, device=${flow.device}` : ''}${flow.humanLike ? ', human-like' : ''}${stealth ? ', stealth' : ''}${noDisplay && !options.headless ? ' — forced (no display)' : ''})`);
    const launchOpts = { headless };
    if (stealth) launchOpts.args = STEALTH_ARGS;
    browser = await chromium.launch(launchOpts);

    const ctxOpts = {};
    if (flow.device && devices[flow.device]) {
      Object.assign(ctxOpts, devices[flow.device]);
    }
    if (stealth && !flow.device) {
      // Only apply desktop defaults if no device preset is chosen (device presets already
      // supply UA + viewport for their target device).
      ctxOpts.userAgent = STEALTH_UA_HEADLESS;
      ctxOpts.viewport = { width: 1920, height: 1080 };
      ctxOpts.locale = 'en-US';
      ctxOpts.timezoneId = 'Europe/Berlin';
      ctxOpts.deviceScaleFactor = 1;
      ctxOpts.hasTouch = false;
      ctxOpts.isMobile = false;
    }
    if (flow.sessionName) {
      const file = path.join(SESSIONS_DIR, flow.sessionName + '.json');
      try {
        await fs.access(file);
        ctxOpts.storageState = file;
        log(`Using session: ${flow.sessionName}`);
      } catch { log(`Session "${flow.sessionName}" not found — running without`); }
    }
    const context = await browser.newContext(ctxOpts);
    if (stealth) await context.addInitScript(stealthInitScript);
    const page = await context.newPage();

    if (options.livePreview !== false) cdp = await startPreview(page);

    const loops = Math.max(1, Number(flow.loops) || 1);
    let dataRows = [null];
    if (flow.dataRows && typeof flow.dataRows === 'string' && flow.dataRows.trim()) {
      try { const parsed = JSON.parse(flow.dataRows); if (Array.isArray(parsed) && parsed.length) dataRows = parsed; }
      catch (e) { log(`  ! invalid dataRows JSON, ignoring: ${e.message}`); }
    }
    for (let l = 0; l < loops; l++) {
      if (state.stopRequested) break;
      if (loops > 1) log(`— loop ${l + 1}/${loops} —`);
      for (const row of dataRows) {
        if (state.stopRequested) break;
        if (row) log(`— row: ${JSON.stringify(row).slice(0, 80)} —`);
        for (const step of flow.steps || []) {
          if (state.stopRequested) break;
          const s = substitute(step, row);
          try { await executeStep(page, s, ctx); }
          catch (e) { log(`  ✖ ${s.type} failed: ${e.message.split('\n')[0]}`); ctx.errored = true; }
        }
      }
    }
  } catch (err) {
    ctx.errored = true;
    log(`Fatal: ${err.message.split('\n')[0]}`);
    if (err.message.includes("Executable doesn't exist")) {
      log('Fix: npx playwright install chromium');
    }
  } finally {
    if (cdp) { try { await cdp.detach(); } catch {} }
    if (browser) await browser.close().catch(() => {});
    const success = !ctx.errored && !state.stopRequested;
    const runs = await loadJSON(RUNS_FILE, []);
    runs.unshift({
      id: runId, flowId: flow.id, flowName: flow.name,
      startedAt, endedAt: Date.now(),
      stopped: state.stopRequested, success,
      screenshots: ctx.screenshots, extracted: ctx.extracted,
      logs: state.logs.slice(),
    });
    if (runs.length > 50) runs.length = 50;
    await saveJSON(RUNS_FILE, runs);
    state.running = false;
    state.currentRunId = null;
    broadcast({ type: 'status', running: false });
    broadcast({ type: 'runs-updated' });
    log(success ? 'Done ✓' : state.stopRequested ? 'Stopped ■' : 'Done ✖');
    await notify(`Playwright: "${flow.name}" — ${success ? '✅ success' : state.stopRequested ? '⏸ stopped' : '❌ failed'}`);
    // Alert on consecutive failures
    if (!success && !state.stopRequested && flow.alertOnFailure && Number(flow.alertOnFailure) > 0) {
      const threshold = Number(flow.alertOnFailure);
      const flowRuns = runs.filter((r) => r.flowId === flow.id).slice(0, threshold);
      if (flowRuns.length >= threshold && flowRuns.every((r) => !r.success && !r.stopped)) {
        await notify(`🚨 ALERT: "${flow.name}" has failed ${threshold} times in a row`);
      }
    }
  }
}

// --- Scheduler ---
const cronJobs = new Map();
async function reschedule() {
  cronJobs.forEach((t) => t.stop());
  cronJobs.clear();
  const flows = await loadJSON(FLOWS_FILE, []);
  for (const flow of flows) {
    if (!flow.schedule) continue;
    if (!cron.validate(flow.schedule)) {
      log(`Invalid cron for "${flow.name}": ${flow.schedule}`);
      continue;
    }
    const task = cron.schedule(flow.schedule, () => {
      if (state.running) { log(`Skip scheduled "${flow.name}" — already running`); return; }
      log(`⏰ Cron trigger: ${flow.name}`);
      runFlow(flow, { headless: true }).catch((e) => log(e.message));
    });
    cronJobs.set(flow.id, task);
  }
  log(`Scheduler: ${cronJobs.size} job(s) active`);
}

// --- Recorder ---
const RECORDER_SCRIPT = () => {
  window.__recBest = function (el) {
    if (!el || el === document.body || el === document.documentElement) return 'body';
    if (el.id) return '#' + CSS.escape(el.id);
    for (const a of ['data-testid', 'data-slot', 'data-test', 'name', 'aria-label']) {
      const v = el.getAttribute(a);
      if (v) return `[${a}="${v.replace(/"/g, '\\"')}"]`;
    }
    let sel = el.tagName.toLowerCase();
    if (typeof el.className === 'string' && el.className.trim()) {
      const cls = el.className.trim().split(/\s+/).slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
      sel += cls;
    }
    if (el.textContent && el.textContent.length < 30) {
      const txt = el.textContent.trim().slice(0, 20);
      if (txt) sel += `:has-text("${txt.replace(/"/g, '\\"')}")`;
    }
    return sel;
  };
  document.addEventListener('click', (e) => {
    try { window.__recStep({ type: 'click', selector: window.__recBest(e.target) }); } catch {}
  }, true);
  document.addEventListener('input', (e) => {
    if (!['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
    try { window.__recStep({ type: 'type', selector: window.__recBest(e.target), text: e.target.value }); } catch {}
  }, true);
};

const RECORDER_VIEWPORT = { width: 1280, height: 720 };
let recorder = null;
app.post('/api/record/start', async (req, res) => {
  if (recorder) return res.status(409).json({ error: 'already recording' });
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: RECORDER_VIEWPORT });
    const page = await context.newPage();
    recorder = { browser, context, page, steps: [], viewport: RECORDER_VIEWPORT };
    await page.exposeFunction('__recStep', (step) => {
      const last = recorder.steps[recorder.steps.length - 1];
      if (last && last.type === 'type' && step.type === 'type' && last.selector === step.selector) {
        last.text = step.text;
        broadcast({ type: 'record-step', step: last, replaceLast: true });
      } else {
        recorder.steps.push(step);
        broadcast({ type: 'record-step', step });
      }
    });
    await page.addInitScript(RECORDER_SCRIPT);
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      const last = recorder.steps[recorder.steps.length - 1];
      if (!last || last.type !== 'goto' || last.url !== url) {
        recorder.steps.push({ type: 'goto', url });
        broadcast({ type: 'record-step', step: { type: 'goto', url } });
      }
    });
    await page.goto(url);

    // Streamed CDP screencast so the user can drive the browser from the web UI
    const cdp = await context.newCDPSession(page);
    recorder.cdp = cdp;
    cdp.on('Page.screencastFrame', async (frame) => {
      broadcast({ type: 'record-frame', data: frame.data });
      try { await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }); } catch {}
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 70,
      maxWidth: RECORDER_VIEWPORT.width, maxHeight: RECORDER_VIEWPORT.height,
      everyNthFrame: 1,
    });
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
      broadcast({ type: 'record-frame', data: buf.toString('base64') });
    } catch {}
    res.json({ ok: true, viewport: RECORDER_VIEWPORT });
  } catch (e) {
    if (recorder?.browser) await recorder.browser.close().catch(() => {});
    recorder = null;
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/record/click', async (req, res) => {
  if (!recorder) return res.status(404).json({ error: 'not recording' });
  const { x, y } = req.body || {};
  try {
    await recorder.page.mouse.click(Number(x) || 0, Number(y) || 0);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/record/type', async (req, res) => {
  if (!recorder) return res.status(404).json({ error: 'not recording' });
  const { key, text } = req.body || {};
  try {
    if (text) await recorder.page.keyboard.type(text);
    else if (key) await recorder.page.keyboard.press(key);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/record/scroll', async (req, res) => {
  if (!recorder) return res.status(404).json({ error: 'not recording' });
  const { dx = 0, dy = 0 } = req.body || {};
  try {
    await recorder.page.evaluate(({ x, y }) => window.scrollBy(x, y), { x: Number(dx), y: Number(dy) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/record/goto', async (req, res) => {
  if (!recorder) return res.status(404).json({ error: 'not recording' });
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    await recorder.page.goto(url);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/record/stop', async (_req, res) => {
  if (!recorder) return res.status(404).json({ error: 'not recording' });
  const steps = recorder.steps;
  await recorder.browser.close().catch(() => {});
  recorder = null;
  res.json({ steps });
});

// --- Selector Picker (headless + streamed via CDP; click on stream to pick) ---
const PICKER_SCRIPT = () => {
  function bestSel(el) {
    if (!el || el === document.body || el === document.documentElement) return 'body';
    if (el.id) return '#' + CSS.escape(el.id);
    for (const a of ['data-testid', 'data-slot', 'data-test', 'name', 'aria-label']) {
      const v = el.getAttribute(a);
      if (v) return `[${a}="${v.replace(/"/g, '\\"')}"]`;
    }
    let sel = el.tagName.toLowerCase();
    if (typeof el.className === 'string' && el.className.trim()) {
      const cls = el.className.trim().split(/\s+/).slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
      sel += cls;
    }
    return sel;
  }
  document.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (window.__pickerReturn) window.__pickerReturn(bestSel(e.target));
    return false;
  }, true);
};

const PICKER_VIEWPORT = { width: 1280, height: 720 };
let pickerActive = null;
app.post('/api/picker/start', async (req, res) => {
  if (pickerActive) return res.status(409).json({ error: 'picker already open' });
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: PICKER_VIEWPORT });
    const page = await context.newPage();
    pickerActive = { browser, page, viewport: PICKER_VIEWPORT };
    await page.exposeFunction('__pickerReturn', async (selector) => {
      broadcast({ type: 'picked-selector', selector });
      try { await browser.close(); } catch {}
      pickerActive = null;
    });
    await page.addInitScript(PICKER_SCRIPT);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const cdp = await context.newCDPSession(page);
    pickerActive.cdp = cdp;
    cdp.on('Page.screencastFrame', async (frame) => {
      broadcast({ type: 'picker-frame', data: frame.data });
      try { await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }); } catch {}
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 70,
      maxWidth: PICKER_VIEWPORT.width, maxHeight: PICKER_VIEWPORT.height,
      everyNthFrame: 1,
    });
    // Bootstrap: send an immediate screenshot so the user sees something even before first screencast frame
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false });
      broadcast({ type: 'picker-frame', data: buf.toString('base64') });
    } catch {}
    res.json({ ok: true, viewport: PICKER_VIEWPORT });
  } catch (e) {
    if (pickerActive?.browser) await pickerActive.browser.close().catch(() => {});
    pickerActive = null;
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/picker/click', async (req, res) => {
  if (!pickerActive) return res.status(404).json({ error: 'no picker active' });
  const { x, y } = req.body || {};
  try {
    await pickerActive.page.mouse.click(Number(x) || 0, Number(y) || 0);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/picker/scroll', async (req, res) => {
  if (!pickerActive) return res.status(404).json({ error: 'no picker active' });
  const { dx = 0, dy = 0 } = req.body || {};
  try {
    await pickerActive.page.evaluate(({ x, y }) => window.scrollBy(x, y), { x: Number(dx), y: Number(dy) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/picker/cancel', async (_req, res) => {
  if (pickerActive) { await pickerActive.browser.close().catch(() => {}); pickerActive = null; }
  broadcast({ type: 'picker-cancelled' });
  res.json({ ok: true });
});

// --- Session recording (login capture — headless + CDP screencast) ---
const SESSION_VIEWPORT = { width: 1280, height: 720 };
const sessionRec = {};
app.post('/api/sessions/start', async (req, res) => {
  const { url, name } = req.body || {};
  if (!url || !name) return res.status(400).json({ error: 'url and name required' });
  try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: SESSION_VIEWPORT });
    const page = await context.newPage();
    await page.goto(url);
    const id = crypto.randomUUID();
    const cdp = await context.newCDPSession(page);
    cdp.on('Page.screencastFrame', async (frame) => {
      broadcast({ type: 'session-frame', id, data: frame.data });
      try { await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }); } catch {}
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 70,
      maxWidth: SESSION_VIEWPORT.width, maxHeight: SESSION_VIEWPORT.height,
      everyNthFrame: 1,
    });
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
      broadcast({ type: 'session-frame', id, data: buf.toString('base64') });
    } catch {}
    sessionRec[id] = { browser, context, page, cdp, name, viewport: SESSION_VIEWPORT };
    res.json({ id, viewport: SESSION_VIEWPORT });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/sessions/click/:id', async (req, res) => {
  const s = sessionRec[req.params.id];
  if (!s) return res.status(404).json({ error: 'session not found' });
  const { x, y } = req.body || {};
  try {
    await s.page.mouse.click(Number(x) || 0, Number(y) || 0);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/sessions/type/:id', async (req, res) => {
  const s = sessionRec[req.params.id];
  if (!s) return res.status(404).json({ error: 'session not found' });
  const { key, text } = req.body || {};
  try {
    if (text) await s.page.keyboard.type(text);
    else if (key) await s.page.keyboard.press(key);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/sessions/scroll/:id', async (req, res) => {
  const s = sessionRec[req.params.id];
  if (!s) return res.status(404).json({ error: 'session not found' });
  const { dx = 0, dy = 0 } = req.body || {};
  try {
    await s.page.evaluate(({ x, y }) => window.scrollBy(x, y), { x: Number(dx), y: Number(dy) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/sessions/goto/:id', async (req, res) => {
  const s = sessionRec[req.params.id];
  if (!s) return res.status(404).json({ error: 'session not found' });
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    await s.page.goto(url);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/sessions/save/:id', async (req, res) => {
  const s = sessionRec[req.params.id];
  if (!s) return res.status(404).json({ error: 'session not found' });
  try {
    const st = await s.context.storageState();
    const file = path.join(SESSIONS_DIR, s.name.replace(/[^a-z0-9-_]/gi, '_') + '.json');
    await fs.writeFile(file, JSON.stringify(st, null, 2));
    await s.browser.close().catch(() => {});
    delete sessionRec[req.params.id];
    log(`Session saved: ${s.name}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/sessions/cancel/:id', async (req, res) => {
  const s = sessionRec[req.params.id];
  if (s) { await s.browser.close().catch(() => {}); delete sessionRec[req.params.id]; }
  res.json({ ok: true });
});
app.get('/api/sessions', async (_req, res) => {
  try {
    const files = await fs.readdir(SESSIONS_DIR);
    res.json(files.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')));
  } catch { res.json([]); }
});
app.delete('/api/sessions/:name', async (req, res) => {
  const file = path.join(SESSIONS_DIR, req.params.name.replace(/[^a-z0-9-_]/gi, '_') + '.json');
  await fs.unlink(file).catch(() => {});
  res.json({ ok: true });
});

// --- Flows CRUD ---
app.get('/api/flows', async (_req, res) => res.json(await loadJSON(FLOWS_FILE, [])));

app.post('/api/flows', async (req, res) => {
  const flows = await loadJSON(FLOWS_FILE, []);
  const flow = { id: crypto.randomUUID(), name: 'Untitled', loops: 1, steps: [], ...req.body };
  flows.push(flow);
  await saveJSON(FLOWS_FILE, flows);
  await reschedule();
  res.json(flow);
});

app.put('/api/flows/:id', async (req, res) => {
  const flows = await loadJSON(FLOWS_FILE, []);
  const i = flows.findIndex((f) => f.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  flows[i] = { ...flows[i], ...req.body, id: flows[i].id };
  await saveJSON(FLOWS_FILE, flows);
  await reschedule();
  res.json(flows[i]);
});

app.delete('/api/flows/:id', async (req, res) => {
  const flows = await loadJSON(FLOWS_FILE, []);
  await saveJSON(FLOWS_FILE, flows.filter((f) => f.id !== req.params.id));
  await reschedule();
  res.json({ ok: true });
});

// --- Run / stop / status ---
app.post('/api/run', async (req, res) => {
  if (state.running) return res.status(409).json({ error: 'Already running' });
  const { flowId, headless = false } = req.body || {};
  const flows = await loadJSON(FLOWS_FILE, []);
  const flow = flows.find((f) => f.id === flowId);
  if (!flow) return res.status(404).json({ error: 'flow not found' });
  runFlow(flow, { headless }).catch((err) => log(`Unhandled: ${err.message}`));
  res.json({ ok: true });
});
app.post('/api/stop', (_req, res) => { state.stopRequested = true; res.json({ ok: true }); });
app.get('/api/status', (_req, res) => res.json({ running: state.running, currentRunId: state.currentRunId, logs: state.logs }));
app.get('/api/runs', async (_req, res) => res.json(await loadJSON(RUNS_FILE, [])));

// --- Settings ---
app.get('/api/settings', async (_req, res) => res.json(settings));
app.put('/api/settings', async (req, res) => {
  const cfg = { ...settings, ...req.body };
  await saveJSON(SETTINGS_FILE, cfg);
  settings = cfg;
  res.json(cfg);
});

// --- Available devices for emulation ---
const DEVICE_LIST = [
  'iPhone 15 Pro', 'iPhone 14 Pro', 'iPhone 13', 'iPhone 12', 'iPhone SE',
  'Pixel 7', 'Pixel 5', 'Galaxy S9+',
  'iPad Pro 11', 'iPad Mini',
  'Desktop Chrome', 'Desktop Firefox', 'Desktop Safari', 'Desktop Edge',
].filter((n) => devices[n]);
app.get('/api/devices', (_req, res) => res.json(DEVICE_LIST));

// --- Public webhook trigger (bypasses password auth) ---
app.post('/api/trigger/:flowId', async (req, res) => {
  const flows = await loadJSON(FLOWS_FILE, []);
  const flow = flows.find((f) => f.id === req.params.flowId);
  if (!flow || flow.triggerDisabled) return res.status(404).json({ error: 'not found' });
  if (state.running) return res.status(409).json({ error: 'busy' });
  log(`🌐 Webhook trigger: ${flow.name}`);
  runFlow(flow, { headless: true }).catch((e) => log(e.message));
  res.json({ ok: true });
});

// --- AI generate flow (needs settings.anthropicKey) ---
app.post('/api/ai/generate', async (req, res) => {
  if (!settings.anthropicKey) return res.status(400).json({ error: 'Set Anthropic API key in Settings first' });
  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  const systemPrompt = `You are a Playwright flow generator. Given a natural-language task, output ONLY JSON (no prose) matching this shape:
{"name":"short name","steps":[...]}
Available step types (use only these):
- {"type":"goto","url":"..."}
- {"type":"click","selector":"CSS","count":1,"delayMs":0}
- {"type":"type","selector":"CSS","text":"..."}
- {"type":"wait","ms":1000}
- {"type":"waitFor","selector":"CSS","timeoutMs":10000}
- {"type":"screenshot","name":"..."}
- {"type":"extract","selector":"CSS","name":"varname"}
- {"type":"expect","check":"exists|not-exists|text-contains|text-equals|url-contains|url-equals","selector":"CSS","text":"..."}
- {"type":"http","method":"GET|POST","url":"...","headers":"{}","body":"","saveAs":"var"}
- {"type":"if","selector":"CSS","text":"optional","then":[...],"else":[...]}
- {"type":"try","steps":[...]}
- {"type":"retry","times":3,"steps":[...]}
Prefer stable selectors (id, data-* attributes). Use {{varname}} in strings for user-provided variables.`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: settings.anthropicModel || 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: data.error?.message || JSON.stringify(data).slice(0, 200) });
    const text = data.content?.[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return res.status(500).json({ error: 'AI returned no JSON: ' + text.slice(0, 200) });
    const parsed = JSON.parse(m[0]);
    const flows = await loadJSON(FLOWS_FILE, []);
    const flow = { id: crypto.randomUUID(), loops: 1, steps: [], ...parsed };
    flows.push(flow);
    await saveJSON(FLOWS_FILE, flows);
    res.json(flow);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Self-deploy (git pull + pm2 restart) ---
app.post('/api/deploy', async (_req, res) => {
  try {
    log('🚀 Deploy: fetching origin...');
    const { stdout: fetchOut } = await execP('git fetch origin', { cwd: __dirname, timeout: 20000 });
    if (fetchOut.trim()) log(fetchOut.trim());
    log('→ git pull');
    const { stdout: pullOut, stderr: pullErr } = await execP('git pull --ff-only origin main', { cwd: __dirname, timeout: 30000 });
    if (pullOut.trim()) log(pullOut.trim());
    if (pullErr && pullErr.trim() && !/^From /.test(pullErr.trim())) log('stderr: ' + pullErr.trim());
    const upToDate = /Already up.to.date/i.test(pullOut);

    // Wait for response to fully flush BEFORE triggering restart
    res.on('finish', () => {
      if (upToDate) { log('Nothing to deploy — up to date.'); return; }
      setTimeout(() => {
        log('♻ Restart triggered (nohup detached)');
        // nohup + background = fully detached; won't be killed with parent process
        exec('nohup pm2 restart playwright-dashboard > /dev/null 2>&1 &', (err) => {
          if (err) log('Restart error: ' + err.message);
        });
      }, 1200);
    });
    res.json({ ok: true, upToDate, output: pullOut, restartMs: upToDate ? 0 : 1500 });
  } catch (e) {
    log(`Deploy failed: ${e.message.split('\n')[0]}`);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/deploy/status', async (_req, res) => {
  try {
    await execP('git fetch origin', { cwd: __dirname, timeout: 15000 });
    const { stdout: local } = await execP('git rev-parse HEAD', { cwd: __dirname });
    const { stdout: remote } = await execP('git rev-parse origin/main', { cwd: __dirname });
    const { stdout: log1 } = await execP('git log -1 --format="%h %s"', { cwd: __dirname });
    const behind = local.trim() !== remote.trim();
    let behindCount = 0;
    if (behind) {
      const { stdout: cnt } = await execP('git rev-list --count HEAD..origin/main', { cwd: __dirname });
      behindCount = Number(cnt.trim()) || 0;
    }
    res.json({ current: log1.trim(), local: local.trim(), remote: remote.trim(), behind, behindCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Boot ---
await ensureDirs();
await loadSettings();
await reschedule();
const PORT = 3000;
const server = app.listen(PORT, () => console.log(`Dashboard: http://localhost:${PORT}`));
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
});
