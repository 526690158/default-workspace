const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { verifyAudit } = require('./governance.js');

test('任务完成、审批和审计形成闭环', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-os-test-'));
  const tenants = path.join(root, 'tenants');
  fs.mkdirSync(tenants);
  fs.cpSync(path.join(__dirname, '..', 'tenants', 'acme-corp'), path.join(tenants, 'acme-corp'), { recursive: true });
  const port = 19000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, TENANTS_ROOT: tenants, PORT: String(port) }, stdio: 'ignore' });
  t.after(() => { child.kill(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/api/state'); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  async function post(url, body) {
    const response = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  const created = await post('/api/tasks', { subject: '检查库存', owner: 'inventory-agent', autonomy: 'L3', done_criteria: ['库存报告已提交'], boundary_confirmed: true });
  assert.equal(created.status, 201);
  const handed = await post(`/api/tasks/${created.data.task.id}/handoff`, { targetOwner: 'procurement-agent', reason: '转采购核对', actor: { id: 'inventory-agent', type: 'agent' } });
  assert.equal(handed.status, 200);
  assert.equal(handed.data.task.owner, 'procurement-agent');
  const returned = await post(`/api/tasks/${created.data.task.id}/handoff`, { targetOwner: 'inventory-agent', reason: '核对完毕', actor: { id: 'procurement-agent', type: 'agent' } });
  assert.equal(returned.status, 200);
  const id = 'task-1';
  const existing = (await (await fetch(base + '/api/state')).json()).tasks.find((task) => task.id === id);
  const criterion = existing.done_criteria.criteria[0];
  const missing = await post(`/api/tasks/${id}/transition`, { to: 'completed', actor: { id: 'inventory-agent', type: 'agent' } });
  assert.equal(missing.status, 400);
  const evidence = { [criterion]: '报告 R-1' };
  const gated = await post(`/api/tasks/${id}/transition`, { to: 'completed', evidence, actor: { id: 'inventory-agent', type: 'agent' } });
  assert.equal(gated.status, 403);
  const evaluated = await post('/api/approvals/evaluate', { action: 'task.transition', taskId: id, to: 'completed', evidence, actor: { id: 'inventory-agent', type: 'agent' } });
  assert.equal(evaluated.data.decision, 'approval_required');
  const approvalId = evaluated.data.approval.id;
  const decided = await post(`/api/approvals/${approvalId}/decision`, { decision: 'approved', actor: { id: 'manager', type: 'human' } });
  assert.equal(decided.status, 200);
  const completed = await post(`/api/tasks/${id}/transition`, { to: 'completed', evidence, approvalId, actor: { id: 'inventory-agent', type: 'agent' } });
  assert.equal(completed.status, 200);
  assert.equal(completed.data.task.status, 'completed');
  const audit = await (await fetch(base + '/api/audit')).json();
  assert.equal(audit.integrity.valid, true);
  assert.equal(verifyAudit(path.join(tenants, 'acme-corp')).valid, true);
  assert.ok(audit.records.some((row) => row.action === 'task.transition' && row.approvalBy === 'manager'));
  assert.equal((await post('/api/run', {})).status, 410);
  assert.equal((await post('/api/run-live', {})).status, 410);
});

test('创建公司到 AI 起草及人工验收', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-os-flow-'));
  const tenants = path.join(root, 'tenants');
  fs.mkdirSync(tenants);
  fs.cpSync(path.join(__dirname, '..', 'tenants', 'acme-corp'), path.join(tenants, 'acme-corp'), { recursive: true });
  const model = http.createServer(async (req, res) => {
    let input = '';
    for await (const chunk of req) input += chunk;
    const body = JSON.parse(input);
    let message = { content: '大家好！周六下午 3 点在社区活动室举办读书会，免费参加，请带一本喜欢的书。' };
    if (body.tools) {
      const last = body.messages.at(-1);
      if (last.role === 'tool') message = { content: '已完成所需工具调用。' };
      else {
        const called = body.messages.flatMap((item) => item.tool_calls?.map((call) => call.function.name) || []);
        const name = !called.includes('create_company') ? 'create_company' : !called.includes('create_role') ? 'create_role' : !called.includes('create_task') ? 'create_task' : 'run_task';
        const roleRecord = body.messages.find((item) => item.role === 'assistant' && item.content?.startsWith('岗位「'));
        const taskRecord = body.messages.find((item) => item.role === 'assistant' && item.content?.startsWith('任务创建：'));
        const roleId = roleRecord ? JSON.parse(roleRecord.content.slice(roleRecord.content.indexOf('：') + 1)).id : '';
        const taskId = taskRecord ? JSON.parse(taskRecord.content.slice(taskRecord.content.indexOf('：') + 1)).task.id : '';
        const args = name === 'create_role' ? { role: '活动文案助理', capability: '通知起草', purpose: '起草活动通知', non_purpose: '不得自行发送', owner: '小林', supervisor: '小林', acceptor: '小林', autonomy: 'L1', tools: [] }
          : name === 'create_task' ? { subject: '起草读书会通知', owner: roleId, context: '周六下午3点，社区活动室', criterion: '包含时间地点' }
          : name === 'run_task' ? { task_id: taskId } : { name: '小林活动工作室', manager: '小林' };
        message = { content: null, tool_calls: [{ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  const port = 19000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, TENANTS_ROOT: tenants, STUDIO_SESSIONS_ROOT: path.join(root, 'sessions'), PORT: String(port), OLLAMA_BASE_URL: `http://127.0.0.1:${model.address().port}`, OLLAMA_MODEL: 'test-local-model' }, stdio: 'ignore' });
  t.after(() => { child.kill(); model.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/api/tenants'); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  async function post(url, body = {}) {
    const response = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  const tenant = await post('/api/tenants', { id: 'reading-club', name: '小林读书会', manager: '小林', boundary_confirmed: true });
  assert.equal(tenant.status, 201);
  const scope = '?tenant=reading-club';
  const role = await post('/api/agents' + scope, { role: '活动文案助理', capability: '活动通知起草', autonomy: 'L1', purpose: '起草通知', non_purpose: '不得自行发送', owner: '小林', supervisor: '小林', acceptor: '小林', tools: [], boundary_confirmed: true });
  assert.equal(role.status, 200);
  const secondRole = await post('/api/agents' + scope, { role: '活动文案助理', capability: '社群文案起草', autonomy: 'L1', purpose: '起草社群通知', non_purpose: '不得自行发送', owner: '小林', supervisor: '小林', acceptor: '小林', tools: [], boundary_confirmed: true });
  assert.equal(secondRole.status, 200);
  assert.notEqual(secondRole.data.id, role.data.id);
  const task = await post('/api/tasks' + scope, { subject: '起草读书会通知', context: '周六下午3点，社区活动室，免费，带一本书', owner: role.data.id, done_criteria: { by: '小林', criteria: ['包含时间地点和费用'] }, boundary_confirmed: true });
  assert.equal(task.status, 201);
  const secondTask = await post('/api/tasks' + scope, { subject: '起草社群提醒', owner: secondRole.data.id, done_criteria: { by: '小林', criteria: ['包含活动时间'] }, boundary_confirmed: true });
  assert.equal(secondTask.status, 201);
  assert.equal(secondTask.data.task.owner, secondRole.data.id);
  assert.equal(task.data.task.owner, role.data.id);
  const wrongApprover = await post('/api/tasks' + scope, { subject: '错误验收人示例', owner: role.data.id, done_criteria: { by: '王总', criteria: ['包含时间'] }, boundary_confirmed: true });
  assert.equal(wrongApprover.status, 400);
  assert.match(wrongApprover.data.error, /验收人/);
  const drafted = await post(`/api/tasks/${task.data.task.id}/run${scope}`);
  assert.equal(drafted.status, 200);
  assert.equal(drafted.data.task.status, 'waiting');
  assert.match(drafted.data.task.draft, /周六下午/);
  const accepted = await post(`/api/tasks/${task.data.task.id}/transition${scope}`, { to: 'completed', evidence: { '包含时间地点和费用': '人工核对通过' }, actor: { id: '小林', type: 'human' } });
  assert.equal(accepted.status, 200);
  assert.equal(verifyAudit(path.join(tenants, 'reading-club')).valid, true);

  let workflowId = null;
  async function workflow(message) {
    const result = await post('/api/studio/turn', { mode: 'workflow', session_id: workflowId, message });
    assert.equal(result.status, 200);
    workflowId = result.data.session_id;
    return result.data;
  }
  assert.equal((await workflow('我想办读书会')).phase, 'company_name');
  await workflow('小林第二工作室');
  await workflow('小林');
  const newCompany = await workflow('确认');
  assert.ok(newCompany.tenant.startsWith('company-'));
  await workflow('活动文案助理');
  await workflow('起草活动邀请');
  await workflow('不得自行发送');
  const responsibility = await workflow('负责人小林，监督人老李，验收人小林');
  assert.match(responsibility.reply, /监督人「老李」/);
  await workflow('确认');
  await workflow('起草周末读书会通知');
  await workflow('周六下午3点，社区活动室');
  await workflow('包含时间地点');
  await workflow('确认');
  const draft = await workflow('开始');
  assert.equal(draft.phase, 'review');
  assert.match(draft.reply, /尚未发送/);
  assert.equal((await workflow('通过')).phase, 'done');

  const agentStart = await post('/api/studio/turn', { mode: 'agent', message: '帮我建立小林活动工作室，负责人小林；招活动文案助理，安排读书会通知并起草' });
  assert.equal(agentStart.status, 200);
  assert.match(agentStart.data.reply, /请.*确认/);
  const agentConfirmed = await post('/api/studio/turn', { mode: 'agent', session_id: agentStart.data.session_id, message: '确认' });
  assert.equal(agentConfirmed.status, 200);
  assert.ok(agentConfirmed.data.tenant.startsWith('company-'));
  const agentSession = agentStart.data.session_id;
  assert.match(agentConfirmed.data.reply, /负责人、监督人、验收人/);
  const assigned = await post('/api/studio/turn', { mode: 'agent', session_id: agentSession, message: '都由小林负责' });
  assert.match(assigned.data.reply, /请核对后回复“确认”/);
  const roleConfirmed = await post('/api/studio/turn', { mode: 'agent', session_id: agentSession, message: '确认' });
  assert.ok(roleConfirmed.data.steps[0].result.id);
  assert.match(roleConfirmed.data.reply, /确认/);
  const taskConfirmed = await post('/api/studio/turn', { mode: 'agent', session_id: agentSession, message: '确认' });
  assert.equal(taskConfirmed.status, 200);
  assert.ok(taskConfirmed.data.steps.some((step) => step.tool === 'run_task' && step.result.task.status === 'waiting'));
  const createdByAgent = taskConfirmed.data.steps.find((step) => step.tool === 'create_task')?.result.task;
  assert.equal(createdByAgent.source_session_id, agentSession);
  assert.equal(createdByAgent.tenant, agentConfirmed.data.tenant);
  assert.match(taskConfirmed.data.reply, /尚未发送/);
  const historyResponse = await fetch(base + `/api/studio/sessions?tenant=${agentConfirmed.data.tenant}`);
  const history = await historyResponse.json();
  assert.ok(history.sessions.some((item) => item.id === agentSession));
  const restored = await (await fetch(base + `/api/studio/sessions/${agentSession}?tenant=${agentConfirmed.data.tenant}`)).json();
  assert.equal(restored.tenant, agentConfirmed.data.tenant);
  assert.ok(restored.transcript.length > 0);
  const wrongSpace = await post('/api/studio/turn', { mode: 'agent', session_id: agentSession, tenant: 'reading-club', message: '新任务' });
  assert.equal(wrongSpace.status, 409);
  assert.equal((await fetch(base + `/api/studio/sessions/${agentSession}?tenant=reading-club`)).status, 404);
  const agentReview = await post('/api/studio/turn', { mode: 'agent', session_id: agentSession, message: '通过' });
  assert.equal(agentReview.status, 200);
  assert.match(agentReview.data.reply, /任务完成/);

  const missingManager = await post('/api/studio/turn', { mode: 'agent', message: '帮我建立小林活动工作室，再安排活动文案助理起草通知' });
  assert.equal(missingManager.status, 200);
  assert.match(missingManager.data.reply, /由谁负责/);
  assert.equal(missingManager.data.tenant, null);
  const cannotConfirmInventedName = await post('/api/studio/turn', { mode: 'agent', session_id: missingManager.data.session_id, message: '确认' });
  assert.match(cannotConfirmInventedName.data.reply, /姓名或称呼/);
  const namedManager = await post('/api/studio/turn', { mode: 'agent', session_id: missingManager.data.session_id, message: '小赵' });
  assert.match(namedManager.data.reply, /人类负责人「小赵」/);
  assert.equal(namedManager.data.tenant, null);

  const existingWorkflow = await post('/api/studio/turn', { mode: 'workflow', tenant: 'reading-club', message: '策划读书会通知' });
  assert.equal(existingWorkflow.data.phase, 'company_choice');
  const reuse = await post('/api/studio/turn', { mode: 'workflow', session_id: existingWorkflow.data.session_id, message: '沿用' });
  assert.equal(reuse.data.tenant, 'reading-club');
  assert.equal(reuse.data.phase, 'role_choice');
  assert.match(reuse.data.reply, /员工 ID/);

  const renamed = await fetch(base + '/api/tenant?tenant=reading-club', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '小林周末读书会' }) });
  assert.equal(renamed.status, 200);
  const tenantList = await (await fetch(base + '/api/tenants')).json();
  assert.equal(tenantList.details.find((item) => item.id === 'reading-club').name, '小林周末读书会');
  assert.equal((await (await fetch(base + '/api/state?tenant=reading-club')).json()).team.name, '小林周末读书会团队');
  assert.equal(verifyAudit(path.join(tenants, 'reading-club')).valid, true);
});
