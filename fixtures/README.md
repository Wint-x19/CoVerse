# Fixtures：样本来源与提交规则

会话样本目录为 `codex`、`claude-code`、`antigravity`；独立的 `protocols/` 存放 M1 消息协议样本，不增加 Agent 适配范围。

`*/synthetic-v1/` 是手写合成的**脚手架测试基线**，不来自个人会话，也不宣称符合任何原生 Agent 格式。用于验证文件装载、摘要校验和通用脱敏工具。M2 的三家原生结构重建样本位于独立基线目录，见下文。

## 采集明确指定的本地文件

```sh
pnpm fixtures:collect --agent codex --format-version unverified --name sample-01 --format jsonl --input /path/to/session.jsonl
```

可以重复 `--input` 收集同一会话的多个文件。工具只接受总计不超过 10 MiB 的 UTF-8 JSON/JSONL，拒绝二进制、压缩、无效编码和无效 JSON；不扫描个人目录，不解压、不猜测 Agent 格式。不同格式分开采集。FileSet 核心仍支持任意字节。

输出固定落在被 git 忽略的 `.local/fixtures/<agent>/<format-version>/<name>/`；已存在的采集目录不会覆盖。原始文件只读，源文件名和路径不进入 manifest，输出采用中性文件名，SHA-256 只基于脱敏后内容计算。

## shape-only-v1 脱敏策略

- 所有字符串值替换为顺序别名，只有明确的 `role` / `type` 通用枚举保留。同一次采集跨文件相同字符串得到相同别名，反向映射只存于内存。
- 未知键名也替换，避免工具参数、动态对象键泄漏信息；结构键名仅保留小型白名单。
- 数值统一变为 `0`，布尔值变为 `false`，`null` 与数组/对象结构保留；空行移除并计数。
- manifest 按文件记录各类修改数量，始终标记 `reviewRequired: true`、`nativeFormatVerified: false`。

这是有意改变内容的采样工具，**不属于无损会话转换，也不能保证脱敏后仍可被原生 Agent 读取**。原生格式回归样本需要后续在对应插件内构造有效的合成 ID、时间戳等字段。大文件、压缩和数据库采集延后到对应插件实现。

人工检查脱敏内容、结构、数量及元数据后，才可将审核后的文件复制到 `fixtures/<agent>/<已验证格式版本>/`，更新 manifest 的审核与原生验证标记及摘要。不要强制添加 `.local/` 或真实用户会话。结构和长度也可能含信息，因此自动脱敏不能代替人工审核。

`pnpm fixtures:check` 验证已提交样本的目录归属、审核标记、JSON/JSONL 可解析性、SHA-256 和文件清单。摘要检测意外漂移，不证明原生格式兼容或无敏感信息。

## M2 原生结构重建样本

`codex/rollout-2026-11-17`、`claude-code/transcript-sdk-0_3_326`、`antigravity/sqlite-2_32_1-step0` 使用独立编写的文本和标识符，`provenance: reconstructed`。清单记录结构验证依据，不能把它们与旧 `synthetic-v1` 占位样本混淆。

Codex 的明文及 zstd raw-block frame 验证解压语义等价；Claude 样本由官方 SDK reader 实际读取验证；Antigravity 数据库由 `tools/fixtures/create-antigravity.py` 使用 Python 标准库 SQLite 和独立 protobuf 编码重建，字段事实对照本机 2.32.1 发布程序。生成器拒绝覆盖已有基线。

校验器新增 JSONL.zst 和 SQLite 的文件头/摘要/清单检查；完整解析与语义由各插件测试和九条转换链路的集成测试验证。`nativeFormatVerified` 在这些目录仅表示清单中列出的结构依据，不表示原生导出/续接或整个 Agent 版本全面兼容。

原通用采集器仍只接受 JSON/JSONL；不能把数据库或 protobuf 交给 shape-only 脱敏后宣称有效。真实二进制记录不自动入库；M2 只提交完全重建的二进制样本。

## M1 协议样本说明

`protocols/<protocol>/m1-2026-11-17/` 每个目录包含 request.json、response.json、stream.sse 和 manifest.json。全部内容均为 synthetic，不来自个人会话或 API 抓包。SSE 从审阅的合成 Chat 事件生成，另有独立手写的三协议事件测试约束生命周期。

Manifest 记录 protocol、能力基线、公开规范链接、审核标记、每份文件的 kind / format / SHA-256。校验器验证请求、响应、SSE 完整生命周期、摘要和完整清单；原有会话样本校验保持独立。基线表示 CoVerse 的测试子集，不声称完整 API 或某 Agent 原生版本已验证。
