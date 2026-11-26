# 项目决策与经验

按任务主题查阅。新记录写明适用范围、结论和依据。决策变更时，在旧条目标明由哪条新决策取代。待验证的推测留在任务交接中。

## 项目决策

### 公开仓库通过 PR 协作

2026-11-26。外部贡献由维护者评审。为让有写权限的协作者也能自行合并，将 `main` 的必需批准数从 1 调为 0。所有改动仍须通过 PR 和四项 CI，并解决评审讨论。格式兼容性问题使用合成复现或经审核的样本，涉及私人数据的安全问题走 GitHub 私密报告。[贡献指南](../CONTRIBUTING.md)

### 桌面阅读位置与原生交接入口

2026-11-26 采纳。会话右栏用于只读文件、历史差异和项目目录。历史补丁按消息与文件标识，当前磁盘内容另开标签，同一路径在不同轮次可分别核对。项目目录沿用主进程的真实路径边界。双栏宽度与开合状态跨启动保存，文件标签、输入草稿和阅读位置按会话保存在本次应用进程中。

单条跨 Agent 交接首先展示目标原生端的续聊方式。CLI 恢复命令取自目标驱动，桌面登记依据独立的桌面会话 ID。完整账本、上下文和归档文件从“交接详情”打开；批量操作逐条保留结果。此入口取代此前默认打开右侧审计栏的做法。

### 桌面功能按需使用 Computer Use 验收

2026-11-22 采纳。按项目约定，Agent 先运行相关自动化测试，再按需从真实桌面入口验收受影响的功能。必须操作窗口才能复现的问题可提前定位。具体执行方式统一维护在 [Agent 测试流程](testing.md)。

### 桌面转换按源工作目录登记到目标 Agent

2026-11-22 采纳。本地会话按完整项目路径跨 Agent 分组，同名目录可属于不同项目。勾选多条时，每条独立转换并保留自己的工作目录与损耗账本。首次导出到某个 Agent 时，CoVerse 在该目录调用目标 CLI，由 CLI 建立原生项目会话记录。源目录已搬迁或无法辨认时，可单独打开会话并选择本机目录。目标 CLI 暂时不可用时保留引导包，桌面审计面板可重试同步。

Antigravity 的桌面登记补充了上述 CLI 流程。Windows 桌面版 2.34.0 与 `agy` 1.5.14 分别使用 `antigravity` 和 `antigravity-cli`。CLI 已返回会话 ID 时，桌面项目仍可能为空。桌面插件按工作目录匹配项目，用当前续聊窗口构造用户与助手的独立记录，写入版本号为 1 的会话数据库、标题和桌面项目索引。桌面进程退出时可能回写缓存的索引，CoVerse 因此等它退出后再登记。CLI 与桌面的会话 ID 分开保存，登记重试复用已有 CLI 会话，两个客户端之后各自保留新增对话。验收需从桌面项目侧栏打开记录，再用不含答案的问题检查目标是否能读取源历史。

### Codex 原生正文与续聊窗口分开读取

2026-11-22 在「开始 M3 阶段开发」核实，Codex 原会话与验证分支可以共用同一标题和项目。分页 rollout 的 `event_msg.item_completed` 提供桌面显示的消息、计划和文件变更；底层 `response_item` 还包含环境注入。选择分支时按 `history_base.thread_id` 查找父记录，按 `end_byte_offset` 和排他序号核对并取前缀。导入器保留原始记录和续聊窗口，桌面显示单独使用原生消息。每轮的文件增删统计要抵消同一行在多次补丁中的重复改写。

在 Windows Antigravity 2.34.0 上，带原生正文的 Codex 会话可直接登记本地桌面历史。CoVerse 内的 CLI 续聊仍在用户首次发言时注入对应窗口。M3 的三端验收比对原生消息 ID、角色、逐条正文、顺序、表格和每个文件的变更统计。目标客户端用文本展示文件清单，原始补丁保存在转换归档。

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

当前交付以用户回到目标 Agent 续聊为验收标准。CoVerse 生成与校验引导包，目标 CLI 持久化会话并返回原生会话 ID。后续可关闭 CoVerse，在同一工作目录使用目标 CLI 继续。

实现状态（2026-11-21）：

