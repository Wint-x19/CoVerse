---
name: create-pr
description: 按团队规范提交 Pull Request:提交前门禁检查、规范的 PR 描述、提交后等待 review 机器人并逐条处理意见。用户要求提 PR / 交 PR 时使用。
---

# 提交 PR

完整流程分三个阶段,**三个阶段都完成才算任务结束**——尤其不要建完 PR 就停。

## 阶段一:提交前门禁

按顺序检查,任何一条不过就先解决:

1. **有对应 Issue 吗?** 没有则先走 `create-issue` skill 补建,PR 必须 `Closes #xxx`。
2. **体量检查**:`git diff <目标分支> --stat` 排除测试文件后,对照 `AGENTS.md` 的 PR 体量红线(非测试代码超过约 1000 行须拆分);超线则停下来向用户提出拆分方案,不要直接提交。
3. **样本清单与锁文件检查**:改动涉及 `fixtures/` 时运行 `pnpm fixtures:check`;改动涉及 `package.json` 依赖时确认 `pnpm-lock.yaml` 同步更新且未经手工篡改(未经用户确认不得新增第三方依赖)。修改 `.claude/skills/` 时确认已同步 `.agents/skills/`。
4. **自查**:先走 `self-review` skill 做对抗性检查,处理完发现的问题再继续。
5. **开发者自测**:根据 Issue PRD、验收标准和实际 diff 设计场景化自测案例并执行。可使用 Codex(当前开发由 Codex 承担或用户可调度 Codex)时,由 Codex 编写并执行;没有 Codex 时,由开发者本人编写并执行。Agent 无法操作的账号、真机或外部环境场景必须明确交给开发者补测;涉及桌面可见交互的改动按 `docs/testing.md` 执行窗口回归或 Computer Use;不能只生成案例而不执行。保留每条案例的执行者和实际结果用于 PR 正文。
6. **本地跑对应 CI 检查**(按改动范围选,参见 `docs/testing.md`):
   - **测试按影响范围选择**:基于相对目标分支的完整 PR diff 判断,不能只看最后一次提交或是否修改了测试文件。目标分支全量通过仅作为基线,不能证明本次改动没有回归。
     - 纯文档、注释或流程说明改动,不影响运行时代码、依赖、构建或测试执行时,可跳过业务单测,核对相对链接、命令及流程走读(涉及 skill 时运行 `pnpm exec vitest run tools/skills-sync.test.ts`)。
     - 单个适配器(`packages/adapters/*`)或独立模块改动且影响范围明确时,先运行 `pnpm build` 与 `pnpm typecheck`,再运行对应模块及受影响调用方的已有测试和新增回归测试;不能仅运行新增或修改的测试文件。桌面服务与 IPC 改动运行 `pnpm exec vitest run packages/ui/test/desktop.test.ts`;涉及对话展示与窗口交互时运行 `pnpm --filter @coverse/ui exec electron test/transcript-window.mjs`。
     - 修改 `@coverse/core`、`@coverse/protocols`、共享接口、跨包流程、`fixtures/`、依赖或测试基础设施等影响面大的内容,或无法明确判断影响范围时,必须在本地跑完整 `pnpm check` 及 `pnpm coverse adapters --json`。
     - 保留选测依据、实际命令和输出摘要用于 PR 正文;本次范围要求的本地检查失败或未执行时,不要创建 PR。
   - **CI 全量验证**:保留 PR 的完整跨平台 CI(`pnpm check` 与 `pnpm coverse adapters --json`);合并前必须确认最终提交对应的全量 CI 检查通过。
7. **diff 卫生**:确认没有调试代码、没有 `.tmp/` 或 `.local/` 临时产物、没有顺手改的无关文件、没有草稿 / 计划文件混入提交。

## 阶段二:创建 PR

