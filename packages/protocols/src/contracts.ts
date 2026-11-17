import { emptyLedger, type JsonValue, type LossLedger, type ProtocolRequest, type ProtocolResponse, type ProtocolEvent } from "@coverse/core";

export type ProtocolId = "responses" | "chat-completions" | "anthropic-messages";
export interface ConversionOptions {
  policy?: "strict" | "allow-loss";
  targetModel?: string;
  maxOutputTokens?: number;
  allowRoleMerge?: boolean;
  reasoningAsText?: boolean;
  candidateIndex?: number;
  /** Exact source JSON pointers; no wildcard or implicit blanket dropping. */
  omit?: readonly string[];
  signal?: AbortSignal;
}
export interface PreservedData { source: string; path: string; value: JsonValue; reason: string }
export interface ConversionReport { ledger: LossLedger; preserved: PreservedData[] }
export interface Decoded<T> { value: T; source: string; original: JsonValue; snapshot: string; report: ConversionReport }
export interface ConversionResult<T> extends ConversionReport { data: T }
export class ProtocolError extends Error {
  constructor(readonly code: string, readonly path: string, message: string, readonly report: ConversionReport = { ledger: emptyLedger(), preserved: [] }) {
    super(message); this.name = "ProtocolError";
  }
}
export class ConversionContext {
  readonly report: ConversionReport = { ledger: emptyLedger(), preserved: [] };
  constructor(readonly source: string, readonly target: string, readonly options: ConversionOptions = {}) {}
  fail(code: string, path: string, reason: string): never { throw new ProtocolError(code, path, reason, this.report); }
  preserve(path: string, value: JsonValue, reason: string): void { this.report.preserved.push({ source: this.source, path, value: structuredClone(value), reason }); }
  loss(category: keyof LossLedger, code: string, path: string, reason: string, enabled = false): void {
    this.report.ledger[category].push({ code, path, reason });
    if (this.options.policy !== "allow-loss" || !enabled) this.fail("LOSS_NOT_ALLOWED", path, reason);
  }
  unsupported(path: string, value: JsonValue, reason: string): void {
    this.preserve(path, value, reason);
    this.loss("dropped", "UNSUPPORTED_FIELD", path, reason, this.options.omit?.includes(path));
  }
}
export interface ProtocolCodec {
  readonly id: string;
  readonly baseline: string;
  readonly capabilities: readonly string[];
  decodeRequest(input: unknown, context: ConversionContext): ProtocolRequest;
  encodeRequest(input: ProtocolRequest, context: ConversionContext): JsonValue;
  decodeResponse(input: unknown, context: ConversionContext): ProtocolResponse;
  encodeResponse(input: ProtocolResponse, context: ConversionContext): JsonValue;
  decodeStream(input: AsyncIterable<Uint8Array>, context: ConversionContext): AsyncIterable<ProtocolEvent>;
  encodeStream(input: AsyncIterable<ProtocolEvent>, context: ConversionContext): AsyncIterable<Uint8Array>;
}
export class ProtocolRegistry {
  private readonly codecs = new Map<string, ProtocolCodec>();
  register(codec: ProtocolCodec): this {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(codec.id) || this.codecs.has(codec.id)) throw new Error(`Invalid or duplicate protocol: ${codec.id}`);
    this.codecs.set(codec.id, codec); return this;
  }
  get(id: string): ProtocolCodec {
    const codec = this.codecs.get(id);
    if (!codec) throw new ProtocolError("UNKNOWN_PROTOCOL", "/", `Unknown protocol: ${id}`);
    return codec;
  }
  list(): readonly ProtocolCodec[] { return [...this.codecs.values()]; }
}
