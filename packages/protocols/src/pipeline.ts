import type { JsonValue, ProtocolRequest, ProtocolResponse, ProtocolEvent } from "@coverse/core";
import { ConversionContext, ProtocolError, ProtocolRegistry, type ConversionOptions, type ConversionResult, type Decoded, type ConversionReport } from "./contracts.js";
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
  if (options.policy !== "allow-loss" && Object.values(c.report.ledger).some(items => items.length)) c.fail("LOSS_NOT_ALLOWED", "/", "Decoded input already contains losses; strict export cannot erase that history");
  const codec = registry.get(to);
  const encoded = kind === "request" ? codec.encodeRequest(decoded.value as ProtocolRequest, c) : codec.encodeResponse(decoded.value as ProtocolResponse, c);
  const unchanged = decoded.source === to && decoded.snapshot === JSON.stringify(decoded.value) && options.targetModel === undefined && options.maxOutputTokens === undefined && options.candidateIndex === undefined && Object.values(c.report.ledger).every(v => v.length === 0);
  return { data: unchanged ? structuredClone(decoded.original) : encoded, ...c.report };
}
export function convertRequest(args: ConvertInput): ConversionResult<JsonValue> { return encodeProtocol("request", decodeProtocol("request", args), args.to, args.options, args.registry); }
export function convertResponse(args: ConvertInput): ConversionResult<JsonValue> { return encodeProtocol("response", decodeProtocol("response", args), args.to, args.options, args.registry); }

export interface StreamConversion {
  data: AsyncIterable<Uint8Array>;
  /** Live diagnostics, available even if iteration fails. */
  report: ConversionReport;
  /** Resolves on success or failure; errors are thrown by data iteration. */
  completion: Promise<{ status: "completed" | "failed" | "cancelled"; report: ConversionReport; error?: ProtocolError }>;
}
export function convertStream(args: Omit<ConvertInput, "input"> & { input: AsyncIterable<Uint8Array> }): StreamConversion {
  const registry = args.registry ?? createProtocolRegistry(); const source = registry.get(args.from); const target = registry.get(args.to);
  const c = new ConversionContext(args.from, args.to, args.options);
  let settle!: (result: Awaited<StreamConversion["completion"]>) => void;
  const completion = new Promise<Awaited<StreamConversion["completion"]>>(resolve => { settle = resolve; });
  let consumed = false;
  const data: AsyncIterable<Uint8Array> = { async *[Symbol.asyncIterator]() {
    if (consumed) c.fail("STREAM_CONSUMED", "/stream", "Conversion streams are single-use");
    consumed = true; let complete = false; let failure: ProtocolError | undefined;
    try {
      async function* bridge(input: AsyncIterable<ProtocolEvent>): AsyncGenerator<ProtocolEvent> {
        const rendered = new Set<number>();
        for await (const e of input) {
          if (e.type === "block_start" && e.kind === "reasoning" && args.from !== args.to) {
            c.loss("downgraded", "REASONING_AS_TEXT", `/blocks/${e.index}`, "Reasoning rendered as visible text; opaque state stays in report", c.options.reasoningAsText);
            rendered.add(e.index); yield { ...e, kind: "text" };
          } else if (e.type === "reasoning_state" && rendered.has(e.index)) c.preserve(`/blocks/${e.index}/opaque`, e.value, `Opaque reasoning from ${e.source}; not sent to target`);
          else yield e;
        }
      }
      yield* target.encodeStream(bridge(source.decodeStream(args.input, c)), c); complete = true;
    } catch (error) {
      failure = error instanceof ProtocolError ? error : new ProtocolError("STREAM_ERROR", "/stream", error instanceof Error ? error.message : "Stream failed", c.report);
      throw failure;
    } finally {
      settle({ status: complete ? "completed" : failure && failure.code !== "CANCELLED" ? "failed" : "cancelled", report: c.report, ...(failure ? { error: failure } : {}) });
    }
  } };
  return { data, report: c.report, completion };
}