- 已实现有效窗口导出。Codex 读取替换历史，缺少替换历史时使用摘要并报告近似。Claude Code 支持主线可辨认的完整摘要；含尚未验证的保留片段会明确报错。Antigravity 优先使用覆盖步号列表，其次使用明确范围；覆盖范围缺失时使用检查点与后续步骤并记入近似。CLI 将这个窗口注入目标新会话，原始记录保存在归档中。
- 原生文件转换遍历全部已解析轮次。Claude Code 的兄弟分支、Codex 的回退前历史都可能进入同一份正文。
- 当前通用「归档并跳过不透明内容」会保留原始字节。专用的推理密文开关、整个导出包的去除及清理后工件的校验尚未实现。Codex 替换历史现在逐项解析，活动窗口中的不可移植压缩密文会阻断注入。
- 桌面从引用会话交接时使用聊天界面的消息投影，可能遗漏系统指令与可见推理。重建桌面新增轮次时，工具参数被写为 `{}`、结果被写为界面状态，已采集的历史与当时实际执行的工具活动需要区分。
- 连续交接可复用上一包的 CSR 轮次，但新损耗账本从空表开始，末跳报告无法代表整条链。[引导包构建器](../packages/core/src/session.ts) · [桌面 Handoff](../packages/ui/src/main/service.ts)

## 已验证经验

### 三家原生会话在桌面对话页的显示能力

截至 `db3182b`，以下为已通过适配器样本、桌面服务或 Windows Electron 窗口回归的行为。下文保留旧版缺口，便于追查历史会话为何显示不同。

| 内容 | 在 CoVerse 对话页可以做什么 |
| --- | --- |
| 文件与目录 | 点击用户或助手消息、变更卡、评审和交接包中的文件引用，按来源项目或归档打开只读查看器；目录可逐级浏览，行号范围会高亮。源文件移动后可手动定位。 |
| 差异与评审 | 展开 Codex 原生及旧式补丁、Claude Code 成功编辑的补丁和已收集的文件历史版本、Antigravity 检查点中可重建的差异。评审卡保留评论、引用和差异侧，可跳到引文。单侧快照会注明缺失信息。 |
| 工具与搜索 | 展开参数、命令、返回正文、失败和已有退出码，点击已记录的网页来源。Codex 的原生 UI 项与底层调用按 ID 对应，延迟返回仍属于原调用。实时对话及再次交接保留已收到的工具详情。 |
| 图片、文档与媒体 | 点击消息或工具结果中的图片、文本、PDF、音频和视频。Antigravity Walkthrough、工件版本和录像使用随历史保存的内容或对应会话的配套文件。 |
| 计划与任务 | 查看 Codex Plan 和任务列表、Claude Code 任务操作、Antigravity 任务边界及快照中的条目、状态和说明。 |
| 历史事件 | 按记录位置查看上下文压缩、系统和开发者消息、进度、通知、错误及未知内容提示。续聊窗口仍遵循源适配器的压缩边界。 |
| 分支与子会话 | 选择分支、跳回父消息、查看回退标记。Antigravity 可展开内嵌子轨迹，也可按外部父子会话 ID 查找已保存或本机登记的会话。 |
| 时间、模型与用量 | 查看来源给出的逐条时间、模型、耗时及用量，并区分消息、请求和会话累计口径。实时对话单独展示可读推理、工具活动和可恢复的变更。 |

已有导入记录可从原生文件或交接包升级显示，并保留随后在本地追加的发言。Antigravity 缺少配套记录时，可补选文件或选择“查看已有记录”；该视图会列出缺项并保持只读。预览本机文件时，文本上限为 8 MiB，支持的二进制媒体上限为 96 MiB。定位到的当前文件和保存的历史补丁可能属于不同版本。[历史消息映射](../packages/ui/src/main/history.ts) · [文件和历史恢复服务](../packages/ui/src/main/service.ts) · [窗口回归](../packages/ui/test/transcript-window.mjs)

#### 旧版缺口基线

