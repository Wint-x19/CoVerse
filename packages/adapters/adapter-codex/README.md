# Codex 会话适配器

M2 基线 `rollout-2026-11-17`：导入 JSONL / JSONL.zst，导出完整注入式引导包；不生成原生会话，不宣称 native resume 或 F3。

已核对的 writer 为 `0.167.0-alpha.4.1`、`0.169.0-alpha.11.1`、`0.169.1` 与 `0.171.0-alpha.13`。在 `0.169.0-alpha.11.1` 与 `0.171.0-alpha.13` 的原生记录中均观察到桌面注入的页面上下文。适配器按 `agent` 命名空间、已验证的记录名称、缺省调用 ID 和文本输出识别这些记录，逐条保留文本并记录降级。未知 writer 的诊断包含实际版本号。回归样本独立重建。

映射 message、函数与自定义工具调用/结果、可读 reasoning、原始指令、turn_context、compacted、回退标记。response_item 为消息来源，重复 UI 事件只归档。原始记录和字段始终保留；未知语义内容与加密 reasoning 阻止引导包导出。可读摘要不代表加密部分已恢复。工具引用损坏、截断行、多份 rollout、缺失附件明确失败。

Zstd 回归样本使用标准 raw-block frame；解码使用 fzstd，不依赖本机压缩程序。压缩前后 CSR 正文等价，归档保持输入原始字节。
