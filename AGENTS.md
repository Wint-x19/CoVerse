# AGENTS.md — CoVerse 工程协作规范

本文件是所有在此仓库工作的 AI Agent 与贡献者必须遵守的规范。请在开始任何任务前完整阅读本文件。

涉及既有取舍或排查类似问题时，查阅[项目决策与经验](docs/project-memory.md)。新的长期决策与已验证经验更新到该文档。

## 协作流程（Skills）

流程型规范以 skill 形式维护在 `.claude/skills/`；`.agents/skills/` 是它的同步拷贝，供 Codex、Antigravity 等其他 Agent 工具发现（不用 symlink 是为兼容 Windows 检出）。修改 skill 后需同步两处，`pnpm test` / CI 会校验两目录完全一致。

执行以下动作前，**必须先读取并遵循对应 `SKILL.md`**——即使当前工具没有原生 skill 支持：

- **发现问题 / 确认需求 → 创建 Issue**：[`.claude/skills/create-issue/SKILL.md`](.claude/skills/create-issue/SKILL.md)（遇到 Bug 或新需求确认后、开始写代码前，先检索现有 Issue/PR 查重并创建 `PRD 状态: Ready` 的 Issue；交 PR 发现尚无对应 Issue 时也须先走此处补建）
- **代码完成后 → 提交前对抗性自查**：[`.claude/skills/self-review/SKILL.md`](.claude/skills/self-review/SKILL.md)（用不带编码上下文的独立只读子 Agent 审查 diff，排查重复造轮子、fallback 缝补、代码膨胀与层级越界）
- **提交 PR → 门禁检查与 Review 闭环**：[`.claude/skills/create-pr/SKILL.md`](.claude/skills/create-pr/SKILL.md)（提交前门禁、场景化开发者自测 + 工程测试汇总、关联 `Closes #xxx`、等待并逐条闭环处理 review 意见）

## 常用命令（Common Commands）

要求 Node.js ≥ 20.19，`pnpm@10.34.9`（本机无全局 `pnpm` 时可用 `.local/node/bin/pnpm` 或 `npx --yes pnpm@10.34.9`）：

- 安装依赖：`pnpm install --frozen-lockfile`
- 全包构建：`pnpm build`（修改包代码后先构建，再跑依赖产物的测试或 CLI）
- 严格类型检查：`pnpm typecheck`
- 运行全部单测：`pnpm test`
- 运行单个测试文件：`pnpm exec vitest run packages/ui/test/desktop.test.ts`
- 校验经审核样本清单：`pnpm fixtures:check`
- 运行冒烟测试：`pnpm smoke`
- 运行全量离线门禁（等同 CI 主检查）：`pnpm check`
- 查看已注册适配器 / 协议 / 驱动：`pnpm coverse adapters --json` · `pnpm coverse protocols --json` · `pnpm coverse drivers --json`
- 启动桌面客户端：`pnpm ui`（开发热重载：`pnpm ui:dev`）
- 打包桌面应用：`pnpm ui:pack`（目录产物） · `pnpm ui:dist`（原生安装包）
- 桌面真实窗口回归：`pnpm --filter @coverse/ui exec electron test/transcript-window.mjs`

## 项目使命

CoVerse 是一个 **Agent 上下文无缝流转平台**：用户可以在任意 Agent 之间切换并继续工作，同时不丢失上下文信息。

核心价值主张：

- 用户可以在平台上直接输入提示词、选择 Agent 及模型、获取输出；
- 用户可以将某个 Agent 的会话记录尽可能无损地导入另一个 Agent 继续对话；
- 平台**只做聚合与协议转换**，不做 Agent 分工、提示词工程等属于特定 Agent 的事情。

## 目录结构

本文件所在的仓库根目录就是项目根目录和 Git 仓库根目录。开发、测试与 Git 操作均直接在此目录中进行。

```
co-verse/                 ← 项目根目录 / Git 仓库根目录
├── .git/
├── .claude/skills/       ← 团队共享协作流程 Skill（主维护目录）
├── .agents/skills/       ← .claude/skills/ 的同步副本（供各 Agent 发现）
├── AGENTS.md             ← 本文件
├── README.md
├── DESIGN.md
├── docs/                 ← 项目决策经验（project-memory.md）与测试流程（testing.md）
├── package.json
├── pnpm-workspace.yaml
├── packages/             ← 各工程模块与适配器插件
├── tools/                ← 工程校验、样本采集与回归工具
└── fixtures/             ← 经审核的脱敏测试样本
```

