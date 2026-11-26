# CoVerse Desktop App (M4)

可本地安装的 Electron 桌面应用（非浏览器 Web 应用），提供会话列表、原生文件/目录选择与全局拖拽转换（含显式 LossLedger 与引导包审计）、以及直聊流式输出与跨 Agent Handoff。

主进程直接通过组合根调用 `@coverse/core`、三家会话适配器与 `@coverse/drivers`，渲染进程仅通过严格类型化的 `preload` / `contextBridge` IPC 通信，不含特定 Agent 格式解析逻辑，也不经手任何密钥。

## 会话工作区

左栏按项目收纳会话。使用搜索按钮或 Ctrl+K（macOS 为 ⌘K）按标题、Agent、项目路径查找。点击消息中的文件引用可在右栏查看，点击变更摘要中的文件名可查看该轮历史补丁。“查看当前文件”打开磁盘版本。文件标签按会话保留；“文件”标签可切换会话清单和按需加载的项目目录。

可拖动左右栏分隔线调整宽度，也可用 Tab 聚焦分隔线后按左右方向键，双击恢复默认宽度。布局偏好保存在本机设置中。空间不足时文件栏临时覆盖对话区。向上阅读生成中的对话时可用“回到最新”恢复跟随。

单条跨 Agent 交接后，从“交接详情”查看目标项目、CLI 恢复命令或桌面登记状态。同步失败可在原会话上重试。丢弃、降级、近似三类记录、归档文件和实际注入的上下文都可从这里核对。批量导入完成后可逐项打开会话或修正失败项。

设置中的适配器详情分别列出随应用打包的插件版本、已验证的会话格式和本机 CLI 状态。可启停适配器并跳转到驱动配置。目前三家适配器随桌面应用一起分发和更新。

## 运行与打包

在桌面侧栏选择「导入」，可按项目目录浏览已启用 Agent 的本地会话。勾选会话或项目后可继续搜索、切换 Agent 筛选，再选择目标 Agent 并点击「导入选中会话」。每条会话保留独立历史，目标 CLI 在其源项目目录下创建原生会话。需要更换目录、模型或调整转换损耗选项时，使用会话右侧的设置按钮。

在仓库根执行：

```sh
pnpm build
pnpm ui          # 启动桌面客户端
pnpm ui:dev      # Vite 热重载 + Electron 开发模式
pnpm ui:pack     # 构建本地未压缩桌面应用目录（packages/ui/release/）
pnpm ui:dist     # 生成可安装的原生安装包（Windows NSIS / macOS DMG / Linux AppImage & DEB）
```

状态与引导包默认写入系统用户数据目录（如 Windows `%APPDATA%/CoVerse/data`），可通过环境变量覆盖：

- `COVERSE_DATA_DIR` — 覆盖状态与引导包存储目录
- `COVERSE_CWD` — 覆盖默认工作目录

## 桌面 IPC 契约（`window.coverse`）

- `coverse:capabilities` — 已注册适配器与本地驱动探测结果
- `coverse:sessions:native-resume` — 从已登记的目标会话和驱动配置读取续聊命令与参数
- `coverse:sessions:list` / `get` / `create` / `update` / `delete`
- `coverse:sessions:inspect` — 读取本地路径（含目录与 SQLite `-wal`/`-shm`/`-journal` 伴随文件）自动探测格式
- `coverse:sessions:convert` — 执行 `convertSession` 与引导包校验并创建目标会话
- `coverse:sessions:handoff` — 将当前会话导出为目标 Agent 引导包并新建会话
- `coverse:bundles:get` — 读取已验证引导包的 `manifest.json`、`report.json` 与 `context.md`
- `coverse:run:start` / `coverse:run:abort` — 流式执行与中止子进程树
- `coverse:dialog:pick-directory` / `coverse:dialog:pick-session-files` — 原生系统目录与文件选择器
