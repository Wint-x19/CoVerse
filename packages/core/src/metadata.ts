import type {ProtocolUsage} from "./protocol.js";

export function recordedUsage(source: Partial<Record<keyof ProtocolUsage,unknown>>): ProtocolUsage | undefined {
  const result: ProtocolUsage = {};
  for (const key of Object.keys(source) as (keyof ProtocolUsage)[]) {
    const raw = source[key];
    const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}