**硬性规则**：

- 所有工程工作以本文件所在的 Git 仓库为边界；工作区级配置与说明文档直接放在仓库根目录，模块代码、工具和样本按上述目录组织；
- 不设置“外层目录仅放文档、内层目录放代码”的两级项目规则，也不要在当前仓库内额外创建一层 `CoVerse/` 项目目录或初始化嵌套 Git 仓库；
- `.claude/skills/` 与 `.agents/skills/` 只放团队共享的流程规范，个人或实验性 skill 放在用户本机全局目录，不入库。

## 模块划分与【】标签

Issue / PR 标题和正文中用以下粗粒度标签标注涉及模块；GitHub `--label` 参数使用同表英文名，不要把中文【模块】标签直接传给 `--label`：

| 标签 | GitHub label | 范围 |
|------|--------------|------|
| 【核心】 | `core` | `packages/core`（CSR、FileSet、损耗账本、通用引导包构建与校验） |
| 【协议】 | `protocols` | `packages/protocols`（Responses / Chat Completions / Anthropic Messages 请求、响应与 SSE 互转） |
| 【适配器】 | `adapters` | `packages/adapters/*`（Codex、Claude Code、Antigravity 会话格式导入导出插件） |
| 【驱动】 | `drivers` | `packages/drivers`、`packages/cli`（本地 Agent CLI 探测、续聊执行驱动与命令行入口） |
| 【模式】 | `modes` | `packages/modes`（目标模式、计划模式、技能等顶层工作模式映射） |
| 【桌面端】 | `desktop` | `packages/ui`（Electron 主进程、IPC preload、React 渲染界面与原生打包） |
| 【基建】 | `infra` | `.github/`、`tools/`、`fixtures/`、`docs/`、构建与测试基础设施 |

一次改动通常涉及 1–2 个标签；超过 3 个标签说明 PR 做了不止一件事，应先评估拆分。

## 三层转换架构

平台的一切功能围绕三层协议转换展开，开发时请始终在这个框架内思考：

| 层级 | 职责 | 覆盖对象 |
|------|------|----------|
| 底层：消息协议 | 单条消息 / API 请求响应的转换 | Responses 等三大主流消息协议 |
| 中层：对话记录协议 | 完整会话历史的读取与写入 | 首批仅 Codex、Claude Code、Antigravity 的对话记录格式 |
| 顶层：模式规范 | 工作模式的语义映射 | 目标模式、计划模式、技能（skills）等 |

其它必需的转换能力可在实践中补充，但新增功能必须能明确归入某一层，避免层级混乱。

## 交付形态（桌面应用）

CoVerse UI 是**可本地安装的原生桌面应用**（Electron 桌面客户端 + 原生安装包），**不是在浏览器中运行的 Web 应用**：

- 桌面客户端通过主进程直接调用 `@coverse/core`、适配器插件与 `@coverse/drivers`，渲染进程仅通过严格类型化的 IPC（`preload` + `contextBridge`）通信，不以浏览器访问本地 HTTP 服务作为运行形态；
- 桌面应用支持原生文件/目录选择器、全局拖拽导入与原生窗口体验，并可通过打包流程生成可安装的桌面安装包（如 Windows 安装程序、macOS DMG、Linux AppImage/DEB）；
- 本地应用状态与生成的引导包写入系统用户数据目录（开发调试时可重定向至被忽略的 `.local/` 或 `.tmp/`），不污染仓库，不经手任何 API 密钥。

## 插件体系（会话适配器）

**初期开发范围仅限 Codex、Claude Code、Antigravity 三家的适配器。** 其它 Agent 不列入当前开发里程碑，扩展需另行确认。三家分别以独立插件包实现；未验证的格式版本和能力不得宣称支持。

各家 Agent 的会话格式**普遍无官方文档且随版本变动**，因此：

- 所有针对具体 Agent 会话格式的适配器必须实现为**社区可贡献的插件**，不允许硬编码在平台核心中；
- 平台核心只依赖统一的适配器接口（导入 / 导出 / 能力声明），不依赖任何具体 Agent 的格式细节；
- 编写新适配器时，参考已有的插件结构与 [适配器开发约定](packages/adapters/README.md)，保持一致的接口与目录约定；
- 适配器应声明其支持的格式版本，格式变动时通过更新对应插件解决，而非改动核心。

