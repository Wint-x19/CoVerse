# CoVerse 可行性分析与工程设计

> 状态：v0.1 草案（2026-11-15）。本文档是工程实施前的分析基线，随实践修订。
> 配套规范见 [AGENTS.md](AGENTS.md)。

---

## 1. 结论先行

| 层级 | 可行性 | 判断 |
|------|--------|------|
| 底层：消息协议互转 | ★★★★★ | 三大协议（Responses / Chat Completions / Anthropic Messages）均有公开规范，纯工程问题 |
| 中层：会话记录互转 | ★★★★☆ | 完全可行，但本质是**持续维护的逆向工程**，成败在插件体系与金样本测试，而非单次解析 |
| 顶层：模式规范映射 | ★★★☆☆ | 部分可行，语义映射天然有损，需能力模型 + 显式降级，不能承诺无损 |
| 平台聚合（选 agent 直聊） | ★★★★☆ | 各家 CLI 均支持 exec 模式且复用用户本地登录态，平台不经手密钥，可行 |

总体判断：**项目可行，且真正的护城河不是某个解析器，而是"适配器生态 + 保真度纪律"**。最大的技术风险点在"原生续接合成"（见 §4-D），采用注入式引导兜底后风险可控。

---

## 2. 本机格式侦察证据（2026-11-15 实测）

