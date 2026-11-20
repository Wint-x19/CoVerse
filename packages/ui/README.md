# CoVerse Web UI (M4)

本地 Web 平台，提供会话列表、拖拽导入/转换（含显式 LossLedger 与引导包审计）以及直聊与流式输出。界面不包含特定 Agent 格式解析逻辑，全部通过 `@coverse/core`、已注册适配器与 `@coverse/drivers` 运行。

## 启动

在仓库根执行：

```sh
pnpm build
pnpm ui
```

默认监听 `http://127.0.0.1:4173`，本地 UI 状态与生成的引导包保存在被忽略的 `.local/ui/` 目录。

支持参数与环境变量：

- `--host` / `COVERSE_UI_HOST`（默认 `127.0.0.1`）
- `--port` / `COVERSE_UI_PORT`（默认 `4173`）
- `--cwd` / `COVERSE_UI_CWD`（默认当前目录）
- `--data-dir` / `COVERSE_UI_DATA_DIR`（默认 `<cwd>/.local/ui`）

前端热重载开发模式：先启动后端 `pnpm ui`，再运行 `pnpm ui:dev`（Vite 默认代理 `/api` 到 `127.0.0.1:4173`）。

## HTTP / SSE API

- `GET /api/health` — 服务状态与默认工作区
- `GET /api/capabilities` — 已注册适配器与本地驱动探测结果
- `GET /api/sessions` / `POST /api/sessions` — 列出或新建会话
- `GET /api/sessions/:id` / `PATCH /api/sessions/:id` / `DELETE /api/sessions/:id`
- `POST /api/sessions/inspect` — 自动探测拖入文件集的格式与预览元数据
- `POST /api/sessions/convert` — 执行 `convertSession` 与引导包校验并创建目标会话
- `POST /api/sessions/:id/handoff` — 将当前会话导出为目标 Agent 的引导包并建立新会话
- `POST /api/sessions/:id/messages` — 流式执行（SSE：`bundle` / `session` / `text` / `tool` / `usage` / `done` / `error`）
- `POST /api/sessions/:id/abort` — 中止运行中的子进程树
- `GET /api/bundles/:bundleId` — 读取已验证引导包的 `manifest.json`、`report.json` 与 `context.md`
