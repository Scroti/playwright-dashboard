const $ = (id) => document.getElementById(id);
let flows = [];
let sessions = [];
let deviceList = [];
let currentFlowId = null;
let sessionRecId = null;
let flowFilter = '';

const STEP_TYPES = {
  goto:       { fields: [['url', 'text', 'https://example.com', 'full']] },
  click:      { fields: [['selector', 'text', 'button#buy', 'full'], ['count', 'number', 1], ['delayMs', 'number', 0]] },
  type:       { fields: [['selector', 'text', 'input[name="q"]', 'full'], ['text', 'text', 'hello', 'full']] },
  wait:       { fields: [['ms', 'number', 1000]] },
  waitFor:    { fields: [['selector', 'text', '.loaded', 'full'], ['timeoutMs', 'number', 10000]] },
  screenshot: { fields: [['name', 'text', 'after-click'], ['fullPage', 'checkbox', false]] },
  extract:    { fields: [['selector', 'text', '.price', 'full'], ['name', 'text', 'price']] },
  expect:     { fields: [['check', 'select:exists|not-exists|text-contains|text-equals|url-contains|url-equals', 'exists'], ['selector', 'text', '.error', 'full'], ['text', 'text', '', 'full']] },
  http:       { fields: [['method', 'select:GET|POST|PUT|PATCH|DELETE', 'GET'], ['url', 'text', 'https://api.example.com/x', 'full'], ['headers', 'textarea', '{}', 'full'], ['body', 'textarea', '', 'full'], ['saveAs', 'text', 'result']] },
  callFlow:   { fields: [['flowId', 'flowSelect', '', 'full']] },
  if:         { fields: [['selector', 'text', '.error', 'full'], ['text', 'text', '', 'full']], hasBranches: true },
  try:        { fields: [], hasSteps: true },
  retry:      { fields: [['times', 'number', 3]], hasSteps: true },
};

async function api(url, opts) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

function toast(msg, kind = 'info', duration = 3500) {
  const c = document.getElementById('toast-container');
  if (!c) { console.log(msg); return; }
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  }, duration);
}
window.alert = (msg) => toast(String(msg), 'error', 4000);

async function loadFlows() {
  flows = await api('/api/flows');
  renderFlows();
  populateFlowSelects();
  if (!currentFlowId && flows.length) selectFlow(flows[0].id);
  else if (currentFlowId) renderEditor();
}

async function loadSessions() {
  sessions = await api('/api/sessions');
  renderSessions();
  const sel = $('flow-session');
  const cur = sel.value;
  sel.innerHTML = '<option value="">(none)</option>' + sessions.map((s) => `<option value="${s}">${s}</option>`).join('');
  if (cur) sel.value = cur;
}

async function loadDevices() {
  deviceList = await api('/api/devices');
  const sel = $('flow-device');
  sel.innerHTML = '<option value="">Default</option>' + deviceList.map((d) => `<option value="${d}">${d}</option>`).join('');
}

function matchesFilter(flow, q) {
  if (!q) return true;
  q = q.toLowerCase().trim();
  if (q.startsWith('#')) {
    const tag = q.slice(1);
    return (flow.tags || []).some((t) => t.toLowerCase().includes(tag));
  }
  if (flow.name.toLowerCase().includes(q)) return true;
  return (flow.tags || []).some((t) => t.toLowerCase().includes(q));
}

