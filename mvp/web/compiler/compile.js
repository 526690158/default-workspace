// 契约编译器（步骤 A，租户感知）：把某个租户的 control-plane/*.yaml 外部契约 → DSH 执行面操作清单
// 输入：mvp/tenants/<tenantId>/control-plane/ 下的 YAML
// 输出：spawn_teammate / team_task_create 的 DSH 操作清单（由契约动态派生，改契约即改团队）

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const TENANTS_ROOT = process.env.TENANTS_ROOT || path.join(__dirname, '..', '..', 'tenants');

function tenantDir(tenantId) {
  return path.join(TENANTS_ROOT, tenantId);
}

function listTenants() {
  if (!fs.existsSync(TENANTS_ROOT)) return [];
  return fs
    .readdirSync(TENANTS_ROOT)
    .filter((d) => fs.statSync(path.join(TENANTS_ROOT, d)).isDirectory())
    .sort();
}

function loadYaml(file) {
  if (!fs.existsSync(file)) return null;
  return yaml.load(fs.readFileSync(file, 'utf8'));
}

// 读取一个租户的全部契约文件，返回 { 文件名: 解析后的对象 }
function loadContracts(tenantId) {
  const dir = path.join(tenantDir(tenantId), 'control-plane');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')) : [];
  const contracts = {};
  for (const f of files) contracts[f] = loadYaml(path.join(dir, f));
  return contracts;
}

function find(contracts, prefix) {
  const name = Object.keys(contracts).find((f) => f.startsWith(prefix));
  if (!name) return null;
  const obj = contracts[name];
  // YAML 顶层唯一键（tenant / team / autonomy_policy）取内层对象
  return obj ? Object.values(obj)[0] : null;
}

// 自治等级 → 人机分工决策语义
function decisionOf(policy, level) {
  const lv = ((policy || {}).levels || []).find((x) => x.level === level);
  return lv ? lv.decision : 'human_decides';
}

// 由 ACC 生成 teammate 的 prompt
function buildPrompt(acc, member, policy) {
  const lvl = acc.autonomy.level;
  const decision = decisionOf(policy, lvl);
  const lines = [];
  lines.push(`你是"${member.role}"，${(member.tenantName || '企业')}经营空间的一名硅基同事（AI Agent），自治等级 ${lvl}。`);
  lines.push('');
  lines.push(`【岗位职责 purpose】\n${acc.purpose}`);
  lines.push('');
  lines.push(`【边界 non_purpose（绝不可做）】\n${acc.non_purpose}`);
  lines.push('');
  lines.push(`【自治规则】\n- 自治等级 ${lvl}，决策模式：${decision}`);
  const esc = acc.human_interaction || {};
  if (esc.ambiguity) lines.push(`- 遇到歧义/信息缺失：${esc.ambiguity}（不臆造）`);
  if (esc.risk_level_above) lines.push(`- 风险高于 ${esc.risk_level_above} 时：转人审批`);
  lines.push('');
  lines.push('【协作】通过共享任务板认领任务，用 send_message 向 lead 汇报会签/待审批事项。');
  lines.push('用中文回复，简洁、结构化。');
  return lines.join('\n');
}

