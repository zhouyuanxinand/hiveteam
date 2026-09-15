# 在团队成员窗口完成需求澄清

在主线程请求使用 `grill`、`grilling`、`grill-me` 或 `grill-with-docs` 时，Hive 的启动说明要求 Orchestrator 先把访谈交给一位空闲成员。主线程不执行访谈，收到最终结论后才拆解和分派任务。

## 使用流程

1. Workspace 绑定包含访谈 Skill 的 Pack，并在 Orchestrator 的 Profile 中启用该 Skill。新绑定 Matt Pack 时，会推荐可用的 grill 入口；既有 Profile 不会自动改写。
2. 启动至少一位团队成员，保持其空闲、没有待办任务。更新 Hive 后，需要重启 Orchestrator 才能加载新的启动说明。
3. 在主线程提出需求，例如：“用 grilling 澄清邮件原型的需求，由一位成员负责访谈。”
4. 主线程执行 `team list`、`team skill list`，再派单，例如：

   ```sh
   team send "需求访谈员" "澄清邮件原型的目标、边界和验收标准" --skill "matt/grilling"
   ```

5. 点击主界面的“进入成员窗口回答”，在该成员终端或下方具名的自由回答框中答复。支持多行文字；Ctrl/⌘ + Enter 发送。关闭窗口保留该成员的浏览器草稿，不与其他成员或主线程混用。
6. 成员展示最终方案并等待用户明确确认，然后通过正式的 `team report --stdin --dispatch <id> --outcome success` 回传精简结论。等待用户答复不算任务阻塞。

没有空闲成员时，Orchestrator 应请用户添加或释放成员，不自动打断已有任务。访谈派单未结束前，服务端拒绝给该成员叠加其他派单。

## 上下文隔离范围

- 自由回答通过 `agent_id` 定向投递，HTTP 验证成员属于当前 Workspace。停止的成员不会因回答而自动启动；未发出的回答可在启动后重试。
- grill 派单激活固定版本的 Skill。显式派单可将 Orchestrator Profile 中的访谈 Skill 委托给成员，不改变成员角色，也不开放其他规划 Skill。
- 成员的中间 `team status` 只本地记录，不注入主线程，也不进入重启恢复摘要或自动记忆摘要。`team list` 隐去该成员的原始终端最后一行；完成访谈后继续隐藏，直到该成员接受新的普通派单。
- 访谈记录应放在 `docs/clarifications/<dispatch-id>/interview.md`，最终方案放在同目录 `final.md`。只报告目标、范围、决策、约束、验收标准、风险和最终文档路径，不附逐轮问答。主线程不读取访谈记录。
- 最终报告沿用持久化 outbox。主线程暂时离线时，报告保留，恢复后继续投递。

这是 Hive 的路由与上下文管理，不是文件系统安全沙箱。成员仍共享项目文件；原生 CLI 在 Hive API 之外直接读取全局 Skill/文件的行为由该 CLI 控制。主线程遵循路由说明、成员遵循最终汇报合同仍是必要条件。不要手动把访谈答案粘贴到主线程。

发送显示“不确定”时，先检查接收成员的终端，再查询提交状态。Hive 不自动重发，避免重复回答。已有旧版全局 Skill 或启动说明导致主线程自行访谈时，重启 Orchestrator，并显式要求使用上述 `team send --skill` 路径。
