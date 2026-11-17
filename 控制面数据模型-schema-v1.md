# 控制面数据模型（Control Plane Schema）— v1

> 配套文档：[企业操作系统-供应链技术架构初稿.md](企业操作系统-供应链技术架构初稿.md)（§9）
> 本文件定义控制面的四类元数据：**Tenant（租户）、AutonomyPolicy（自治策略）、ACC（能力契约）、Team（团队）**，以及它们之间的关系和"契约编译器"的映射规则。
> 说明：当前用 YAML 示例 + 字段表表达，可后续固化为 JSON Schema 供校验。

---

## 0. 四类元数据的关系

```
Tenant（租户：一个企业 = 一个隔离空间）
   │ 1:N
   ├── AutonomyPolicy（自治策略：L0–L4 语义 + 升级规则，可多份/可继承）
   │        ▲ 被引用
   ├── ACC（能力契约：一个能力 = agent / workflow / human_role）
   │        ▲ 被组装
   └── Team（团队：把 N 个 ACC 对应的人/Agent 组织起来 + 共治 Leader）
```

依赖方向（编译顺序）：`Tenant → AutonomyPolicy → ACC → Team`。编译器按这个顺序解析，最后把 Team 落地成 DSH 的团队实例。

---

## 1. Tenant（租户）

一个企业 = 一个 Tenant。上层（Team/ACC）只依赖 `tenant.id` 和 `workspace_root`，不感知隔离实现。

```yaml
tenant:
  id: acme-corp                # 必填，全局唯一
  name: Acme 制造有限公司
  isolation:
    mode: process              # process | container | vm（当前 process，可升级）
    workspace_root: /tenants/acme-corp   # 数据空间根，全部主体在此隔离
    upgrade_path: [process, container, vm]
  identity_domain:             # 人 + Agent 共用的身份域
    idp: local                 # local | oidc | saml | ldap
    default_role: member
  quota:                       # 资源配额
    max_agents: 50
    max_concurrent_tasks: 100
    max_storage_gb: 500
    max_tokens_per_month: 1_000_000_000
  compliance:
    data_residency: cn         # 数据驻留地
    retention_days: 365        # 审计日志保留
  billing:
    plan: pro
    seats: 20                  # 人类席位
  audit:
    full_trace: true
    log_destination: tenant-local
```

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `id` | string | ✅ | 全局唯一租户标识 |
| `isolation.mode` | enum | ✅ | 当前隔离实现（process 起步） |
| `isolation.workspace_root` | string | ✅ | 数据空间根，人/Agent 所有读写都约束在此 |
| `isolation.upgrade_path` | enum[] | ✅ | 可升级路径，保证上层零改动 |
| `identity_domain.idp` | enum | ✅ | 身份源（人和 Agent 都从这里拿身份） |
| `quota.*` | object | ✅ | 资源上限（防单租户打爆） |
| `compliance` / `audit` | object | ✅ | 合规与留痕（企业开箱即用） |

---

## 2. AutonomyPolicy（自治策略）

这是**人机分工的"宪法"**：定义 L0–L4 每级的语义，以及跨能力复用的升级规则。团队/契约引用它，不各自重复定义。

```yaml
autonomy_policy:
  id: default-enterprise       # 必填，可被租户继承/覆盖
  levels:                      # L0–L4 的统一语义
    - level: L0
      name: 观察
      agent_action: read_only      # Agent 只能读
      human_role: owner            # 人全权负责
      decision: human_decides
    - level: L1
      name: 起草
      agent_action: draft          # Agent 出草稿
      human_role: executor         # 人执行
      decision: human_decides
    - level: L2
      name: 预备
      agent_action: prepare        # Agent 备好动作
      human_role: approver         # 人审批提交
      decision: human_approves
    - level: L3
      name: 有界执行
      agent_action: execute_bounded # Agent 在边界内自动执行
      human_role: overseer         # 人只盯例外
      decision: agent_decides_human_co_signs   # 共治：人会签
    - level: L4
      name: 高自主
      agent_action: execute_high   # 仅明确授权
      human_role: owner
      decision: human_decides      # 人最终负责
  escalation_rules:             # 跨能力复用的升级规则（风险 → 最低自治等级）
    - when: amount > 100000
      min_level: L2
    - when: data_class in [PII, financial]
      min_level: L2
    - when: action in [sign_contract, pay]
      min_level: L4
    - when: supplier_risk == high
      min_level: L3
```

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `id` | string | ✅ | 策略标识，可被租户/契约引用 |
| `levels[].level` | L0–L4 | ✅ | 等级编号 |
| `levels[].agent_action` | enum | ✅ | Agent 在该级能做什么 |
| `levels[].human_role` | enum | ✅ | 人在该级扮演什么角色 |
| `levels[].decision` | enum | ✅ | 最终决策权归属（核心：共治的体现） |
| `escalation_rules[]` | rule | 可选 | 风险条件 → 强制最低等级 |