function renderFlows() {
  const el = $('flows-list');
  el.innerHTML = '';
  const visible = flows.filter((f) => matchesFilter(f, flowFilter));
  if (!visible.length) { el.innerHTML = '<div class="empty" style="padding:1rem 0">No flows</div>'; return; }
  visible.forEach((f) => {
    const div = document.createElement('div');
    div.className = 'flow-item' + (f.id === currentFlowId ? ' active' : '');
    const tags = (f.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
    div.innerHTML = `
      <span>${f.schedule ? '<span class="schedule-mark">⏰</span>' : ''}${escapeHtml(f.name)} ${tags}</span>
      <button class="del">✕</button>`;
    div.onclick = (e) => {
      if (e.target.classList.contains('del')) return deleteFlow(f.id);
      selectFlow(f.id);
    };
    el.appendChild(div);
  });
}

function renderSessions() {
  const el = $('sessions-list');
  el.innerHTML = '';
  sessions.forEach((name) => {
    const div = document.createElement('div');
    div.className = 'session-item';
    div.innerHTML = `<span>🔑 ${escapeHtml(name)}</span><button class="del">✕</button>`;
    div.querySelector('.del').onclick = async () => {
      if (!confirm(`Delete session "${name}"?`)) return;
      await api('/api/sessions/' + name, { method: 'DELETE' });
      loadSessions();
    };
    el.appendChild(div);
  });
}

function populateFlowSelects() {
  document.querySelectorAll('select[data-flowselect]').forEach((sel) => {
    const cur = sel.value;
    sel.innerHTML = '<option value="">(pick a flow)</option>' + flows
      .filter((f) => f.id !== currentFlowId)
      .map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');
    if (cur) sel.value = cur;
  });
}

function selectFlow(id) {
  currentFlowId = id;
  renderFlows();
  renderEditor();
}
function currentFlow() { return flows.find((f) => f.id === currentFlowId); }

function renderEditor() {
  const f = currentFlow();
  if (!f) { $('editor-empty').style.display = ''; $('editor-content').style.display = 'none'; return; }
  $('editor-empty').style.display = 'none';
  $('editor-content').style.display = '';
  $('flow-name').value = f.name;
  $('flow-loops').value = f.loops || 1;
  $('flow-schedule').value = f.schedule || '';
  $('flow-session').value = f.sessionName || '';
  $('flow-device').value = f.device || '';
  $('flow-human').checked = !!f.humanLike;
  $('flow-tags').value = (f.tags || []).join(', ');
  $('flow-datarows').value = f.dataRows || '';
  $('flow-trigger').value = `${location.origin}/api/trigger/${f.id}`;
  renderStepsInto(f.steps || [], $('steps'));
}

function renderStepsInto(stepsArray, container) {
  container.innerHTML = '';
  stepsArray.forEach((step, idx) => container.appendChild(renderStep(stepsArray, step, idx)));
}

function renderStep(stepsArray, step, idx) {
  const wrap = document.createElement('div');
  wrap.className = 'step';
  const def = STEP_TYPES[step.type] || STEP_TYPES.click;
  const typeOptions = Object.keys(STEP_TYPES).map((t) =>
    `<option value="${t}" ${t === step.type ? 'selected' : ''}>${t}</option>`).join('');
  const fields = def.fields.map(([key, type, defVal, span]) => {
    const val = step[key] ?? defVal;
    const cls = span === 'full' ? 'full' : '';
    if (type === 'checkbox') {
      return `<label class="full" style="display:flex;align-items:center;gap:0.4rem;color:#e6e6e6;text-transform:none"><input type="checkbox" data-k="${key}" ${val ? 'checked' : ''}/> ${key}</label>`;
    }
    if (type === 'textarea') {
      return `<div class="${cls}"><label>${key}</label><textarea data-k="${key}" rows="2" style="width:100%;font-family:monospace;font-size:0.8rem">${escapeHtml(val)}</textarea></div>`;
    }
    if (type === 'flowSelect') {
      return `<div class="${cls}"><label>${key}</label><select data-k="${key}" data-flowselect="1"></select></div>`;
    }
    if (type.startsWith('select:')) {
      const opts = type.slice(7).split('|').map((o) => `<option value="${o}" ${o === val ? 'selected' : ''}>${o}</option>`).join('');
      return `<div class="${cls}"><label>${key}</label><select data-k="${key}">${opts}</select></div>`;
    }
    return `<div class="${cls}"><label>${key}</label><input type="${type}" data-k="${key}" value="${escapeAttr(val)}" /></div>`;
  }).join('');
  wrap.innerHTML = `
    <div class="step-head">
      <span class="idx">#${idx + 1}</span>
      <select data-role="type">${typeOptions}</select>
      <div class="spacer"></div>
      <button data-role="up" class="small">▲</button>
      <button data-role="down" class="small">▼</button>
      <button data-role="dup" class="small">⧉</button>
      <button data-role="del" class="danger small">✕</button>
    </div>
    <div class="step-fields">${fields}</div>
  `;
  wrap.querySelector('[data-role=type]').onchange = (e) => {
    stepsArray[idx] = { type: e.target.value };
    renderStepsInto(stepsArray, wrap.parentElement);
    populateFlowSelects();
  };
  wrap.querySelector('[data-role=up]').onclick = () => moveStep(stepsArray, idx, -1, wrap.parentElement);
  wrap.querySelector('[data-role=down]').onclick = () => moveStep(stepsArray, idx, 1, wrap.parentElement);
  wrap.querySelector('[data-role=dup]').onclick = () => {
    stepsArray.splice(idx + 1, 0, JSON.parse(JSON.stringify(step)));
    renderStepsInto(stepsArray, wrap.parentElement);
  };
  wrap.querySelector('[data-role=del]').onclick = () => {
    stepsArray.splice(idx, 1);
    renderStepsInto(stepsArray, wrap.parentElement);
  };
  wrap.querySelectorAll('[data-k]').forEach((inp) => {
    inp.oninput = inp.onchange = () => {
      const k = inp.dataset.k;
      const val = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? Number(inp.value) : inp.value;
      stepsArray[idx][k] = val;
    };
  });

  if (def.hasBranches) {
    step.then = step.then || [];
    step.else = step.else || [];
    const thenBox = document.createElement('div');
    thenBox.className = 'nested';
    thenBox.innerHTML = '<div class="nested-label">THEN steps:</div>';
    const thenSteps = document.createElement('div');
    thenBox.appendChild(thenSteps);
    const addThen = document.createElement('button');
    addThen.className = 'small'; addThen.textContent = '+ add to THEN';
    addThen.onclick = () => { step.then.push({ type: 'click', selector: '' }); renderStepsInto(step.then, thenSteps); };
    thenBox.appendChild(addThen);
    renderStepsInto(step.then, thenSteps);
    wrap.appendChild(thenBox);

    const elseBox = document.createElement('div');
    elseBox.className = 'nested';
    elseBox.innerHTML = '<div class="nested-label">ELSE steps:</div>';
    const elseSteps = document.createElement('div');
    elseBox.appendChild(elseSteps);
    const addElse = document.createElement('button');
    addElse.className = 'small'; addElse.textContent = '+ add to ELSE';
    addElse.onclick = () => { step.else.push({ type: 'click', selector: '' }); renderStepsInto(step.else, elseSteps); };
    elseBox.appendChild(addElse);
    renderStepsInto(step.else, elseSteps);
    wrap.appendChild(elseBox);
  }
  if (def.hasSteps) {
    step.steps = step.steps || [];
    const box = document.createElement('div');
    box.className = 'nested';
    box.innerHTML = `<div class="nested-label">${step.type === 'retry' ? 'RETRY these' : 'TRY these'}:</div>`;
    const sub = document.createElement('div');
    box.appendChild(sub);
    const add = document.createElement('button');
    add.className = 'small'; add.textContent = '+ add step';
    add.onclick = () => { step.steps.push({ type: 'click', selector: '' }); renderStepsInto(step.steps, sub); };
    box.appendChild(add);
    renderStepsInto(step.steps, sub);
    wrap.appendChild(box);
  }
  return wrap;
}

function moveStep(stepsArray, idx, dir, container) {
  const j = idx + dir;
  if (j < 0 || j >= stepsArray.length) return;
  [stepsArray[idx], stepsArray[j]] = [stepsArray[j], stepsArray[idx]];
  renderStepsInto(stepsArray, container);
}

async function newFlow() {
  const flow = await api('/api/flows', { method: 'POST', body: JSON.stringify({ name: 'New flow', loops: 1, steps: [] }) });
  currentFlowId = flow.id;
  await loadFlows();
}
async function deleteFlow(id) {
  if (!confirm('Delete this flow?')) return;
  await api('/api/flows/' + id, { method: 'DELETE' });
  if (currentFlowId === id) currentFlowId = null;
  await loadFlows();
}
async function saveFlow() {
  const f = currentFlow();
  if (!f) return;
  f.name = $('flow-name').value;
  f.loops = Number($('flow-loops').value);
  f.schedule = $('flow-schedule').value.trim();
  f.sessionName = $('flow-session').value;
  f.device = $('flow-device').value;
  f.humanLike = $('flow-human').checked;
  f.tags = $('flow-tags').value.split(',').map((s) => s.trim()).filter(Boolean);
  f.dataRows = $('flow-datarows').value.trim();
  await api('/api/flows/' + f.id, { method: 'PUT', body: JSON.stringify(f) });
  await loadFlows();
}
async function run() {
  const f = currentFlow();
  if (!f) return alert('Select a flow');
  await saveFlow();
  try { await api('/api/run', { method: 'POST', body: JSON.stringify({ flowId: f.id, headless: $('headless').checked }) }); }
  catch (e) { alert(e.message); }
}
async function stop() { await api('/api/stop', { method: 'POST' }); }
function addStep() {
  currentFlow().steps.push({ type: 'click', selector: '', count: 1, delayMs: 0 });
  renderStepsInto(currentFlow().steps, $('steps'));
}

async function loadRuns() {
  const runs = await api('/api/runs');
  const el = $('runs-list');
  el.innerHTML = runs.length ? '' : '<div class="empty">No runs yet</div>';
  runs.slice(0, 20).forEach((r) => {
    const dur = ((r.endedAt - r.startedAt) / 1000).toFixed(1);
    const shots = (r.screenshots || []).map((src) => `<img src="${src}" data-full="${src}" />`).join('');
    const status = r.success ? '<span class="ok">✓ ok</span>' : r.stopped ? '<span class="stopped">■ stopped</span>' : '<span class="fail">✖ failed</span>';
    const div = document.createElement('div');
    div.className = 'run';
    div.innerHTML = `
      <div class="name">${escapeHtml(r.flowName)}</div>
      <div class="meta">${new Date(r.startedAt).toLocaleString()} · ${dur}s · ${status}</div>
      ${shots ? `<div class="shots">${shots}</div>` : ''}
    `;
    div.querySelectorAll('img').forEach((img) => img.onclick = () => showShot(img.dataset.full));
    el.appendChild(div);
  });
}

function showShot(src) { $('shot-modal-img').src = src; $('shot-modal').classList.add('on'); }
$('shot-modal').onclick = () => $('shot-modal').classList.remove('on');

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $('logs').style.display = t.dataset.tab === 'logs' ? '' : 'none';
    $('preview').style.display = t.dataset.tab === 'preview' ? 'flex' : 'none';
  };
});

