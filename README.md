# CoVerse

**Agent 上下文无缝流转平台** —— 让你在任意 Agent 之间切换并继续工作，而不丢失上下文。

## 它解决什么问题

你正在用 codex 写代码，中途想换 Claude Code 继续、或把会话交给 zcode / dsh 接手——各家 Agent 的会话格式互不相通，上下文迁移靠人肉复制粘贴。CoVerse 把这件事变成一次拖拽。

## 核心能力（三层转换）

| 层级 | 职责 |
|------|------|
| 底层：消息协议 | Responses / Chat Completions / Anthropic Messages 等主流消息协议互转 |
| 中层：对话记录 | codex、claude-code、dsh、zcode 等会话记录的导入导出与跨 Agent 续接 |
| 顶层：模式规范 | 目标模式、计划模式、技能等工作模式的语义映射 |

平台只做**聚合与协议转换**，不做 Agent 分工、提示词工程。

会话格式适配器以**社区可贡献的插件**形式开发（各家格式无文档且随版本变动）。

## 文档

- [DESIGN.md](DESIGN.md) —— 可行性分析、难点与方案、工程架构、里程碑规划
- [AGENTS.md](AGENTS.md) —— 工程协作规范（所有贡献者与 AI Agent 必读）

## 状态

🚧 项目处于 M0 阶段（脚手架），路线图见 [DESIGN.md §5](DESIGN.md)。

## License

TBD