> **关键**：`decision` 字段把"共治"写成了可配置数据——L0–L2 `human_decides`，L3 `agent_decides_human_co_signs`（人会签），L4 `human_decides`。企业改这里就改变了整个人机分工，无需改代码。

---

## 3. ACC（Agent Capability Contract，能力契约）

一个能力 = 一份 ACC。类型可以是 `agent`（自主员工）、`workflow`（确定性流程）、`human_role`（纯人岗位）、`composite`（混合）。

```yaml
acc:
  id: procurement-agent
  version: 1.2.0
  type: agent                  # agent | workflow | human_role | composite
  capability: 采购寻源
  owner:                       # 责任主体（CEAD 强调 accountable owner）
    team: supply-chain
    human_owner: 张三
    agent_owner: procurement-lead
  purpose: 询价比价、生成采购建议与采购订单
  non_purpose: 不得签署合同、不得付款、不得修改供应商准入名单
  autonomy:
    level: L2
    policy: default-enterprise       # 引用自治策略
    overrides:                       # 本能力专属升级（覆盖策略）
      - when: supplier_risk == high
        min_level: L3
  interaction:
    topology: specialist      # supervised|specialist|peer|verifier|broker|workflow-adjunct|human-assistive
    leader: supply-chain-lead
    peers: [inventory-agent]
  io:
    input_schema: erp.requisition
    output_schema: procurement.proposal
  tools:                      # 最小权限（allow + deny 都写）
    allow:
      - { name: erp.read }
      - { name: erp.po.create, mode: draft }
      - { name: web.search }
    deny:
      - erp.payment
      - erp.contract.sign
  data_scope:                 # 数据最小权限
    - suppliers.basic
    - inventory.read
  memory:
    short_term: session
    long_term:
      write: false
      retention_days: 90
  model_policy:               # 模型行为边界
    providers: [deepseek, qwen]
    default_model: deepseek-chat
    temperature_ceiling: 0.7
  verification:               # 评测/验证（发布门禁）
    oracles:
      - 比价结果含 >= 3 家供应商
      - 价格落在历史区间 [P10, P90]
    accuracy_threshold: 0.95
    adversarial_tests: [prompt_injection, 恶意报价诱导]
  human_interaction:          # 何时必须人介入
    ambiguity: escalate
    risk_level_above: L3      # 风险 > L3 必须人
  observability:
    audit: full
    trace: { spans: [plan, tool_call, decision] }
  lifecycle:
    status: active            # draft | active | deprecated
    version_history: [1.0.0, 1.1.0]
```

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `id` / `version` | string | ✅ | 契约标识 + 版本（可审计、可回滚） |
| `type` | enum | ✅ | 形态：员工/流程/人岗/混合 |
| `owner` | object | ✅ | 责任归属（人 + 团队 + 上级 Agent） |
| `purpose` / `non_purpose` | string | ✅ | **能做 / 明确不能做**（CEAD 核心） |
| `autonomy` | object | ✅ | 自治等级 + 引用策略 + 专属覆盖 |
| `tools.allow` / `tools.deny` | list | ✅ | 工具白名单 + 黑名单（最小权限） |
| `data_scope` | list | ✅ | 数据访问范围 |
| `verification` | object | ✅ | 评测阈值（发布门禁） |
| `human_interaction` | object | ✅ | 何时强制转人 |

> **`type` 是"先流程还是先员工"的落点**：同一份 schema，`type: workflow` 就是"确定性流程"，`type: agent` 就是"自主员工"，`type: human_role` 就是"纯人岗位"。企业靠改一个字段 + 自治等级，就能把同一能力在"流程/员工"之间切换——这就是前面几轮讨论的最终答案，落成了一张可配置的表。

