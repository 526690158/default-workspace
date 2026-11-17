// 控制面前端逻辑（演示版：含总览 + 对齐校验 + 任务流转 + L1字段）
const $ = (sel) => document.querySelector(sel);
let currentTenant = localStorage.getItem('enterprise-os-tenant') || 'acme-corp';
let currentManager = 'local-operator';

function q(path) {
  return path + (path.includes('?') ? '&' : '?') + 'tenant=' + encodeURIComponent(currentTenant);
}

// ---- 租户切换 ----
let tenantDetails = [];
async function loadTenants() {
  const res = await fetch('/api/tenants');
  const { tenants, details = [] } = await res.json();
  tenantDetails = details;
  const countByName = new Map();
  details.forEach((item) => countByName.set(item.name, (countByName.get(item.name) || 0) + 1));
  const sel = $('#tenant-select');
  sel.innerHTML = '';
  tenants.forEach((t) => {
    const o = document.createElement('option');
    o.value = t;
    const name = details.find((item) => item.id === t)?.name || t;
    o.textContent = countByName.get(name) > 1 ? `${name} · ${t.slice(-8)}` : name;
    o.title = `${name} · ${t}`;
    sel.appendChild(o);
  });
  if (!tenants.includes(currentTenant)) currentTenant = tenants[0];
  sel.value = currentTenant;
  sel.title = sel.selectedOptions[0]?.title || '切换经营空间';
  renderConversationScope();
  loadConversationHistory();
}

$('#tenant-select').addEventListener('change', () => {
  currentTenant = $('#tenant-select').value;
  localStorage.setItem('enterprise-os-tenant', currentTenant);
  $('#tenant-select').title = $('#tenant-select').selectedOptions[0]?.title || '切换经营空间';
  for (const mode of ['agent', 'workflow']) {
    studioSessions[mode] = null;
    studioLogs[mode] = [];
    studioPhases[mode] = 'intro';
  }
  saveStudioClient();
  setStudioMode(studioMode);
  refreshAll();
});

$('#tenant-rename-start').addEventListener('click', () => {
  $('#tenant-rename-input').value = tenantDetails.find((item) => item.id === currentTenant)?.name || '';
  $('#tenant-rename-form').hidden = false;
  $('#tenant-rename-status').textContent = '';
  $('#tenant-rename-input').focus();
});
$('#tenant-rename-cancel').addEventListener('click', () => { $('#tenant-rename-form').hidden = true; });
$('#tenant-rename-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('#tenant-rename-input').value.trim();
  const status = $('#tenant-rename-status');
  if (!name) return;
  status.textContent = '保存中…';
  try {
    const res = await fetch(q('/api/tenant'), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '重命名失败');
    await loadTenants();
    refreshAll();
    $('#tenant-rename-form').hidden = true;
    status.textContent = `已重命名为「${name}」`;
  } catch (error) { status.textContent = error.message; }
});

// ---- Tab 切换 ----
function openTab(t) {
    document.body.classList.toggle('chat-page', t === 'chat');
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    document.querySelector(`.tab[data-tab="${t}"]`).classList.add('active');
    $('#tab-' + t).classList.add('active');
    const labels = { chat: '开始创建', overview: '总览', create: '高级配置', contracts: '岗位契约', compile: '契约编译', team: '数字团队', tasks: '任务板', align: '对齐校验' };
    $('.breadcrumbs strong').textContent = labels[t] || t;
    if (t === 'overview') loadOverview();
    if (t === 'chat') renderChat();
    if (t === 'team') loadTeam();
    if (t === 'tasks') loadTasks();
    if (t === 'contracts') loadContractList();
}
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    openTab(btn.dataset.tab);
  });
});
document.querySelectorAll('.go-tab').forEach((btn) => btn.addEventListener('click', () => openTab(btn.dataset.go)));

