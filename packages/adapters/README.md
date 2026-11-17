# 会话适配器开发约定

中层采用 **2 × N**：每个插件只实现原生格式与 CSR 的导入、CSR 与目标工件的导出。所有转换经 `core.convertSession`；不要实现 Codex→Claude 等专用转换器。首批仅三家，新增厂商另行确认。

插件以独立 workspace 包导出 `SessionAdapter`，格式代码、依赖和测试留在该包。核心只提供 CSR、FileSet、损耗账本、诊断和通用引导包构建器。CLI 的 `createRegistry()` 是组合入口，不属于核心。

## 契约

- `id` 是开放的安全标识符；`supportedVersions` 使用有证据的格式基线，不把安装版本当作全面兼容声明。
- `detect(FileSet)` 返回 `[0,1]` 置信度及可选版本/诊断；不能仅检查扩展名。CLI 自动探测要求至少 0.9，最高分并列时拒绝。
- `import(FileSet)` 返回 `{ session, ledger, diagnostics? }`；原始工件保存在 `sourceArtifacts`，未知字段/记录保存在 `raw` 或 `x-<plugin>-*`。输入不得被修改。
- `export(CSR, ExportContext?)` 返回 `{ artifacts, ledger, diagnostics? }`。本轮调用 `buildInjectionBundle(session, id, context)`；`context` 带入导入账本/诊断，报告合并两阶段账本，返回的 `ledger` 只包含导出新增损耗，避免重复计数。
- 分别声明 `capabilities.import`、`export`、`nativeResume`、`importFormats`、`exportFormats`。注入式引导包不意味着原生会话合成，也不意味着 F3 往返。
- 失败使用 `SessionError(code, path, message)`，定位工件/记录。未知语义用 `opaque` 或 `unknown` 内容块保留，引导包构建器会拒绝。不得把错误伪装成空会话成功。

## 保真度与文件边界

CSR 的 `origin` 保存工件、记录位置、父 ID、分支和消息类别。保留全部输入分支，不能把子会话混入主会话；工具结果必须能关联来源调用。历史内容是引用数据，不执行工具，不改变目标运行权限。

通用引导包含 `context.md`、`session.json`、`report.json`、`manifest.json`、`source/`。来源字节 SHA-256 可核验；修改 CSR 后正文必须来自修改后的 CSR，不能用原始记录覆盖编辑。完整归档不等于已解释语义；附件缺失或无法解释时明确失败。

FileSet 支持任意字节和多文件，路径必须可移植、相对且无重复或文件/目录冲突。插件不扫描用户目录、不自动读取记录中提及的外部路径，不写入 Agent 的配置或数据库。CLI 负责稳定读取和输出发布。

## 新增/更新格式的最低验收

1. 核实格式依据，建立审核后的版本化重建/脱敏样本；测试不能只由生产编码器生成自己的输入。
2. 验证内容顺序、工具关系、分支、压缩记录、未知数据、附件及错误路径；既验证正常转换，也验证拒绝不完整转换。
3. 验证源码工件字节不变、账本合并正确、长内容没有截断、修改 CSR 不会恢复旧原文。
4. 在组合根注册插件，验证所有已支持来源/目标组合，以及一个核心不认识的测试插件。运行 `pnpm check` 后提交。

后续原生合成须另增明确能力及独立原生 Agent 读取/续接测试，不能复用引导包测试来宣称 nativeResume。
