# MVP：供应链数字经营空间（人机共治）

> 当前可运行的 Web 控制面在 `mvp/web/`。进入该目录执行 `npm ci && npm start`，访问 `http://127.0.0.1:8091`。P0 审批、任务验收和审计接口见 [README-governance.md](web/README-governance.md)，运行 `npm test` 可验证服务端闭环。下面保留早期 DSH 方案说明。

当前 Agent 对话和 AI 起草由本机 Ollama 模型执行，无需付费 API key。首次使用先运行 `ollama pull qwen3:4b-instruct`；确认 Ollama 服务已启动后再执行 `npm start`。旧付费模型的 headless/live 推演入口已停用。

想从头走一遍新流程，请看 [五分钟测试：双模式对话](TEST-SCENARIO.md)。两种模式的区别见 [双模式设计](DUAL-MODE-DESIGN.md)，架构文档与实现之间的差距见 [架构落地状态](ARCHITECTURE-STATUS.md)。

这是"企业操作系统"的最小可跑原型，演示**人（碳基）+ AI（硅基）共同组成一个经营空间**。

## 目录结构

```
mvp/
├── control-plane/                 # 控制面：外部契约（企业自助配置的对象）
│   ├── tenant.acme-corp.yaml      # 租户（一个企业 = 一个隔离空间）
│   ├── autonomy-policy.default-enterprise.yaml  # 自治策略（人机分工的宪法）
│   ├── acc.procurement-agent.yaml # 能力契约：采购助手（L2）
│   ├── acc.inventory-agent.yaml   # 能力契约：库存机器人（L3）
│   └── team.supply-chain.yaml     # 团队：人机共治 Leader
└── README.md
```

> 注：契约编译器（control-plane → DSH 执行面）属于"下一步 A"，本 MVP 先用手工映射（下面"映射表"），验证链路后再自动化。

## 三个关键点

1. **两个硅基同事**：`采购助手`（L2，出草稿需人审批）+ `库存机器人`（L3，有界自动补货）。
2. **人机共治 Leader**：`L0-L2` Agent 可推进、人可否决；`L3` Agent 提议、人会签；`L4` 人最终决定。
3. **共享任务板**：人/Agent 都可认领任务，可互相交接。

## 采购履约链（本 MVP 要跑通的）

```
① 库存机器人(L3) 发现库存低于阈值 → 发补货信号（自动，人会签）
② 采购助手(L2)   生成"采购建议"（草稿）
③ 人(采购主管)   【审批闸门】批准采购建议
④ 采购助手(L2)   生成采购订单草稿
⑤ 人(采购主管)   【审批闸门】批准 PO
⑥ 履约/对账      （本 MVP 简化为留痕报告）
```

## 手工映射表（契约 → DSH）

| 契约字段 | DSH 落地 |
|---|---|
| `team.members` 里的 agent | `spawn_teammate`（durable teammate） |
| `team.task_board` | `team_task_*` 共享任务板 |
| `acc.purpose/non_purpose` | teammate 的 prompt（人设 + 边界） |
| `acc.autonomy.level` | teammate prompt 里的自治规则（L2 需审批 / L3 可自动） |
| `policy.decision` | 人（Lead/用户）在审批点介入 |
| `team.leader.decision_protocol` | Lead 作为共治协调者 |

## 怎么运行

本 MVP 直接在 DeepSeek Harness 的 Agent Teams 上运行（无需额外部署）：

1. Lead 用 `spawn_teammate` 创建两个硅基同事。
2. Lead 用 `team_task_create` 建采购履约链的任务。
3. 两个 teammate 认领并执行；在 L2 审批点，**人（你）**通过 Lead 介入批准/否决。
4. 观察任务板状态流转（pending → in_progress → completed）。

下一步（A）：写 `compiler/compile.js`，把 `control-plane/*.yaml` 自动解析成上述 DSH 操作，实现"改契约即改团队"。
