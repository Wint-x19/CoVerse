# M3.1 会话迁移评测

[2026-11-18 首轮报告](./REPORT-2026-11-18.md) · [可机器读取的首轮结果](./results/2026-11-18.json)

2026-11-19 在 Antigravity CLI 1.5.11 上单独复验换模。此前返回 503 的 Sonnet → Gemini Flash Low 路线、Gemini Flash Medium 同模型对照和 Medium → Low 路线均通过。三个新会话的六轮都收到原生 `SUCCESS`，每次追问均在原会话答对标记。[复验记录](./results/2026-11-19-antigravity-switch.json)

## 运行与证据

在已登录三种 CLI 的机器上，以下命令为五条跨 Agent 路线创建真实来源会话。测试从 CoVerse 桌面服务的本机会话列表找到来源，经过导入或当前会话的切换入口，最后另起目标 CLI 进程，按目标 UUID 追问。每条路线核对角色、正文、工作目录、源文件 SHA-256 和随机回执。Windows 上的 Claude Code → Antigravity 还要求完成桌面项目登记，请先退出 Antigravity 桌面客户端。结果与测试工作区保存在仓库忽略的 `.tmp/native-handoffs-*/` 下。

```sh
pnpm build
node tools/m31/native-handoffs.mjs --live
node tools/m31/native-handoffs.mjs --live antigravity:codex
```

三个客户端默认使用本机模型设置。可用 `COVERSE_TEST_CODEX_MODEL`、`COVERSE_TEST_CLAUDE_MODEL`、`COVERSE_TEST_AGY_MODEL` 指定当前账号可用的模型。测试会在各客户端留下专用原生会话。

在仓库根目录使用已锁定的依赖。离线入口运行协议、适配器、驱动和专项回归，再启动可控子进程验证九个方向。完整的 `pnpm check` 已包含这些断言。

```sh
pnpm build
pnpm eval:m31:offline
pnpm eval:m31:live --live --campaign second --scenario paired --route codex:claude-code --seed 17
pnpm eval:m31:live --live --campaign second --scenario all
```

真机使用对应 CLI 当前的本地登录态。两个种子为 17 和 53。可选场景有 `source`、`paired`、`length`、`switch`、`capability`、`relay`。配对可以选 `--route 来源:目标`，长度和工具按该方向的目标端运行，采集按来源运行。三端接力固定为 Codex → Claude Code → Antigravity。源码采集只按本次创建的 UUID 查找会话；检验原始记录所用的读写器版本与所属客户端分别记录。

每个 campaign 在 `.tmp/m31/<名称>/` 下保存轮次配额、每轮输出、目标会话 ID、模型用量、输入摘要、目录快照和诊断。每轮限定四分钟。首次运行后相同参数重用已有证据；改变实验使用新名称。每组使用独占配额文件，总额 120 个显式模型轮次，包含超时和错误。厂商客户端内部重试不计为另一个显式轮次。正文上限采用 UTF-8 字节数除以 4 的粗估，最大为 128 × 1024，实际分词和工具开销由服务决定。

如果要重复首轮的专项复验，在同一 campaign 完成各场景后运行下列命令。报告命令的 `--offline` 参数取离线命令输出目录中的 `results.json`。导出的 `summary.json` 包含各轮结果分类和答题指标，原文与账户信息留在本机。

```sh
pnpm eval:m31:live --live --campaign second --scenario retest
pnpm eval:m31:live --live --campaign second --scenario verify-tool
node tools/m31/report.mjs --campaign second --offline .tmp/m31-offline/<运行目录>/results.json
```

## 评测口径

- **样本与对照。** 两个独立标注的案例包含提议、更正、撤销、保留约束和未知费用。三种受支持的原生记录形状由测试编码器独立构造，源数据和答案均为虚构。每条路线的两组使用相同提问、模型和初始空目录。注入组实际调用 CoVerse 转换及运行入口，直接对照组用角色加原文的模板输入等价历史；顺序由路线及种子的散列决定。另建真实客户端会话检验可导入性，二次迁移读取 B 写出的真实记录。答案在工作目录外，题目要求不用工具；服务调用记录与驱动事件可用于检查工具使用。
- **语义。** 三个角色轮次产生七个字段：当前货物、最终端口、更正者、保留区域、撤销方案、未知费用与组合标签。按字段匹配，忽略大小写和数字类型，未知值接受语义等价表达。未输出、错误值、额外字段分别计数。只有首轮终态成功且字段全对，第二轮按同一 ID 返回精确标签，才计入端到端完成。每个分数均保留原分母，包括被首轮失败阻断的后续任务。
- **长度。** 题内证据出现在首、中、尾，干扰批次具有相似字段。第五项要求用首尾印记组成字符串。严格字段分和等价表达复核分同时保留。复核接受 `head_stamp`、`start_stamp`、嵌套的 `start.stamp` 等同义字段；直接输出字面量 `head/tail` 无法得到组合分。只在实际观察到压缩事件时记录显式压缩。缺失事件、超时或供应商零用量均不能用于推算压缩率。
- **工具和角色。** 真值边由分支祖先、调用 ID、实参、返回值和错误状态组成，按边计算精确率／召回率。两套只读 MCP 服务的同名 `lookup` 具有不同 schema 和随机回执，以服务侧日志判定是否实际调用。Skill 的“历史列出”“目标实际调用”“读出新版本参考标记”分别记录。只在临时工作区或单个子进程配置测试服务，沿用目标的授权裁决。
- **损耗。** 每项预期损耗指定类别、位置、代码和原因的语义。已支持正例检查误拒，负例要求指定错误。M1 的消息请求、SSE 参数、签名、角色与上下文超限错误另跑协议层回归。M3 的正式注入路径以同一份引导包完成来源工件、CSR、转写、子进程 stdin 和事件验证。

## 风险来源

| 公开证据 | 本项目的验证 |
|---|---|
| 记忆更新、时间关系与未知信息的拒答。[LongMemEval](https://arxiv.org/abs/2410.10813) | 旧值与新值同时保留，核查最新决定、人员归属与拒答。 |
| 长文位置影响和有效上下文跨度。[Lost in the Middle](https://arxiv.org/abs/2307.03172) · [RULER](https://arxiv.org/abs/2404.06654) | 四档长度、三个位置、组合任务，报告实际 token 与未完成原因。 |
| 中断后调用缺结果、换模型后密文被拒。[Claude Code #18880](https://github.com/anthropics/claude-code/issues/18880) · [Codex #17541](https://github.com/openai/codex/issues/17541) | 截断行与完整但未完成的调用分别处理，测试加密块、签名、按 ID 换模型。 |
| Skill 目录和渐进加载、压缩后的技能可见性、MCP 结构化输出与资源引用。[Agent Skills](https://agentskills.io/specification) · [Claude Code #74990](https://github.com/anthropics/claude-code/issues/74990) · [MCP 工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | 版本标记、相对引用、工具缺失与错误回执分别取证。 |
| Antigravity 发布记录包含模型切换后的签名问题以及错误步骤记录修复。[更新记录](https://antigravity.google/docs/changelog) | 观察原生终态、错误步骤、切换后的输出和 CoVerse 退出状态。 |

公开 issue 是历史个案。哪些问题在当前安装版本上复现，以首轮报告中的本地受控证据和真机记录为准。
