import type { JsonValue, Turn } from "@coverse/core";
import { ConversionContext } from "./contracts.js";
export type Obj = { [key: string]: JsonValue };
export function object(value: unknown, c: ConversionContext, path: string): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) c.fail("INVALID_INPUT", path, "Expected an object");
  return value as Obj;
}
export function array(value: unknown, c: ConversionContext, path: string): JsonValue[] {
  if (!Array.isArray(value)) c.fail("INVALID_INPUT", path, "Expected an array");
  return value as JsonValue[];
}
export function string(value: unknown, c: ConversionContext, path: string): string {
  if (typeof value !== "string") c.fail("INVALID_INPUT", path, "Expected a string");
  return value as string;
}
export function nonempty(value: unknown, c: ConversionContext, path: string): string {
  const result = string(value, c, path);
  if (!result.length) c.fail("INVALID_INPUT", path, "Expected a nonempty string");
  return result;
}
export function number(value: unknown, c: ConversionContext, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) c.fail("INVALID_INPUT", path, "Expected a finite number");
  return value as number;
}
export function boolean(value: unknown, c: ConversionContext, path: string): boolean {
  if (typeof value !== "boolean") c.fail("INVALID_INPUT", path, "Expected a boolean");
  return value as boolean;
}
export function pointer(key: string): string { return key.replace(/~/g, "~0").replace(/\//g, "~1"); }
export function fields(o: Obj, known: readonly string[], c: ConversionContext, path: string): void {
  for (const [k, v] of Object.entries(o)) if (!known.includes(k)) c.unsupported(`${path}/${pointer(k)}`, v, "Unverified field; not forwarded");
}
export function literal(value: unknown, allowed: readonly JsonValue[], c: ConversionContext, path: string): void {
  if (!allowed.includes(value as JsonValue)) c.fail("INVALID_INPUT", path, "Unexpected discriminator or value");
}
export function jsonArguments(value: unknown, c: ConversionContext, path: string): { arguments: JsonValue; argumentsText: string } {
  const text = string(value, c, path);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return c.fail("INVALID_ARGUMENTS", path, "Tool arguments must be complete JSON"); }
  object(parsed, c, path);
  return { arguments: parsed as JsonValue, argumentsText: text };
}
/** Request histories must contain an earlier, unique call for every result. */
export function validateHistory(messages: readonly Turn[], c: ConversionContext): void {
  const calls = new Set<string>(); const results = new Set<string>();
  messages.forEach((m, i) => m.content.forEach((b, j) => {
    const p = `/messages/${i}/content/${j}`;
    if (b.type === "tool_call") {
      if (m.role !== "assistant" || calls.has(b.id) || !b.id || !b.name) c.fail("INVALID_TOOL_LINK", p, "Duplicate, empty, or misplaced tool call");
      calls.add(b.id);
    }
    if (b.type === "tool_result") {
      if (!["tool", "user"].includes(m.role) || !calls.has(b.callId) || results.has(b.callId)) c.fail("INVALID_TOOL_LINK", p, "Result requires a unique preceding tool call");
      results.add(b.callId);
    }
  }));
}