2026-11-23 核对实现版本 `430135d`。下表描述从本地记录导入后，读者在 CoVerse 对话页能看到或打开的内容。Codex 有两条展示路径：存在原生已完成的用户消息项时优先采用原生时间线，否则与另两家共用通用消息映射。[Codex 原生时间线](../packages/adapters/adapter-codex/src/transcript.ts) · [历史消息映射](../packages/ui/src/main/service.ts) · [对话组件](../packages/ui/src/client/components/ThreadView.tsx)

| 内容 | 在 `430135d` 可观察到的缺口 |
| --- | --- |
| 文件、目录和行号引用（三家） | 用户消息按纯文本显示。助手 Markdown 可以生成链接，但没有按会话工作目录解析文件、打开编辑器或定位行号的操作。变更卡的路径只是文本。交接审计的文件列表也只显示路径和大小。[桌面接口](../packages/ui/src/shared/types.ts) · [审计面板](../packages/ui/src/client/components/InspectorDrawer.tsx) |
| 文件 diff 和行内评审 | Codex 已完成的原生文件变更能显示路径、净增删行数和更多文件，逐行补丁只留在源记录。Claude Code 的编辑工具输入不进消息卡，`file-history-snapshot` 只留在原始记录。Antigravity 的检查点文件差异、文件/差异评论和工件评论以未解码字段保留。三者都不能在对话里打开当轮 diff 或定位评论行。[Codex 文件变更用例](../packages/adapters/adapter-codex/test/adapter.test.ts) · [Claude Code 适配器](../packages/adapters/adapter-claude-code/src/index.ts) · [Antigravity 适配器](../packages/adapters/adapter-antigravity/src/index.ts) |
| 工具调用、命令和结果（三家） | 通用工具列表仅展示名称和状态，无法展开查看参数、文件内容、命令输出或失败正文。Codex 原生时间线可把命令及已有的汇总输出放进活动折叠区，与推理摘要、过程说明合并。一些搜索项只保留查询文字，没有结构化来源列表。 |
| 原生图片、文档与媒体 | 通用展示会把用户图片写成含 URL 的占位文字，助手原生图片块会被略过。Claude Code 的文本型文档展开为历史文字，其余未识别文档块归档。Antigravity 的媒体、工件快照及外部工具输出没有会话内预览；缺少 `full_output_uri` 引用的文件会导致导入报错。助手正文中直接写的 Markdown 图片走另一条渲染路径。 |
| 计划、工件与历史交互 | Codex 原生 Plan 可读，但与普通助手消息共用样式。三家工具形式的任务列表通常只剩工具名称和状态。Antigravity 的实现计划、Walkthrough、截图和浏览器录像在原生客户端可作为工件打开；CoVerse 缺少对应的工件与批注查看器，各项能否从某份数据库恢复取决于实际保存的字段和配套文件。[Antigravity 工件说明](https://antigravity.google/docs/artifacts) |
| 压缩、通知与历史错误 | 通用映射跳过系统和开发者轮次。Codex 的压缩或页面上下文、Claude Code 的系统边界、progress 和顶层 attachment、Antigravity 的通知、检查点和独立错误步骤均缺少对应的历史展示。Claude Code 放在普通消息里的摘要可能仍可读，但没有压缩边界标识。 |
| 分支、子会话与回退 | Claude Code 已解析的父子关系未传入消息卡，关联记录可能平铺在主线上。Codex 已支持在有原生时间线时按分支前缀和回退恢复正文，界面没有回退标记或跳回父消息的入口。Antigravity 遇到带子轨迹的步骤会在导入时报错，标为已撤回的普通轮次则没有界面标记。 |
| 时间、模型与用量 | 历史消息未展示逐条时间。通用导入使用回退时间，不向消息卡传入逐条模型或用量。部分 Codex 原生消息有轮次耗时。CoVerse 内新发言可以显示模型、用量和运行错误，但实时工具事件仍只有名称与状态，缺少详细参数、结果、diff 和单独的推理事件。[桌面消息与流式事件](../packages/ui/src/shared/types.ts) |

用三份经审核的基线样本分别调用适配器和桌面历史消息映射，均能在统一记录中找到读取工具返回的 `Hello from the sample.`，均无法在对话消息数据中找到这段返回值。Codex 和 Antigravity 显示 `read_file / completed`。Claude Code 的 `tool_result` 位于用户记录中，同一次成功读取在消息中显示为 `Read / called`。Antigravity 样本的系统通知、检查点和错误步骤也都未进入消息列表。此处核对了样本数据、桌面组件和 IPC，未在三个原生窗口逐项点验。[Codex 样本](../fixtures/codex/rollout-2026-11-17/sample.jsonl) · [Claude Code 样本](../fixtures/claude-code/transcript-sdk-0_3_326/sample.jsonl) · [Antigravity 样本生成器](../tools/fixtures/create-antigravity.py)

后续实现进展：

- `33315ed` 增加项目文件、目录与交接包文本文件的只读查看。Windows Electron 回归从两种消息角色打开了带空格的文件名并定位到引用行。
- `215ed06` 保留 Codex 原生变更的逐次补丁及旧式成功补丁事件。对话中可核对当时的增删行，包括当前磁盘上已经不存在的行。
- Claude Code 的成功 Edit、Write 可在关联的用户结果记录中携带 `toolUseResult.structuredPatch`。新建文件可能只提供完整新正文；覆盖文件在缺少旧正文和补丁时无法计算行数。应按返回记录显示，工具请求中的替换字符串不足以证明某一行实际被修改。[官方工具结果定义](https://code.claude.com/docs/en/agent-sdk/typescript#edit) · [适配器回归](../packages/adapters/adapter-claude-code/test/adapter.test.ts)

### 五条路线的目标续聊与 Antigravity 桌面回传

2026-11-23 在 Windows 用 Codex CLI `0.171.0-alpha.13`、Claude Code `2.1.121` 和 agy `1.5.14` 各创建专用原生会话。Codex ↔ Claude Code、Antigravity ↔ Claude Code、Antigravity → Codex 五条路线均在源项目中生成目标会话。另起目标 CLI，只提交会话 ID 与不含答案的问题，五条路线均取回源回执。首轮覆盖一问一答。随后用新的真实会话完成双轮复验，每份来源含四条消息，回执和标签分别来自两轮用户发言。五个目标均按指定顺序返回两项随机值。两批测试都核对了角色、顺序、逐条正文与源文件 SHA-256。CLI 登记使用既有的历史上下文注入流程。[真机测试入口](../tools/m31/native-handoffs.mjs)

CoVerse 开发版的导入窗口能按项目选中 agy CLI 来源，转到 Claude Code 后用户原文只显示一次，审计面板显示已同步。Antigravity Windows 桌面端从项目侧栏打开 Claude Code 转入的会话后，也答回了正确回执。额外在该桌面会话写入一个标记，再转给 Claude Code 和 Codex，两者均从自己的目标会话准确取回桌面新增的值。

Antigravity 的 CLI 文件以 `cascade_id` 命名，数据库内另有 `trajectory_id`。桌面退出后，最新提交可能仍在同名 WAL 中。本次回传的八个步骤及数据库各表内容与 SQLite 对同一份文件副本执行在线备份的结果一致。导入器使用校验后的 WAL 索引确定读取边界。该行为取代早期一律拒绝非空 WAL 的限制。[适配器支持范围](../packages/adapters/adapter-antigravity/README.md)

Windows 的 Antigravity 项目 URI 可能保留 8.3 短路径。匹配时对请求目录和登记目录都调用 `realpath`，命中后沿用已登记的 ID 与原始 URI。GitHub Windows runner 的 `RUNNER~1` 与 `runneradmin` 触发过重复建项目；回归用例用指向同一目录的两条路径验证该行为。

桌面文件预览和实时 diff 恢复也会同时遇到原生记录中的路径与系统解析后的路径。文件预览用最终文件的真实路径检查项目边界，实时 diff 恢复用真实目录比对目录列表、原生记录和运行项目。桌面测试用目录联接稳定复现两种拼写，并覆盖联接指向项目外文件时的拒绝结果。[桌面回归](../packages/ui/test/desktop.test.ts)

### Codex 桌面页面上下文可跨 writer 复用同一记录形状

2026-11-22 在 `0.169.0-alpha.11.1` 的一份原生 rollout 中复现缺少调用 ID 的导入错误。此前仅在 `0.171.0-alpha.13` 中识别桌面注入的页面上下文。修复后按记录结构识别，两种 writer 共享回归用例，普通工具结果继续校验调用关联。2026-11-26 在 `0.169.0-alpha.11.1` 与 `0.171.0-alpha.13` 的本地 rollout 中复现并核实同一结构的 `browser_tabs` 记录，一并纳入已验证桌面上下文名称集合。[Codex 适配器](../packages/adapters/adapter-codex/src/index.ts)

Windows 打包版从导入窗口引用了该原始会话，显示 295 条消息。关闭并重启后重新打开历史，重复导入仍指向同一会话，源文件 SHA-256 一致。另用真实 Codex CLI 建立含随机回执的测试会话，从桌面分别验证 Codex 原生续聊和转换到 Claude Code 后的续聊。退出 CoVerse 后直接运行 Claude CLI，使用目标会话 ID 再次取回相同回执。以上验证使用本机已登录的 CLI。

### 导入目录可以独立于会话正文刷新

2026-11-22 桌面端按 Agent 在用户数据目录保存标题、项目路径和文件标识等列表元数据。打开导入窗口时先读缓存，再根据路径、大小、修改时间和 SQLite 活跃状态刷新，Codex 的原生标题索引单独核对。实际导入仍从磁盘读取稳定快照。实测两种新增的 Codex 桌面 writer，相关格式约定见[适配器说明](../packages/adapters/adapter-codex/README.md)。

### 目标 Agent 可以独立接续已迁移的压缩窗口

2026-11-21 使用合成会话验证 Codex→Claude Code、Claude Code→Codex、Codex→Antigravity。首轮从源压缩窗口读取随机回执，第二轮直接调用目标 CLI 按同一会话 ID 取回回执。另核对了包内上下文排除仅供归档的旧消息。Antigravity 默认配置首次建会话返回空 ID，显式选用 `claude-sonnet-4-6` 后完成两轮。各项结论限于这三条实测路线。

### 一次性协议转换的快照开销与 SSE 分块

优化后复测同规模合成输入，同一进程预热 5 次、交替测量 15 次。可编辑管线中位数 52.14 ms，一次性转换 18.76 ms，目标数据与完整报告深比较相等。128 KiB 长行的 SSE 按 64 KiB 和 256 B 分块分别为 5.68 ms 和 6.19 ms。以上均为离线转换时间。

以下为优化前的测量。当前一次性请求和响应转换已采用共享转换上下文，SSE 按新到达的分块扫描换行。2026-11-21 在 Windows x64、Node 20.19.5 用内存合成输入测量。Responses→Chat 请求包含 2,048 条交替角色的文本消息，每条约 1 KiB，输入 JSON 共 2,268,105 字节。两组复用同一注册表、交替运行，预热 5 次，各取 15 次中位数。现有 `convertRequest` 为 49.90 ms；在同一转换上下文中直接调用现有解码器和编码器、保留一次完整源载荷、跳过编辑与回放用的快照及额外复制，为 16.95 ms。该样本的目标数据和完整报告深比较相等。这个对照仍经过 IR，仅验证纯文本跨协议的一次性转换。编辑后的导出、同协议回放与失败报告需分别验证。[转换管线](../packages/protocols/src/pipeline.ts)

同次环境下，一个含 128 KiB 文本增量的 Chat SSE 事件转 Responses，输入共 131,238 字节。预热 3 次，测量 11 次。按 64 KiB 或 256 B 切分相同字节时，消费整条输出流的中位数分别为 5.86 ms 和 47.99 ms。读取器在未遇到换行时会从头扫描累积缓冲区，分块还影响异步迭代次数。这组数据只描述长单行事件的分块敏感性，未测线上流量、内存峰值或各因素的独立耗时。[SSE 读取器](../packages/protocols/src/sse.ts)

### 在线网关能回放的摘要与可移植的上下文

2026-11-21 核对上游源码。CC Switch 的 Codex 兼容路径可以把自生成的摘要以带前缀的 base64 包装，在下次请求还原为文字。CLIProxyAPI 的部分执行器将生成的摘要封装为自有加密格式；共享展开逻辑按调用路径移除或保留其他来源的压缩项。这些往返依赖已知来源，不能证明网关能恢复第三方原生密文中的事实。[CC Switch 压缩转换](https://github.com/farion1231/cc-switch/blob/908a83edaf7b2c55b961ff1a31523735a417b6e9/src-tauri/src/proxy/providers/codex_compaction.rs) · [CLIProxyAPI 压缩转换](https://github.com/router-for-me/CLIProxyAPI/blob/f5c5681a8361c9da53e93c60b6507816eee7468b/internal/runtime/executor/helps/antigravity_compaction.go#L135)

相同的损坏历史也会触发不同策略。CC Switch 的 Codex→Chat 路线将无调用可配对的工具结果转为带标记的用户消息；sub2api 的 Responses→Anthropic 回归用例要求移除孤立结果和无结果的调用；CoVerse 的请求校验拒绝不完整配对。核对保真度时，应分别断言结果正文、角色与调用关联。[CC Switch 孤立结果处理](https://github.com/farion1231/cc-switch/blob/908a83edaf7b2c55b961ff1a31523735a417b6e9/src-tauri/src/proxy/providers/transform_codex_chat.rs#L1455) · [sub2api 配对用例](https://github.com/Wei-Shaw/sub2api/blob/328db26f450edbdf9f8d4344a3ea903ac6396842/backend/internal/pkg/apicompat/responses_to_anthropic_tool_pairing_test.go#L113) · [CoVerse 请求校验](../packages/protocols/src/validation.ts)

### 底层协议的空损耗账本不能证明跨协议语义等价

以下三项已在 2026-11-21 修复。工具参数中的超大整数沿 JSON 字节往返保留，Responses 完整响应保留消息分组，目标合并消息或近似映射终止原因均须显式授权并记账。修复前使用合成输入调用 `convertRequest` 和 `convertResponse` 复核了三种默认严格模式仍会成功、三类账本均为空的情形：

- Responses 的函数参数字符串 `{"order":9007199254740993}` 转成 Anthropic 的 `tool_use.input` 时变成 `9007199254740992`。原始参数文本在源报告中可查，目标对象使用 JavaScript 数值。[参数解码](../packages/protocols/src/validation.ts) · [工具消息编码](../packages/protocols/src/messages.ts)
- Responses 完整响应中两条独立的助手消息转成 Chat Completions 的同一条助手消息。两段文字与顺序保留，源消息边界只在原始报告中可查。[响应解码与编码](../packages/protocols/src/responses.ts)
- Anthropic 的结束原因 `refusal` 转成 Chat Completions 的 `content_filter`。依赖结束原因区分模型拒答和内容过滤的调用方，会得到不同分类。[结束原因映射](../packages/protocols/src/responses.ts)

### 会话压缩记录与推理密文需按原生类型辨认

- Codex rollout 的 `compacted` 可带文本 `message` 和替换历史 `replacement_history`。OpenAI Responses 服务端也能返回加密 `compaction` 项，其中可含后续任务所需的上下文和工具定义。处理推理密文时应检查原生记录类型，避免把这个项作为推理删除。[Codex 适配器](../packages/adapters/adapter-codex/src/index.ts) · [OpenAI Compaction](https://developers.openai.com/api/docs/guides/compaction)
- Claude Code 使用结构化摘要。适配器识别 `compact_boundary`、`isCompactSummary` 和旧式 `summary` 记录。同一会话中可另有 `redacted_thinking.data`，Anthropic 将该字段定义为加密推理。[Claude Code 上下文说明](https://code.claude.com/docs/en/context-window) · [Anthropic 消息类型](https://platform.claude.com/docs/en/api/typescript/messages/create)
- Antigravity checkpoint 包含摘要和会话快照。已验证的 SQLite/protobuf 子集中，`session_summary`、`code_change_summary` 等为文本，部分嵌套快照为字节字段。字节类型本身不足以判定加密。[Antigravity 压缩说明](https://antigravity.google/docs/commands/compact) · [已验证字段](../packages/adapters/adapter-antigravity/src/wire.ts)

### Claude Code 生成的标题可能出现在下一跳的输入中

2026-11-18 的连续迁移实测中，两份 Claude Code 来源记录都因 `ai-title` 阻断了引导包生成；修复后用相同的会话字节复验通过。修改导入器时，应覆盖目标 Agent 续聊后实际写出的记录，包括自动生成的元数据。[M3.1 实测报告](../tools/m31/REPORT-2026-11-18.md)