## 工程质量与代码规范

1. **需求澄清优先**
   - 需求模糊时不猜测，先用具体问题澄清范围；
   - 涉及超过 3 个文件或跨模块行为变更时，先输出简要方案经用户确认；
   - 遇到缺陷或需求确认后，按 `create-issue` skill 先查重并建立 `PRD 状态: Ready`、待确认事项清零的 Issue，再切分支开发；后续需求变化先更新 Issue 并重新确认。
2. **复用优先与奥卡姆剃刀**
   - 写新函数、组件或工具前，先按功能关键词搜索仓库已有实现并查看邻近文件；差异仅几行时优先扩展原实现；
   - 不做单次使用的过度抽象，不留“以后可能有用”的死代码，未经用户确认不引入新的第三方依赖；
   - 注释优先解释“为什么”（如格式假设、边界原因），不写复述代码字面意思的注释。
3. **模块隔离与根因修复**
   - 跨包只通过各包公开导出与统一注册表交互，不直接引用其他包内部路径；单插件出错不得拖垮其他适配器；
   - 修 Bug 前先定位真实根因，禁止用多层 `try/catch` fallback 掩盖未查明的问题；每个 `try/catch` 必须明确捕获的具体异常与触发场景。
4. **PR 体量与改动收敛**
   - 一个 Issue / PR 只做一件事；排除测试文件后，非测试代码改动超过约 1000 行须停下来提出拆分方案；
   - 禁止顺手重排无关 import、格式化无关文件或混入调试代码；
   - `ISSUE_DRAFT`、`PR_DRAFT`、评审临时 diff 等草稿文件一律放临时目录（如 `.tmp/`），严禁提交进仓库。

## Git 版本管理

- **分支命名**：从 `main` 切出工作分支；有 Issue 时命名为 `type/issue-id-short-desc`（如 `bugfix/12-codex-browser-tabs`），无 Issue 的微小维护命名为 `type/short-desc`（常用前缀：`feature/`、`bugfix/`、`hotfix/`、`docs/`、`refactor/`）；
- **提交规范**：每完成一次可独立验证的修改并通过测试后及时 commit，不要攒大批量改动一起提交；commit message 遵循 Conventional Commits `type(scope): subject`（类型：`feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`chore`，subject 简明扼要，必要时在 body 说明“为什么”）；
- **安全与远端边界**：严禁提交密钥、Token、用户原始会话数据或未脱敏引导包；未经用户明确要求不执行 push 或改写历史；收到提 PR 指令时按 `create-pr` skill 推送分支并关联 `Closes #xxx`，PR 合并（优先 Squash and merge）由人工操作，Agent 不自行合并。

## 开发与测试约定

- 按 [Agent 测试流程](docs/testing.md) 选择回归用例和桌面验收方式。Computer Use 用于自动化通过后的定向验收，或必须操作真实窗口才能复现的问题；
- 新功能与缺陷修复必须同步编写或补充行为级回归测试（并入对应模块的既有 `*.test.ts`，避免散落零碎测试文件），每次修改后运行相关测试与类型检查确认通过再提交；
- PR 描述须按 `create-pr` skill 分别记录**场景化开发者自测案例**与**工程测试结果**，不得仅用一句“测试通过”代替；
- 转换功能（尤其会话导入/导出）以“上下文无损”为最高目标，转换中丢弃、降级或近似的信息必须显式记入损耗账本，不允许静默丢失；
- 遇到某 Agent 格式解析失败时，优先怀疑格式版本变化，将修复落在对应插件内；对不确定的格式行为，宁可保守处理并在代码、文档与提交信息中注明假设，也不要猜测后静默通过。

## 边界（不要做的事）

- ❌ 不做 Agent 编排、分工、自动提示词优化——那是各 Agent 自己的事，平台只做聚合与转换；
- ❌ 不在平台核心中硬编码任何特定 Agent 的会话格式；
- ❌ 不将本项目工程产物写到当前 Git 仓库之外，也不在仓库内初始化嵌套 Git 仓库；
- ❌ 不以浏览器访问本地网页替代可安装的桌面应用形态；
- ❌ 不跳过 Issue 查重/PRD 确认、对抗性自查或测试门禁直接提 PR，也不自行合并 PR。
