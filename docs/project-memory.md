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
- 同一转换会话保留两种用途的数据。供人查看的消息记录保留选中时间线上的原文和压缩边界；首次向目标发送消息时使用来源压缩后实际保留的上下文，再接上边界后的消息。例如，若 `a,b,c` 被压缩、`c` 仍被显式保留，发送时应按来源窗口顺序保留摘要及 `c`，再接 `d,f`。已被摘要替换的原文只出现在历史记录中。此决定取代 M3 跨 Agent 首轮注入全部转写的做法。

实现差距（2026-11-21）：

- 当前引导包生成器遍历全部 CSR 轮次写出 `context.md`，桌面端和 CLI 首轮将全文与当前请求拼成提示词。消息协议转换器可处理已支持的结构化请求，但这条续聊路径未调用它，也没有独立表示压缩后的有效窗口。[引导包构建器](../packages/core/src/session.ts) · [CLI 发送入口](../packages/cli/src/run-cli.ts) · [消息协议管线](../packages/protocols/src/pipeline.ts)
- 原生文件转换遍历全部已解析轮次。Claude Code 的兄弟分支、Codex 的回退前历史都可能进入同一份正文。
- 当前通用「归档并跳过不透明内容」会保留原始字节。专用的推理密文开关、整个导出包的去除及清理后工件的校验尚未实现。Codex 的压缩替换历史目前整段转成 JSON 文本，嵌套密文字段也可能随之进入正文。
- 桌面从引用会话交接时使用聊天界面的消息投影，可能遗漏系统指令与可见推理。重建桌面新增轮次时，工具参数被写为 `{}`、结果被写为界面状态，已采集的历史与当时实际执行的工具活动需要区分。
- 连续交接可复用上一包的 CSR 轮次，但新损耗账本从空表开始，末跳报告无法代表整条链。[引导包构建器](../packages/core/src/session.ts) · [桌面 Handoff](../packages/ui/src/main/service.ts)

## 已验证经验

### 一次性协议转换的快照开销与 SSE 分块

2026-11-21 在 Windows x64、Node 20.19.5 用内存合成输入测量。Responses→Chat 请求包含 2,048 条交替角色的文本消息，每条约 1 KiB，输入 JSON 共 2,268,105 字节。两组复用同一注册表、交替运行，预热 5 次，各取 15 次中位数。现有 `convertRequest` 为 49.90 ms；在同一转换上下文中直接调用现有解码器和编码器、保留一次完整源载荷、跳过编辑与回放用的快照及额外复制，为 16.95 ms。该样本的目标数据和完整报告深比较相等。这个对照仍经过 IR，仅验证纯文本跨协议的一次性转换。编辑后的导出、同协议回放与失败报告需分别验证。[转换管线](../packages/protocols/src/pipeline.ts)

同次环境下，一个含 128 KiB 文本增量的 Chat SSE 事件转 Responses，输入共 131,238 字节。预热 3 次，测量 11 次。按 64 KiB 或 256 B 切分相同字节时，消费整条输出流的中位数分别为 5.86 ms 和 47.99 ms。读取器在未遇到换行时会从头扫描累积缓冲区，分块还影响异步迭代次数。这组数据只描述长单行事件的分块敏感性，未测线上流量、内存峰值或各因素的独立耗时。[SSE 读取器](../packages/protocols/src/sse.ts)

### 在线网关能回放的摘要与可移植的上下文

