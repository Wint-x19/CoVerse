import {isRecord, recordedUsage, type JsonValue, type MessageMetadata} from "@coverse/core";

export function tokenMetadata(info:JsonValue | undefined):MessageMetadata {
  if (!isRecord(info)) return {};
  const last = isRecord(info.last_token_usage);
  const value = last ? info.last_token_usage : info.total_token_usage;
  if (!isRecord(value)) return {};
  const usage = recordedUsage({input:value.input_tokens,output:value.output_tokens,cachedInput:value.cached_input_tokens,reasoning:value.reasoning_output_tokens});
  return usage ? {usage,usageScope:last ? "request" : "session"} : {};
}
