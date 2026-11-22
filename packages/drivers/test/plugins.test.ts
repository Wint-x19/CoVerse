import { expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import * as fs from "node:fs/promises";
import { createSandbox, removeSandbox } from "../../../tools/test-helpers.js";
import { createDriverRegistry } from "../src/index.js";

const registry = createDriverRegistry();
it("discovers both Antigravity stores and flags a busy CLI conversation", async () => {
  const sandbox = await createSandbox();
  const homedir = vi.spyOn(os, "homedir").mockReturnValue(sandbox);
  try {
    const driver = registry.get("antigravity");
    const cli = path.join(sandbox, ".gemini", "antigravity-cli", "conversations");
    await fs.mkdir(cli, {recursive:true});
    await fs.writeFile(path.join(cli, "one.db"), "test");
    await fs.writeFile(path.join(cli, "one.db-journal"), "busy");
    expect(await driver.listLocalSessions()).toMatchObject([{id:"one", active:true}]);
    const desktop = path.join(sandbox, ".gemini", "antigravity", "conversations");
    await fs.mkdir(desktop, {recursive:true});
    await fs.writeFile(path.join(desktop, "two.db"), "test");
    expect((await driver.listLocalSessions()).map(s => s.id).sort()).toEqual(["one", "two"]);
    expect(await driver.listLocalSessions(1)).toHaveLength(1);
  } finally {
    homedir.mockRestore();
    await removeSandbox(sandbox);
  }
});
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

it("emits a missing final suffix exactly once and rejects contradictory summaries", () => {
  const decode = registry.get("antigravity").plugin.decoder();
  decode({ event: "step_update", step_update: { conversation_id: "id", step_type: "agent_response", text_delta: "abc" } });
  const result = (response: string) => decode({ event: "result", result: { conversation_id: "id", response, status: "SUCCESS" } });
  expect(result("abcde")).toContainEqual({ type: "text", text: "de" });
  expect(() => result("different")).toThrow("differs");
});