2026-11-21 核对上游源码。CC Switch 的 Codex 兼容路径可以把自生成的摘要以带前缀的 base64 包装，在下次请求还原为文字。CLIProxyAPI 的部分执行器将生成的摘要封装为自有加密格式；共享展开逻辑按调用路径移除或保留其他来源的压缩项。这些往返依赖已知来源，不能证明网关能恢复第三方原生密文中的事实。[CC Switch 压缩转换](https://github.com/farion1231/cc-switch/blob/908a83edaf7b2c55b961ff1a31523735a417b6e9/src-tauri/src/proxy/providers/codex_compaction.rs) · [CLIProxyAPI 压缩转换](https://github.com/router-for-me/CLIProxyAPI/blob/f5c5681a8361c9da53e93c60b6507816eee7468b/internal/runtime/executor/helps/antigravity_compaction.go#L135)

相同的损坏历史也会触发不同策略。CC Switch 的 Codex→Chat 路线将无调用可配对的工具结果转为带标记的用户消息；sub2api 的 Responses→Anthropic 回归用例要求移除孤立结果和无结果的调用；CoVerse 的请求校验拒绝不完整配对。核对保真度时，应分别断言结果正文、角色与调用关联。[CC Switch 孤立结果处理](https://github.com/farion1231/cc-switch/blob/908a83edaf7b2c55b961ff1a31523735a417b6e9/src-tauri/src/proxy/providers/transform_codex_chat.rs#L1455) · [sub2api 配对用例](https://github.com/Wei-Shaw/sub2api/blob/328db26f450edbdf9f8d4344a3ea903ac6396842/backend/internal/pkg/apicompat/responses_to_anthropic_tool_pairing_test.go#L113) · [CoVerse 请求校验](../packages/protocols/src/validation.ts)

### 底层协议的空损耗账本不能证明跨协议语义等价

2026-11-21 使用合成输入调用 `convertRequest` 和 `convertResponse` 复核了三种默认严格模式仍会成功、三类账本均为空的情形：

- Responses 的函数参数字符串 `{"order":9007199254740993}` 转成 Anthropic 的 `tool_use.input` 时变成 `9007199254740992`。原始参数文本在源报告中可查，目标对象使用 JavaScript 数值。[参数解码](../packages/protocols/src/validation.ts) · [工具消息编码](../packages/protocols/src/messages.ts)
- Responses 完整响应中两条独立的助手消息转成 Chat Completions 的同一条助手消息。两段文字与顺序保留，源消息边界只在原始报告中可查。[响应解码与编码](../packages/protocols/src/responses.ts)
- Anthropic 的结束原因 `refusal` 转成 Chat Completions 的 `content_filter`。依赖结束原因区分模型拒答和内容过滤的调用方，会得到不同分类。[结束原因映射](../packages/protocols/src/responses.ts)

### 会话压缩记录与推理密文需按原生类型辨认

- Codex rollout 的 `compacted` 可带文本 `message` 和替换历史 `replacement_history`。OpenAI Responses 服务端也能返回加密 `compaction` 项，其中可含后续任务所需的上下文和工具定义。处理推理密文时应检查原生记录类型，避免把这个项作为推理删除。[Codex 适配器](../packages/adapters/adapter-codex/src/index.ts) · [OpenAI Compaction](https://developers.openai.com/api/docs/guides/compaction)
- Claude Code 使用结构化摘要。适配器识别 `compact_boundary`、`isCompactSummary` 和旧式 `summary` 记录。同一会话中可另有 `redacted_thinking.data`，Anthropic 将该字段定义为加密推理。[Claude Code 上下文说明](https://code.claude.com/docs/en/context-window) · [Anthropic 消息类型](https://platform.claude.com/docs/en/api/typescript/messages/create)
- Antigravity checkpoint 包含摘要和会话快照。已验证的 SQLite/protobuf 子集中，`session_summary`、`code_change_summary` 等为文本，部分嵌套快照为字节字段。字节类型本身不足以判定加密。[Antigravity 压缩说明](https://antigravity.google/docs/commands/compact) · [已验证字段](../packages/adapters/adapter-antigravity/src/wire.ts)

### Claude Code 生成的标题可能出现在下一跳的输入中

2026-11-18 的连续迁移实测中，两份 Claude Code 来源记录都因 `ai-title` 阻断了引导包生成；修复后用相同的会话字节复验通过。修改导入器时，应覆盖目标 Agent 续聊后实际写出的记录，包括自动生成的元数据。[M3.1 实测报告](../tools/m31/REPORT-2026-11-18.md)
