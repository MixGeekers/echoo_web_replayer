# Agent 本地控制能力

此前的概念草案已由正式本地 MCP 基线替代。当前实现、接入配置、28 项工具、授权和生命周期规则见 [本地 MCP 使用说明](local-mcp.md)。

入口：`src/main/mcp/stdio.ts`（官方 MCP SDK / stdio）、`server.ts`（认证本机管道）、`controller.ts`（连接 / 授权 / 租约 / 采集归属）、`tools.ts`（业务工具）、`browser.ts`（网页观察与动作）、`operations.ts`（持久回执与导出任务）。

桌面端采用顶栏常驻的协作徽标和 Agent 连接面板。支持“人操作、Agent 分析”和“Agent 操作、同步采集”两条流程；外部 Agent 与 UI 共享 Workspace 的业务保护与状态，不存在旧原型入口或兼容迁移层。
