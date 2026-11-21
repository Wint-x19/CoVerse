# Antigravity 会话适配器

M2 基线 `sqlite-2_32_1-step0`：导入 Antigravity 2.32.1 的稳定 SQLite 会话快照与已验证 protobuf 子集，导出注入式引导包。nativeResume 为 false；旧版 `.pb` 存储不在此基线内。

2026-11-17 只读检查五份本机稳定数据库，观察到一致的七表结构及 1862 条 `step_format=0` 记录；类型为用户输入 14、助手响应 15、错误 17、检查点 23、系统消息 101、通用工具 132。`wire.ts` 的字段名、编号与基础类型对照该版本 language_server.exe 内嵌 FileDescriptorProto 验证；未复制可执行程序或用户记录。独立 Python 编码器重建 SQLite/protobuf 金样本，见 `tools/fixtures/create-antigravity.py` 和 fixture manifest。

运行时只使用 sql.js 内存数据库及 protobufjs，不依赖安装 Antigravity 或 Python。严格校验表/列、数据库完整性、步骤类型与状态的一致性、protobuf wire type 和嵌套未知字段。

这是明确的格式子集：可读文本、推理、工具调用及文本结果、系统通知、错误和文本检查点可转换。嵌套上下文、二进制媒体、Any 工具载荷和其他尚未解码内容完整归档，但阻止引导包导出；运行状态/权限/生成元数据归档并记录降级。不得将这些限制解释为完整支持全部 2.32.1 会话。

非空 WAL/journal、未知 step_format、子轨迹或父轨迹引用明确拒绝。`full_output_uri` 必须提供对应工件，按显式输入中的唯一文件名匹配，不访问任意外部路径。用户应提供已停止写入、已 checkpoint 的数据库副本；插件不修改原始数据库。

Windows Antigravity 桌面版 2.34.0 和 CLI 1.5.14 的会话存储分别独立。CoVerse 桌面应用在 CLI 建立续聊会话后，使用已校验的引导包在对应桌面项目登记另一份会话。已有项目按本地文件夹匹配，新项目按文件夹创建。桌面历史保留当前续聊窗口的消息顺序与用户、助手角色，工具活动以文本展示。Antigravity 运行期间登记会等待，退出后由 CoVerse 自动重试。旧版已完成 CLI 同步的会话可从审计面板补登记。一旦完成导出，两份会话各自追加后续消息。
