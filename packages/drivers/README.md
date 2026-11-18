# CoVerse 执行驱动

`coverse drivers --json` 通过本机可执行文件的版本命令探测安装状态。`available` 表示能取得版本，`verifiedCapabilities` 只列出该版本已经通过真机验收的能力。账户、配额和模型可用性由每次实际执行确认。Windows 使用原生 EXE，macOS/Linux 使用 PATH 中的可执行入口；Windows 上也检查 agy 官方默认安装目录。

| 目标 | 首轮与追问入口 | 2026-11-18 真机结果 |
|------|---------------|--------------------|
| Codex | `codex exec --json`，按 ID 执行 `exec resume` | `0.169.0-alpha.11.1` 通过两轮；来源 Antigravity，5 项降级 |
| Claude Code | `claude --print --verbose --output-format stream-json --include-partial-messages`，按 ID 执行 `--resume` | `2.1.121` 使用 `claude-sonnet-4-6` 通过两轮，来源 Codex，4 项降级 |
| Antigravity | `agy --input-format stream-json --output-format stream-json`，按 ID 执行 `--conversation` | 独立 CLI `1.5.11` 通过两轮；来源 Claude Code，4 项降级 |

### 复现真机验收

在仓库根运行，每条命令只验证指定目标，使用仓库中的重建样本、独立工作目录和当前 CLI 登录态。常规 CI 离线运行。

```sh
pnpm build
node tools/m3-demo.mjs codex
node tools/m3-demo.mjs antigravity
node tools/m3-demo.mjs claude-code
```

首轮要求从历史工具结果引用 `Hello from the sample.` 并追加随机标记。第二轮只问上轮的标记，验收同时检查会话 ID、答案和成功终态。命令输出的证据目录包含版本清单、引导包与 LossLedger、两轮 JSONL、失败诊断或成功的 `result.json`。三条路线均有 0 项丢弃与 0 项近似。

### 运行契约

M3.1 专项新增空响应诊断。回合结束时既没有可见文本也没有工具活动会返回 `EMPTY_RESPONSE`。Antigravity 工具失败后既无后续恢复也无答复时会报告运行失败，诊断保留已取得的会话 ID。[失败样本与复验](../../tools/m31/REPORT-2026-11-18.md)

- `createDriverRegistry().get(id).run({ prompt, cwd, model?, session?, attachmentDirectory?, signal? })` 返回异步事件流。`session` 接受目标 CLI 已创建的会话 UUID。新插件提供命令构造、逐行解码和实测版本，在驱动注册表注册。
- `--json` 首次迁移先发出 `bundle`（报告路径和损耗计数），再输出 `session`、`text`、`tool`、`usage` 等事件。Codex 按完成的消息输出文本，Claude Code 和 agy 支持文本增量。用量包含统一的计数字段及厂商原始计数，含义与统计区间沿用目标 CLI。
- `done` 表示目标成功终态和退出码已确认。错误发往 stderr；已经输出的文字与会话 ID 可以保留。退出码沿用 CLI 约定，0 成功，1 I/O，2 参数或输入，3 驱动不可用、目标拒绝、取消、引导包校验失败或运行中断。
- 附件通过来源归档目录定位。驱动只在存在必要附件时传入额外目录，文件访问仍遵循目标 CLI 的权限配置。完整转写超过目标上下文窗口时返回目标诊断。
- Antigravity 使用独立 `agy` CLI。可从官方说明安装并登录。[安装说明](https://antigravity.google/docs/getting-started) · [无头模式和会话恢复](https://antigravity.google/docs/cli/headless/)
