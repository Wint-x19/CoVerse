import type { ConversionContext, ProtocolCodec, ProtocolId } from "./contracts.js";
import { decodeRequest, encodeRequest } from "./requests.js";
import { decodeResponse, encodeResponse } from "./responses.js";
import { decodeStream } from "./stream-decode.js";
import { encodeStream } from "./stream-encode.js";

export function createCodec(id: ProtocolId): ProtocolCodec {
  return {
    id, baseline: "m1-2026-11-17",
    capabilities: ["request", "response", "stream-text", "stream-function-tools", ...(id !== "chat-completions" ? ["stream-reasoning"] : []), "text", "function-tools", "user-images", "json-schema", "usage"],
    decodeRequest: (v, c) => decodeRequest(v, id, c), encodeRequest: (v, c) => encodeRequest(v, id, c),
    decodeResponse: (v, c) => decodeResponse(v, id, c), encodeResponse: (v, c) => encodeResponse(v, id, c),
    decodeStream: (input, context) => decodeStream(input, id, context),
    encodeStream: (input, context) => encodeStream(input, id, context),
    ...(id === "responses" ? { replayStream: (input: AsyncIterable<Uint8Array>, context: ConversionContext) => decodeStream(input, id, context, true) } : {}),
  };
}
