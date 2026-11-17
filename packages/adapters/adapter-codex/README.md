# Codex 会话适配器

M2 基线 `rollout-2026-11-17`：导入 JSONL / JSONL.zst，导出完整注入式引导包；不生成原生会话，不宣称 native resume 或 F3。

验证依据：2026-11-17 只读观察本机 writer `0.169.0-alpha.11.1` 的记录结构，并核对 [官方 rollout 实现](https://github.com/openai/codex/tree/main/codex-rs/rollout)。仅此 writer 列入首批验证；其他 writer 明确拒绝。测试样本独立重建，未复制个人消息。

映射 message、函数与自定义工具调用/结果、可读 reasoning、原始指令、turn_context、compacted、回退标记。response_item 为消息来源，重复 UI 事件只归档。原始记录和字段始终保留；未知语义内容与加密 reasoning 阻止引导包导出。可读摘要不代表加密部分已恢复。工具引用损坏、截断行、多份 rollout、缺失附件明确失败。

Zstd 回归样本使用标准 raw-block frame；解码使用 fzstd，不依赖本机压缩程序。压缩前后 CSR 正文等价，归档保持输入原始字节。