// ---- 建岗位（步骤2）----
let TEMPLATES = [];
async function loadTemplates() {
  const res = await fetch('/api/templates');
  const { templates } = await res.json();
  TEMPLATES = templates;
  const sel = $('#f-template');
  templates.forEach((t) => {
    const o = document.createElement('option');
    o.value = t.role;
    o.textContent = `${t.role}（推荐 ${t.autonomy}）`;
    sel.appendChild(o);
  });
}

$('#f-template').addEventListener('change', () => {
  const t = TEMPLATES.find((x) => x.role === $('#f-template').value);
  const hint = $('#template-hint');
  if (!t) { hint.textContent = ''; return; }
  $('#f-role').value = t.role;
  $('#f-capability').value = t.capability;
  $('#f-purpose').value = t.purpose;
  $('#f-nonpurpose').value = t.non_purpose;
  $('#f-autonomy').value = t.autonomy;
  document.querySelectorAll('.tools-grid input').forEach((c) => { c.checked = t.tools.includes(c.value); });
  hint.innerHTML = `💡 推荐自治等级 <b>${t.autonomy}</b>：${t.reason}`;
  hint.className = 'hint';
});

$('#agent-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = $('#form-status');
  st.textContent = '创建中…';
  const tools = [...document.querySelectorAll('.tools-grid input:checked')].map((c) => c.value);
  const body = {
    role: $('#f-role').value.trim(),
    capability: $('#f-capability').value.trim(),
    purpose: $('#f-purpose').value.trim(),
    non_purpose: $('#f-nonpurpose').value.trim(),
    owner: $('#f-owner').value.trim(),
    supervisor: $('#f-supervisor').value.trim(),
    acceptor: $('#f-acceptor').value.trim(),
    autonomy: $('#f-autonomy').value,
    tools,
    boundary_confirmed: $('#role-boundary').checked,
  };
  if (!body.role || !body.capability) { st.textContent = '请填写岗位名称和能力'; st.className = 'status err'; return; }
  try {
    const res = await fetch(q('/api/agents'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (data.ok) {
      st.textContent = `✅ 已创建硅基同事「${body.role}」（自治等级 ${data.autonomy}），已加入团队`;
      st.className = 'status ok';
      e.target.reset();
      $('#f-autonomy').value = 'L2';
      loadContractList();
      loadTeam();
      loadOverview();
      openTab('tasks');
      $('#task-form-status').textContent = `「${body.role}」已创建。现在给它安排任务。`;
    } else {
      st.textContent = '❌ ' + (data.error || '创建失败');
      st.className = 'status err';
    }
  } catch (err) {
    st.textContent = '❌ 请求失败：' + err.message;
    st.className = 'status err';
  }
});

// ---- 总览 ----
const LAYERS = [
  { id: 'L0', name: '做事哲学 · 执行 Harness', desc: 'DSH Agent + Tools + 执行/验证' },
  { id: 'L1', name: '管理哲学 · 岗位定义', desc: '岗位/身份/授权/责任/监督/验收' },
  { id: 'L2', name: '业务哲学 · 任务编排', desc: '状态机流转 + 交接 + 完成判定' },
  { id: 'L3', name: '认知协同 · 对齐校验', desc: '硬规则引擎 + 软校验' },
  { id: 'L4', name: '人机交互工作台', desc: '委托/澄清/协商/授权审批/监督接管/验收反馈' },
];

async function loadOverview() {
  const [stateRes, tenantsRes] = await Promise.all([fetch(q('/api/state')), fetch('/api/tenants')]);
  const state = await stateRes.json();
  const { tenants } = await tenantsRes.json();
  const team = state.team || {};
  const members = team.members || [];
  const agents = members.filter((m) => m.type === 'agent');
  const humans = members.filter((m) => m.type !== 'agent');

  // 五层架构 + 状态
  const map = $('#layer-map');
  map.innerHTML = '';
  const statusMap = {
    L0: { ok: agents.length > 0, txt: `可起草任务草稿（${agents.length} 个岗位；外部工具受控执行待补）` },
    L1: { ok: agents.length > 0, txt: `岗位契约已可创建（${agents.length} 个；真实身份鉴权待补）` },
    L2: { ok: true, txt: `状态机与人工验收（${(state.tasks || []).length} 个任务）` },
    L3: { ok: false, txt: '部分 API 有硬规则；底层 SDK 工具拦截待补' },
    L4: { ok: false, txt: '对话与审批部分可用；其余交互待补' },
  };
  LAYERS.forEach((l) => {
    const row = document.createElement('div');
    row.className = 'layer-row';
    const s = statusMap[l.id];
    row.innerHTML = `
      <div class="layer-id">${l.id}</div>
      <div class="layer-name">${l.name}</div>
      <div class="layer-desc">${l.desc}</div>
      <div class="layer-status ${s.ok ? 'ok' : 'warn'}">${s.ok ? '●' : '○'} ${s.txt}</div>`;
    map.appendChild(row);
  });

  // 企业概览
  const brief = $('#org-brief');
  brief.innerHTML = `
    <div class="brief-card">
      <div class="brief-title">${team.name || '团队'}</div>
      <div class="kv"><span>企业</span><b>${currentTenant}</b></div>
      <div class="kv"><span>人</span><b>${humans.length}</b></div>
      <div class="kv"><span>硅基同事</span><b>${agents.length}</b></div>
      <div class="kv"><span>任务</span><b>${(state.tasks || []).length}</b></div>
      <div class="kv"><span>可切换企业</span><b>${tenants.length}</b></div>
    </div>`;
}

// ---- 契约 ----
async function loadContractList() {
  const res = await fetch(q('/api/contracts'));
  const { contracts } = await res.json();
  const list = $('#contract-list');
  list.innerHTML = '';
  contracts.forEach((name) => {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.textContent = name;
    item.addEventListener('click', () => loadContract(name));
    list.appendChild(item);
  });
}

async function loadContract(name) {
  const res = await fetch(q('/api/contracts/' + encodeURIComponent(name)));
  const data = await res.json();
  $('#current-file').textContent = data.name;
  $('#yaml-editor').value = data.yaml;
  $('#save-status').textContent = '';
}

$('#save-btn').addEventListener('click', async () => {
  const name = $('#current-file').textContent;
  if (!name || name === '—') return;
  const res = await fetch(q('/api/contracts/' + encodeURIComponent(name)), {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: $('#yaml-editor').value,
  });
  const data = await res.json();
  const st = $('#save-status');
  if (data.ok) { st.textContent = '✅ 已保存 ' + name; st.className = 'status ok'; }
  else { st.textContent = '❌ ' + (data.error || '保存失败'); st.className = 'status err'; }
});

// ---- 编译 / 运行 ----
$('#compile-btn').addEventListener('click', async () => {
  const out = $('#compile-output');
  out.textContent = '编译中…';
  const res = await fetch(q('/api/compile'), { method: 'POST' });
  out.textContent = JSON.stringify(await res.json(), null, 2);
});

// ---- 团队 ----
async function loadTeam() {
  const res = await fetch(q('/api/state'));
  const state = await res.json();
  const team = state.team || {};
  $('#team-title').textContent = `${team.name || '团队'} · 共治 Leader（人 + Agent）`;
  const roster = $('#team-roster');
  roster.innerHTML = '';
  const leader = team.leader || {};
  roster.appendChild(mkCard('leader', '经营总管 · 管理入口', [
    ['人类负责人', leader.human], ['总管标识', leader.agent],
  ]));
  (team.members || []).forEach((m) => {
    const isAgent = m.type === 'agent';
    const kvs = isAgent ? [['员工 ID', m.subject.slice('agent:'.length)]] : [['主体', m.subject]];
    if (isAgent) kvs.push(['自治等级', m.autonomy]);
    if (isAgent && m.owner) kvs.push(['负责人', m.owner]);
    if (isAgent && m.supervisor) kvs.push(['监督人', m.supervisor]);
    if (isAgent && m.acceptor) kvs.push(['验收人', m.acceptor]);
    kvs.push(['状态', m.status]);
    roster.appendChild(mkCard(isAgent ? 'agent' : 'human', (isAgent ? '🤖 ' : '🧑 ') + m.role, kvs));
  });
  if (!(team.members || []).length) {
    roster.appendChild(mkCard('', '空白空间', [['提示', '去「建岗位」添加第一个硅基同事']]));
  }
}

function mkCard(kind, title, kvs) {
  const card = document.createElement('div');
  card.className = 'card ' + kind;
  let html = `<div class="card-title">${escapeHtml(title)}</div>`;
  kvs.forEach(([k, v]) => { html += `<div class="kv"><span>${escapeHtml(k)}</span><b>${escapeHtml(v || '—')}</b></div>`; });
  card.innerHTML = html;
  return card;
}

// ---- 任务板（含状态流转）----
const TASK_FLOW = { pending: 'in_progress', in_progress: 'waiting', waiting: 'completed', completed: null, rejected: 'pending' };
const TASK_LABEL = { pending: '⬜ 新建', in_progress: '⏳ 处理中', waiting: '⏸️ 待审批', completed: '✅ 完成', rejected: '❌ 退回' };

async function loadTasks() {
  const res = await fetch(q('/api/state'));
  const state = await res.json();
  const board = $('#task-board');
  board.innerHTML = '';
  const tasks = state.tasks || [];
  const agentsById = new Map((state.team?.members || []).filter((m) => m.type === 'agent').map((m) => [m.subject.slice('agent:'.length), m]));
  currentManager = state.team?.leader?.human || 'local-operator';
  const ownerSelect = $('#task-owner');
  const selectedOwner = ownerSelect.value;
  ownerSelect.innerHTML = '';
  (state.team?.members || []).filter((m) => m.type === 'agent').forEach((m) => {
    const option = document.createElement('option');
    option.value = m.subject.slice('agent:'.length);
    option.textContent = `${m.role} · ${option.value}（${m.autonomy}）`;
    option.dataset.acceptor = m.acceptor || '';
    ownerSelect.appendChild(option);
  });
  if ([...ownerSelect.options].some((o) => o.value === selectedOwner)) ownerSelect.value = selectedOwner;
  if (!tasks.length) {
    board.innerHTML = '<div class="card"><div class="card-title">暂无任务</div></div>';
    return;
  }
  tasks.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'task-row';
    const next = TASK_FLOW[t.status];
    row.innerHTML = `
      <div class="task-status">${escapeHtml(TASK_LABEL[t.status] || t.status)}</div>
      <div class="task-body">
        <div class="task-subject">${escapeHtml(t.id)} · ${escapeHtml(t.subject)}</div>
        <div class="task-meta"><span class="tag">${escapeHtml(t.autonomy === 'human' ? '人' : t.autonomy)}</span><span>执行员工：${escapeHtml(agentsById.get(t.owner)?.role || t.owner)} · ID ${escapeHtml(t.owner)}</span><span>验收人：${escapeHtml(t.done_criteria?.by || '待定')}</span></div>
        ${t.context ? `<div class="task-context">已知信息：${escapeHtml(t.context)}</div>` : ''}
        ${t.draft ? `<div class="task-draft"><b>AI 草稿（尚未发送）</b><pre>${escapeHtml(t.draft)}</pre></div>` : ''}
      </div>`;
    if (t.execution_mode === 'draft_only' && t.status === 'pending') {
      const btn = document.createElement('button');
      btn.className = 'primary small';
      btn.textContent = '让 AI 起草';
      btn.addEventListener('click', () => runTask(t.id, btn));
      row.appendChild(btn);
    } else if (t.execution_mode === 'draft_only' && t.status === 'waiting') {
      if (t.done_criteria?.by === currentManager) {
        const accept = document.createElement('button');
        accept.className = 'primary small';
        accept.textContent = '验收通过';
        accept.addEventListener('click', () => reviewTask(t, true));
        row.appendChild(accept);
        const reject = document.createElement('button');
        reject.className = 'ghost small';
        reject.textContent = '退回';
        reject.addEventListener('click', () => reviewTask(t, false));
        row.appendChild(reject);
      } else {
        const note = document.createElement('span');
        note.className = 'task-review-note';
        note.textContent = `待「${t.done_criteria?.by || '指定验收人'}」验收；当前演示未提供身份登录`;
        row.appendChild(note);
      }
    } else if (next && t.execution_mode !== 'draft_only') {
      const btn = document.createElement('button');
      btn.className = 'ghost small';
      btn.textContent = '推进 →';
      btn.addEventListener('click', () => transitionTask(t.id, next));
      row.appendChild(btn);
    }
    board.appendChild(row);
  });
}