| Agent | 存储位置 | 形态 | 关键观察 |
|-------|----------|------|----------|
| codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl(.zst)` | JSONL，部分 zstd 压缩 | 行结构 `{timestamp, ordinal, type, payload}`；type 含 `session_meta` / `event_msg` / `response_item` 等；带 turn_attribution（turn_id 树）；另有 `session_index.jsonl` 索引、多个 sqlite（state/goals/memories） |
| dsh | `~/.dsh/sessions/<双横线编码项目路径>/session-<uuid>/session.v4.jsonl.zstd` | 每会话一目录，zstd 压缩 | **文件名自带版本号 v4**——格式作者自己也在版本化，印证"随版本变动"；项目路径编码方式与 claude-code 同源（`--C-Users-...--`） |
| zcode | `~/.zcode/v2/`（tasks-index.sqlite、workspace/、runtime/） | **SQLite + 目录混合** | 会话很可能在 sqlite/内部存储中，非明文 JSONL，逆向成本四者中最高 |
| claude code | 本机未安装 | （已知：`~/.claude/projects/<编码路径>/<uuid>.jsonl`） | 社区资料最多、格式最广为人知的 agent，作为首个适配对象风险最低 |

三点推论：

1. **异构性是常态**：明文 JSONL / zstd 压缩 / SQLite 混合存储。适配器接口必须以"字节/文件集"为输入，而非假定"一个明文 JSONL 文件"。
2. **版本化不可避免**：dsh 已到 v4；codex 的 payload type 体系随版本增删。适配器必须声明 `supportedVersions` 并做版本探测。
3. **金样本唾手可得**：开发者本机就是语料库。测试语料采集工具应从第一天就位。

---

## 3. 核心难点与解决方案

### A. N×N 转换爆炸
**难点**：k 个 agent 两两互转需 k(k-1) 个转换器，且每加一家成本平方级增长。
**方案**：**IR 枢纽模型**（hub-and-spoke）。定义 CoVerse 会话中间表示（CSR），一切转换走 `源 → IR → 目标`。k 个适配器自动获得 k×k 能力。这是整个架构的第一性决策。

### B. 无文档且漂移的格式
**难点**：会话格式无官方文档，随 agent 版本静默变动。
**方案**：四位一体——
1. **插件化适配器**（AGENTS.md 已定）：核心零 agent 依赖；
2. **金样本语料库（fixtures）**：从真实会话采集→脱敏→入库，每次格式变动先落一条新金样本再修代码；
3. **容错解析**：已知字段精确建模，未知字段**原样保留**在 IR 的 `raw`/`x-*` 区，解析永不因未知内容崩溃；
4. **漂移监控 CI**：对金样本做 round-trip 回归，agent 升级后跑一遍即可发现格式变化。

### C. "无损"在跨 agent 时理论上不可达
**难点**：工具调用语义、thinking 块、todo/计划结构、子代理链各家互不对应，严格无损是伪命题。
**方案**：**保真度分级 + 损耗账本（Loss Ledger）**，把"尽可能无损"工程化：

| 级别 | 名称 | 含义 |
|------|------|------|
| F3 | 同构等价 | import→export 回同一 agent，语义无损（raw 保留保证） |
| F2 | 跨 agent 语义完整 | 全部内容块保留，仅元数据降级，账本记录 |
| F1 | 语义降级 | 如工具调用历史叙述化为文本，账本记录 |
| F0 | 上下文引导 | 摘要 + 转写注入新会话（兜底通道，永远可用） |

每次转换必须返回 LossLedger（`dropped / downgraded / approximated` 三列表），UI 呈现给用户——**降级显式化是产品承诺，静默丢失是缺陷**。

### D. 续接机制：目标 agent 只认自己的会话文件
**难点**：用户要的不是"导出 JSON"，而是"在 B agent 里继续聊"。但 B 通常只能 resume 自己写的会话。
**方案**：双通道，**injection-first**：
1. **注入式引导（主通道，M2 即交付）**：将 A 的会话转写+结构化摘要组装为引导上下文，在 B 中开新会话注入。对格式变动免疫，永远可用；
2. **原生会话合成（增强通道，M5 按插件能力提供）**：直接产出 B 格式的会话文件供其 `resume`（如 codex resume / claude --resume）。体验最佳但最脆——agent 升级可能拒绝合成文件，故仅作为适配器 `capabilities.nativeResume` 可选项，失败自动回退注入式。

### E. 上下文 = 会话 + 工作区
**难点**：会话引用磁盘文件状态（改了哪些文件、cwd、git 分支）。脱离工作区的会话转写失去 grounding。
**方案**：IR 顶层携带工作区指针（cwd、VCS 信息）；续接操作默认在**原工作区目录**发起目标 agent；后期可将会话与工作区快照打包为"会话档案（session bundle）"。

### F. 大上下文注入超窗
**难点**：长会话全文注入可能超出目标模型上下文窗。
**方案**：注入器分层组装——身份/任务摘要（必有）→ 关键决策与结论（必有）→ 完整转写（按预算裁剪）；超窗时明确告知用户裁剪了什么（进 LossLedger）。

### G. 调用各家 agent（认证/流式/模型选择）
**方案**：Driver 抽象（同样插件化）封装各家 CLI 的 exec 模式，复用用户本地登录态（codex/claude 均如此），平台**不经手任何密钥**。流式输出统一归一为 IR 事件流。

### H. 法律与社区
**方案**：只读写用户本地文件；适配器代码社区贡献、不随核心分发任何专有样本；金样本入库前强制脱敏。

---

## 4. 工程架构

### 4.1 技术栈（建议，待拍板）

- **语言**：TypeScript（JSON/JSONL 原生生态、CLI 与 Web 同构、社区贡献门槛低）；性能敏感处后期可下沉 Rust，接口留缝。
- **Monorepo**：pnpm workspace，统一版本与 CI。
- **测试**：Vitest + 金样本回归；round-trip 属性测试。

### 4.2 目录设计

```
CoVerse/                        ← git 仓库根（AGENTS.md 硬性规定）
├── package.json / pnpm-workspace.yaml
├── packages/
│   ├── core/                   # CSR 中间表示 + 转换管线 + LossLedger（零 agent 依赖）
│   ├── protocols/              # 底层：responses / chat-completions / anthropic-messages 互转
│   ├── adapters/               # 中层插件：每 agent 一个独立包
│   │   ├── adapter-codex/
│   │   ├── adapter-claude-code/
│   │   ├── adapter-dsh/
│   │   └── adapter-zcode/      # sqlite 逆向，难度最高，靠后
│   ├── modes/                  # 顶层：目标/计划模式、技能规范映射
│   ├── drivers/                # agent 执行驱动（CLI 封装、流式归一）
│   ├── cli/                    # 命令行入口（先于 UI 交付）
│   └── ui/                     # Web 前端（M4 起）
├── fixtures/                   # 金样本语料库（脱敏后，按 agent/版本归档）
└── tools/                      # 采集/脱敏/漂移对比 CLI 工具
```

### 4.3 核心接口（草案）

```ts
// —— CSR：CoVerse Session Record（IR）——
interface CSR {
  meta: { id; agent; agentFormatVersion; cwd; vcs?; model?; createdAt };
  turns: Turn[];          // content blocks: text | reasoning | tool_call | tool_result | attachment
  xExtensions: Record<string, unknown>;  // agent 特有语义（x-codex-* 等）
  raw?: unknown;          // 原始记录保留 → F3 同构往返与审计的基础
}

