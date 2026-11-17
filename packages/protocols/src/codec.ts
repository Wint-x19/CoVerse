import { ConversionContext, type ProtocolCodec, type ProtocolId } from "./contracts.js";
import { decodeRequest, encodeRequest } from "./requests.js";
import { decodeResponse, encodeResponse } from "./responses.js";

export function createCodec(id: ProtocolId): ProtocolCodec {
  return {
    id, baseline: "m1-2026-11-17",
    capabilities: ["request", "response", "text", "function-tools", "user-images", "json-schema", "usage"],
    decodeRequest: (v, c) => decodeRequest(v, id, c), encodeRequest: (v, c) => encodeRequest(v, id, c),
    decodeResponse: (v, c) => decodeResponse(v, id, c), encodeResponse: (v, c) => encodeResponse(v, id, c),
    async *decodeStream(_input, context: ConversionContext) { context.fail("UNSUPPORTED_CAPABILITY", "/stream", "Streaming codec is not yet installed"); },
    async *encodeStream(_input, context: ConversionContext) { context.fail("UNSUPPORTED_CAPABILITY", "/stream", "Streaming codec is not yet installed"); },
  };
}