$('#task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('#task-form-status');
  const body = { owner: $('#task-owner').value, subject: $('#task-subject').value.trim(), context: $('#task-context').value.trim(), done_criteria: { by: $('#task-owner').selectedOptions[0]?.dataset.acceptor || currentManager, criteria: [$('#task-criterion').value.trim()] }, boundary_confirmed: $('#task-boundary').checked };
  if (!body.owner) { status.textContent = '请先创建 AI 员工'; return; }
  const res = await fetch(q('/api/tasks'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  status.textContent = res.ok ? '✅ 任务已创建。点击下方「让 AI 起草」。' : `❌ ${data.error}`;
  status.className = res.ok ? 'status ok' : 'status err';
  if (res.ok) { e.target.reset(); loadTasks(); }
});

async function runTask(id, button) {
  button.disabled = true;
  button.textContent = '起草中…';
  try {
    const res = await fetch(q(`/api/tasks/${id}/run`), { method: 'POST' });
    const data = await res.json();
    if (!res.ok) alert(data.error || '执行失败');
    loadTasks();
  } catch (error) { alert('执行失败：' + error.message); button.disabled = false; button.textContent = '让 AI 起草'; }
}

async function reviewTask(task, accepted) {
  const criteria = Array.isArray(task.done_criteria) ? task.done_criteria : task.done_criteria?.criteria || [];
  if (accepted && !confirm('你已阅读草稿并核对完成标准，确认验收通过？')) return;
  const feedback = accepted ? '人工已核对草稿' : prompt('请写下退回原因，供后续修改参考：');
  if (!accepted && !feedback?.trim()) return;
  const evidence = accepted ? Object.fromEntries(criteria.map((criterion) => [criterion, `${feedback}：${task.draft.slice(0, 300)}`])) : undefined;
  const res = await fetch(q(`/api/tasks/${task.id}/transition`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: accepted ? 'completed' : 'rejected', evidence, feedback, actor: { id: currentManager, type: 'human' } }) });
  if (!res.ok) alert((await res.json()).error || '验收失败');
  loadTasks();
}

