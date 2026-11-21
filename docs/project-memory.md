# 项目决策与经验

按任务主题查阅。新记录写明适用范围、结论和依据。决策变更时，在旧条目标明由哪条新决策取代。待验证的推测留在任务交接中。

## 项目决策

### 跨 Agent 共享项目知识

已采纳。跨会话仍会影响工作的决定和已验证经验随代码保存在 Git 中。各 Agent 通过仓库入口找到同一份记录，项目约定也能随分支演进。已有设计、报告或回归用例直接链接到原处。

### 会话格式的兼容性由适配器负责

已采纳。各 Agent 的会话格式独立演进。遇到新记录类型时，在对应插件中核实其语义、补充回归用例，并核对能力声明。这样单家格式变化的影响可收敛到该插件。[适配器说明](../packages/adapters/README.md)

### 跨 Agent 转换输出选中对话的线性历史

2026-11-21 采纳，适用于原生会话文件转换和桌面 Handoff。以下是产品约定，现有适配器仍有实现差距。

- 按来源 Agent 认定的选中对话路径和回退结果输出单一时间线。保留原文、角色、顺序与来源标记，指令优先级由目标 Agent 决定。此决定取代 M2 将所有分支写入目标正文的约定。
- 工具活动保留为历史，读者应能辨认调用名称、已有参数和实际返回内容。源记录仅提供状态时，如实标注结果正文缺失。图片、附件、工作区沿用现有引用方式。
- 可见推理及可读摘要随历史转写。默认从整个导出包去除已识别的推理密文，范围包括正文、CSR 及其原始记录、源文件归档副本和报告。用户勾选后才归档密文；两种设置都只向目标 Agent 注入可读部分。磁盘上的原始会话文件保持原样。损耗账本记录处理位置和原因。此决定取代将已识别推理密文一律作为阻断导出的未知块处理的约定。
- 保留来源已有的压缩记录。CoVerse 导出时不按长度再次摘要或裁剪，后续窗口管理由目标 Agent 负责。目标模式和计划模式的映射暂缓，Skill 沿用历史中的名称或记录。

实现差距（2026-11-21）：

- 原生文件转换遍历全部已解析轮次。Claude Code 的兄弟分支、Codex 的回退前历史都可能进入同一份正文。
- 当前通用「归档并跳过不透明内容」会保留原始字节。专用的推理密文开关、整个导出包的去除及清理后工件的校验尚未实现。Codex 的压缩替换历史目前整段转成 JSON 文本，嵌套密文字段也可能随之进入正文。
- 桌面从引用会话交接时使用聊天界面的消息投影，可能遗漏系统指令与可见推理。重建桌面新增轮次时，工具参数被写为 `{}`、结果被写为界面状态，已采集的历史与当时实际执行的工具活动需要区分。
- 连续交接可复用上一包的 CSR 轮次，但新损耗账本从空表开始，末跳报告无法代表整条链。[引导包构建器](../packages/core/src/session.ts) · [桌面 Handoff](../packages/ui/src/main/service.ts)

## 已验证经验

### 会话压缩记录与推理密文需按原生类型辨认

- Codex rollout 的 `compacted` 可带文本 `message` 和替换历史 `replacement_history`。OpenAI Responses 服务端也能返回加密 `compaction` 项，其中可含后续任务所需的上下文和工具定义。处理推理密文时应检查原生记录类型，避免把这个项作为推理删除。[Codex 适配器](../packages/adapters/adapter-codex/src/index.ts) · [OpenAI Compaction](https://developers.openai.com/api/docs/guides/compaction)
- Claude Code 使用结构化摘要。适配器识别 `compact_boundary`、`isCompactSummary` 和旧式 `summary` 记录。同一会话中可另有 `redacted_thinking.data`，Anthropic 将该字段定义为加密推理。[Claude Code 上下文说明](https://code.claude.com/docs/en/context-window) · [Anthropic 消息类型](https://platform.claude.com/docs/en/api/typescript/messages/create)
- Antigravity checkpoint 包含摘要和会话快照。已验证的 SQLite/protobuf 子集中，`session_summary`、`code_change_summary` 等为文本，部分嵌套快照为字节字段。字节类型本身不足以判定加密。[Antigravity 压缩说明](https://antigravity.google/docs/commands/compact) · [已验证字段](../packages/adapters/adapter-antigravity/src/wire.ts)

### Claude Code 生成的标题可能出现在下一跳的输入中

2026-11-18 的连续迁移实测中，两份 Claude Code 来源记录都因 `ai-title` 阻断了引导包生成；修复后用相同的会话字节复验通过。修改导入器时，应覆盖目标 Agent 续聊后实际写出的记录，包括自动生成的元数据。[M3.1 实测报告](../tools/m31/REPORT-2026-11-18.md)