- **标题**:Conventional Commits 格式 `type(scope): 简短描述`。
- **正文**:中文直白三段,写给无法深入代码细节的人类审阅者:
  1. **解决了什么**——一两句,对应 Issue 的问题。
  2. **怎么解决的**——思路层面(为什么选这个方案),不逐文件罗列实现细节。
  3. **自测案例与测试情况**——必须分成两部分,不能只贴完整 Vitest、typecheck 或构建结果来代替开发者自测:
     - **开发者自测案例**:依据 Issue PRD 与验收标准设计,逐项写明对应的需求或验收标准编号、场景、前置条件、操作步骤或验证方式、预期结果、实际结果和执行者(`Codex`、当前 Agent 或开发者)。案例可以通过手工操作或开发者设计并执行的定向自动化 / 窗口回归测试验证;至少覆盖核心正常流程以及存在的相关边界或异常场景,没有适用边界场景时说明不适用及理由,不得虚构。文档或流程改动可记录流程走读、链接 / 渲染检查或实际工作流模拟。推荐使用「对应 PRD / 验收标准 | 场景 | 前置条件 | 操作步骤或验证方式 | 预期结果 | 实际结果 | 执行者」表格。Agent 只能为自己实际执行的案例署名;无法执行的场景必须由开发者补测并填写开发者为执行者。
     - **工程测试结果**:单独列出 `pnpm check`、`vitest`、`tsc`、构建等命令及本地输出摘要(例如通过数量、失败数量、耗时或完整 summary 行),注明本地测试策略(全量 / 受影响测试 / 跳过)、对应改动范围和选测依据;执行测试时记录实际运行结果,跳过时说明符合阶段一哪条条件及已执行的替代检查。CI 全量结果与本地结果分开记录,尚未完成时注明待 CI 验证,不得将定向测试表述为全量通过。阶段一按范围规定的必跑门禁不得标为“未执行”;其他可选测试如未执行,必须说明原因及风险。
     - 两部分都不能只写“测试通过”;开发者自测案例与工程门禁可以复用同一个定向测试作为证据,但必须分别提供场景化结果和命令摘要。
- 标注涉及模块:【模块】标签(`AGENTS.md`「模块划分与【】标签」小节)。
- GitHub label 使用 `AGENTS.md` 同表 `GitHub label` 列的英文名,并通过 `gh pr create --label` 添加;不要把中文【模块】标签直接传给 `--label`。
- `Closes #xxx` 关联 Issue。
- 关键文件可用「改动 | 说明」表格,**只列关键的几个**,不全量罗列。
- 用 `gh pr create --label "<module>"` 直接创建;涉及多个模块时重复传 `--label`,例如 `--label "core" --label "adapters"`。超过 3 个模块时先按 `AGENTS.md` 判断是否应拆分 PR。

## 阶段三:等待并处理 review

若仓库启用了自动 review 机器人(如 PR-Agent,在 PR 创建 / push 时触发并以 comment 出现):

1. PR 创建后等待机器人 review:轮询 `gh pr view <编号> --comments`,间隔 2-3 分钟,最多等约 10 分钟;超时仍无机器人评论(或仓库未配置自动 review),向用户说明后结束,不无限等待。
2. 对每条 review 意见逐条处理,不允许无视任何一条:
   - **意见成立** → 修改代码并 push(push 触发新一轮 review,重复本阶段,**最多 2 轮**;之后仍有新意见,汇总交用户决策)。
   - **意见不成立** → 在 PR 里回复,有理有据地 argue;同一条意见只回复一次,不与机器人多轮辩论。
3. **已解决的意见要闭环**:每轮 push 后,随即在本轮已修复的每条意见的 comment 下回复已解决并注明修复 commit(上一条的"只回复一次"只约束 argue,不限制这类回复)。若该意见是 inline review 线程(如行内代码建议),回复后再置为 resolved——`gh` 无直接命令,用 `gh api graphql` 查 `pullRequest.reviewThreads` 拿线程 id,调 `resolveReviewThread` mutation;整条 comment 型意见没有 resolved 状态,回复即算闭环。
4. 向用户汇总:PR 链接、review 意见列表、每条的处理结果(已修改并 resolved / 已回复理由)。

## 备注

- 合并方式优先 Squash and merge(由人操作,不要自行合并)。