async function transitionTask(id, to) {
  const task = (await (await fetch(q('/api/state'))).json()).tasks.find((x) => x.id === id);
  let evidence;
  if (to === 'completed') {
    const criteria = Array.isArray(task.done_criteria) ? task.done_criteria : (task.done_criteria || {}).criteria || [];
    if (!criteria.length) { alert('任务缺少完成标准，请先在 state.json 中补齐 done_criteria。'); return; }
    evidence = {};
    for (const criterion of criteria) {
      const value = prompt(`请提供验收证据：${criterion}`);
      if (!value || !value.trim()) return;
      evidence[criterion] = value.trim();
    }
  }
  const res = await fetch(q(`/api/tasks/${id}/transition`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, evidence, actor: { id: 'local-operator', type: 'human' } }) });
  if (!res.ok) alert((await res.json()).error || '任务推进失败');
  loadTasks();
}

$('#reset-tasks-btn').addEventListener('click', async () => {
  await fetch(q('/api/tasks/reset'), { method: 'POST' });
  loadTasks();
});

// ---- 对齐校验（L3）----
$('#align-btn').addEventListener('click', async () => {
  const box = $('#align-result');
  box.textContent = '校验中…';
  const res = await fetch(q('/api/align'), { method: 'POST' });
  const data = await res.json();
  box.innerHTML = '';
  box.innerHTML = `<div class="align-summary ${data.passed ? 'ok' : 'warn'}">${data.passed ? '✅ 全部通过' : `⚠️ ${data.failed}/${data.total} 项未通过`}</div>`;
  (data.checks || []).forEach((c) => {
    const row = document.createElement('div');
    row.className = 'align-row ' + (c.pass ? 'ok' : 'warn');
    row.innerHTML = `<span class="align-icon">${c.pass ? '✅' : '⚠️'}</span><span class="align-rule">${c.rule}</span><span class="align-detail">${c.detail}</span>`;
    box.appendChild(row);
  });
});