---

## 4. Team（团队）

把若干 ACC 对应的人/Agent 组织起来，配一个**共治 Leader**。

```yaml
team:
  id: supply-chain
  name: 供应链团队
  tenant: acme-corp
  leader:                       # 共治 Leader（决策 2）
    mode: co_governance         # human_only | agent_only | co_governance
    human: 张三
    agent: supply-chain-lead
    decision_protocol:          # 内联或引用自治策略
      L0-L2: agent_decides_human_can_veto
      L3: agent_proposes_human_co_signs
      L4: human_decides
  members:                      # 成员 = 人 + Agent（统一主体）
    - subject: human:张三
      role: 采购主管
      acc: human_role:purchase-approver
    - subject: human:李四
      role: 计划员
      acc: human_role:planner
    - subject: agent:procurement-agent
      role: 采购助手
      acc: procurement-agent
    - subject: agent:inventory-agent
      role: 库存机器人
      acc: inventory-agent
  capabilities:                 # 团队覆盖的能力（引用 ACC）
    - procurement-agent
    - inventory-agent
    - settlement-agent
  task_board:                   # 人机共用的任务板
    claim_policy: any           # any | role | subject
    handoff_allowed: true       # 允许人↔Agent 交接
    sla: { default_minutes: 240, escalate_on_breach: true }
```

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `leader.mode` | enum | ✅ | 共治/纯人/纯 Agent |
| `leader.decision_protocol` | map | ✅ | 分级决策协议（共治核心） |
| `members[].subject` | string | ✅ | 统一主体引用 `human:xxx` / `agent:xxx` |
| `members[].acc` | string | ✅ | 每个主体绑定一份能力契约 |
| `task_board.claim_policy` | enum | ✅ | 任务谁能认领 |
| `task_board.handoff_allowed` | bool | ✅ | 是否允许人↔Agent 交接 |

---

## 5. 契约编译器映射（控制面 → DSH 执行面）

| 控制面元数据 | 编译成 DSH 的什么 |
|---|---|
| `tenant.isolation.workspace_root` | 独立 `$DSH_HOME` / 工作目录 / 沙箱模式 |
| `tenant.quota` | DSH 的 subagent 并发上限、token 限额 |
| `acc.type: agent` + `acc.tools.allow` | `dsh-agent-preset` 的 `plugins`（只挂白名单工具） |
| `acc.purpose/non_purpose` | `dsh-persona` 的 `prefix/suffix`（人设 + 边界） |
| `acc.memory.long_term` | 记忆写入开关 + 保留策略 |
| `acc.autonomy.level` + `policy.levels` | 工具层的自治拦截（L 级 → 哪些动作需人） |
| `policy.escalation_rules` + `acc.human_interaction` | `ask_user` / approval 闸门（触发条件） |
| `team.members` | `spawn_teammate`（每个 agent 成员一个 durable teammate） |
| `team.task_board` | `team_task_*` 共享任务板（claim/complete/handoff） |
| `team.leader.decision_protocol` | Leader Agent 的 `steer`/审批 + 人的 `ask_user` 会签 |
| `acc.verification` | 发布门禁（离线评测 + 线上 canary） |
| `acc.type: workflow` | DSH `workflow`（`pipeline`/`parallel`） |

**编译原则**：控制面是"声明式意图"，DSH 是"执行式落地"；编译器保证**同一份 ACC 无论落到哪个引擎（DSH / 其他 agent runtime）语义一致**——这是"外部契约"决策的兑现。

---

## 6. 一致性与校验规则（初稿）

1. `team.members[].acc` 必须引用**已存在**的 `acc.id`（否则编译失败）。
2. `acc.autonomy.policy` 必须引用已存在的 `autonomy_policy.id`。
3. `acc.tools.deny` 与 `allow` 冲突时，**deny 优先**（最小权限）。
4. `tenant.isolation.workspace_root` 必须是所有主体读写的**唯一根**（越界即违规）。
5. 任何 L4 动作，`audit.full_trace` 强制开启，且必须有人审批记录。

---

*下一步（待你确认）：基于这份 schema 写"契约编译器"的最小实现，或先搭 2 个能力（采购 L2 + 库存 L3）+ 共治团队的可跑 MVP。*
