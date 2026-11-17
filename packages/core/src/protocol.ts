import type { ContentBlock, JsonValue, Turn } from "./types.js";

export interface ProtocolTool { name: string; description?: string; parameters: JsonValue; strict?: boolean }
export interface ProtocolUsage {
  input?: number;
  output?: number;
  cachedInput?: number;
  cacheWrite?: number;
  reasoning?: number;
}
export interface ProtocolRequest {
  schemaVersion: "1.0";
  model: string;
  messages: Turn[];
  tools: ProtocolTool[];
  parameters: {
    temperature?: number; topP?: number; stop?: string[]; stream?: boolean;
    tokenLimit?: { value: number; semantics: "output" | "completion" | "legacy-output" };
    toolChoice?: "auto" | "none" | "required" | { name: string };
    parallelTools?: boolean;
    outputFormat?: { type: "json_schema"; name: string; schema: JsonValue; strict?: boolean };
  };
}
export interface ProtocolResponse {
  schemaVersion: "1.0";
  id: string;
  model: string;
  createdAt?: number;
  candidates: { index: number; content: ContentBlock[]; finish: string }[];
  usage: ProtocolUsage;
}
/** Semantic events; wire metadata is retained separately by the codec context. */
export type ProtocolEvent =
  | { type: "start"; id: string; model: string }
  | { type: "block_start"; index: number; kind: "text" | "reasoning" | "tool_call"; id?: string; name?: string }
  | { type: "delta"; index: number; text: string }
  | { type: "reasoning_state"; index: number; source: string; value: string }
  | { type: "block_end"; index: number }
  | { type: "usage"; usage: ProtocolUsage }
  | { type: "finish"; reason: string }
  | { type: "end" };