// ---- 对话（Concierge Agent）----
let studioMode = 'agent';
function storedStudio(key, fallback) { try { return JSON.parse(sessionStorage.getItem(key)) || fallback; } catch { return fallback; } }
const studioSessions = storedStudio('studio-sessions', { agent: null, workflow: null });
const studioLogs = storedStudio('studio-logs', { agent: [], workflow: [] });
const studioPhases = storedStudio('studio-phases', { agent: 'intro', workflow: 'intro' });
let chatLog = studioLogs.agent;
function saveStudioClient() {
  sessionStorage.setItem('studio-sessions', JSON.stringify(studioSessions));
  sessionStorage.setItem('studio-logs', JSON.stringify(studioLogs));
  sessionStorage.setItem('studio-phases', JSON.stringify(studioPhases));
}
function renderConversationScope() {
  const name = tenantDetails.find((item) => item.id === currentTenant)?.name || currentTenant || '未选择';
  $('#chat-tenant-name').textContent = name;
  const firstGoal = (studioLogs[studioMode] || []).find((item) => item.role === 'user')?.text;
  $('#chat-goal-title').textContent = firstGoal ? firstGoal.slice(0, 60) : '新目标';
}
async function loadConversationHistory() {
  const tenantAtRequest = currentTenant;
  const select = $('#chat-history');
  try {
    const response = await fetch(q('/api/studio/sessions'));
    if (!response.ok || tenantAtRequest !== currentTenant) return;
    const data = await response.json();
    select.replaceChildren(new Option('选择一段对话', ''));
    (data.sessions || []).forEach((session) => select.add(new Option(`${session.mode === 'agent' ? 'Agent' : 'Workflow'} · ${session.title}`, session.id)));
  } catch { select.replaceChildren(new Option('历史对话暂不可用', '')); }
}
function setStudioMode(mode) {
  studioMode = mode;
  chatLog = studioLogs[mode];
  $('#mode-agent').classList.toggle('active', mode === 'agent');
  $('#mode-workflow').classList.toggle('active', mode === 'workflow');
  $('#mode-agent').setAttribute('aria-pressed', String(mode === 'agent'));
  $('#mode-workflow').setAttribute('aria-pressed', String(mode === 'workflow'));
  $('#studio-explanation').textContent = mode === 'agent'
    ? '沿用现有团队，关键操作会请你确认。'
    : '按阶段推进，关键操作会请你确认。';
  renderStudioProgress();
  renderChat();
  renderConversationScope();
}
function renderStudioProgress() {
  const box = $('#studio-progress');
  if (studioMode === 'agent') { box.textContent = ''; box.hidden = true; return; }
  box.hidden = false;
  const phase = studioPhases.workflow;
  const index = phase.startsWith('company') || phase === 'intro' ? 0 : phase.startsWith('role') ? 1 : phase.startsWith('task') ? 2 : phase === 'ready' ? 3 : 4;
  box.innerHTML = ['公司', '员工', '任务', '执行', '验收'].map((name, i) => `<span class="${i === index ? 'current' : i < index ? 'done' : ''}">${i + 1} ${name}</span>`).join('');
}
$('#mode-agent').addEventListener('click', () => setStudioMode('agent'));
$('#mode-workflow').addEventListener('click', () => setStudioMode('workflow'));
document.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => {
  $('#chat-input').value = button.dataset.prompt;
  $('#chat-input').focus();
}));
$('#chat-new').addEventListener('click', () => {
  studioSessions[studioMode] = null;
  studioLogs[studioMode] = [];
  chatLog = studioLogs[studioMode];
  studioPhases[studioMode] = 'intro';
  saveStudioClient();
  renderStudioProgress();
  renderChat();
  renderConversationScope();
  loadConversationHistory();
});
$('#chat-history-open').addEventListener('click', async () => {
  const id = $('#chat-history').value;
  if (!id) return;
  const tenantAtRequest = currentTenant;
  const response = await fetch(q(`/api/studio/sessions/${encodeURIComponent(id)}`));
  const data = await response.json();
  if (tenantAtRequest !== currentTenant) return;
  if (!response.ok) { alert(data.error || '打开对话失败'); return; }
  studioSessions[data.mode] = data.id;
  studioPhases[data.mode] = data.phase || 'intro';
  studioLogs[data.mode] = data.transcript.map((entry) => ({ role: entry.role === 'user' ? 'user' : 'agent', text: entry.text }));
  saveStudioClient();
  setStudioMode(data.mode);
});
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function renderChat() {
  renderConversationScope();
  const box = $('#chat-log');
  box.innerHTML = '';
  if (!chatLog.length) {
    box.innerHTML = studioMode === 'agent'
      ? '<div class="chat-empty"><span class="empty-icon">✳</span><strong>为当前经营空间开启一个目标</strong><p>可以创建员工或任务。任务归属、执行员工和完成标准会在创建前请你确认。</p></div>'
      : '<div class="chat-empty"><span class="empty-icon">⌘</span><strong>从你的第一个想法开始</strong><p>比如说“我想办一个周末读书会”，我会从建立公司开始，逐步引导你完成。</p></div>';
    return;
  }
  chatLog.forEach((m) => {
    const div = document.createElement('div');
    div.className = 'chat-msg ' + m.role;
    if (m.role === 'user') {
      div.textContent = m.text;
    } else {
      div.innerHTML = `<span class="message-author">经营总管 · 共创助手</span>${escapeHtml(m.text).replace(/\n/g, '<br/>')}`;
      if (m.steps && m.steps.length) {
        const trace = document.createElement('div');
        trace.className = 'chat-trace';
        m.steps.forEach((s) => {
          const line = document.createElement('div');
          line.className = 'chat-step';
          line.textContent = `🔧 ${s.tool}(${JSON.stringify(s.args)}) → ${JSON.stringify(s.result).slice(0, 100)}`;
          trace.appendChild(line);
        });
        div.appendChild(trace);
      }
    }
    box.appendChild(div);
  });
  box.scrollTop = box.scrollHeight;
}

