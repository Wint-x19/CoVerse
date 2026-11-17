# Codex 会话适配器

首批范围内的独立插件。M0 仅提供契约占位，`supportedVersions: []`，探测置信度为 0，import / export / nativeResume 均不可用；调用会明确报错。

后续以已脱敏且经审核的格式样本为依据实现解析、版本探测与 LossLedger，不在核心中加入格式知识。Antigravity 的存储格式和续接能力尚未验证，不作假设。
