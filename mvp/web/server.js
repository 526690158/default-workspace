// 企业操作系统 —— Web 控制面 后端（多租户版）
// 租户目录：mvp/tenants/<tenantId>/control-plane/*.yaml + state.json
const http = require('http');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { compile, listTenants, getTeamView } = require('./compiler/compile.js');
const crypto = require('crypto');
const { appendAudit, readAudit, verifyAudit, doneCheck, evaluateAction, criteriaOf } = require('./governance.js');

const ROOT = __dirname;
const TENANTS_ROOT = process.env.TENANTS_ROOT || path.join(ROOT, '..', 'tenants');
const PUBLIC = path.join(ROOT, 'public');
const STUDIO_ROOT = process.env.STUDIO_SESSIONS_ROOT || path.join(ROOT, '..', 'studio-sessions');
const PORT = process.env.PORT || 8091;

function send(res, code, body, type = 'application/json') {
  const data = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
  });
}

function cpDir(tenantId) {
  return path.join(TENANTS_ROOT, tenantId, 'control-plane');
}
function stateFile(tenantId) {
  return path.join(TENANTS_ROOT, tenantId, 'state.json');
}

function listContractFiles(tenantId) {
  const dir = cpDir(tenantId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort();
}

function tenantInfo(tenantId) {
  const file = listContractFiles(tenantId).find((name) => name.startsWith('tenant.'));
  if (!file) return { id: tenantId, name: tenantId };
  const tenant = yaml.load(fs.readFileSync(path.join(cpDir(tenantId), file), 'utf8'))?.tenant || {};
  return { id: tenantId, name: String(tenant.name || tenantId) };
}

function readState(tenantId) {
  const f = stateFile(tenantId);
  if (!fs.existsSync(f)) return { team: {}, tasks: [] };
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function tenantDir(tenantId) { return path.join(TENANTS_ROOT, tenantId); }
function actorOf(body, fallback = 'local-operator') {
  return body && body.actor && body.actor.id ? body.actor : { id: fallback, type: 'human' };
}
function logAction(tenant, action, actor, input, output, approvalBy = null) {
  return appendAudit(tenantDir(tenant), { actor, action, input, output, approvalBy });
}
function decisionStatus(decision) { return decision.decision === 'approval_required' ? 403 : 400; }

function createTenant(form) {
  const id = String(form.id || '').trim();
  const name = String(form.name || '').trim();
  const manager = String(form.manager || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(id)) return { error: '公司 ID 须为 3–40 位小写字母、数字或连字符，首尾不能是连字符' };
  if (!name || !manager) return { error: '请填写公司名称和负责人' };
  if (!form.boundary_confirmed) return { error: '请先确认数据与风险边界' };
  const dir = tenantDir(id);
  if (fs.existsSync(dir)) return { error: '公司 ID 已存在' };
  const cp = path.join(dir, 'control-plane');
  fs.mkdirSync(cp, { recursive: true });
  const tenantDoc = { tenant: { id, name, isolation: { mode: 'process', workspace_root: path.join(dir, 'workspace'), upgrade_path: ['process', 'container'] }, identity_domain: { idp: 'local' }, quota: { max_agents: 6, max_concurrent_tasks: 20 }, compliance: { data_residency: 'local', retention_days: 365 }, audit: { full_trace: true } } };
  const teamDoc = { team: { id: 'main', name: `${name}团队`, tenant: id, leader: { mode: 'co_governance', human: manager, agent: 'concierge', decision_protocol: { 'L0-L2': 'human_approves', L3: 'human_co_signs', L4: 'human_decides' } }, members: [{ subject: `human:${manager}`, role: manager }], task_board: { handoff_allowed: true } } };
  const policy = yaml.load(fs.readFileSync(path.join(ROOT, 'templates', 'autonomy-policy.default-enterprise.yaml'), 'utf8'));
  fs.writeFileSync(path.join(cp, `tenant.${id}.yaml`), yaml.dump(tenantDoc, { lineWidth: -1 }));
  fs.writeFileSync(path.join(cp, 'team.main.yaml'), yaml.dump(teamDoc, { lineWidth: -1 }));
  fs.writeFileSync(path.join(cp, 'autonomy-policy.default-enterprise.yaml'), yaml.dump(policy, { lineWidth: -1 }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ team: { id: 'main', name: teamDoc.team.name }, tasks: [], approvals: [] }, null, 2));
  logAction(id, 'tenant.create', { id: manager, type: 'human' }, { id, name, manager, boundary_confirmed: true }, { ok: true });
  return { ok: true, id, name };
}

// 岗位模板库：角色 → 推荐自治等级（含推荐理由）
const ROLE_TEMPLATES = [
  { role: '活动文案助理', capability: '活动通知起草', autonomy: 'L1', reason: '只起草文案，由人核对、发送',
    purpose: '根据已提供的活动信息起草清楚、友好的通知文案',
    non_purpose: '不得编造时间地点；不得自行发送消息、发布内容或承诺费用',
    tools: [] },
  { role: '采购员', capability: '采购寻源', autonomy: 'L2', reason: '涉及金额与供应商选择，需人审批',
    purpose: '询价比价、生成采购建议与采购订单草稿',
    non_purpose: '不得签合同、不得付款、不得改供应商准入名单',
    tools: ['erp.read', 'erp.po.create', 'web.search'] },
  { role: '库存管理员', capability: '库存监控与补货', autonomy: 'L3', reason: '阈值内自动补货属低风险，可让 AI 有界自动执行、人会签',
    purpose: '监控库存水位，低于阈值生成补货信号并在边界内自动补货',
    non_purpose: '不得采购新品类、不得超预算、不得换供应商',
    tools: ['erp.inventory.read', 'report.generate'] },
  { role: '客服专员', capability: '客户咨询', autonomy: 'L2', reason: '回复涉及对客户的承诺，需人审批',
    purpose: '回答客户咨询、记录工单、生成回复草稿',
    non_purpose: '不得退款、不得私自改价、不得承诺无法兑现的事',
    tools: ['crm.read', 'web.search'] },
  { role: '财务对账员', capability: '对账结算', autonomy: 'L3', reason: '对账规则明确，可自动执行，差异自动转人',
    purpose: '自动对账、生成差异报告',
    non_purpose: '不得改动账目、不得对外付款',
    tools: ['erp.read', 'report.generate'] },
  { role: '物流调度员', capability: '运输调度', autonomy: 'L3', reason: '排车/路线优化属边界内可自动执行',
    purpose: '安排车辆、优化路线、跟踪运单',
    non_purpose: '不得擅自加价、不得改合同条款',
    tools: ['crm.read', 'report.generate'] },
  { role: '销售助理', capability: '销售线索跟进', autonomy: 'L2', reason: '报价与承诺需人审批',
    purpose: '跟进线索、整理客户信息、生成报价草稿',
    non_purpose: '不得直接签约、不得给最终折扣承诺',
    tools: ['crm.read', 'web.search'] },
  { role: '合规巡检员', capability: '合规审计', autonomy: 'L1', reason: '只读留痕，最终由人签字',
    purpose: '巡检留痕、生成合规报告',
    non_purpose: '不得自行定性违规、不得修改记录',
    tools: ['erp.read', 'report.generate'] },
];

// 从表单数据生成一份 ACC YAML 并追加进团队 members
function createAgent(tenantId, form) {
  if (!form || typeof form !== 'object' || typeof form.role !== 'string' || !form.role.trim()) return { error: '需要岗位名称 role' };
  if (!String(form.owner || '').trim() || !String(form.non_purpose || '').trim() || !String(form.supervisor || '').trim() || !String(form.acceptor || '').trim()) return { error: '需要负责人、监督人、禁止事项和验收人' };
  if (!form.boundary_confirmed) return { error: '请先确认岗位职责、工具和风险边界' };
  const dir = cpDir(tenantId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const slug = String(form.capability || form.role || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const id = String(form.id || '').replace(/[^a-zA-Z0-9_-]/g, '') || slug || ('agent-' + crypto.randomUUID().slice(0, 8));
  const autonomy = ['L0', 'L1', 'L2', 'L3', 'L4'].includes(form.autonomy) ? form.autonomy : 'L2';
  const tools = (Array.isArray(form.tools) ? form.tools : []).filter((t) => typeof t === 'string').map((t) => ({ name: t }));

  const acc = {
    acc: {
      id,
      version: '0.1.0',
      type: 'agent',
      capability: form.capability || form.role || '自定义能力',
      identity: { account: id },
      owner: { team: 'auto', human_owner: form.owner || '待定', agent_owner: 'lead' },
      responsibility: { accountable_to: form.accountable_to || form.owner || '待定', audit: 'full' },
      purpose: form.purpose || '',
      non_purpose: form.non_purpose || '',
      autonomy: { level: autonomy, policy: 'default-enterprise' },
      tools: { allow: tools, deny: [] },
      data_scope: [],
      memory: { short_term: 'session', long_term: { write: false, retention_days: 90 } },
      verification: { oracles: [], accuracy_threshold: 0.9 },
      supervision: { supervisor: form.supervisor || '待定', mode: 'periodic' },
      acceptance: { by: form.acceptor || '待定', criteria: [] },
      human_interaction: { ambiguity: 'escalate', risk_level_above: 'L2' },
      observability: { audit: 'full' },
    },
  };
  const accFile = path.join(dir, `acc.${id}.yaml`);
  if (fs.existsSync(accFile)) return { error: `岗位 ${id} 已存在` };
  fs.writeFileSync(accFile, yaml.dump(acc, { lineWidth: -1 }));

  // 追加进 team.yaml 的 members
  const teamTarget = listContractFiles(tenantId).find((f) => f.startsWith('team.'));
  const tf = path.join(dir, teamTarget || 'team.auto.yaml');
  let team = {};
  if (fs.existsSync(tf)) team = yaml.load(fs.readFileSync(tf, 'utf8')) || {};
  team.team = team.team || { members: [] };
  team.team.members = team.team.members || [];
  team.team.members.push({ subject: `agent:${id}`, role: form.role || id, acc: id });
  fs.writeFileSync(tf, yaml.dump(team, { lineWidth: -1 }));

  return { ok: true, accFile: `acc.${id}.yaml`, id, autonomy };
}

// 更新岗位（如改自治等级）
function updateAgent(tenantId, id, patch) {
  if (patch.autonomy && !['L0', 'L1', 'L2', 'L3', 'L4'].includes(patch.autonomy)) return { error: '自治等级无效' };
  const dir = cpDir(tenantId);
  const files = listContractFiles(tenantId).filter((f) => f.startsWith('acc.'));
  let target = null;
  for (const f of files) {
    const obj = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8')) || {};
    if (obj.acc && obj.acc.id === id) { target = { file: f, obj }; break; }
  }
  if (!target) return { error: `未找到岗位 ${id}` };
  const acc = target.obj.acc;
  acc.identity = acc.identity || { account: id };
  acc.responsibility = acc.responsibility || { accountable_to: acc.owner?.human_owner || '待定', audit: 'full' };
  if (patch.autonomy && ['L0', 'L1', 'L2', 'L3', 'L4'].includes(patch.autonomy)) {
    acc.autonomy = acc.autonomy || {};
    acc.autonomy.level = patch.autonomy;
  }
  if (patch.purpose) acc.purpose = patch.purpose;
  if (patch.non_purpose) acc.non_purpose = patch.non_purpose;
  if (patch.owner) { acc.owner = acc.owner || {}; acc.owner.human_owner = patch.owner; }
  if (patch.accountable_to) { acc.responsibility = acc.responsibility || {}; acc.responsibility.accountable_to = patch.accountable_to; }
  fs.writeFileSync(path.join(dir, target.file), yaml.dump(target.obj, { lineWidth: -1 }));
  return { ok: true, id, autonomy: acc.autonomy ? acc.autonomy.level : null };
}

// ---- Concierge Agent（经营总管）：LLM 函数调用 loop ----
const CONCIERGE_SYSTEM = `你是「企业数字经营空间」的 Concierge Agent（经营总管），一个管理操作型 AI Agent。
你的职责：把人（管理者）的自然语言目标，规划成使用已有公司、创建公司、匹配员工、必要时创建岗位、创建任务和执行等操作。你能跨多轮记住上下文，不要把用户当成在填表。默认沿用当前选中的公司；只有用户明确要求新建公司时才创建。先查询团队，优先匹配已有员工；能力缺口再建议新建岗位。缺少公司名、负责人或岗位责任关系时询问，不得编造姓名或把公司负责人自动填成所有岗位的监督人、验收人。
你有以下工具：
- create_company：建立新的公司空间。
- create_role：创建/招聘一个硅基同事（岗位）。参数：role(岗位名)、capability(能力)、autonomy(自治等级 L0-L4)、purpose(职责)、non_purpose(边界)、owner(负责人)、supervisor(监督人)、acceptor(验收人)、tools(工具数组)。
- update_role：更新一个已有岗位。参数：id(岗位id)、autonomy(新自治等级)、purpose、owner。
- query_team：查询当前团队（有谁、各自自治等级、任务数）。
- create_task：创建一个由员工执行的任务，必须有目标、负责人和完成标准，只生成草稿。
- run_task：让员工执行指定任务，产出草稿并等待人验收。
规则：
0. 当前对话只属于一个经营空间。新目标可以另建任务，但不能把旧目标的事实带入新任务；若新目标与空间明显无关，先询问它是否仍归属该空间，确认后再创建岗位或任务。
1. 能直接用工具完成就调用，不要反复追问。
2. 创建岗位必须明确负责人、监督人、验收人、禁止事项；缺少这些信息时先问清楚。用户还须在界面勾选边界确认。
3. 完成后用简洁中文汇报做了什么。
4. 你是经营总管，不是执行任务的员工。每个员工由岗位和独立 ID 标识；派任务前先确认目标员工 ID。同名岗位有多位员工时，必须询问用户要选哪一个，不能猜测。
5. 不要臆造。`;

const CONCIERGE_TOOLS = [
  { type: 'function', function: { name: 'create_company', description: '创建公司空间。先收集公司名称和人类负责人；工具会要求用户确认演示数据边界。', parameters: { type: 'object', properties: { name: { type: 'string' }, manager: { type: 'string' } }, required: ['name', 'manager'] } } },
  {
    type: 'function',
    function: {
      name: 'create_role',
      description: '创建/招聘一个硅基同事（岗位）',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', description: '岗位名称，如 采购员' },
          capability: { type: 'string', description: '能力描述' },
          autonomy: { type: 'string', enum: ['L0', 'L1', 'L2', 'L3', 'L4'], description: '自治等级' },
          purpose: { type: 'string', description: '职责' },
          non_purpose: { type: 'string', description: '边界（不能做什么）' },
          owner: { type: 'string', description: '负责人' },
          supervisor: { type: 'string', description: '监督人' },
          acceptor: { type: 'string', description: '验收人' },
          tools: { type: 'array', items: { type: 'string' }, description: '技能/工具' },
        },
        required: ['role', 'owner', 'supervisor', 'acceptor', 'non_purpose'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_role',
      description: '更新一个已有岗位（如改自治等级）',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '岗位 id（如 procurement-agent）' },
          autonomy: { type: 'string', enum: ['L0', 'L1', 'L2', 'L3', 'L4'] },
          purpose: { type: 'string' },
          owner: { type: 'string' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_team',
      description: '查询当前团队（成员、自治等级、任务数）',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  { type: 'function', function: { name: 'create_task', description: '给本公司指定 AI 员工创建只起草、不对外发送的任务。必须使用 query_team 返回的准确员工 ID；同名岗位有多人时先让用户选定。', parameters: { type: 'object', properties: { subject: { type: 'string' }, owner: { type: 'string', description: '准确的员工 ID，不是岗位名或经营总管名称' }, context: { type: 'string' }, criterion: { type: 'string', description: '可核对的完成标准' } }, required: ['subject', 'owner', 'criterion'] } } },
  { type: 'function', function: { name: 'run_task', description: '执行已创建任务，产生草稿并等待人工验收', parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } } },
];

async function callLocalModel(messages, tools) {
  const base = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  const url = new URL('/v1/chat/completions', base);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('只允许连接本机 Ollama，避免调用付费远程 API');
  const model = process.env.OLLAMA_MODEL || 'qwen3:4b-instruct';
  if (/(?:-|:)cloud$/i.test(model)) throw new Error('云端模型可能收费，请选择已下载的本地 Ollama 模型');
  const body = { model, messages, temperature: 0.2, max_tokens: 1024 };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
  let resp;
  try { resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  }); } catch (error) { throw new Error(`本地 Ollama 未连接：${error.message}。请运行 ollama serve`); }
  if (!resp.ok) throw new Error(`本地模型调用失败 ${resp.status}：${(await resp.text()).slice(0, 200)}。请确认已安装 ${body.model}`);
  return resp.json();
}

const runningTasks = new Set();
function createTask(tenant, body) {
  const actor = actorOf(body);
  const st = readState(tenant);
  const criteria = Array.isArray(body.done_criteria) ? body.done_criteria : body.done_criteria?.criteria;
  if (typeof body.subject !== 'string' || !body.subject.trim() || typeof body.owner !== 'string' || !body.owner.trim() || !Array.isArray(criteria) || !criteria.length || criteria.some((x) => typeof x !== 'string' || !x.trim())) return { status: 400, error: '需要 subject、owner 和非空 done_criteria' };
  const decision = evaluateAction({ action: 'task.create', actor });
  if (decision.decision !== 'allow') return { status: decisionStatus(decision), ...auditDenied(tenant, 'task.create', actor, body, decision) };
  const member = getTeamView(tenant).members.find((m) => m.subject === `agent:${body.owner}`);
  if (!member) return { status: 400, error: '请选择本公司的硅基员工' };
  if (member.acceptor && member.acceptor !== '待定' && body.done_criteria?.by !== member.acceptor) return { status: 400, error: `该岗位的验收人是「${member.acceptor}」，任务不能指定其他人代验收` };
  if (!body.boundary_confirmed) return { status: 400, error: '请确认任务只生成草稿、不自动对外发送' };
  const task = { id: crypto.randomUUID(), tenant, source_session_id: body.source_session_id || null, subject: body.subject.trim(), context: String(body.context || '').trim(), owner: body.owner.trim(), autonomy: member.autonomy, execution_mode: 'draft_only', status: 'pending', done_criteria: { by: body.done_criteria?.by || actor.id, criteria }, handoff: { allowed: true } };
  st.tasks = st.tasks || [];
  st.tasks.push(task);
  writeState(tenant, st);
  logAction(tenant, 'task.create', actor, body, { task });
  return { status: 201, ok: true, task };
}
async function executeDraftTask(tenantId, taskId) {
  const lock = `${tenantId}:${taskId}`;
  if (runningTasks.has(lock)) return { status: 409, error: '任务正在执行' };
  const st = readState(tenantId);
  const task = (st.tasks || []).find((t) => t.id === taskId);
  if (!task) return { status: 404, error: '任务不存在' };
  const guard = evaluateAction({ action: 'task.run', actor: { id: task.owner, type: 'agent' }, task });
  if (guard.decision !== 'allow') {
    auditDenied(tenantId, 'task.run', { id: task.owner, type: 'agent' }, { taskId }, guard);
    return { status: 409, error: guard.reason };
  }
  const accFile = listContractFiles(tenantId).find((f) => {
    if (!f.startsWith('acc.')) return false;
    const obj = yaml.load(fs.readFileSync(path.join(cpDir(tenantId), f), 'utf8'));
    return obj?.acc?.id === task.owner;
  });
  if (!accFile) return { status: 400, error: '任务负责人不是本公司的硅基员工' };
  const acc = yaml.load(fs.readFileSync(path.join(cpDir(tenantId), accFile), 'utf8')).acc;
  runningTasks.add(lock);
  task.status = 'in_progress';
  writeState(tenantId, st);
  logAction(tenantId, 'task.run.start', { id: task.owner, type: 'agent' }, { taskId, subject: task.subject }, { status: 'in_progress' });
  try {
    const system = `你是${acc.capability}岗位的 AI 员工。职责：${acc.purpose || '完成指定起草任务'}。禁止事项：${acc.non_purpose}。只能输出草稿，不能声称已经发送、发布、付款或操作外部系统。遇到缺失的事实要标注待确认，不得编造。`;
    const user = `任务：${task.subject}\n补充说明：${task.context || '无'}\n完成标准：${criteriaOf(task).join('；')}\n请给出可供人验收的草稿。`;
    const response = await callLocalModel([{ role: 'system', content: system }, { role: 'user', content: user }]);
    const draft = response.choices?.[0]?.message?.content;
    if (!draft || typeof draft !== 'string') throw new Error('模型未返回草稿');
    task.draft = draft;
    task.status = 'waiting';
    task.drafted_at = new Date().toISOString();
    writeState(tenantId, st);
    logAction(tenantId, 'task.run.draft', { id: task.owner, type: 'agent' }, { taskId }, { draft, status: 'waiting' });
    return { status: 200, ok: true, task };
  } catch (error) {
    task.status = 'pending';
    writeState(tenantId, st);
    logAction(tenantId, 'task.run.error', { id: task.owner, type: 'agent' }, { taskId }, { error: error.message });
    return { status: 502, error: error.message };
  } finally { runningTasks.delete(lock); }
}

function newCompanyRequested(text) {
  return /(?:创建|新建|建立|成立|开办|注册).{0,20}(?:公司|企业|工作室|经营空间)|(?:公司|企业|工作室).{0,12}(?:创建|新建|建立|成立|开办|注册)/.test(String(text || ''));
}
function userNamedPerson(text, field, name) {
  const value = String(name || '').trim();
  if (!value || value.length > 30 || /^(?:待定|未知|负责人|用户|我|默认)$/.test(value)) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${field}\\s*(?:是|为|由|[:：])?\\s*${escaped}(?=$|[\\s，,。；;、])`).test(String(text || ''));
}
function roleResponsibilityExplicit(session, args) {
  const input = [session.activeGoal, ...(session.transcript || []).filter((entry) => entry.role === 'user').map((entry) => entry.text)].join('\n');
  return userNamedPerson(input, '(?:负责人|负责)', args.owner)
    && userNamedPerson(input, '(?:监督人|监督)', args.supervisor)
    && userNamedPerson(input, '(?:验收人|验收)', args.acceptor);
}
function parseRoleResponsibility(text, manager) {
  const value = String(text || '').trim();
  if (/^(?:都由我负责|均由我负责|我都负责|由我统一负责)[。！!\s]*$/.test(value) && manager) return { owner: manager, supervisor: manager, acceptor: manager };
  const one = value.match(/^(?:都由|均由|统一由)([^，,。；;\s]{2,20})(?:负责|担任)[。！!\s]*$/);
  if (one) return { owner: one[1], supervisor: one[1], acceptor: one[1] };
  const find = (field) => value.match(new RegExp(`${field}\\s*(?:是|为|由|[:：])?\\s*([^，,。；;\\s]{2,20})`))?.[1];
  const owner = find('负责人'), supervisor = find('监督人'), acceptor = find('验收人');
  return owner && supervisor && acceptor ? { owner, supervisor, acceptor } : null;
}

async function executeConciergeTool(session, name, args, boundaryConfirmed = false) {
  const tenantId = session.tenant;
  if (name === 'create_company') {
    if (!newCompanyRequested(session.activeGoal)) return { error: '当前目标没有要求新建公司。请沿用所选企业，先查询团队并规划任务；确需新公司时请用户明确提出。' };
    if (tenantId) return { error: '当前对话已有公司空间；如需新公司，请开始新对话并明确提出。' };
    if (!args.name || !String(session.activeGoal || '').includes(String(args.name))) {
      session.pendingCompanyName = true;
      return { clarification_required: true, message: '可以新建公司。请先告诉我这家公司的名称；我不会替你起一个虚构名称。' };
    }
    if (!userNamedPerson(session.activeGoal, '(?:公司负责人|负责人)', args.manager)) {
      session.pendingCompanyManager = { name: args.name };
      return { clarification_required: true, message: `「${args.name}」由谁负责？请回复真实的负责人姓名或称呼；我不会代填。` };
    }
    session.pendingCompany = { name: args.name, manager: args.manager };
    return { confirmation_required: true, message: `准备创建「${args.name}」，人类负责人「${args.manager}」。请确认只使用演示数据，不放入客户资料或密码。` };
  }
  if (!tenantId) return { error: '请先建立公司空间' };
  if (name === 'create_role') {
    if (!boundaryConfirmed) {
      if (session.mode !== 'agent') return { error: '请先在对话中确认岗位边界' };
      if (!args.role || !args.purpose || !args.non_purpose) return { error: '岗位需要名称、明确职责和禁止事项；请先澄清，不能用“待补”创建。' };
      if (!roleResponsibilityExplicit(session, args)) {
        session.pendingRoleAssignments = args;
        return { clarification_required: true, message: `「${args.role}」的职责是「${args.purpose}」，禁止事项是「${args.non_purpose}」。请指定这个岗位的人类负责人、监督人、验收人；若三者相同，可回复“都由某某负责”，也可回复“负责人小林，监督人老李，验收人王总”。我不会自动把三项都填成同一个人。` };
      }
      session.pendingRole = args;
      return { confirmation_required: true, message: `将创建 AI 岗位「${args.role}」，职责：${args.purpose}；禁止事项：${args.non_purpose}；人类负责人：${args.owner}；人类监督人：${args.supervisor}；人类验收人：${args.acceptor}。请确认岗位边界。` };
    }
    const result = createAgent(tenantId, { ...args, boundary_confirmed: true });
    logAction(tenantId, 'role.create', { id: 'concierge', type: 'agent' }, args, result, session.manager || 'local-operator');
    return result;
  }
  if (name === 'update_role') {
    if (!boundaryConfirmed) {
      if (session.mode !== 'agent') return { error: '请先在对话中确认岗位变更' };
      session.pendingUpdate = args;
      return { confirmation_required: true, message: `将修改岗位 ${args.id} 的契约：${JSON.stringify(args)}。请用户确认变更。` };
    }
    const result = updateAgent(tenantId, args.id, args);
    logAction(tenantId, 'role.update', { id: 'concierge', type: 'agent' }, args, result, session.manager || 'local-operator');
    return result;
  }
  if (name === 'query_team') {
    const tv = getTeamView(tenantId);
    return {
      team: tv.name,
      members: tv.members.map((m) => ({ id: m.type === 'agent' ? m.subject.slice(6) : m.subject, role: m.role, type: m.type, autonomy: m.autonomy, status: m.status })),
    };
  }
  if (name === 'create_task') {
    const assignee = getTeamView(tenantId).members.find((member) => member.type === 'agent' && member.subject === `agent:${args.owner}`);
    if (!assignee) return { error: '找不到该员工 ID；请先查询团队，再选择准确的员工 ID 派活。' };
    if (!boundaryConfirmed) {
      if (session.mode !== 'agent') return { error: '请先在对话中确认任务边界' };
      session.pendingTask = args;
      return { confirmation_required: true, message: `归属经营空间：「${tenantInfo(tenantId).name}」。任务「${args.subject}」将交给「${assignee.role}」（员工 ID：${args.owner}），由「${assignee.acceptor || '待定'}」验收，完成标准为「${args.criterion}」。只生成草稿，不自动发送。请确认经营空间、员工与任务边界。` };
    }
    if (!assignee.acceptor || assignee.acceptor === '待定') return { error: '该员工尚未指定人类验收人，不能创建待验收任务。' };
    return createTask(tenantId, { subject: args.subject, owner: args.owner, context: args.context, source_session_id: session.id, done_criteria: { by: assignee.acceptor, criteria: [args.criterion] }, actor: { id: session.manager || 'local-operator', type: 'human' }, boundary_confirmed: true });
  }
  if (name === 'run_task') {
    const result = await executeDraftTask(tenantId, args.task_id);
    if (result.ok) session.pendingReview = result.task.id;
    return result;
  }
  return { error: '未知工具 ' + name };
}

function approvalFor(st, approvalId, action, input) {
  const record = (st.approvals || []).find((a) => a.id === approvalId);
  return record && record.status === 'approved' && record.action === action && record.inputHash === crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex') ? record : null;
}
function actionDecision(tenant, st, action, actor, input) {
  const approval = approvalFor(st, input.approvalId, action, input.payload);
  const decision = evaluateAction({ action, actor, ...input.payload, approval });
  if (decision.decision === 'approval_required' && approval) return { decision: 'allow', approvalBy: approval.decidedBy, approval };
  return decision;
}
function auditDenied(tenant, action, actor, input, decision) {
  logAction(tenant, action, actor, input, { decision });
  return { error: decision.reason, decision: decision.decision, missing: decision.missing };
}

// 真正 agent loop：LLM 决策 → 调用工具 → 结果回灌 → 直到最终答复
async function runConcierge(session, userMessage, boundaryConfirmed = false) {
  const messages = [
    { role: 'system', content: CONCIERGE_SYSTEM + (session.tenant ? `\n当前公司 ID：${session.tenant}；负责人：${session.manager || '待定'}。` : '\n当前尚未选择公司。') },
    ...(session.history || []).slice(-18),
    { role: 'user', content: userMessage },
  ];
  const steps = [];
  for (let i = 0; i < 6; i++) {
    const availableTools = session.tenant || !newCompanyRequested(session.activeGoal)
      ? CONCIERGE_TOOLS.filter((tool) => tool.function.name !== 'create_company') : CONCIERGE_TOOLS;
    const data = await callLocalModel(messages, availableTools);
    const msg = data.choices[0].message;
    if (msg.tool_calls && msg.tool_calls.length) {
      messages.push(msg);
      for (let callIndex = 0; callIndex < msg.tool_calls.length; callIndex++) {
        const tc = msg.tool_calls[callIndex];
        let args = {};
        try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : (tc.function.arguments || {}); } catch {}
        const result = await executeConciergeTool(session, tc.function.name, args, boundaryConfirmed);
        steps.push({ tool: tc.function.name, args, result });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        if (result.confirmation_required || result.clarification_required) {
          for (const deferred of msg.tool_calls.slice(callIndex + 1)) {
            messages.push({ role: 'tool', tool_call_id: deferred.id, content: JSON.stringify({ deferred: true, reason: '先等待当前动作的人工确认' }) });
          }
          session.history = messages.slice(1).slice(-20);
          return { reply: result.message + (result.confirmation_required ? '\n如确认，请回复“确认”。' : ''), steps };
        }
      }
    } else {
      const completedTask = [...steps].reverse().find((step) => step.tool === 'run_task' && step.result.ok)?.result.task;
      const reviewHint = completedTask?.done_criteria?.by === session.manager
        ? '请核对后回复“通过”或“退回”。'
        : `指定验收人是「${completedTask?.done_criteria?.by || '待定'}」。当前未提供身份登录，不能在此冒用其身份验收。`;
      const reply = (msg.content || '（完成）') + (completedTask ? `\n\nAI 草稿（尚未发送）：\n${completedTask.draft}\n\n${reviewHint}` : '');
      messages.push({ role: 'assistant', content: reply });
      session.history = messages.slice(1).slice(-20);
      return { reply, steps };
    }
  }
  session.history = messages.slice(1).slice(-20);
  return { reply: '（达到最大步数）', steps };
}

function studioPath(id) { return path.join(STUDIO_ROOT, `${id}.json`); }
function loadStudio(id, mode) {
  if (id && /^[0-9a-f-]{36}$/.test(id) && fs.existsSync(studioPath(id))) {
    const session = JSON.parse(fs.readFileSync(studioPath(id), 'utf8'));
    if (session.mode !== mode) throw new Error('对话模式不匹配');
    return session;
  }
  return { id: crypto.randomUUID(), mode, tenant: null, manager: null, phase: 'intro', data: {}, history: [], transcript: [] };
}
function saveStudio(session) {
  fs.mkdirSync(STUDIO_ROOT, { recursive: true });
  const file = studioPath(session.id);
  fs.writeFileSync(file + '.tmp', JSON.stringify(session, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
function studioSummary(session) {
  return { id: session.id, mode: session.mode, tenant: session.tenant || session.selectedTenant || null,
    title: session.title || (session.transcript || []).find((entry) => entry.role === 'user')?.text?.slice(0, 80) || '新对话',
    updated_at: session.updated_at || null, message_count: (session.transcript || []).length };
}
function listStudioSessions(tenantId) {
  if (!fs.existsSync(STUDIO_ROOT)) return [];
  return fs.readdirSync(STUDIO_ROOT).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).flatMap((name) => {
    try {
      const session = JSON.parse(fs.readFileSync(path.join(STUDIO_ROOT, name), 'utf8'));
      if ((session.tenant || session.selectedTenant) !== tenantId) return [];
      const summary = studioSummary(session);
      summary.updated_at ||= fs.statSync(path.join(STUDIO_ROOT, name)).mtime.toISOString();
      return [summary];
    } catch { return []; }
  }).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}
function confirmed(message) { return /^(确认|同意|可以|开始|是的|yes|ok|确认创建|确认执行)[！!。\s]*$/i.test(message.trim()); }
async function workflowTurn(session, message) {
  const d = session.data;
  const value = message.trim();
  const ask = (phase, reply) => { session.phase = phase; return { reply }; };
  const nextEmployee = () => {
    const agents = getTeamView(session.tenant).members.filter((member) => member.type === 'agent');
    if (!agents.length) return ask('role_name', '当前企业还没有 AI 员工。为完成目标，需要一位什么岗位的 AI 员工？');
    return ask('role_choice', `当前团队有：${agents.map((member) => `「${member.role}」（ID：${member.subject.slice(6)}）`).join('、')}。请回复要派活的员工 ID；若现有岗位都不适合，回复“新建”。`);
  };
  if (session.phase === 'intro') {
    d.goal = value;
    if (session.selectedTenant && !newCompanyRequested(value)) {
      const team = getTeamView(session.selectedTenant);
      return ask('company_choice', `先确定经营空间：当前选择的是「${team.name}」，记录的人类负责人是「${team.leader?.human || '未设置'}」。回复“沿用”在这里完成目标，或回复“新建”创建另一家公司。`);
    }
    return ask('company_name', '先确定经营空间。请告诉我新公司叫什么；如已有企业，也可以在左侧选择后开始新对话。');
  }
  if (!value) return { reply: '请先回复上一步所问的信息。' };
  if (session.phase === 'company_choice') {
    if (value === '沿用') {
      session.tenant = session.selectedTenant;
      session.manager = getTeamView(session.tenant).leader?.human || null;
      return nextEmployee();
    }
    if (value === '新建') return ask('company_name', '新公司叫什么？');
    return { reply: '请回复“沿用”或“新建”。' };
  }
  if (session.phase === 'company_name') { d.companyName = value; return ask('company_manager', `「${value}」的负责人是谁？`); }
  if (session.phase === 'company_manager') { d.manager = value; return ask('company_confirm', `将创建「${d.companyName}」，负责人「${d.manager}」。这是本机演示空间，请勿放入真实客户资料、密码或敏感信息。确认后回复“确认”。`); }
  if (session.phase === 'company_confirm') {
    if (!confirmed(value)) return value.startsWith('修改') ? ask('company_name', '好，重新告诉我公司名称。') : { reply: '若确认仅使用演示数据，请回复“确认”；回复“修改”可重新填写公司名称和负责人。' };
    const result = createTenant({ id: `company-${crypto.randomUUID().slice(0, 8)}`, name: d.companyName, manager: d.manager, boundary_confirmed: true });
    if (!result.ok) return { reply: `创建失败：${result.error}` };
    session.tenant = result.id; session.manager = d.manager;
    return nextEmployee();
  }
  if (session.phase === 'role_choice') {
    if (value === '新建') return ask('role_name', '需要新建什么 AI 岗位？例如“活动文案助理”。');
    const member = getTeamView(session.tenant).members.find((item) => item.type === 'agent' && item.subject === `agent:${value}`);
    if (!member) return { reply: '找不到这个员工 ID。请从上方列表选择，或回复“新建”。' };
    d.agentId = value; d.role = member.role; d.acceptor = member.acceptor;
    return ask('task_subject', `已选择「${member.role}」（ID：${value}）。你最初的目标是「${d.goal}」。请说出要交给它完成的第一项任务。`);
  }
  if (session.phase === 'role_name') { d.role = value; return ask('role_purpose', `「${value}」应该负责做什么？`); }
  if (session.phase === 'role_purpose') { d.purpose = value; return ask('role_boundary', '它绝不能做什么？例如“不得自行发送消息、不得编造时间地点”。'); }
  if (session.phase === 'role_boundary') { d.nonPurpose = value; return ask('role_responsibility', `请指定「${d.role}」的人类负责人、监督人、验收人。可回复“负责人小林，监督人老李，验收人王总”；如确实由同一人兼任，回复“都由小林负责”。`); }
  if (session.phase === 'role_responsibility') {
    const assignments = parseRoleResponsibility(value, null);
    if (!assignments) return { reply: '请明确三项人类责任，例如“负责人小林，监督人老李，验收人王总”；不能由系统代填。' };
    Object.assign(d, assignments);
    return ask('role_confirm', `将创建 L1 AI 岗位「${d.role}」：职责「${d.purpose}」；禁止「${d.nonPurpose}」；人类负责人「${d.owner}」、监督人「${d.supervisor}」、验收人「${d.acceptor}」。L1 只出草稿，人来验收和执行。确认后回复“确认”。`);
  }
  if (session.phase === 'role_confirm') {
    if (!confirmed(value)) return value.startsWith('修改') ? ask('role_name', '好，重新告诉我岗位名称。') : { reply: '请确认员工的职责与禁止事项；回复“修改”可重新描述岗位。' };
    const result = createAgent(session.tenant, { role: d.role, capability: d.role, purpose: d.purpose, non_purpose: d.nonPurpose, owner: d.owner, supervisor: d.supervisor, acceptor: d.acceptor, autonomy: 'L1', tools: [], boundary_confirmed: true });
    if (!result.ok) return { reply: `创建失败：${result.error}` };
    d.agentId = result.id;
    logAction(session.tenant, 'role.create', { id: session.manager, type: 'human' }, { role: d.role }, result, session.manager);
    return ask('task_subject', `员工已加入团队。你最初的目标是「${d.goal}」。现在给「${d.role}」一个任务：想让它做什么？`);
  }
  if (session.phase === 'task_subject') { d.taskSubject = value; return ask('task_context', '有哪些已知信息必须告诉它？如时间、地点、对象；没有就回复“无”。'); }
  if (session.phase === 'task_context') { d.taskContext = value === '无' ? '' : value; return ask('task_criterion', '怎样算完成？请给一条你能亲自核对的标准。'); }
  if (session.phase === 'task_criterion') { d.taskCriterion = value; return ask('task_confirm', `归属经营空间：「${tenantInfo(session.tenant).name}」。将让「${d.role}」（ID：${d.agentId}）完成「${d.taskSubject}」，由「${d.acceptor || '待定'}」验收，标准：「${value}」。AI 只生成草稿，不自动发送或发布。确认后回复“确认”。`); }
  if (session.phase === 'task_confirm') {
    if (!confirmed(value)) return value.startsWith('修改') ? ask('task_subject', '好，重新告诉我任务目标。') : { reply: '请核对任务和边界后回复“确认”；回复“修改”可重新描述任务。' };
    if (!d.acceptor || d.acceptor === '待定') return { reply: '该员工没有明确的人类验收人，请先修改岗位契约。' };
    const result = createTask(session.tenant, { subject: d.taskSubject, context: d.taskContext, owner: d.agentId, source_session_id: session.id, done_criteria: { by: d.acceptor, criteria: [d.taskCriterion] }, actor: { id: session.manager, type: 'human' }, boundary_confirmed: true });
    if (!result.ok) return { reply: `创建失败：${result.error}` };
    d.taskId = result.task.id;
    return ask('ready', '任务已创建。回复“开始”，我就让 AI 起草。');
  }
  if (session.phase === 'ready') {
    if (!confirmed(value)) return { reply: '准备好后回复“开始”。' };
    const result = await executeDraftTask(session.tenant, d.taskId);
    if (!result.ok) return { reply: `暂未执行：${result.error}` };
    return ask('review', `AI 草稿（尚未发送）：\n\n${result.task.draft}\n\n请核对标准「${d.taskCriterion}」。回复“通过”或“退回”。`);
  }
  if (session.phase === 'review') {
    if (!['通过', '退回'].includes(value)) return { reply: '请回复“通过”或“退回”。' };
    if (d.acceptor !== session.manager) return { reply: `该任务指定验收人是「${d.acceptor}」，当前对话记录的企业负责人是「${session.manager}」。系统尚未提供身份登录，不能冒用验收人身份完成审批。` };
    const st = readState(session.tenant);
    const task = st.tasks.find((t) => t.id === d.taskId);
    const to = value === '通过' ? 'completed' : 'rejected';
    const evidence = to === 'completed' ? { [d.taskCriterion]: '负责人在对话中核对草稿并确认通过' } : undefined;
    const guard = evaluateAction({ action: 'task.transition', actor: { id: session.manager, type: 'human' }, task, to, evidence });
    if (guard.decision !== 'allow') return { reply: guard.reason };
    task.status = to; task.evidence = evidence; task.feedback = value; writeState(session.tenant, st);
    logAction(session.tenant, 'task.transition', { id: session.manager, type: 'human' }, { taskId: d.taskId, to }, { status: to, evidence }, session.manager);
    return ask('done', to === 'completed' ? '已验收通过，任务完成。草稿仍未对外发送。' : '已退回并记录。你可以在任务板查看，后续再安排修改。');
  }
  return { reply: `这条固定流程已结束。公司：${d.companyName}；员工：${d.role}；任务：${d.taskSubject}。你可以开始新的对话。` };
}

async function studioTurn(session, message) {
  if (session.mode === 'workflow') return workflowTurn(session, message);
  const value = message.trim();
  if (session.pendingCompanyName) {
    if (!value || value.length > 80 || confirmed(value)) return { reply: '请告诉我新公司空间的名称。' };
    session.pendingCompanyName = false;
    session.pendingCompanyManager = { name: value };
    return { reply: `新公司「${value}」由谁负责？请回复真实的负责人姓名或称呼。` };
  }
  if (session.pendingCompanyManager) {
    if (!newCompanyRequested(session.activeGoal)) {
      session.pendingCompanyManager = null;
      return { reply: '你没有要求新建公司。请开始新对话，选择当前企业后直接描述要完成的目标。' };
    }
    if (!value || value.length > 30 || confirmed(value)) return { reply: '请回复负责人的姓名或称呼；不能用“确认”代替。' };
    session.pendingCompany = { name: session.pendingCompanyManager.name, manager: value };
    session.pendingCompanyManager = null;
    session.companyManagerClarified = true;
    return { reply: `将创建「${session.pendingCompany.name}」，人类负责人「${value}」。请确认只使用演示数据，不放入客户资料或密码；回复“确认”后执行。` };
  }
  if (session.pendingRoleAssignments) {
    const assignments = parseRoleResponsibility(value, session.managerExplicit ? session.manager : null);
    if (!assignments) return { reply: '请明确指定三项人类责任，例如“负责人小林，监督人老李，验收人王总”；三者相同可回复“都由小林负责”。' };
    const pending = session.pendingRoleAssignments;
    session.pendingRoleAssignments = null;
    session.pendingRole = { ...pending, ...assignments };
    session.roleAssignmentClarified = true;
    return { reply: `将创建 AI 岗位「${pending.role}」；职责：${pending.purpose}；禁止事项：${pending.non_purpose}；人类负责人：${assignments.owner}；人类监督人：${assignments.supervisor}；人类验收人：${assignments.acceptor}。请核对后回复“确认”。` };
  }
  if (session.pendingReview && ['通过', '退回'].includes(message.trim())) {
    const st = readState(session.tenant);
    const task = (st.tasks || []).find((item) => item.id === session.pendingReview);
    if (!task) return { reply: '待验收任务不存在。' };
    if (task.done_criteria?.by !== session.manager) return { reply: `指定验收人是「${task.done_criteria?.by || '待定'}」，当前对话记录的人类负责人是「${session.manager || '未设置'}」。系统尚未提供身份登录，不能冒用验收人身份完成审批。` };
    const to = message.trim() === '通过' ? 'completed' : 'rejected';
    const criterion = criteriaOf(task)[0];
    const evidence = to === 'completed' ? { [criterion]: '负责人在对话中核对草稿并确认通过' } : undefined;
    const actor = { id: session.manager, type: 'human' };
    const guard = evaluateAction({ action: 'task.transition', actor, task, to, evidence });
    if (guard.decision !== 'allow') return { reply: guard.reason };
    task.status = to; task.evidence = evidence; task.feedback = message.trim();
    writeState(session.tenant, st);
    logAction(session.tenant, 'task.transition', actor, { taskId: task.id, to }, { status: to, evidence }, session.manager);
    session.pendingReview = null;
    session.history.push({ role: 'user', content: message }, { role: 'assistant', content: `任务 ${task.id} 已${to === 'completed' ? '验收通过' : '退回'}。` });
    return { reply: to === 'completed' ? '已验收通过，任务完成。草稿仍未对外发送。' : '已退回，任务记录已更新。' };
  }
  async function continueAfterConfirmation(label, tool, result) {
    session.history.push({ role: 'user', content: message }, { role: 'assistant', content: `${label}：${JSON.stringify(result)}` });
    session.history = session.history.slice(-20);
    if (!result.ok) return { reply: `${label}失败：${result.error}`, steps: [{ tool, result }] };
    const continued = await runConcierge(session, `刚才确认的动作已完成。继续完成这个目标：${session.activeGoal || '管理当前公司'}。已完成的动作不要重复。`);
    return { reply: `${label}成功。${continued.reply}`, steps: [{ tool, result }, ...(continued.steps || [])] };
  }
  if (session.pendingCompany || session.pendingRole || session.pendingTask || session.pendingUpdate) {
    if (!confirmed(message)) return { reply: '请回复“确认”以执行刚才显示的动作，或开始新的对话取消。' };
    if (session.pendingCompany) {
      const pending = session.pendingCompany;
      if (!newCompanyRequested(session.activeGoal)) {
        session.pendingCompany = null;
        return { reply: '你没有要求新建公司，我已取消这次创建。请开始新对话，沿用当前企业继续目标。' };
      }
      if (!session.companyManagerClarified && !userNamedPerson(session.activeGoal, '(?:公司负责人|负责人)', pending.manager)) {
        session.pendingCompany = null;
        session.pendingCompanyManager = { name: pending.name };
        return { reply: `「${pending.name}」由谁负责？请回复真实的负责人姓名或称呼；我不会沿用模型猜测的「${pending.manager}」。` };
      }
      session.pendingCompany = null;
      const result = createTenant({ id: `company-${crypto.randomUUID().slice(0, 8)}`, ...pending, boundary_confirmed: true });
      if (!result.ok) return { reply: `创建失败：${result.error}` };
      session.tenant = result.id; session.manager = pending.manager; session.managerExplicit = true;
      return continueAfterConfirmation(`公司「${pending.name}」创建`, 'create_company', result);
    }
    if (session.pendingRole) {
      const pending = session.pendingRole;
      if (!session.roleAssignmentClarified && !roleResponsibilityExplicit(session, pending)) {
        session.pendingRole = null;
        session.pendingRoleAssignments = pending;
        return { reply: `「${pending.role}」的人类负责人、监督人、验收人分别是谁？请明确指定；我不会沿用模型自动填写的名字。` };
      }
      session.pendingRole = null;
      session.roleAssignmentClarified = false;
      const result = await executeConciergeTool(session, 'create_role', pending, true);
      return continueAfterConfirmation(`岗位「${pending.role}」创建`, 'create_role', result);
    }
    if (session.pendingUpdate) {
      const pending = session.pendingUpdate; session.pendingUpdate = null;
      const result = await executeConciergeTool(session, 'update_role', pending, true);
      return continueAfterConfirmation(`岗位 ${pending.id} 更新`, 'update_role', result);
    }
    const pending = session.pendingTask; session.pendingTask = null;
    const result = await executeConciergeTool(session, 'create_task', pending, true);
    return continueAfterConfirmation('任务创建', 'create_task', result);
  }
  session.activeGoal = message;
  return runConcierge(session, message);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const method = req.method;
  const tenant = url.searchParams.get('tenant') || 'acme-corp';
  if (p === '/api/studio/sessions' && method === 'GET') {
    if (!listTenants().includes(tenant)) return send(res, 404, { error: '经营空间不存在' });
    return send(res, 200, { sessions: listStudioSessions(tenant) });
  }
  if (p.startsWith('/api/studio/sessions/') && method === 'GET') {
    const id = p.slice('/api/studio/sessions/'.length);
    if (!/^[0-9a-f-]{36}$/.test(id) || !fs.existsSync(studioPath(id))) return send(res, 404, { error: '对话不存在' });
    const session = JSON.parse(fs.readFileSync(studioPath(id), 'utf8'));
    if ((session.tenant || session.selectedTenant) !== tenant) return send(res, 404, { error: '对话不属于当前经营空间' });
    return send(res, 200, { ...studioSummary(session), phase: session.phase, transcript: session.transcript || [] });
  }
  if (p === '/api/tenants' && method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(res, 400, { error: 'JSON 解析失败' }); }
    const result = createTenant(body);
    return send(res, result.ok ? 201 : 400, result);
  }
  if (p === '/api/studio/turn' && method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(res, 400, { error: 'JSON 解析失败' }); }
    if (!['agent', 'workflow'].includes(body.mode) || typeof body.message !== 'string' || body.message.length > 4000) return send(res, 400, { error: '需要有效的模式和对话内容' });
    const session = loadStudio(body.session_id, body.mode);
    if (body.session_id && body.tenant && (session.tenant || session.selectedTenant) && body.tenant !== (session.tenant || session.selectedTenant)) {
      return send(res, 409, { error: '对话属于另一个经营空间。请切换空间或开启新对话。' });
    }
    if (!session.initialized) {
      session.initialized = true;
      if (listTenants().includes(body.tenant)) session.selectedTenant = body.tenant;
      if (body.mode === 'agent' && !session.tenant && !session.pendingCompany && !newCompanyRequested(body.message) && listTenants().includes(body.tenant)) {
        session.tenant = body.tenant;
        session.manager = getTeamView(body.tenant).leader?.human || null;
        session.managerExplicit = false;
      }
    }
    const result = await studioTurn(session, body.message);
    if (!session.title) session.title = body.message.trim().slice(0, 80);
    session.transcript.push({ role: 'user', text: body.message }, { role: 'assistant', text: result.reply });
    session.transcript = session.transcript.slice(-100);
    session.updated_at = new Date().toISOString();
    saveStudio(session);
    return send(res, 200, { session_id: session.id, mode: session.mode, tenant: session.tenant, phase: session.phase, ...result });
  }

  // ---- 静态 ----
  if (p === '/' || p === '/index.html') return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'), 'text/html');
  if (p === '/app.js') return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8'), 'text/javascript');
  if (p === '/style.css') return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8'), 'text/css');

  // ---- 租户 ----
  if (p === '/api/tenants' && method === 'GET') {
    const tenants = listTenants();
    return send(res, 200, { tenants, details: tenants.map(tenantInfo) });
  }
  if (!listTenants().includes(tenant)) return send(res, 404, { error: '租户不存在' });
  if (p === '/api/tenant' && method === 'GET') {
    const file = listContractFiles(tenant).find((f) => f.startsWith('tenant.'));
    return send(res, 200, { tenant: file ? yaml.load(fs.readFileSync(path.join(cpDir(tenant), file), 'utf8')).tenant : null });
  }
  if (p === '/api/tenant' && method === 'PATCH') {
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(res, 400, { error: 'JSON 解析失败' }); }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) return send(res, 400, { error: '经营空间名称须为 1–80 个有效字符' });
    const actor = actorOf(body);
    const decision = evaluateAction({ action: 'tenant.update', actor });
    if (decision.decision !== 'allow') return send(res, decisionStatus(decision), auditDenied(tenant, 'tenant.update', actor, { name }, decision));
    const file = listContractFiles(tenant).find((f) => f.startsWith('tenant.'));
    if (!file) return send(res, 404, { error: '经营空间契约不存在' });
    const target = path.join(cpDir(tenant), file);
    const document = yaml.load(fs.readFileSync(target, 'utf8'));
    const before = document.tenant.name;
    if (before === name) return send(res, 200, { ok: true, id: tenant, name });
    document.tenant.name = name;
    fs.writeFileSync(target, yaml.dump(document, { lineWidth: -1 }));
    const teamFile = listContractFiles(tenant).find((f) => f.startsWith('team.'));
    if (teamFile) {
      const teamPath = path.join(cpDir(tenant), teamFile);
      const team = yaml.load(fs.readFileSync(teamPath, 'utf8'));
      if (team?.team) { team.team.name = `${name}团队`; fs.writeFileSync(teamPath, yaml.dump(team, { lineWidth: -1 })); }
    }
    const state = readState(tenant);
    state.team = state.team || {};
    state.team.name = `${name}团队`;
    writeState(tenant, state);
    logAction(tenant, 'tenant.update', actor, { name }, { before, name });
    return send(res, 200, { ok: true, id: tenant, name });
  }

  // ---- 岗位模板 + 推荐自治等级 ----
  if (p === '/api/templates' && method === 'GET') {
    return send(res, 200, { templates: ROLE_TEMPLATES });
  }

  // ---- 契约 ----
  if (p === '/api/contracts' && method === 'GET') {
    return send(res, 200, { tenant, contracts: listContractFiles(tenant) });
  }
  if (p.startsWith('/api/contracts/') && method === 'GET') {
    const name = decodeURIComponent(p.replace('/api/contracts/', ''));
    const f = path.join(cpDir(tenant), name);
    if (!/^[a-zA-Z0-9._-]+\.yaml$/.test(name) || !fs.existsSync(f)) return send(res, 404, { error: 'not found' });
    return send(res, 200, { name, yaml: fs.readFileSync(f, 'utf8') });
  }
  if (p.startsWith('/api/contracts/') && method === 'PUT') {
    const name = decodeURIComponent(p.replace('/api/contracts/', ''));
    const f = path.join(cpDir(tenant), name);
    if (!/^[a-zA-Z0-9._-]+\.yaml$/.test(name) || !fs.existsSync(f)) return send(res, 400, { error: '只允许编辑已有 .yaml 文件' });
    const body = await readBody(req);
    try { yaml.load(body); } catch (e) { return send(res, 400, { error: 'YAML 解析失败：' + e.message }); }
    const actor = actorOf({});
    const decision = evaluateAction({ action: 'contract.update', actor });
    if (decision.decision !== 'allow') return send(res, decisionStatus(decision), auditDenied(tenant, 'contract.update', actor, { name }, decision));
    fs.writeFileSync(f, body);
    logAction(tenant, 'contract.update', actor, { name, content: body }, { ok: true });
    return send(res, 200, { ok: true, name });
  }

  // ---- 建岗位（步骤2：友好表单 → 生成 ACC + 入队）----
  if (p === '/api/agents' && method === 'POST') {
    const body = await readBody(req);
    let form;
    try { form = JSON.parse(body); } catch { return send(res, 400, { error: 'JSON 解析失败' }); }
    try {
      const actor = actorOf(form);
      const decision = evaluateAction({ action: 'role.create', actor });
      if (decision.decision !== 'allow') return send(res, decisionStatus(decision), auditDenied(tenant, 'role.create', actor, form, decision));
      const result = createAgent(tenant, form);
      logAction(tenant, 'role.create', actor, form, result);
      return send(res, result.error ? 409 : 200, result);
    } catch (e) {
      return send(res, 500, { error: '创建失败：' + e.message });
    }
  }

  // ---- 编译 ----
  if (p === '/api/compile' && method === 'POST') {
    try { return send(res, 200, compile(tenant)); }
    catch (e) { return send(res, 500, { error: '编译失败：' + e.message }); }
  }

  // ---- 状态 ----
  if (p === '/api/state' && method === 'GET') {
    const team = getTeamView(tenant);
    const tasks = (readState(tenant).tasks) || [];
    return send(res, 200, { team, tasks });
  }

  // ---- 运行（headless）----
  if (p === '/api/run' && method === 'POST') {
    return send(res, 410, { error: '旧 headless 推演使用付费模型，已停用。请使用本地 Ollama 的 Agent/Workflow 对话。' });
  }

  // ---- live 运行（SDK 桥：人在环）----
  if (p === '/api/run-live' && method === 'POST') {
    return send(res, 410, { error: '旧 live 推演使用付费模型，已停用。请使用本地 Ollama 的 Agent/Workflow 对话。' });
  }
  // ---- L3 对齐校验（硬规则）----
  if (p === '/api/align' && method === 'POST') {
    return send(res, 200, runAlignment(tenant));
  }

  if (p === '/api/audit' && method === 'GET') {
    const rows = readAudit(tenantDir(tenant));
    return send(res, 200, { records: rows.slice(-100), integrity: verifyAudit(tenantDir(tenant)) });
  }
  if (p === '/api/approvals/evaluate' && method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const st = readState(tenant);
    const task = (st.tasks || []).find((t) => t.id === body.taskId);
    const actor = actorOf(body);
    const payload = { task, to: body.to, evidence: body.evidence, targetOwner: body.targetOwner };
    const decision = evaluateAction({ action: body.action, actor, ...payload });
    let approval = null;
    if (decision.decision === 'approval_required') {
      approval = { id: crypto.randomUUID(), action: body.action, inputHash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'), status: 'pending', requestedBy: actor.id, at: new Date().toISOString() };
      st.approvals = st.approvals || [];
      st.approvals.push(approval);
      writeState(tenant, st);
    }
    logAction(tenant, 'approval.evaluate', actor, { action: body.action, payload }, { decision, approvalId: approval && approval.id });
    return send(res, 200, { ...decision, approval });
  }
  if (p === '/api/tasks' && method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const result = createTask(tenant, body);
    return send(res, result.status, result);
  }
  if (p.match(/^\/api\/tasks\/[^/]+\/run$/) && method === 'POST') {
    const result = await executeDraftTask(tenant, p.split('/')[3]);
    return send(res, result.status, result);
  }
  if (p.match(/^\/api\/approvals\/[^/]+\/decision$/) && method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const actor = actorOf(body);
    if (actor.type !== 'human' || !['approved', 'rejected'].includes(body.decision)) return send(res, 400, { error: '只有人可批准或否决' });
    const st = readState(tenant);
    const approval = (st.approvals || []).find((a) => a.id === p.split('/')[3]);
    if (!approval) return send(res, 404, { error: '审批不存在' });
    if (approval.status !== 'pending') return send(res, 409, { error: '审批已处理' });
    approval.status = body.decision;
    approval.decidedBy = actor.id;
    approval.decidedAt = new Date().toISOString();
    writeState(tenant, st);
    logAction(tenant, 'approval.decision', actor, { approvalId: approval.id, decision: body.decision }, { status: approval.status }, actor.id);
    return send(res, 200, { ok: true, approval });
  }

  // ---- L2 任务状态流转 ----
  if (p.match(/^\/api\/tasks\/[^/]+\/transition$/) && method === 'POST') {
    const id = p.split('/')[3];
    const body = JSON.parse((await readBody(req)) || '{}');
    const st = readState(tenant);
    const task = (st.tasks || []).find((t) => t.id === id);
    if (!task) return send(res, 404, { error: '任务不存在' });
    const actor = actorOf(body);
    const payload = { task, to: body.to, evidence: body.evidence, targetOwner: undefined };
    const decision = actionDecision(tenant, st, 'task.transition', actor, { payload, approvalId: body.approvalId });
    if (decision.decision !== 'allow') return send(res, decisionStatus(decision), auditDenied(tenant, 'task.transition', actor, { id, to: body.to }, decision));
    task.status = body.to;
    if (body.to === 'completed') { task.evidence = body.evidence; task.completed_at = new Date().toISOString(); }
    if (body.feedback) task.feedback = String(body.feedback).slice(0, 2000);
    writeState(tenant, st);
    logAction(tenant, 'task.transition', actor, { id, to: body.to, evidence: body.evidence, feedback: body.feedback }, { task }, decision.approvalBy);
    return send(res, 200, { ok: true, task });
  }
  if (p.match(/^\/api\/tasks\/[^/]+\/handoff$/) && method === 'POST') {
    const id = p.split('/')[3];
    const body = JSON.parse((await readBody(req)) || '{}');
    const st = readState(tenant);
    const task = (st.tasks || []).find((t) => t.id === id);
    const actor = actorOf(body);
    const decision = evaluateAction({ action: 'task.handoff', actor, task, targetOwner: body.targetOwner });
    if (decision.decision !== 'allow') return send(res, decisionStatus(decision), auditDenied(tenant, 'task.handoff', actor, body, decision));
    const from = task.owner;
    task.owner = body.targetOwner;
    task.handoffs = task.handoffs || [];
    task.handoffs.push({ from, to: body.targetOwner, reason: body.reason || '', by: actor.id, at: new Date().toISOString() });
    writeState(tenant, st);
    logAction(tenant, 'task.handoff', actor, { id, from, to: body.targetOwner, reason: body.reason }, { task });
    return send(res, 200, { ok: true, task });
  }
  // 演示：把任务重置为"新建"以便体验状态机
  if (p === '/api/tasks/reset' && method === 'POST') {
    const st = readState(tenant);
    const decision = evaluateAction({ action: 'tasks.reset', actor: actorOf({}) });
    if (decision.decision !== 'allow') return send(res, decisionStatus(decision), auditDenied(tenant, 'tasks.reset', actorOf({}), {}, decision));
    (st.tasks || []).forEach((t) => { t.status = 'pending'; });
    writeState(tenant, st);
    logAction(tenant, 'tasks.reset', actorOf({}), {}, { count: (st.tasks || []).length });
    return send(res, 200, { ok: true });
  }

  // ---- Concierge Agent 对话入口 ----
  if (p === '/api/concierge/chat' && method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    try {
      const r = await runConcierge({ tenant, manager: getTeamView(tenant).leader?.human, history: [] }, body.message || '', body.boundary_confirmed === true);
      return send(res, 200, r);
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }
  // ---- 直接改岗位（REST）----
  if (p.match(/^\/api\/roles\/[^/]+$/) && method === 'PUT') {
    const id = decodeURIComponent(p.split('/')[3]);
    const body = JSON.parse((await readBody(req)) || '{}');
    const actor = actorOf(body);
    const decision = evaluateAction({ action: 'role.update', actor });
    if (decision.decision !== 'allow') return send(res, decisionStatus(decision), auditDenied(tenant, 'role.update', actor, { id, patch: body }, decision));
    const r = updateAgent(tenant, id, body);
    logAction(tenant, 'role.update', actor, { id, patch: body }, r);
    return r.error ? send(res, 404, r) : send(res, 200, r);
  }

  return send(res, 404, { error: 'not found' });
}

// 写回 state.json
function writeState(tenantId, st) {
  const f = stateFile(tenantId);
  fs.writeFileSync(f, JSON.stringify(st, null, 2));
}

// L3 硬规则对齐校验（演示版）：检查契约是否自洽
function runAlignment(tenantId) {
  const c = compile(tenantId);
  const checks = [];
  const accs = c.agents || [];

  checks.push({
    rule: '团队有共治 Leader',
    pass: !!(c.team && c.team.leader),
    detail: c.team && c.team.leader ? `Leader=${c.team.leader.agent || c.team.leader.human}` : '缺失',
  });
  checks.push({
    rule: '每个硅基同事都有能力契约(ACC)',
    pass: accs.length > 0,
    detail: `共 ${accs.length} 个岗位`,
  });
  for (const a of accs) {
    checks.push({
      rule: `岗位「${a.name}」有自治等级`,
      pass: !!a.autonomy,
      detail: a.autonomy || '缺失',
    });
  }
  const contracts = listContractFiles(tenantId).filter((f) => f.startsWith('acc.'));
  for (const file of contracts) {
    const acc = (yaml.load(fs.readFileSync(path.join(cpDir(tenantId), file), 'utf8')) || {}).acc;
    if (!acc) continue;
    checks.push({ rule: `岗位「${acc.id}」有身份与责任归属`, pass: !!(acc.identity?.account && acc.responsibility?.accountable_to), detail: `${acc.identity?.account || '缺身份'} / ${acc.responsibility?.accountable_to || '缺责任人'}` });
  }
  // 任务有完成判定
  const tasks = readState(tenantId).tasks || [];
  const noCriteria = tasks.filter((t) => !criteriaOf(t).length);
  checks.push({
    rule: '任务均有完成判定(done_criteria)',
    pass: noCriteria.length === 0,
    detail: noCriteria.length ? `${noCriteria.length} 个任务缺完成判定` : `共 ${tasks.length} 个任务`,
  });

  const failed = checks.filter((x) => !x.pass).length;
  return { checks, passed: failed === 0, total: checks.length, failed };
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => send(res, 500, { error: e.message }));
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。请停止旧服务，或运行 PORT=8092 npm start 后访问 http://127.0.0.1:8092`);
    process.exitCode = 1;
    return;
  }
  throw error;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[控制面] 已启动：http://127.0.0.1:${PORT}`);
});
