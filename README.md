# CoVerse

**Agent 上下文无缝流转平台** —— 让你在任意 Agent 之间切换并继续工作，而不丢失上下文。

## 它解决什么问题

你正在用 Codex 写代码，中途想换 Claude Code 或 Antigravity 继续——各家 Agent 的会话格式互不相通，上下文迁移依赖手动复制粘贴。CoVerse 的目标是让上下文迁移成为可审计的转换过程。

## 核心能力（三层转换）

| 层级 | 职责 |
|------|------|
| 底层：消息协议 | Responses / Chat Completions / Anthropic Messages 等主流消息协议互转 |
| 中层：对话记录 | 首批仅 Codex、Claude Code、Antigravity 的会话记录导入导出与续接 |
| 顶层：模式规范 | 目标模式、计划模式、技能等工作模式的语义映射 |

平台只做**聚合与协议转换**，不做 Agent 分工、提示词工程。

会话格式适配器以**社区可贡献的插件**形式开发（各家格式无文档且随版本变动）。

## 文档

- [DESIGN.md](DESIGN.md) —— 可行性分析、难点与方案、工程架构、里程碑规划
- [AGENTS.md](AGENTS.md) —— 工程协作规范（所有贡献者与 AI Agent 必读）

## 状态

M1 底层协议转换已实现：三协议请求、响应及 SSE 的已测试子集互转。能力和限制见 [protocols 说明](packages/protocols/README.md)，路线图见 [DESIGN.md §5](DESIGN.md)。

M2 已实现 **Codex、Claude Code、Antigravity 三个独立插件的已验证格式子集**，采用 `来源 → CSR → 目标引导包` 的 2 × N 架构。九种来源/目标组合均有集成测试。引导包保留全文、CSR、原始工件和损耗账本，不自动摘要或裁剪；原生会话合成与自动续聊尚未实现。

| 插件 | 首批格式依据 | 限制说明 |
|------|-------------|----------|
| Codex | `rollout-2026-11-17`，writer `0.169.0-alpha.11.1`，JSONL / JSONL.zst | [格式子集与加密内容限制](packages/adapters/adapter-codex/README.md) |
| Claude Code | `transcript-sdk-0_3_326`，官方 SDK reader 实测的重建 transcript | [分支、版本与验证边界](packages/adapters/adapter-claude-code/README.md) |
| Antigravity | `sqlite-2_32_1-step0`，2.32.1 本机 SQLite / protobuf 字段验证 | [稳定快照、外部输出和不透明内容限制](packages/adapters/adapter-antigravity/README.md) |

能力清单不是“所有该版本会话均可转换”的承诺。未知语义、加密推理、缺失关联数据可能使导出明确失败；原始数据已归档不等于语义已恢复。插件扩展约定见 [适配器开发说明](packages/adapters/README.md)。

## 本地开发

在本 README 所在的 git 仓库目录运行，要求 Node.js ≥ 20.19，pnpm 10.34.9：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm coverse adapters --json
pnpm coverse doctor
pnpm coverse protocols --json
```

如果本机 pnpm 启动器不可用，可将命令中的 `pnpm` 换成 `npx --yes pnpm@10.34.9`，无需修改全局安装。

`pnpm check` 依次构建所有包、严格类型检查、运行 Vitest、校验 fixtures 清单及摘要、执行协议和会话管线冒烟测试。`pnpm test` 与 `pnpm smoke` 使用构建后的包，新克隆或修改包代码后先执行 `pnpm build`。CLI 运行构建后的原生 ESM。

核心定义 CSR v1、消息/请求/响应/事件 IR、FileSet、LossLedger 和插件契约。`protocols` 实现格式 codec 与转换，`modes`、`drivers` 仍为占位，`ui` 留待 M4。

## 会话转换 CLI

先运行 `pnpm build`，输出父目录须已存在，输出目录必须不存在：

```sh
node packages/cli/dist/bin.js convert-session --from auto --to claude-code --input fixtures/codex/rollout-2026-11-17/sample.jsonl --output .tmp/codex-to-claude
```

`--from` 接受 `auto` 或明确的插件 ID；探测不足或有歧义时失败。`--input` 可重复，可以指定包含单一会话文件集的目录；目录内相对路径会保留。不要同时指定同一会话的明文和压缩副本。数据库旁的 WAL/journal 会一并检查，非空时须先提供一致快照。会话命令不使用 stdin/stdout 传输原始记录。

引导包包含 `context.md`（完整历史转写）、`session.json`（CSR 与来源引用）、`report.json`（损耗、诊断、字符/字节统计）、`source/`（输入原始字节）和 `manifest.json`（工件 SHA-256）。将完整引导包带入目标 Agent 的新对话，并读取 `context.md` 与所引用附件。此步骤由用户完成，CoVerse 不启动 Agent、不执行历史工具、不保证目标端不会再次压缩。

历史角色、工具及推理的明确转写默认允许，并逐项报告；无法解释的语义、缺失附件等不自动放行。全部工件校验后暂存，独占创建目标目录，最后发布 manifest；失败会清理本次创建的目录，已有输出绝不覆盖。stdout 返回 JSON 结果摘要，stderr 返回结构化诊断。退出码：`0` 成功、`1` I/O/内部错误、`2` 参数或输入结构错误、`3` 能力/保真度不足、输入变化或取消。

引导包包含原始会话，不是脱敏样本，不能提交到仓库。临时输出请放在 `.tmp/` 或 `.local/`。

## 协议转换 CLI

先运行 `pnpm build`，使用纯 Node 命令，确保 stdout 不含包管理器提示：

```sh
node packages/cli/dist/bin.js convert-protocol --from responses --to anthropic-messages --kind request --input fixtures/protocols/responses/m1-2026-11-17/request.json --output .tmp/request.json --report .tmp/report.json
```

输出目录须已存在。`--input -` / `--output -`（默认）使用 stdin/stdout；请求和响应用 JSON，`--kind stream` 用原生 SSE。`--target-model` 和 `--max-output-tokens` 显式指定目标参数。`--report` 单独保存来源、保留数据和损耗，不混入正文。

默认严格转换。降级须使用 `--policy allow-loss --report <file>`，按需加 `--allow-role-merge`、`--reasoning-as-text`、`--candidate-index <n>` 或可重复的 `--omit <诊断中的JSON指针>`。仅设置 allow-loss 不会自动丢字段。

退出码：`0` 成功；`1` 文件/I/O/内部错误；`2` 参数或非流式输入错误；`3` 能力不足、损耗不被允许、流式失败或取消。诊断走 stderr。文件转换失败不替换已有目标；stdout 流可能有部分输出，此时仍返回非零并报告失败。报告含原始内容，不能作为已脱敏样本提交。

## 样本采集与脱敏

```sh
pnpm fixtures:collect --help
pnpm fixtures:check
```

三家保留原有脚手架样本，并新增有验证依据的 M2 原生结构重建样本；`fixtures/protocols/` 另有三协议的请求、响应及 SSE 合成基线。采集工具处理显式指定的 UTF-8 JSON/JSONL 文件，输出结构脱敏后的文件与修改计数清单，写入被忽略的 `.local/fixtures/`，经人工审核后才能入库。原始会话不会自动提交。详见 [fixtures 说明](fixtures/README.md)。

## CI

[CI 配置](.github/workflows/ci.yml) 覆盖 Windows/Linux 与 Node 20/22，固定依赖安装后运行 `pnpm check`。当前远端为 Gitee，GitHub Actions 配置不会在 Gitee 自动执行；Gitee 自建流水线应使用同一检查命令。

## License

TBD
