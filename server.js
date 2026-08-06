import express from 'express';
import { chromium, devices } from 'playwright';
import { WebSocketServer } from 'ws';
import cron from 'node-cron';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

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
app.use(express.json({ limit: '2mb' }));
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
    log(`Run "${flow.name}" (headless=${!!options.headless}${flow.device ? `, device=${flow.device}` : ''}${flow.humanLike ? ', human-like' : ''})`);
    browser = await chromium.launch({ headless: !!options.headless });

    const ctxOpts = {};
    if (flow.device && devices[flow.device]) {
      Object.assign(ctxOpts, devices[flow.device]);
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

let recorder = null;
app.post('/api/record/start', async (req, res) => {
  if (recorder) return res.status(409).json({ error: 'already recording' });
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    recorder = { browser, context, page, steps: [] };
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
    res.json({ ok: true });
  } catch (e) {
    if (recorder?.browser) await recorder.browser.close().catch(() => {});
    recorder = null;
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/record/stop', async (_req, res) => {
  if (!recorder) return res.status(404).json({ error: 'not recording' });
  const steps = recorder.steps;
  await recorder.browser.close().catch(() => {});
  recorder = null;
  res.json({ steps });
});

// --- Session recording (login capture) ---
const sessionRec = {};
app.post('/api/sessions/start', async (req, res) => {
  const { url, name } = req.body || {};
  if (!url || !name) return res.status(400).json({ error: 'url and name required' });
  try {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url);
    const id = crypto.randomUUID();
    sessionRec[id] = { browser, context, name };
    res.json({ id });
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
