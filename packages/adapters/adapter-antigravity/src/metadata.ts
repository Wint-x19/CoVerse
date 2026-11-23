import {isRecord, recordedUsage, type JsonValue, type MessageMetadata} from "@coverse/core";
import {nestedRecord} from "./wire.js";

function timestamp(value:JsonValue | undefined) {
  if (!isRecord(value) || typeof value.seconds !== "string") return;
  const time = Number(value.seconds) * 1000 + Math.floor(Number(value.nanos ?? 0)/1e6);
  return Number.isSafeInteger(time) && Math.abs(time) <= 8.64e15 ? time : undefined;
}
export function stepMetadata(value:JsonValue | undefined, at:string): MessageMetadata {
  if (!isRecord(value)) return {};
  const result:MessageMetadata = {};
  const created = timestamp(value.created_at), started = timestamp(value.started_at) ?? created, ended = timestamp(value.completed_at);
  if (created !== undefined) result.createdAt = new Date(created).toISOString();
  if (started !== undefined && ended !== undefined && ended >= started) result.durationMs = ended-started;
  const info = value.model_info ? nestedRecord("ModelInfo",value.model_info,at) : undefined;
  const name = info?.display_name ?? info?.model_name ?? info?.chat_model_name;
  if (typeof name === "string" && name) result.model = name;
  else if (typeof value.generator_model === "number") result.model = "Model #" + value.generator_model;
  const u = value.model_usage ? nestedRecord("ModelUsageStats",value.model_usage,at) : undefined;
  if (u) {
    const usage = recordedUsage({input:u.input_tokens,output:u.output_tokens,cacheWrite:u.cache_write_tokens,
      cachedInput:u.cache_read_tokens,reasoning:u.thinking_output_tokens});
    if (usage) {result.usage = usage;result.usageScope = "message";}
  }
  return result;
}
