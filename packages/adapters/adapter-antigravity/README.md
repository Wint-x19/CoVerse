# Antigravity 会话适配器

M2 基线 `sqlite-2_32_1-step0`：导入 Antigravity 2.32.1 的稳定 SQLite 会话快照与已验证 protobuf 子集，导出注入式引导包。nativeResume 为 false；旧版 `.pb` 存储不在此基线内。

2026-11-17 只读检查五份本机稳定数据库，观察到一致的七表结构及 1862 条 `step_format=0` 记录；类型为用户输入 14、助手响应 15、错误 17、检查点 23、系统消息 101、通用工具 132。`wire.ts` 的字段名、编号与基础类型对照该版本 language_server.exe 内嵌 FileDescriptorProto 验证；未复制可执行程序或用户记录。独立 Python 编码器重建 SQLite/protobuf 金样本，见 `tools/fixtures/create-antigravity.py` 和 fixture manifest。

运行时只使用 sql.js 内存数据库及 protobufjs，不依赖安装 Antigravity 或 Python。严格校验表/列、数据库完整性、步骤类型与状态的一致性、protobuf wire type 和嵌套未知字段。

已验证的格式子集涵盖可读文本、推理、工具结果、历史事件、检查点、部分媒体、工件与嵌套轨迹。子轨迹独立展示；检查点里的子会话 ID、日志 URI 和父引用可用于打开关联记录。尚未识别的字段及 Any 工具载荷保留原件，按导出策略报告损耗。运行状态、权限和生成元数据归档并记录降级。

Windows 桌面 2.34.0 的描述符确认，检查点字段 18 包含重复的 `TrajectoryFileDiff`。其 URI、原始正文与修改后正文分别使用字段 1、2、3。两份正文齐全时，桌面可展开当时的差异。只有哈希或单侧正文时会显示路径并提示差异缺失；遇到未识别的嵌套字段时，该条差异继续按不透明内容处理。[独立编码的回归用例](test/adapter.test.ts)

桌面与 CLI 会话列表均可按原项目导入。桌面客户端退出后仍可能留下包含最新对话的 WAL。CoVerse 捕获同名数据库、WAL 和 SHM 的稳定字节，在内存中验证两个索引头、盐值、逐帧校验和以及最终提交页数，读取索引确认的最后一笔提交。采集期间文件变化、WAL 缺少有效索引、非空回滚日志、未知 step_format 或缺少关联轨迹时返回诊断。原始文件随包归档。`full_output_uri` 必须提供对应工件，优先按同一会话工件目录中的相对路径匹配，也接受显式提供的唯一同名文件。缺件时可在桌面选择“查看已有记录”，检查仍然可读的消息。[SQLite WAL 格式](https://sqlite.org/fileformat2.html#walformat) · [SQLite WAL 索引](https://sqlite.org/walformat.html)

Windows Antigravity 桌面版 2.34.0 和 CLI 1.5.14 的会话存储分别独立。CoVerse 桌面应用在 CLI 建立续聊会话后，使用已校验的引导包在对应桌面项目登记另一份会话。已有项目按本地文件夹匹配，新项目按文件夹创建。桌面历史保留当前续聊窗口的消息顺序与用户、助手角色，工具活动以文本展示。Antigravity 运行期间登记会等待，退出后由 CoVerse 自动重试。旧版已完成 CLI 同步的会话可从审计面板补登记。一旦完成导出，两份会话各自追加后续消息。