document.querySelectorAll('.cron-presets button').forEach((b) => {
  b.onclick = (e) => { e.preventDefault(); $('flow-schedule').value = b.dataset.cron; };
});

function closeModal(id) { $(id).classList.remove('on'); }
document.querySelectorAll('[data-close]').forEach((b) => {
  if (b.id) return;
  b.onclick = () => closeModal(b.dataset.close);
});

$('open-settings').onclick = async () => {
  const s = await api('/api/settings');
  $('setting-discord').value = s.discordWebhook || '';
  $('setting-slack').value = s.slackWebhook || '';
  $('setting-tg-token').value = s.telegramBotToken || '';
  $('setting-tg-chat').value = s.telegramChatId || '';
  $('setting-password').value = s.password || '';
  $('setting-anthropic').value = s.anthropicKey || '';
  $('settings-modal').classList.add('on');
};
$('save-settings').onclick = async () => {
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({
    discordWebhook: $('setting-discord').value.trim(),
    slackWebhook: $('setting-slack').value.trim(),
    telegramBotToken: $('setting-tg-token').value.trim(),
    telegramChatId: $('setting-tg-chat').value.trim(),
    password: $('setting-password').value,
    anthropicKey: $('setting-anthropic').value.trim(),
  })});
  closeModal('settings-modal');
  if ($('setting-password').value) alert('Password set. Next page load will prompt for username (any) + password.');
};

