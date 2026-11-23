# Claude Code 会话适配器

M2 基线 `transcript-sdk-0_3_326`：导入原生会话 JSONL 与显式提供的关联 JSONL，导出完整注入式引导包。nativeResume 为 false。

验证依据：官方 npm 发布包 `@anthropic-ai/claude-agent-sdk@0.3.326` 的 transcript reader 与 SessionMessage 定义。独立重建的四条消息通过该 SDK 的 `getSessionMessages` 实际读取验证，摘要见 fixture manifest。测试不依赖安装 SDK，不执行 Agent、不调用模型。

本机没有个人会话样本，不能将安装版本当作全面兼容性证据。重建样本 writer 标签为 `2.1.121`，仅接受此标签或无标签且符合已验证结构的记录；能力声明是 reader 验证的格式基线，不保证该版本所有事件类型均受支持。

保留全部分支和原始记录；parentUuid、分支、子会话分别标注，不仅选择最后一个叶节点。工具结果须引用祖先调用；缺失父记录、循环、同 UUID 不同内容、未知 writer 明确拒绝。progress/system/attachment 原生记录以完整 JSON 历史转写并记录降级。未知消息块（包括 redacted_thinking）留存原文但阻止引导包导出。

对话页按调用展示工具输入、结果、错误、附件与网页来源。成功的 Edit 或 Write 可展示返回的结构化补丁，文件历史检查点可对比已取得的对应备份。单独的写入请求无法证明最终变更；原文或备份缺失时，展示现有记录和缺失提示。消息中的原生图片、受支持的文档、任务进度与用量可独立查看。[适配器回归](test/adapter.test.ts)