async function sendChat() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  const mode = studioMode;
  const log = studioLogs[mode];
  input.value = '';
  log.push({ role: 'user', text });
  renderChat();
  log.push({ role: 'agent', text: '思考中…', steps: [] });
  renderChat();
  $('#chat-send').disabled = true;
  try {
    const res = await fetch('/api/studio/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, session_id: studioSessions[mode], tenant: currentTenant, message: text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '请求失败');
    studioSessions[mode] = data.session_id;
    studioPhases[mode] = data.phase;
    log[log.length - 1] = { role: 'agent', text: data.reply || data.error || '（无回复）', steps: data.steps || [] };
    saveStudioClient();
    renderStudioProgress();
    renderChat();
    loadConversationHistory();
    if (data.tenant && data.tenant !== currentTenant) {
      currentTenant = data.tenant;
      localStorage.setItem('enterprise-os-tenant', currentTenant);
      await loadTenants();
    }
    refreshAll();
  } catch (e) {
    log[log.length - 1] = { role: 'agent', text: '❌ 请求失败：' + e.message, steps: [] };
    saveStudioClient();
    renderChat();
  } finally { $('#chat-send').disabled = false; }
}

$('#chat-send').addEventListener('click', sendChat);
$('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

// ---- 统一刷新 ----
function refreshAll() {
  loadOverview();
  loadContractList();
  loadTeam();
  loadTasks();
}

// 初始加载
(async () => {
  await loadTenants();
  await loadTemplates();
  setStudioMode('agent');
  refreshAll();
})();