$('record-flow').onclick = () => {
  $('record-url').value = 'https://';
  $('record-live').style.display = 'none';
  $('record-steps').innerHTML = '';
  $('record-start').style.display = '';
  $('record-stop').style.display = 'none';
  $('record-modal').classList.add('on');
};
$('record-start').onclick = async () => {
  const url = $('record-url').value.trim();
  if (!url) return alert('URL required');
  try {
    await api('/api/record/start', { method: 'POST', body: JSON.stringify({ url }) });
    $('record-start').style.display = 'none';
    $('record-stop').style.display = '';
    $('record-live').style.display = '';
  } catch (e) { alert(e.message); }
};
$('record-stop').onclick = async () => {
  try {
    const { steps } = await api('/api/record/stop', { method: 'POST' });
    const flow = await api('/api/flows', { method: 'POST', body: JSON.stringify({ name: 'Recorded ' + new Date().toLocaleTimeString(), loops: 1, steps }) });
    closeModal('record-modal');
    currentFlowId = flow.id;
    await loadFlows();
  } catch (e) { alert(e.message); }
};
async function cancelRecording() {
  if ($('record-stop').style.display !== 'none') {
    try { await api('/api/record/stop', { method: 'POST' }); } catch {}
  }
  closeModal('record-modal');
}
document.querySelector('#record-modal [data-close="record-modal"]').onclick = cancelRecording;

$('new-session').onclick = () => {
  $('session-name').value = '';
  $('session-url').value = 'https://';
  $('session-start').style.display = '';
  $('session-save').style.display = 'none';
  sessionRecId = null;
  $('session-modal').classList.add('on');
};
$('session-start').onclick = async () => {
  const name = $('session-name').value.trim();
  const url = $('session-url').value.trim();
  if (!name || !url) return alert('Name and URL required');
  try {
    const { id } = await api('/api/sessions/start', { method: 'POST', body: JSON.stringify({ name, url }) });
    sessionRecId = id;
    $('session-start').style.display = 'none';
    $('session-save').style.display = '';
  } catch (e) { alert(e.message); }
};
$('session-save').onclick = async () => {
  if (!sessionRecId) return;
  try {
    await api('/api/sessions/save/' + sessionRecId, { method: 'POST' });
    sessionRecId = null;
    closeModal('session-modal');
    await loadSessions();
  } catch (e) { alert(e.message); }
};
$('session-cancel').onclick = async () => {
  if (sessionRecId) { try { await api('/api/sessions/cancel/' + sessionRecId, { method: 'POST' }); } catch {} sessionRecId = null; }
  closeModal('session-modal');
};

