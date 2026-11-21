# @coverse/protocols — M1

离线消息协议转换：`源 codec → CoVerse IR v1 → 目标 codec`。三个内置 codec 为 `responses`、`chat-completions`、`anthropic-messages`；新增协议通过 `ProtocolRegistry.register` 注册。协议与 Agent 会话适配器是独立契约。

## 规范基线与支持范围

`m1-2026-11-17` 是 CoVerse 已测试能力快照，不是厂商版本号。实现基于公开文档和合成样本；未调用付费 API，未验证全部字段、全部模型或厂商兼容端点。未知字段默认拒绝。

| 能力 | Responses | Chat Completions | Anthropic Messages |
|---|---|---|---|
| 请求、完整响应、SSE | 已测试子集 | 已测试子集 | 已测试子集 |
| 文本、用户图片 URL / inline base64 | 支持 | 支持 | 支持；OpenAI detail 需显式处理 |
| 函数定义、调用、文本结果、并行流式参数 | 支持 | 支持 | 支持 |
| JSON Schema 输出 | text.format | response_format | output_config.format |
| system / developer | 保留角色 | 保留角色 | developer、多个或中途指令需显式合并 |
| 推理 | summary、同协议 opaque state | 标准协议不声明推理字段 | thinking、同协议 signature |
| 推理流 | 每个 reasoning item 一个 summary part，可保留 encrypted_content | 仅显式转写为正文 | thinking / signature delta |
| 多候选完整响应 | 目标需显式选一个 | 保留全部候选 | 目标需显式选一个 |
| 多候选流 | 需显式选择源候选 | M1 也需显式选择，输出 index 0 | 需显式选择源候选 |
| 用量 | input/output、cached、reasoning | prompt/completion、cached、reasoning | fresh input、cache read/write、output |

附件类型在 IR 中预留。M1 不转换音视频、文件 ID、工具结果中的图片/内容数组、托管工具、非 JSON 函数参数、redacted thinking、无 summary 的加密推理流、WebSocket 或厂商私有 reasoning 字段。未知内容保存在诊断中并阻止转换，或仅在调用者明确允许省略对应路径后丢弃。工具关联和无效 JSON 不能靠 allow-loss 修复。

旧 Chat `max_tokens` 输出限额与 completion budget 分开建模；跨类型必须显式给出目标 `maxOutputTokens`。缺少 Anthropic 必填限额也须补充，不根据模型名猜测。JSON Schema 映射不承诺某模型支持所有 schema 关键字。

## 库接口

```ts
import { convertRequest, convertResponse, convertStream } from "@coverse/protocols";

const result = convertRequest({
  from: "responses", to: "anthropic-messages",
  input: { model: "synthetic-source", input: "hello" },
  options: { targetModel: "synthetic-target", maxOutputTokens: 256 },
});
// result.data 为目标 JSON；ledger / preserved 为旁路报告。

const stream = convertStream({
  from: "chat-completions", to: "responses",
  input: byteChunks, // AsyncIterable<Uint8Array>，任意网络分块
  options: { signal: abortController.signal },
});
for await (const bytes of stream.data) await write(bytes);
const outcome = await stream.completion;
```

`decodeProtocol(kind, args)` 返回可编辑的 Decoded IR；`encodeProtocol(kind, decoded, to, options)` 导出。decode 时指定计划目标，让源特有内容的诊断使用相同策略。未编辑的同协议完整对象可以回放经过验证的原文；编辑后重新编码，原始工具参数仅在解析值未变时复用。`original`、`snapshot` 属于来源信息，不应被调用者修改。

`ProtocolCodec` 提供请求、响应和流的 decode/encode 六个方法。core 只拥有通用模型，格式字段和 SSE 语义留在 protocols。

## 保真与损耗

默认 `policy: "strict"`。不可表示的语义导致 ProtocolError，包含 code、path、report。allow-loss 本身不启用全部降级，仍需逐项选择：

- `allowMessageMerge: true`：允许将独立助手消息合并到一条目标响应，记录原消息边界降级。
- `allowFinishApproximation: true`：允许在缺少对应结束原因时映射拒答和内容过滤，记录近似。
- `allowRoleMerge: true`：合并指令角色/位置，记入 downgraded。
- `reasoningAsText: true`：摘要/可见 thinking 转成正文，签名和加密状态只保留在报告，记入 downgraded。
- `candidateIndex: n`：选择指定候选，其他候选或流片段保留在报告，记入 dropped。
- `omit: ["/具体路径"]`：允许省略诊断指向的字段，记入 dropped。路径可能指向源 JSON 或明确标出的 IR 字段，不接受通配符。

调用方从原始 JSON 字节进入时，应使用导出的 `parseWireJson` 和 `stringifyWireJson`。超出 JavaScript 安全整数范围的普通整数在内存中用 bigint 表示，写出为 JSON 数字。已被调用方提前舍入的 Number 无法恢复；无法精确表示的小数会报错。

原生 Responses 非流式请求和响应可携带已识别的 `compaction` 项；跨协议无法读取该压缩状态时返回 `UNPORTABLE_COMPACTION`。同协议严格模式下的 Responses SSE 逐帧校验并保留来源 item 与消息边界。

完整 JSON 转换报告保留源 payload，含原始内容，应与源文件同等保护。流只保留需审计的元数据、丢弃片段和不透明状态，不重复归档所有文本增量。工具不执行、历史不自动补齐、状态 ID 不解析成隐藏会话。

消息边界、工具 ID、参数和内容顺序按目标能力保持。无法在单个 Chat 响应中表示的“工具调用之后还有文本”等顺序会拒绝。协议专属 item ID、schema 标签、时间戳等线格式元数据留在报告；目标 item ID 确定性生成。目标必须有创建时间而源未报告时使用 `0` 表示不可用，不取当前时间冒充源创建时间。同义的空结构、状态包装及 SSE 分块可重新编码。

Anthropic 流开始帧用量为临时零值；最终 message_delta 用已报告的实际计数更新。最终缺少实际 input/output 计数时拒绝完成。流可能输出部分内容才发现错误，调用者须检查迭代错误和 completion。completion 在 data 被消费后结算；data 单次消费，提前退出关闭上游并报告 cancelled。

## 来源

- [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages)、[Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)、[Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [CC Switch 转换模块](https://github.com/farion1231/cc-switch/tree/main/src-tauri/src/proxy/providers)：研究工具关联、流状态和兼容问题。本实现独立编写，未复制或翻译上游代码，不含其 provider 特例或默认参数策略。

测试覆盖九种源/目标组合、同协议往返、未知字段、显式降级、可编辑 IR、UTF-8 分块、并行工具、签名、事件顺序、取消及截断。格式漂移先增加失败样本，再修对应 codec。
