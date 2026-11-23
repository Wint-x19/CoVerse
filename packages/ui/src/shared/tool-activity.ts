import type {ToolActivity} from "./types.js";

/** An update sharing the native call ID replaces the latest snapshot of that call. */
export function updateToolActivity(tools: readonly ToolActivity[], event: ToolActivity): ToolActivity[] {
  const index = event.id ? tools.findIndex(t => t.id === event.id) : -1;
  if (index < 0) return [...tools,event];
  const previous = tools[index]!;
  const next = tools.slice();
  next[index] = {...previous,...event,timestamp:previous.timestamp};
  return next;
}