// --- AI Generate ---
$('ai-flow').onclick = () => {
  $('ai-prompt').value = '';
  $('ai-modal').classList.add('on');
};
$('ai-generate').onclick = async () => {
  const prompt = $('ai-prompt').value.trim();
  if (!prompt) return alert('Describe what you want');
  const btn = $('ai-generate');
  btn.disabled = true; btn.textContent = 'Generating…';
  try {
    const flow = await api('/api/ai/generate', { method: 'POST', body: JSON.stringify({ prompt }) });
    closeModal('ai-modal');
    currentFlowId = flow.id;
    await loadFlows();
  } catch (e) { alert(e.message); }
  finally { btn.disabled = false; btn.textContent = 'Generate'; }
};

// --- Import / export ---
$('import-flow').onclick = () => { $('import-text').value = ''; $('import-modal').classList.add('on'); };
$('import-do').onclick = async () => {
  try {
    const parsed = JSON.parse($('import-text').value);
    delete parsed.id;
    const flow = await api('/api/flows', { method: 'POST', body: JSON.stringify(parsed) });
    closeModal('import-modal');
    currentFlowId = flow.id;
    await loadFlows();
  } catch (e) { alert('Invalid JSON: ' + e.message); }
};
$('export-flow').onclick = () => {
  const f = currentFlow();
  if (!f) return;
  const { id, ...rest } = f;
  const blob = new Blob([JSON.stringify(rest, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(f.name || 'flow').replace(/[^a-z0-9-_]/gi, '_')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

// --- Trigger URL copy ---
$('flow-trigger').onclick = (e) => { e.target.select(); document.execCommand('copy'); };

// --- Search ---
$('flow-search').oninput = (e) => { flowFilter = e.target.value; renderFlows(); };

// --- WebSocket ---
function connectWS() {
  const ws = new WebSocket('ws://' + location.host);
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'log') {
      const logs = $('logs');
      if (logs.textContent === 'Waiting for first run…') logs.textContent = '';
      logs.textContent += (logs.textContent ? '\n' : '') + msg.text;
      logs.scrollTop = logs.scrollHeight;
    } else if (msg.type === 'status') {
      const badge = $('status');
      badge.textContent = msg.running ? 'running' : 'idle';
      badge.className = 'status-badge ' + (msg.running ? 'running' : 'idle');
      if (msg.running) $('logs').textContent = '';
      else $('preview').innerHTML = '<div class="placeholder">Live preview appears here when a run starts</div>';
    } else if (msg.type === 'preview-frame') {
      const p = $('preview');
      let img = p.querySelector('img');
      if (!img) { p.innerHTML = ''; img = document.createElement('img'); p.appendChild(img); }
      img.src = 'data:image/jpeg;base64,' + msg.data;
    } else if (msg.type === 'record-step') {
      const el = $('record-steps');
      if (msg.replaceLast) {
        const last = el.lastElementChild;
        if (last) last.textContent = renderRecStep(msg.step);
        else appendRecStep(msg.step);
      } else appendRecStep(msg.step);
    } else if (msg.type === 'runs-updated') {
      loadRuns();
    }
  };
  ws.onclose = () => setTimeout(connectWS, 2000);
}
function appendRecStep(step) {
  const el = $('record-steps');
  const div = document.createElement('div');
  div.className = 'rec-step';
  div.textContent = renderRecStep(step);
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}
function renderRecStep(step) {
  if (step.type === 'goto') return `→ goto  ${step.url}`;
  if (step.type === 'click') return `→ click  ${step.selector}`;
  if (step.type === 'type') return `→ type  ${step.selector}  = "${step.text}"`;
  return JSON.stringify(step);
}

function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }

$('new-flow').onclick = newFlow;
$('save-flow').onclick = saveFlow;
$('add-step').onclick = addStep;
$('run-btn').onclick = run;
$('stop-btn').onclick = stop;

loadFlows();
loadSessions();
loadDevices();
loadRuns();
setInterval(loadRuns, 5000);
connectWS();
