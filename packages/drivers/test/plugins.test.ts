import { expect, it } from "vitest";
import { createDriverRegistry } from "../src/index.js";

const registry = createDriverRegistry();
it("uses explicit native resume with a prompt on stdin on each target", () => {
  for (const driver of registry.list()) {
    const { args, input } = driver.plugin.invocation({ session: "target-id", prompt: "new question", cwd: ".", model: "test-model" });
    expect(args).toContain("target-id");
    expect(args).toContain("test-model");
    expect(args).not.toContain("new question");
    expect(input).toContain("new question");
  }
});
it("streams Claude deltas once, ignores nested text, and exposes terminal errors", () => {
  const decode = registry.get("claude-code").plugin.decoder();
  expect(decode({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "你好" } } })).toEqual([{ type: "text", text: "你好" }]);
  expect(decode({ type: "assistant", message: { content: [{ type: "text", text: "你好" }] } })).toEqual([]);
  expect(decode({ type: "assistant", parent_tool_use_id: "parent", message: { content: [{ type: "text", text: "child" }] } })).toEqual([]);
  expect(decode({ type: "result", subtype: "success", is_error: false, result: "你好", session_id: "id" })).toEqual([{ type: "session", id: "id" }, { type: "done" }]);
  expect(() => decode({ type: "result", subtype: "error", errors: ["prompt too long"] })).toThrow("prompt too long");
});
it("maps Codex and Antigravity tool and terminal records", () => {
  const codex = registry.get("codex").plugin.decoder(), agy = registry.get("antigravity").plugin.decoder();
  expect(codex({ type: "item.started", item: { type: "command_execution", status: "in_progress" } })[0]?.type).toBe("tool");
  expect(codex({ type: "turn.completed", usage: { input_tokens: 5 } }).map(e => e.type)).toEqual(["usage", "done"]);
  expect(agy({ event: "step_update", step_update: { conversation_id: "id", step_type: "tool", tool_name: "read", state: "DONE" } }).at(-1)?.type).toBe("tool");
  expect(codex({ type: "turn.completed", usage: { input_tokens: 5, cached_input_tokens: 2 } })[0]).toEqual({
    type: "usage", usage: { input: 5, cachedInput: 2 }, nativeUsage: { input_tokens: 5, cached_input_tokens: 2 },
  });
  expect(() => agy({ event: "result", result: { status: "WAITING" } })).toThrow();
});
