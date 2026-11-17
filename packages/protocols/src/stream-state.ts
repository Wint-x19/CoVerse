import type { ProtocolEvent, ProtocolUsage } from "@coverse/core";
import { ConversionContext } from "./contracts.js";
import { jsonArguments } from "./validation.js";

export interface BlockState { index: number; kind: "text" | "reasoning" | "tool_call"; text: string; id?: string; name?: string; ended: boolean; opaque?: { source: string; value: string } }
/** One response lifecycle. Multiple candidates require explicit selection in M1 streams. */
export class StreamState {
  started = false; finished = false; ended = false;
  id = ""; model = ""; reason = ""; usage: ProtocolUsage = {};
  readonly blocks = new Map<number, BlockState>();
  constructor(readonly c: ConversionContext) {}
  accept(e: ProtocolEvent): void {
    if (this.ended) this.c.fail("INVALID_EVENT_ORDER", "/stream", "Event after terminal event");
    if (e.type === "start") {
      if (this.started) this.c.fail("INVALID_EVENT_ORDER", "/stream", "Duplicate response start");
      this.started = true; this.id = e.id; this.model = e.model; return;
    }
    if (!this.started) this.c.fail("INVALID_EVENT_ORDER", "/stream", "Event before response start");
    if (e.type === "usage") { this.usage = { ...this.usage, ...e.usage }; return; }
    if (e.type === "end") {
      if (!this.finished) this.c.fail("TRUNCATED_STREAM", "/stream", "No finish reason before terminal event");
      this.ended = true; return;
    }
    if (this.finished) this.c.fail("INVALID_EVENT_ORDER", "/stream", "Content after finish");
    if (e.type === "finish") {
      if ([...this.blocks.values()].some(b => !b.ended)) this.c.fail("INVALID_EVENT_ORDER", "/stream", "Finish before content blocks close");
      this.finished = true; this.reason = e.reason; return;
    }
    if (!Number.isSafeInteger(e.index) || e.index < 0) this.c.fail("INVALID_INPUT", "/index", "Invalid block index");
    if (e.type === "block_start") {
      if (this.blocks.has(e.index)) this.c.fail("INVALID_EVENT_ORDER", "/stream", "Duplicate block start");
      if (e.kind === "tool_call" && (!e.id || !e.name || [...this.blocks.values()].some(b => b.id === e.id))) this.c.fail("INVALID_TOOL_LINK", "/stream", "Empty or duplicate tool identity");
      this.blocks.set(e.index, { ...e, text: "", ended: false }); return;
    }
    const block = this.blocks.get(e.index);
    if (!block || block.ended) this.c.fail("INVALID_EVENT_ORDER", "/stream", "Delta/stop requires an open block");
    if (e.type === "reasoning_state") {
      if (block.kind !== "reasoning" || block.opaque && block.opaque.source !== e.source) this.c.fail("INVALID_EVENT_ORDER", "/stream", "Reasoning state on incompatible block");
      block.opaque = { source: e.source, value: (block.opaque?.value ?? "") + e.value };
    }
    else if (e.type === "delta") block.text += e.text;
    else {
      if (block.kind === "tool_call") jsonArguments(block.text, this.c, `/blocks/${e.index}/arguments`);
      block.ended = true;
    }
  }
  ensureEnd(): void { if (!this.ended) this.c.fail("TRUNCATED_STREAM", "/stream", "Missing terminal event"); }
}
