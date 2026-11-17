import type { JsonValue, ProtocolRequest, ProtocolResponse } from "@coverse/core";
import { ConversionContext, ProtocolRegistry, type ConversionOptions, type ConversionResult, type Decoded } from "./contracts.js";
import { createCodec } from "./codec.js";

export function createProtocolRegistry(): ProtocolRegistry {
  return new ProtocolRegistry().register(createCodec("responses")).register(createCodec("chat-completions")).register(createCodec("anthropic-messages"));
}
export interface ConvertInput { from: string; to: string; input: unknown; options?: ConversionOptions; registry?: ProtocolRegistry }
export function decodeProtocol(kind: "request", args: ConvertInput): Decoded<ProtocolRequest>;
export function decodeProtocol(kind: "response", args: ConvertInput): Decoded<ProtocolResponse>;
export function decodeProtocol(kind: "request" | "response", args: ConvertInput): Decoded<ProtocolRequest> | Decoded<ProtocolResponse> {
  const registry = args.registry ?? createProtocolRegistry(); registry.get(args.to);
  const c = new ConversionContext(args.from, args.to, args.options);
  const codec = registry.get(args.from);
  c.preserve("", args.input as JsonValue, "Original source payload retained for audit; never blindly forwarded");
  const value = kind === "request" ? codec.decodeRequest(args.input, c) : codec.decodeResponse(args.input, c);
  return { value, source: args.from, original: structuredClone(args.input) as JsonValue, snapshot: JSON.stringify(value), report: c.report } as Decoded<ProtocolRequest> | Decoded<ProtocolResponse>;
}
export function encodeProtocol(kind: "request", decoded: Decoded<ProtocolRequest>, to: string, options?: ConversionOptions, registry?: ProtocolRegistry): ConversionResult<JsonValue>;
export function encodeProtocol(kind: "response", decoded: Decoded<ProtocolResponse>, to: string, options?: ConversionOptions, registry?: ProtocolRegistry): ConversionResult<JsonValue>;
export function encodeProtocol(kind: "request" | "response", decoded: Decoded<ProtocolRequest> | Decoded<ProtocolResponse>, to: string, options: ConversionOptions = {}, registry = createProtocolRegistry()): ConversionResult<JsonValue> {
  const c = new ConversionContext(decoded.source, to, options);
  c.report.ledger = structuredClone(decoded.report.ledger); c.report.preserved = structuredClone(decoded.report.preserved);
  const codec = registry.get(to);
  const encoded = kind === "request" ? codec.encodeRequest(decoded.value as ProtocolRequest, c) : codec.encodeResponse(decoded.value as ProtocolResponse, c);
  const unchanged = decoded.source === to && decoded.snapshot === JSON.stringify(decoded.value) && options.targetModel === undefined && options.maxOutputTokens === undefined && options.candidateIndex === undefined && Object.values(c.report.ledger).every(v => v.length === 0);
  return { data: unchanged ? structuredClone(decoded.original) : encoded, ...c.report };
}
export function convertRequest(args: ConvertInput): ConversionResult<JsonValue> { return encodeProtocol("request", decodeProtocol("request", args), args.to, args.options, args.registry); }
export function convertResponse(args: ConvertInput): ConversionResult<JsonValue> { return encodeProtocol("response", decodeProtocol("response", args), args.to, args.options, args.registry); }
