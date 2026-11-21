import { isInteger, parse, stringify, toSafeNumberOrThrow } from "lossless-json";
import type { JsonValue } from "./types.js";

/** Preserve integer identifiers before JavaScript has a chance to round them. */
export function parseWireJson(text: string): JsonValue {
  // All integer tokens of 15 digits or fewer fit in Number. A match inside a
  // quoted string merely selects the more conservative parser.
  if (!/\d{16}|\d[.eE]/.test(text)) return JSON.parse(text) as JsonValue;
  return parse(text, null, token => {
    const value = Number(token);
    if (isInteger(token) && !Number.isSafeInteger(value)) return BigInt(token);
    return toSafeNumberOrThrow(token);
  }) as JsonValue;
}

/** BigInts in the IR represent unquoted JSON integer tokens on the wire. */
export function stringifyWireJson(value: unknown, replacer: null = null, space?: number): string {
  try { return JSON.stringify(value, replacer, space); }
  catch (error) {
    if (!(error instanceof TypeError) || !/bigint/i.test(error.message)) throw error;
    const result = stringify(value, replacer, space);
    if (result === undefined) throw error;
    return result;
  }
}