// 由 team.members 动态派生任务链：每个 agent 一个执行任务；L0-L2 的 agent 后面跟一个人审批任务
function buildTasks(team, accs) {
  const tasks = [];
  let n = 1;
  for (const member of team.members || []) {
    if (!member.subject || !member.subject.startsWith('agent:')) continue;
    const name = member.subject.replace('agent:', '');
    const acc = accs[name];
    if (!acc) continue;
    const lvl = acc.autonomy.level;
    const scope = ['runtime', name];
    tasks.push({
      id: `task-${n}`,
      subject: `执行「${acc.capability}」`,
      description: `${member.role} 执行 ${acc.capability}，自治等级 ${lvl}。`,
      blockedBy: n === 1 ? [] : [`task-${n - 1}`],
      writeScopes: [scope.join('/')],
      owner: name,
      autonomy: lvl,
      done_criteria: { by: (acc.acceptance || {}).by || (acc.owner || {}).human_owner || '负责人', criteria: (acc.acceptance || {}).criteria?.length ? acc.acceptance.criteria : [`${acc.capability} 的结果已记录并经负责人验收`] },
    });
    n += 1;
    if (['L0', 'L1', 'L2'].includes(lvl)) {
      tasks.push({
        id: `task-${n}`,
        subject: `人工审批「${acc.capability}」（${lvl} 闸门）`,
        description: `人审批 ${member.role} 的产出 —— 人机共治决策点。`,
        blockedBy: [`task-${n - 1}`],
        writeScopes: [scope.join('/')],
        owner: 'lead',
        autonomy: 'human',
        done_criteria: { by: (acc.acceptance || {}).by || (acc.owner || {}).human_owner || '负责人', criteria: ['审批决定已记录'] },
      });
      n += 1;
    }
  }
  return tasks;
}

function compile(tenantId) {
  const contracts = loadContracts(tenantId);
  const tenant = find(contracts, 'tenant.') || {};
  const policy = find(contracts, 'autonomy-policy.') || {};
  const team = find(contracts, 'team.') || {};

  // 所有 acc.*.yaml → { agentId: acc }
  const accs = {};
  for (const f of Object.keys(contracts)) {
    if (!f.startsWith('acc.')) continue;
    const c = contracts[f];
    const acc = c && c.acc;
    if (acc) accs[acc.id] = acc;
  }

  const spawn = [];
  for (const member of team.members || []) {
    if (!member.subject || !member.subject.startsWith('agent:')) continue;
    const name = member.subject.replace('agent:', '');
    const acc = accs[name];
    if (!acc) continue;
    spawn.push({
      name,
      description: `${member.role}（${acc.capability}，自治等级 ${acc.autonomy.level}）`,
      prompt: buildPrompt(acc, { ...member, tenantName: tenant.name || tenant.id }, policy),
    });
  }

  return {
    tenant: { id: tenant.id, name: tenant.name, isolation: (tenant.isolation || {}).mode },
    team: { id: team.id, name: team.name, leader: team.leader },
    agents: spawn.map((s) => ({ name: s.name, description: s.description, autonomy: accs[s.name].autonomy.level })),
    // DSH 执行面操作清单
    dsh_ops: {
      spawn_teammate: spawn,
      team_task_create: buildTasks(team, accs),
    },
  };
}

module.exports = { compile, listTenants, getTeamView };

// 读取 team.yaml 的真实团队定义（含成员类型 + 自治等级），供「团队」页签展示
// 这是"建岗位"表单写入的源头，确保新增员工即时可见
function getTeamView(tenantId) {
  const contracts = loadContracts(tenantId);
  const team = find(contracts, 'team.') || {};

  // 收集所有 ACC：{ agentId: acc }
  const accs = {};
  for (const f of Object.keys(contracts)) {
    if (!f.startsWith('acc.')) continue;
    const c = contracts[f];
    if (c && c.acc) accs[c.acc.id] = c.acc;
  }

  const members = (team.members || []).map((m) => {
    const isAgent = m.subject && m.subject.startsWith('agent:');
    const name = isAgent ? m.subject.replace('agent:', '') : '';
    const acc = isAgent ? accs[name] : null;
    return {
      subject: m.subject,
      role: m.role || name,
      type: isAgent ? 'agent' : 'human',
      autonomy: acc ? acc.autonomy.level : null,
      owner: acc && acc.owner ? acc.owner.human_owner : null,
      supervisor: acc && acc.supervision ? acc.supervision.supervisor : null,
      acceptor: acc && acc.acceptance ? acc.acceptance.by : null,
      status: isAgent ? 'inactive' : 'active',
    };
  });

  return { id: team.id, name: team.name, leader: team.leader, members };
}

if (require.main === module) {
  const t = process.argv[2] || 'acme-corp';
  console.log(JSON.stringify(compile(t), null, 2));
}
