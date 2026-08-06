const $ = (id) => document.getElementById(id);
let flows = [];
let sessions = [];
let deviceList = [];
let currentFlowId = null;
let sessionRecId = null;
let flowFilter = '';
let settingsCache = {};
let pickerTargetInput = null;
let dragSrc = null;
let firstLoad = true;

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
  if (firstLoad && !currentFlowId && flows.length) {
    firstLoad = false;
    selectFlow(flows[0].id);
  } else {
    firstLoad = false;
    // If the current flow was deleted, drop selection so empty state shows
    if (currentFlowId && !flows.find((f) => f.id === currentFlowId)) currentFlowId = null;
    renderEditor();
  }
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

let collapsedFolders = JSON.parse(localStorage.getItem('collapsedFolders') || '[]');
function toggleFolder(name) {
  if (collapsedFolders.includes(name)) collapsedFolders = collapsedFolders.filter((n) => n !== name);
  else collapsedFolders.push(name);
  localStorage.setItem('collapsedFolders', JSON.stringify(collapsedFolders));
  renderFlows();
  refreshIcons();
}

function renderFlows() {
  const el = $('flows-list');
  el.innerHTML = '';
  const visible = flows.filter((f) => matchesFilter(f, flowFilter));
  const countEl = $('flows-count');
  if (countEl) countEl.textContent = flows.length;
  if (!visible.length) { el.innerHTML = '<div class="empty" style="padding:1rem 0;font-size:0.75rem">No flows</div>'; return; }

  // Group by folder — unfiled last
  const groups = new Map();
  visible.forEach((f) => {
    const key = (f.folder || '').trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  });
  const folderNames = Array.from(groups.keys()).sort((a, b) => {
    if (a === '' && b !== '') return 1;
    if (b === '' && a !== '') return -1;
    return a.localeCompare(b);
  });

  const renderItem = (f) => {
    const div = document.createElement('div');
    div.className = 'flow-item' + (f.id === currentFlowId ? ' active' : '');
    const tags = (f.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
    div.innerHTML = `
      <span class="flow-name-wrap">${f.schedule ? '<span class="schedule-mark">⏰</span>' : ''}<span class="flow-name-text">${escapeHtml(f.name)}</span>${tags}</span>
      <button class="del" title="Delete">✕</button>`;
    div.onclick = (e) => {
      if (e.target.classList.contains('del')) return deleteFlow(f.id);
      selectFlow(f.id);
    };
    return div;
  };

  folderNames.forEach((name) => {
    const items = groups.get(name);
    if (name === '' && folderNames.length === 1) {
      // Only unfiled → render flat without header
      items.forEach((f) => el.appendChild(renderItem(f)));
      return;
    }
    const isCollapsed = collapsedFolders.includes(name || '__unfiled__');
    const header = document.createElement('div');
    header.className = 'folder-header' + (isCollapsed ? ' collapsed' : '');
    header.innerHTML = `
      <i data-lucide="chevron-down" class="chevron"></i>
      <span class="fname">${name === '' ? 'Unfiled' : escapeHtml(name)}</span>
      <span class="folder-count">${items.length}</span>
    `;
    header.onclick = () => toggleFolder(name || '__unfiled__');
    el.appendChild(header);
    const body = document.createElement('div');
    body.className = 'folder-body' + (isCollapsed ? ' collapsed' : '');
    items.forEach((f) => body.appendChild(renderItem(f)));
    el.appendChild(body);
  });

  // Populate folder datalist
  const list = $('folder-list');
  if (list) {
    const uniqueFolders = Array.from(new Set(flows.map((f) => f.folder).filter(Boolean))).sort();
    list.innerHTML = uniqueFolders.map((n) => `<option value="${escapeAttr(n)}">`).join('');
  }
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
  const crumb = $('crumb-flow');
  const closeBtn = $('close-flow');
  if (!f) {
    $('editor-empty').style.display = '';
    $('editor-content').style.display = 'none';
    if (crumb) crumb.textContent = 'No flow selected';
    if (closeBtn) closeBtn.style.display = 'none';
    return;
  }
  $('editor-empty').style.display = 'none';
  $('editor-content').style.display = '';
  if (crumb) crumb.textContent = f.name || 'Untitled';
  if (closeBtn) closeBtn.style.display = '';
  $('flow-name').value = f.name;
  $('flow-loops').value = f.loops || 1;
  $('flow-schedule').value = f.schedule || '';
  $('flow-session').value = f.sessionName || '';
  $('flow-device').value = f.device || '';
  $('flow-human').checked = !!f.humanLike;
  $('flow-tags').value = (f.tags || []).join(', ');
  $('flow-datarows').value = f.dataRows || '';
  $('flow-alert').value = f.alertOnFailure || '';
  $('flow-folder').value = f.folder || '';
  const base = settingsCache.publicUrl || location.origin;
  $('flow-trigger').value = `${base}/api/trigger/${f.id}`;
  renderStepsInto(f.steps || [], $('steps'));
}

function renderStepsInto(stepsArray, container) {
  container.innerHTML = '';
  stepsArray.forEach((step, idx) => container.appendChild(renderStep(stepsArray, step, idx)));
}

function renderStep(stepsArray, step, idx) {
  const wrap = document.createElement('div');
  wrap.className = 'step';
  wrap.setAttribute('draggable', 'true');
  const def = STEP_TYPES[step.type] || STEP_TYPES.click;
  const typeOptions = Object.keys(STEP_TYPES).map((t) =>
    `<option value="${t}" ${t === step.type ? 'selected' : ''}>${t}</option>`).join('');
  const fields = def.fields.map(([key, type, defVal, span]) => {
    const val = step[key] ?? defVal;
    const cls = span === 'full' ? 'full' : '';
    if (type === 'checkbox') {
      return `<label class="full" style="display:flex;align-items:center;gap:0.4rem;color:hsl(var(--foreground));text-transform:none"><input type="checkbox" data-k="${key}" ${val ? 'checked' : ''}/> ${key}</label>`;
    }
    if (type === 'textarea') {
      return `<div class="${cls}"><label>${key}</label><textarea data-k="${key}" rows="2" style="width:100%;font-family:'JetBrains Mono',monospace;font-size:0.75rem">${escapeHtml(val)}</textarea></div>`;
    }
    if (type === 'flowSelect') {
      return `<div class="${cls}"><label>${key}</label><select data-k="${key}" data-flowselect="1"></select></div>`;
    }
    if (type.startsWith('select:')) {
      const opts = type.slice(7).split('|').map((o) => `<option value="${o}" ${o === val ? 'selected' : ''}>${o}</option>`).join('');
      return `<div class="${cls}"><label>${key}</label><select data-k="${key}">${opts}</select></div>`;
    }
    if (key === 'selector' || key === 'url') {
      return `<div class="${cls}"><label>${key}</label><div class="with-pick"><input type="${type}" data-k="${key}" value="${escapeAttr(val)}" /><button type="button" class="pick-btn" data-pick="${key}">🖱 Pick</button></div></div>`;
    }
    return `<div class="${cls}"><label>${key}</label><input type="${type}" data-k="${key}" value="${escapeAttr(val)}" /></div>`;
  }).join('');
  wrap.innerHTML = `
    <div class="step-head">
      <span class="drag-handle" title="Drag to reorder">⋮⋮</span>
      <span class="idx">#${idx + 1}</span>
      <select data-role="type">${typeOptions}</select>
      <div class="spacer"></div>
      <button data-role="dup" class="small" title="Duplicate">⧉</button>
      <button data-role="del" class="danger small" title="Delete">✕</button>
    </div>
    <div class="step-fields">${fields}</div>
  `;
  wrap.querySelector('[data-role=type]').onchange = (e) => {
    stepsArray[idx] = { type: e.target.value };
    renderStepsInto(stepsArray, wrap.parentElement);
    populateFlowSelects();
  };
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
  wrap.querySelectorAll('[data-pick]').forEach((btn) => {
    btn.onclick = () => {
      const input = wrap.querySelector(`[data-k="${btn.dataset.pick}"]`);
      const defaultUrl = findDefaultUrl();
      openPicker(input, defaultUrl);
    };
  });

  wrap.addEventListener('dragstart', (e) => {
    dragSrc = { array: stepsArray, idx };
    wrap.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  wrap.addEventListener('dragend', () => {
    wrap.classList.remove('dragging');
    document.querySelectorAll('.step.drag-over').forEach((s) => s.classList.remove('drag-over'));
  });
  wrap.addEventListener('dragover', (e) => {
    if (!dragSrc || dragSrc.array !== stepsArray) return;
    e.preventDefault();
    wrap.classList.add('drag-over');
  });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drag-over'));
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    wrap.classList.remove('drag-over');
    if (!dragSrc || dragSrc.array !== stepsArray || dragSrc.idx === idx) return;
    const [moved] = stepsArray.splice(dragSrc.idx, 1);
    const newIdx = dragSrc.idx < idx ? idx - 1 : idx;
    stepsArray.splice(newIdx, 0, moved);
    dragSrc = null;
    renderStepsInto(stepsArray, wrap.parentElement);
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

function findDefaultUrl() {
  const f = currentFlow();
  if (!f) return 'https://';
  const goto = (f.steps || []).find((s) => s.type === 'goto' && s.url);
  return goto ? goto.url : 'https://';
}

function openPicker(inputEl, defaultUrl) {
  pickerTargetInput = inputEl;
  $('picker-url').value = defaultUrl;
  $('picker-setup').style.display = '';
  $('picker-stream-wrap').style.display = 'none';
  $('picker-stream').src = '';
  const load = $('picker-loading');
  if (load) load.classList.remove('hide');
  $('picker-modal').classList.add('on');
  setTimeout(() => $('picker-url').focus(), 50);
}

function refreshIcons() {
  try { if (window.lucide) window.lucide.createIcons(); } catch {}
}

function openNewFlow() {
  $('newflow-name').value = '';
  $('newflow-modal').classList.add('on');
  setTimeout(() => { $('newflow-name').focus(); refreshIcons(); }, 50);
}
async function createFlowFromModal() {
  const name = $('newflow-name').value.trim() || 'Untitled flow';
  try {
    const flow = await api('/api/flows', { method: 'POST', body: JSON.stringify({ name, loops: 1, steps: [] }) });
    currentFlowId = flow.id;
    closeModal('newflow-modal');
    await loadFlows();
    toast('Flow created', 'success', 1500);
  } catch (e) { toast(e.message, 'error'); }
}
async function deleteFlow(id) {
  if (!confirm('Delete this flow?')) return;
  await api('/api/flows/' + id, { method: 'DELETE' });
  if (currentFlowId === id) currentFlowId = null;
  await loadFlows();
  toast('Flow deleted', 'info', 1500);
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
  f.alertOnFailure = Number($('flow-alert').value) || 0;
  f.folder = $('flow-folder').value.trim();
  await api('/api/flows/' + f.id, { method: 'PUT', body: JSON.stringify(f) });
  await loadFlows();
  toast('Flow saved', 'success', 1500);
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
  settingsCache = s;
  $('setting-discord').value = s.discordWebhook || '';
  $('setting-slack').value = s.slackWebhook || '';
  $('setting-tg-token').value = s.telegramBotToken || '';
  $('setting-tg-chat').value = s.telegramChatId || '';
  $('setting-public-url').value = s.publicUrl || '';
  $('setting-password').value = s.password || '';
  $('setting-anthropic').value = s.anthropicKey || '';
  $('settings-modal').classList.add('on');
};
$('save-settings').onclick = async () => {
  settingsCache = await api('/api/settings', { method: 'PUT', body: JSON.stringify({
    discordWebhook: $('setting-discord').value.trim(),
    slackWebhook: $('setting-slack').value.trim(),
    telegramBotToken: $('setting-tg-token').value.trim(),
    telegramChatId: $('setting-tg-chat').value.trim(),
    publicUrl: $('setting-public-url').value.trim().replace(/\/$/, ''),
    password: $('setting-password').value,
    anthropicKey: $('setting-anthropic').value.trim(),
  })});
  closeModal('settings-modal');
  renderEditor();
  toast('Settings saved', 'success');
  if ($('setting-password').value) toast('Password set — next page load will prompt for it.', 'info', 5000);
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

// --- Picker modal ---
let pickerViewport = { width: 1280, height: 720 };
$('picker-open').onclick = async () => {
  const url = $('picker-url').value.trim();
  if (!url) return toast('URL required', 'error');
  try {
    const r = await api('/api/picker/start', { method: 'POST', body: JSON.stringify({ url }) });
    if (r.viewport) pickerViewport = r.viewport;
    $('picker-setup').style.display = 'none';
    $('picker-stream-wrap').style.display = '';
    toast('Loading page…', 'info', 2000);
  } catch (e) { toast(e.message, 'error'); pickerTargetInput = null; }
};
$('picker-cancel-btn').onclick = async () => {
  try { await api('/api/picker/cancel', { method: 'POST' }); } catch {}
  pickerTargetInput = null;
  closeModal('picker-modal');
};
$('picker-stop').onclick = async () => {
  try { await api('/api/picker/cancel', { method: 'POST' }); } catch {}
  pickerTargetInput = null;
  closeModal('picker-modal');
};
$('picker-stream').onclick = async (e) => {
  const img = e.target;
  const rect = img.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * pickerViewport.width;
  const y = ((e.clientY - rect.top) / rect.height) * pickerViewport.height;
  try { await api('/api/picker/click', { method: 'POST', body: JSON.stringify({ x, y }) }); }
  catch (err) { toast(err.message, 'error'); }
};
$('picker-stream').addEventListener('wheel', async (e) => {
  e.preventDefault();
  try { await api('/api/picker/scroll', { method: 'POST', body: JSON.stringify({ dx: e.deltaX, dy: e.deltaY }) }); }
  catch {}
}, { passive: false });

// --- Resizable bottom panel ---
(() => {
  const handle = $('resize-handle');
  const bottom = $('bottom');
  let resizing = false;
  handle.addEventListener('mousedown', (e) => { resizing = true; handle.classList.add('dragging'); e.preventDefault(); });
  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const total = window.innerHeight;
    const runbarH = $('runbar').offsetHeight;
    const newBottom = total - e.clientY - runbarH;
    const min = 80, max = total * 0.85;
    if (newBottom < min || newBottom > max) return;
    bottom.style.height = newBottom + 'px';
  });
  document.addEventListener('mouseup', () => { resizing = false; handle.classList.remove('dragging'); });
})();

// --- Analytics modal ---
$('open-analytics').onclick = async () => {
  $('analytics-modal').classList.add('on');
  $('analytics-content').innerHTML = 'Loading…';
  try {
    const runs = await api('/api/runs');
    $('analytics-content').innerHTML = renderAnalytics(runs);
  } catch (e) { $('analytics-content').innerHTML = 'Error: ' + e.message; }
};

function renderAnalytics(runs) {
  const total = runs.length;
  const successes = runs.filter((r) => r.success).length;
  const failures = runs.filter((r) => !r.success && !r.stopped).length;
  const stopped = runs.filter((r) => r.stopped).length;
  const successRate = total ? Math.round((successes / total) * 100) : 0;
  const avgDur = total ? Math.round(runs.reduce((s, r) => s + (r.endedAt - r.startedAt), 0) / total / 100) / 10 : 0;
  const totalShots = runs.reduce((s, r) => s + ((r.screenshots || []).length), 0);
  const totalExtracted = runs.reduce((s, r) => s + Object.keys(r.extracted || {}).length, 0);

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const runsToday = runs.filter((r) => r.startedAt >= todayStart.getTime()).length;
  const runsWeek = runs.filter((r) => r.startedAt >= now - 7 * day).length;

  // Bin runs into last 14 days (aligned to local midnight)
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const dayStart = todayStart.getTime() - i * day;
    const dayEnd = dayStart + day;
    const d = new Date(dayStart);
    const label = `${d.getMonth() + 1}/${d.getDate()}`;
    const dayRuns = runs.filter((r) => r.startedAt >= dayStart && r.startedAt < dayEnd);
    days.push({
      label,
      ok: dayRuns.filter((r) => r.success).length,
      fail: dayRuns.filter((r) => !r.success && !r.stopped).length,
    });
  }
  const maxDay = Math.max(1, ...days.map((d) => d.ok + d.fail));

  // Per-flow aggregate
  const perFlow = {};
  runs.forEach((r) => {
    if (!perFlow[r.flowName]) perFlow[r.flowName] = { name: r.flowName, runs: 0, success: 0, fail: 0, totalDur: 0 };
    const f = perFlow[r.flowName];
    f.runs++;
    if (r.success) f.success++;
    else if (!r.stopped) f.fail++;
    f.totalDur += (r.endedAt - r.startedAt);
  });
  const flowStats = Object.values(perFlow).sort((a, b) => b.runs - a.runs);

  // Recent failures with error line
  const recentFails = runs
    .filter((r) => !r.success && !r.stopped)
    .slice(0, 5)
    .map((r) => {
      const errLine = (r.logs || []).slice().reverse().find((l) => /✖|Fatal|Error/i.test(l)) || '(no error captured)';
      return { ...r, errLine };
    });

  // SVG chart with fixed unit coordinates
  const chartW = 700, chartH = 190, marginL = 32, marginR = 12, marginB = 24, marginT = 8;
  const plotW = chartW - marginL - marginR;
  const plotH = chartH - marginB - marginT;
  const barWidth = plotW / days.length;
  const bars = days.map((d, i) => {
    if (d.ok + d.fail === 0) return '';
    const okH = (d.ok / maxDay) * plotH;
    const failH = (d.fail / maxDay) * plotH;
    const x = marginL + i * barWidth + barWidth * 0.18;
    const w = barWidth * 0.64;
    return `
      <rect class="chart-bar success" x="${x}" y="${marginT + plotH - okH}" width="${w}" height="${okH}"><title>${d.label}: ${d.ok} ok</title></rect>
      <rect class="chart-bar fail" x="${x}" y="${marginT + plotH - okH - failH}" width="${w}" height="${failH}"><title>${d.label}: ${d.fail} failed</title></rect>
    `;
  }).join('');
  const dayLabels = days.map((d, i) => {
    if (i % 2 !== 0 && i !== days.length - 1) return '';
    return `<text class="chart-label" x="${marginL + i * barWidth + barWidth / 2}" y="${chartH - 6}" text-anchor="middle">${d.label}</text>`;
  }).join('');
  const axes = `
    <text class="chart-label" x="${marginL - 6}" y="${marginT + 4}" text-anchor="end">${maxDay}</text>
    <text class="chart-label" x="${marginL - 6}" y="${marginT + plotH}" text-anchor="end">0</text>
    <line class="chart-axis" x1="${marginL}" y1="${marginT}" x2="${marginL}" y2="${marginT + plotH}"/>
    <line class="chart-axis" x1="${marginL}" y1="${marginT + plotH}" x2="${chartW - marginR}" y2="${marginT + plotH}"/>
  `;

  return `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">Total runs</div><div class="stat-value">${total}</div></div>
      <div class="stat-card"><div class="stat-label">Success rate</div><div class="stat-value" style="color:${successRate >= 80 ? 'hsl(142 71% 45%)' : successRate >= 50 ? 'hsl(38 92% 60%)' : 'hsl(0 84% 65%)'}">${successRate}%</div></div>
      <div class="stat-card"><div class="stat-label">Failed</div><div class="stat-value" style="color:hsl(0 84% 65%)">${failures}</div></div>
      <div class="stat-card"><div class="stat-label">Stopped</div><div class="stat-value" style="color:hsl(38 92% 60%)">${stopped}</div></div>
      <div class="stat-card"><div class="stat-label">Avg duration</div><div class="stat-value">${avgDur}<span style="font-size:0.9rem;color:hsl(var(--muted-foreground))">s</span></div></div>
      <div class="stat-card"><div class="stat-label">Screenshots</div><div class="stat-value">${totalShots}</div></div>
      <div class="stat-card"><div class="stat-label">Data extracted</div><div class="stat-value">${totalExtracted}</div><div class="stat-hint">fields captured</div></div>
      <div class="stat-card"><div class="stat-label">Runs today</div><div class="stat-value">${runsToday}</div><div class="stat-hint">${runsWeek} this week</div></div>
    </div>

    <div class="chart-section">
      <div class="chart-title">Runs by day — last 14 days</div>
      <div class="chart-legend">
        <span><span class="legend-dot success"></span>Success</span>
        <span><span class="legend-dot fail"></span>Failed</span>
      </div>
      <svg class="chart-svg" viewBox="0 0 ${chartW} ${chartH}" preserveAspectRatio="xMidYMid meet">
        ${axes}
        ${bars}
        ${dayLabels}
      </svg>
    </div>

    <div class="chart-section">
      <div class="chart-title">Per-flow stats</div>
      ${flowStats.length ? `
        <div class="flow-stats-table">
          <div class="flow-stats-row header">
            <span>Flow</span>
            <span>Runs</span>
            <span>Success</span>
            <span>Avg time</span>
          </div>
          ${flowStats.slice(0, 12).map((f) => {
            const rate = f.runs ? Math.round((f.success / f.runs) * 100) : 0;
            const avgS = f.runs ? Math.round(f.totalDur / f.runs / 100) / 10 : 0;
            const rateColor = rate >= 80 ? 'hsl(142 71% 45%)' : rate >= 50 ? 'hsl(38 92% 60%)' : 'hsl(0 84% 65%)';
            return `
              <div class="flow-stats-row">
                <span class="flow-stats-name">${escapeHtml(f.name)}</span>
                <span>${f.runs}</span>
                <span style="color:${rateColor}">${rate}%</span>
                <span>${avgS}s</span>
              </div>
            `;
          }).join('')}
        </div>
      ` : '<div style="color:hsl(var(--muted-foreground));padding:0.6rem;font-size:0.85rem">No runs yet</div>'}
    </div>

    ${recentFails.length ? `
      <div class="chart-section">
        <div class="chart-title">Recent failures</div>
        ${recentFails.map((r) => `
          <div class="failure-item">
            <div class="failure-head">
              <span class="failure-name">${escapeHtml(r.flowName)}</span>
              <span class="failure-time">${new Date(r.startedAt).toLocaleString()}</span>
            </div>
            <div class="failure-err">${escapeHtml(r.errLine)}</div>
          </div>
        `).join('')}
      </div>
    ` : `
      <div class="chart-section">
        <div class="chart-title">Recent failures</div>
        <div style="color:hsl(var(--muted-foreground));font-size:0.85rem;padding:0.5rem">No failures yet 🎉</div>
      </div>
    `}
  `;
}

// --- WebSocket ---
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const ws = new WebSocket(proto + location.host);
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
    } else if (msg.type === 'picked-selector') {
      if (pickerTargetInput) {
        if (msg.selector) {
          pickerTargetInput.value = msg.selector;
          pickerTargetInput.dispatchEvent(new Event('input', { bubbles: true }));
          toast('Selector picked: ' + msg.selector, 'success', 4000);
        } else {
          toast('Picker cancelled', 'info');
        }
        pickerTargetInput = null;
      }
      closeModal('picker-modal');
    } else if (msg.type === 'picker-frame') {
      const img = $('picker-stream');
      if (img) img.src = 'data:image/jpeg;base64,' + msg.data;
      const load = $('picker-loading');
      if (load) load.classList.add('hide');
    } else if (msg.type === 'picker-cancelled') {
      pickerTargetInput = null;
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

$('close-flow').onclick = () => { currentFlowId = null; renderFlows(); renderEditor(); refreshIcons(); };
$('new-flow').onclick = openNewFlow;

async function duplicateFlow() {
  const f = currentFlow();
  if (!f) return;
  const copy = JSON.parse(JSON.stringify(f));
  delete copy.id;
  copy.name = f.name + ' (copy)';
  try {
    const created = await api('/api/flows', { method: 'POST', body: JSON.stringify(copy) });
    currentFlowId = created.id;
    await loadFlows();
    toast('Flow duplicated', 'success', 1500);
  } catch (e) { toast(e.message, 'error'); }
}
$('duplicate-flow').onclick = duplicateFlow;

// --- Command palette (⌘K) ---
let cmdkSelected = 0;
let cmdkCurrentItems = [];
function cmdkItems() {
  const actions = [];
  if (currentFlowId) {
    actions.push(
      { group: 'Current flow', label: 'Run flow', icon: 'play', run: () => run() },
      { group: 'Current flow', label: 'Save flow', icon: 'save', run: () => saveFlow() },
      { group: 'Current flow', label: 'Duplicate flow', icon: 'copy', run: () => duplicateFlow() },
      { group: 'Current flow', label: 'Delete flow', icon: 'trash-2', run: () => deleteFlow(currentFlowId) },
      { group: 'Current flow', label: 'Close flow', icon: 'x', run: () => { currentFlowId = null; renderFlows(); renderEditor(); refreshIcons(); } },
    );
  }
  actions.push(
    { group: 'Actions', label: 'Create new flow', icon: 'plus', run: () => openNewFlow() },
    { group: 'Actions', label: 'Record new flow', icon: 'mic', run: () => $('record-flow').click() },
    { group: 'Actions', label: 'Generate flow with AI', icon: 'sparkles', run: () => $('ai-flow').click() },
    { group: 'Actions', label: 'Import flow from JSON', icon: 'upload', run: () => $('import-flow').click() },
    { group: 'Actions', label: 'Capture login session', icon: 'key-round', run: () => $('new-session').click() },
    { group: 'Actions', label: 'Stop running flow', icon: 'square', run: () => stop() },
  );
  actions.push(
    { group: 'View', label: 'Open Analytics', icon: 'bar-chart-3', run: () => $('open-analytics').click() },
    { group: 'View', label: 'Open Settings', icon: 'settings', run: () => $('open-settings').click() },
  );
  flows.forEach((f) => {
    actions.push({ group: 'Flows', label: f.name, sub: f.folder || '', icon: 'workflow', run: () => selectFlow(f.id) });
  });
  return actions;
}
function filterCmdk(items, q) {
  if (!q) return items;
  const t = q.toLowerCase();
  return items.filter((i) => i.label.toLowerCase().includes(t) || (i.sub || '').toLowerCase().includes(t) || i.group.toLowerCase().includes(t));
}
function renderCmdk() {
  const q = $('cmdk-input').value;
  cmdkCurrentItems = filterCmdk(cmdkItems(), q);
  if (cmdkSelected >= cmdkCurrentItems.length) cmdkSelected = Math.max(0, cmdkCurrentItems.length - 1);
  const list = $('cmdk-list');
  if (!cmdkCurrentItems.length) { list.innerHTML = '<div class="empty" style="padding:2rem 1rem;font-size:0.85rem">No results</div>'; return; }
  let html = '';
  let lastGroup = null;
  cmdkCurrentItems.forEach((it, i) => {
    if (it.group !== lastGroup) {
      html += `<div class="cmdk-group-label">${escapeHtml(it.group)}</div>`;
      lastGroup = it.group;
    }
    html += `
      <div class="cmdk-item${i === cmdkSelected ? ' selected' : ''}" data-idx="${i}">
        <i data-lucide="${it.icon}"></i>
        <span class="cmdk-label">${escapeHtml(it.label)}</span>
        ${it.sub ? `<span class="cmdk-sub">${escapeHtml(it.sub)}</span>` : ''}
      </div>
    `;
  });
  list.innerHTML = html;
  list.querySelectorAll('.cmdk-item').forEach((el) => {
    el.onmouseover = () => { cmdkSelected = Number(el.dataset.idx); highlightCmdk(); };
    el.onclick = () => runCmdkItem(cmdkCurrentItems[Number(el.dataset.idx)]);
  });
  refreshIcons();
  scrollSelectedIntoView();
}
function highlightCmdk() {
  $('cmdk-list').querySelectorAll('.cmdk-item').forEach((el, i) => el.classList.toggle('selected', i === cmdkSelected));
  scrollSelectedIntoView();
}
function scrollSelectedIntoView() {
  const sel = $('cmdk-list').querySelector('.cmdk-item.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}
function runCmdkItem(item) {
  closeModal('cmdk-modal');
  if (item) setTimeout(() => item.run(), 30);
}
function openCmdk() {
  $('cmdk-input').value = '';
  cmdkSelected = 0;
  $('cmdk-modal').classList.add('on');
  renderCmdk();
  setTimeout(() => $('cmdk-input').focus(), 30);
}
$('cmdk-input').addEventListener('input', () => { cmdkSelected = 0; renderCmdk(); });
$('cmdk-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); cmdkSelected = Math.min(cmdkCurrentItems.length - 1, cmdkSelected + 1); highlightCmdk(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkSelected = Math.max(0, cmdkSelected - 1); highlightCmdk(); }
  else if (e.key === 'Enter') { e.preventDefault(); runCmdkItem(cmdkCurrentItems[cmdkSelected]); }
});

// --- Global keyboard shortcuts ---
function isTypingIn(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}
document.addEventListener('keydown', (e) => {
  const meta = e.ctrlKey || e.metaKey;
  // ⌘K / Ctrl+K: command palette
  if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmdk(); return; }
  // ⌘S: save current flow
  if (meta && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (currentFlowId) { saveFlow(); }
    return;
  }
  // ⌘Enter: run current flow (only outside modals)
  if (meta && e.key === 'Enter') {
    if (currentFlowId && !document.querySelector('.modal.on')) { e.preventDefault(); run(); }
    return;
  }
  // ⌘D: duplicate current flow
  if (meta && e.key.toLowerCase() === 'd') {
    if (currentFlowId) { e.preventDefault(); duplicateFlow(); }
    return;
  }
  // Escape: close topmost modal
  if (e.key === 'Escape') {
    const open = Array.from(document.querySelectorAll('.modal.on')).pop();
    if (open) { open.classList.remove('on'); }
    return;
  }
  // /: focus search (when not typing)
  if (e.key === '/' && !isTypingIn(e.target)) {
    e.preventDefault();
    $('flow-search').focus();
    return;
  }
});
$('newflow-create').onclick = createFlowFromModal;
$('newflow-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') createFlowFromModal(); });
$('save-flow').onclick = saveFlow;
$('delete-flow').onclick = () => { if (currentFlowId) deleteFlow(currentFlowId); };
$('add-step').onclick = addStep;
$('run-btn').onclick = run;
$('stop-btn').onclick = stop;

(async () => {
  refreshIcons();
  try { settingsCache = await api('/api/settings'); } catch {}
  await loadFlows();
  await loadSessions();
  await loadDevices();
  await loadRuns();
  refreshIcons();
  setInterval(loadRuns, 5000);
  connectWS();
})();
