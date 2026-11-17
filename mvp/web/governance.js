const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEVELS = new Set(['L0', 'L1', 'L2', 'L3', 'L4', 'human']);
const STATES = { pending: ['in_progress'], in_progress: ['waiting', 'completed'], waiting: ['completed', 'rejected'], rejected: ['pending'], completed: [] };

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function auditPath(tenantDir) { return path.join(tenantDir, 'audit.jsonl'); }
function readAudit(tenantDir) {
  const file = auditPath(tenantDir);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
function appendAudit(tenantDir, entry) {
  const rows = readAudit(tenantDir);
  const previousHash = rows.length ? rows[rows.length - 1].hash : null;
  const record = { id: crypto.randomUUID(), at: new Date().toISOString(), previousHash, ...entry };
  record.hash = digest(record);
  fs.appendFileSync(auditPath(tenantDir), JSON.stringify(record) + '\n', { flag: 'a', mode: 0o600 });
  return record;
}
function verifyAudit(tenantDir) {
  const rows = readAudit(tenantDir);
  for (let i = 0; i < rows.length; i++) {
    const { hash, ...body } = rows[i];
    if (hash !== digest(body) || body.previousHash !== (i ? rows[i - 1].hash : null)) return { valid: false, count: rows.length, brokenAt: i };
  }
  return { valid: true, count: rows.length };
}

function criteriaOf(task) {
  const d = task.done_criteria;
  return Array.isArray(d) ? d : d && Array.isArray(d.criteria) ? d.criteria : [];
}
function doneCheck(task, evidence) {
  const criteria = criteriaOf(task);
  if (!criteria.length) return { passed: false, reason: '任务缺少完成标准 done_criteria' };
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return { passed: false, reason: '缺少验收证据 evidence' };
  const missing = criteria.filter((item) => typeof evidence[item] !== 'string' || !evidence[item].trim());
  return missing.length ? { passed: false, reason: '验收证据缺失', missing } : { passed: true, criteria };
}
function evaluateAction({ action, actor, task, to, evidence, targetOwner, approval }) {
  if (!['task.transition', 'task.handoff', 'task.create', 'task.run', 'role.create', 'role.update', 'contract.update', 'tenant.update', 'tasks.reset'].includes(action)) return { decision: 'deny', reason: '未知动作' };
  if (!actor || typeof actor.id !== 'string' || !actor.id.trim() || !['human', 'agent', 'system'].includes(actor.type)) return { decision: 'deny', reason: '需要有效的 actor.id 和 actor.type' };
  if (action === 'task.transition') {
    if (!task) return { decision: 'deny', reason: '任务不存在' };
    if (!STATES[task.status]?.includes(to)) return { decision: 'deny', reason: `不允许 ${task.status} → ${to}` };
    if (task.owner !== actor.id && actor.type !== 'human') return { decision: 'deny', reason: '只有任务负责人或人类管理者可推进任务' };
    if (to === 'completed') {
      const result = doneCheck(task, evidence);
      if (!result.passed) return { decision: 'deny', ...result };
      if (task.execution_mode === 'draft_only' && (actor.type !== 'human' || actor.id !== task.done_criteria?.by)) return { decision: 'deny', reason: '只有任务指定的验收人可确认草稿完成' };
      if (actor.type === 'agent' || task.autonomy === 'human' && actor.type !== 'human') return { decision: 'approval_required', reason: '任务完成需要人工验收' };
    }
  }
  if (action === 'task.run') {
    if (!task || task.status !== 'pending' || task.execution_mode !== 'draft_only') return { decision: 'deny', reason: '任务状态或执行模式不允许 AI 起草' };
    if (actor.type !== 'agent' || task.owner !== actor.id) return { decision: 'deny', reason: '只有该任务的 AI 员工可执行' };
  }
  if (action === 'task.handoff') {
    if (!task || task.status === 'completed') return { decision: 'deny', reason: '任务不存在或已完成' };
    if (typeof targetOwner !== 'string' || !targetOwner.trim() || targetOwner === task.owner) return { decision: 'deny', reason: '需要不同的交接目标' };
    if (task.handoff && task.handoff.allowed === false) return { decision: 'deny', reason: '该任务禁止交接' };
    if (task.owner !== actor.id && actor.type !== 'human') return { decision: 'deny', reason: '只有负责人或人类管理者可交接' };
  }
  if (action === 'role.create' || action === 'role.update' || action === 'contract.update' || action === 'tenant.update' || action === 'tasks.reset') {
    if (actor.type !== 'human') return { decision: 'approval_required', reason: '管理配置变更需要人批准' };
  }
  if (action === 'task.create' && actor.type === 'agent') return { decision: 'approval_required', reason: 'Agent 创建任务需要人批准' };
  if (approval && approval.status !== 'approved') return { decision: 'deny', reason: '审批尚未批准' };
  return { decision: 'allow' };
}

module.exports = { appendAudit, readAudit, verifyAudit, criteriaOf, doneCheck, evaluateAction, LEVELS };
