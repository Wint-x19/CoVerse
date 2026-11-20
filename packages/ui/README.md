# CoVerse Desktop App (M4)

可本地安装的 Electron 桌面应用（非浏览器 Web 应用），提供会话列表、原生文件/目录选择与全局拖拽转换（含显式 LossLedger 与引导包审计）、以及直聊流式输出与跨 Agent Handoff。

主进程直接通过组合根调用 `@coverse/core`、三家会话适配器与 `@coverse/drivers`，渲染进程仅通过严格类型化的 `preload` / `contextBridge` IPC 通信，不含特定 Agent 格式解析逻辑，也不经手任何密钥。

## 运行与打包

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
- `coverse:sessions:list` / `get` / `create` / `update` / `delete`
- `coverse:sessions:inspect` — 读取本地路径（含目录与 SQLite `-wal`/`-shm`/`-journal` 伴随文件）自动探测格式
- `coverse:sessions:convert` — 执行 `convertSession` 与引导包校验并创建目标会话
- `coverse:sessions:handoff` — 将当前会话导出为目标 Agent 引导包并新建会话
- `coverse:bundles:get` — 读取已验证引导包的 `manifest.json`、`report.json` 与 `context.md`
- `coverse:run:start` / `coverse:run:abort` — 流式执行与中止子进程树
- `coverse:dialog:pick-directory` / `coverse:dialog:pick-session-files` — 原生系统目录与文件选择器
