# P0 管理与执行闭环

启动：`npm start`。验证：`npm test`。数据仍保存在 `mvp/tenants/<tenant>/`。

## 新增接口

- `GET /api/studio/sessions?tenant=<id>`：列出当前经营空间的对话；`GET /api/studio/sessions/:id?tenant=<id>`：恢复一段对话。历史会话按空间隔离；新目标使用新会话，不自动继承旧对话。
- `POST /api/tasks`：创建任务，必须提供 `subject`、`owner` 和非空 `done_criteria` 数组。
- `POST /api/tasks/:id/transition`：流转到 `completed` 时，`evidence` 对每条完成标准都要给出非空文本。
- `POST /api/tasks/:id/handoff`：用 `targetOwner` 和 `reason` 交接，记录交接历史。
- `POST /api/approvals/evaluate`：评估动作；需要审批时生成待审批记录。
- `POST /api/approvals/:id/decision`：人以 `approved` 或 `rejected` 做决定。
- `GET /api/audit`：返回最近 100 条审计记录与哈希链校验结果。

所有请求可带 `actor: { "id": "...", "type": "human|agent|system" }`。旧 Web 界面未带身份时默认使用 `local-operator`，仅供本地演示。

Agent 与 Workflow 创建的任务记录 `tenant` 和 `source_session_id`。对话绑定经营空间后，`POST /api/studio/turn` 若传入另一个空间会返回 409。创建任务前的对话确认会显示经营空间、员工和完成标准。

Agent 完成任务的最小流程：

1. `POST /api/approvals/evaluate`，传入 `{"action":"task.transition","taskId":"...","to":"completed","evidence":{"验收标准":"证据"},"actor":{"id":"任务负责人","type":"agent"}}`。
2. 人调用 `POST /api/approvals/:id/decision` 批准。
3. Agent 用同一份 `evidence` 调用 `POST /api/tasks/:id/transition`，增加 `approvalId`。审批与请求内容绑定；任务状态变化后旧审批不能复用。

## 当前边界

审计采用逐条 SHA-256 哈希链，可检测单条改动，但没有外部锚点或独立存储，不能抵抗拥有文件写权限者整体重写。身份目前由请求自报，尚无登录、签名、RBAC；因此审批人身份和责任归属尚不能用于真实企业追责。旧 `run-live` 和 `run` 付费模型入口已经停用；今后若接入 Harness 的外部工具调用，需要让它们通过同一审批与审计入口。自动化测试覆盖服务端任务闭环，另已用本机 Ollama 做过真实工具调用与草稿生成冒烟验证。