// —— 会话适配器（中层插件契约）——
interface SessionAdapter {
  id: string;                                  // 'codex' | 'claude-code' | ...
  detect(input: FileSet): number;              // 识别置信度 0~1
  supportedVersions: string[];
  import(input: FileSet): { session: CSR; ledger: LossLedger };
  export(session: CSR): { artifacts: FileSet; ledger: LossLedger };  // FileSet：多文件/目录/压缩
  capabilities: { nativeResume: boolean };     // 是否支持原生会话合成
}

// —— 执行驱动 ——
interface AgentDriver {
  id: string;
  listSessions(): SessionRef[];
  run(opts: { prompt; model?; cwd; resumeFrom? }): AsyncIterable<IREvent>;  // 流式归一
}

// —— 损耗账本 ——
interface LossLedger { dropped: LossItem[]; downgraded: LossItem[]; approximated: LossItem[] }
```

### 4.4 数据流

```
[转换]  A.jsonl ──adapterA.import──▶ CSR ──adapterB.export──▶ B 会话工件（引导包 或 原生会话）
[直聊]  用户 prompt ──▶ driver(agent, model) ──▶ IR 事件流 ──▶ CLI/UI 渲染
[归一]  三大消息协议 ◀──protocols──▶ CSR 单消息子集
```

---

## 5. 开发顺序（里程碑制，每步交付可用物）

| 里程碑 | 内容 | 交付物 | 主要验证的问题 |
|--------|------|--------|----------------|
| **M0** 脚手架 | git init（在 `CoVerse/` 下）、pnpm monorepo、CI、**fixtures 采集脱敏工具** | 可跑的空管线 + 首批金样本 | 工程底座 |
| **M1** 底层协议 | core IR v1 + protocols 三协议互转 | `coverse convert-protocol` CLI | 管线与测试纪律（文档齐全，低风险热身） |
| **M2** 首对适配器 | adapter-codex + adapter-claude-code：import → CSR → 注入式引导包；金样本回归 | `coverse convert-session codex→claude` CLI | IR 表达力够不够、LossLedger 可行性 |
| **M3** 端到端闭环 | drivers + 注入式续接：A 会话 → 在 B agent 里继续对话 | 端到端演示（含 LossLedger 报告） | 核心价值主张成立与否 |
| **M4** 平台 UI | Web：会话列表、拖拽转换、选 agent/model 直聊 | 可日常自用的 Web 平台 | 产品形态 |
| **M5** 原生合成 | codex / claude-code 的原生会话文件合成 + resume；失败回退注入 | 无缝续接（F2/F3 级） | 最高风险项后置攻坚 |
| **M6** 顶层+生态 | modes/skills 映射；dsh、zcode 适配器；插件贡献模板与漂移 CI | 社区可贡献体系 | 生态化 |

排序原则：**先建管线信心（有文档的底层）→ 再碰逆向（无文档的中层）→ 最险的原生合成放 M5**；UI 在核心能力闭环后再上，避免先做壳。

---

## 6. 风险登记

| 风险 | 概率/影响 | 缓解 |
|------|-----------|------|
| agent 升级改格式 | 高/中 | 金样本 CI + 容错解析 + 版本声明（B 方案） |
| 原生合成文件被 agent 拒绝 | 中/中 | 仅作可选能力，注入式兜底（D 方案） |
| 厂商封闭化/反移植 | 低/高 | 社区插件快速跟进；平台价值在聚合层，不依赖单一 agent |
| 长会话超窗 | 中/中 | 分层注入 + 裁剪显式化（F 方案） |
| zcode sqlite 逆向成本超预期 | 中/低 | 排 M6，必要时降级为仅导出（读）不合成（写） |
| 法律/条款争议 | 低/高 | 只碰用户本地数据、社区贡献、金样本脱敏（H 方案） |

---

## 7. 待拍板决策

1. **技术栈**：TypeScript monorepo（建议）／Rust 核心 + TS UI ／ Python；
2. **首批适配器对**：codex + claude-code（建议，文档资料最多）／其它组合；
3. **产品形态**：CLI 先行后补 Web（建议）／直接 Web。

以上决策确认后进入 M0 实施。
