import { ConversionContext } from "./contracts.js";

export interface SseFrame { event: string; data: string }
/** The input is bytes, not network frames: UTF-8 and CRLF may straddle chunks. */
export async function* readSse(input: AsyncIterable<Uint8Array>, c: ConversionContext): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder("utf-8", { fatal: true }); const iterator = input[Symbol.asyncIterator]();
  let buffer = ""; let event = "message"; let data: string[] = [];
  const signal = c.options.signal;
  const line = (text: string): SseFrame | undefined => {
    if (text === "") { const frame = data.length ? { event, data: data.join("\n") } : undefined; event = "message"; data = []; return frame; }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":"); const key = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1); if (value.startsWith(" ")) value = value.slice(1);
    if (key === "event") event = value;
    else if (key === "data") data.push(value);
    else if (key === "id" || key === "retry") c.preserve(`/sse/${key}`, value, "Transport reconnection metadata; offline conversion does not reconnect");
    else c.fail("INVALID_SSE", "/stream", `Unrecognized SSE field: ${key}`);
  };
  try {
    for (;;) {
      if (signal?.aborted) c.fail("CANCELLED", "/stream", "Conversion cancelled");
      let remove = () => {};
      const abort = new Promise<never>((_, reject) => {
        if (!signal) return;
        const handler = () => { try { c.fail("CANCELLED", "/stream", "Conversion cancelled"); } catch (e) { reject(e); } };
        signal.addEventListener("abort", handler, { once: true }); remove = () => signal.removeEventListener("abort", handler);
      });
      let next: IteratorResult<Uint8Array>;
      try { next = await Promise.race([iterator.next(), abort]); } finally { remove(); }
      try { buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true }); }
      catch { c.fail("INVALID_SSE", "/stream", "Invalid UTF-8 stream"); }
      for (;;) {
        const index = buffer.search(/[\r\n]/);
        if (index < 0 || !next.done && buffer[index] === "\r" && index === buffer.length - 1) break;
        const text = buffer.slice(0, index); const size = buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(index + size); const frame = line(text); if (frame) yield frame;
      }
      if (next.done) break;
    }
    if (buffer.length || data.length || event !== "message") c.fail("TRUNCATED_STREAM", "/stream", "SSE ended inside an event");
  } finally {
    if (signal?.aborted) void iterator.return?.().catch(() => {});
    else await iterator.return?.();
  }
}
const encoder = new TextEncoder();
export function sse(data: unknown, event?: string): Uint8Array {
  return encoder.encode(`${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}
