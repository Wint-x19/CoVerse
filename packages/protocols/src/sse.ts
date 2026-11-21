import { stringifyWireJson } from "@coverse/core";
import { ConversionContext } from "./contracts.js";

export interface SseFrame { event: string; data: string }
/** The input is bytes, not network frames: UTF-8 and CRLF may straddle chunks. */
export async function* readSse(input: AsyncIterable<Uint8Array>, c: ConversionContext): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder("utf-8", { fatal: true }); const iterator = input[Symbol.asyncIterator]();
  let fragments: string[] = []; let skipLF = false;
  let event = "message"; let data: string[] = [];
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
      const abort = signal && new Promise<never>((_, reject) => {
        const handler = () => { try { c.fail("CANCELLED", "/stream", "Conversion cancelled"); } catch (e) { reject(e); } };
        signal.addEventListener("abort", handler, { once: true }); remove = () => signal.removeEventListener("abort", handler);
      });
      let next: IteratorResult<Uint8Array>;
      try { next = abort ? await Promise.race([iterator.next(), abort]) : await iterator.next(); } finally { remove(); }
      let chunk: string;
      try { chunk = next.done ? decoder.decode() : decoder.decode(next.value, { stream: true }); }
      catch { c.fail("INVALID_SSE", "/stream", "Invalid UTF-8 stream"); }
      if (chunk.length) {
        let start: number = skipLF && chunk[0] === "\n" ? 1 : 0;
        skipLF = false;
        const endings = /\r\n|[\r\n]/g;
        endings.lastIndex = start;
        for (let match; (match = endings.exec(chunk));) {
          const tail = chunk.slice(start, match.index);
          const frame = line(fragments.length ? fragments.join("") + tail : tail);
          fragments = [];
          start = endings.lastIndex;
          skipLF = match[0] === "\r" && start === chunk.length;
          if (frame) yield frame;
        }
        if (start < chunk.length) fragments.push(chunk.slice(start));
      }
      if (next.done) break;
    }
    if (fragments.length || data.length || event !== "message") c.fail("TRUNCATED_STREAM", "/stream", "SSE ended inside an event");
  } finally {
    if (signal?.aborted) void iterator.return?.().catch(() => {});
    else await iterator.return?.();
  }
}
const encoder = new TextEncoder();
export function sse(data: unknown, event?: string): Uint8Array {
  return encoder.encode(`${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : stringifyWireJson(data)}\n\n`);
}
