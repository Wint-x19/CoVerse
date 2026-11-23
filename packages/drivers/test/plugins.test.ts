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
    expect(await driver.listLocalSessions()).toMatchObject([{id:"one", active:true, size:8}]);
    const desktop = path.join(sandbox, ".gemini", "antigravity", "conversations");
    await fs.mkdir(desktop, {recursive:true});
    await fs.writeFile(path.join(desktop, "two.db"), "test");
    expect((await driver.listLocalSessions()).map(s => s.id).sort()).toEqual(["one", "two"]);
    expect(await driver.listLocalSessions(1)).toHaveLength(1);
    const journal = path.join(cli, "one.db-journal");
    const latest = new Date(Date.now() + 10000);
    await fs.utimes(journal, latest, latest);
    expect(await driver.listLocalSessions(1)).toMatchObject([{id:"one"}]);
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
it("streams only readable reasoning, deduplicates the Claude snapshot, and reports the actual model", () => {
  const claude = registry.get("claude-code").plugin.decoder();
  const events = [
    ...claude({type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"thinking_delta",thinking:"part"}}}),
    ...claude({type:"assistant",message:{model:"resolved",content:[
      {type:"thinking",thinking:"part rest"},{type:"redacted_thinking",data:"ciphertext"},{type:"text",text:"answer"},
    ]}}),
  ];
  expect(events.flatMap(e => e.type === "reasoning" ? [e.text] : []).join("").trim()).toBe("part rest");
  expect(events).toContainEqual({type:"model",model:"resolved"});
  expect(events).toContainEqual({type:"text",text:"answer"});
  const codex = registry.get("codex").plugin.decoder();
  expect(codex({type:"item.completed",item:{type:"reasoning",text:"readable"}})[0]).toEqual({type:"reasoning",text:"readable\n\n"});
  expect(codex({type:"item.completed",item:{type:"reasoning",encrypted_content:"cipher"}})).toEqual([]);
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

it("preserves tool identities, exact arguments and real outputs across each CLI stream", () => {
  const codex = registry.get("codex").plugin.decoder();
  expect(codex({type:"item.completed",item:{id:"f",type:"file_change",changes:[{path:"a.md",diff:"@@ -1 +1 @@\n-a\n+b\n"},{path:"b.md",kind:"update"}]}})[0])
    .toMatchObject({changedFiles:[{path:"a.md",added:1,removed:1,patches:["@@ -1 +1 @@\n-a\n+b\n"]},{path:"b.md",added:null,removed:null}]});
  expect(codex({type:"item.completed",item:{id:"c",type:"command_execution",command:"read example",exit_code:1,aggregated_output:"missing"}})[0])
    .toMatchObject({id:"c",argumentsText:"read example",results:[{text:"missing",failed:true}]});
  const claude = registry.get("claude-code").plugin.decoder();
  expect(claude({type:"assistant",message:{content:[{type:"tool_use",id:"r",name:"Read",input:{id:9007199254740993n}}]}})[0])
    .toMatchObject({id:"r",argumentsText:expect.stringContaining("9007199254740993")});
  expect(claude({type:"user",message:{content:[{type:"tool_result",tool_use_id:"r",content:"body"}]}})[0])
    .toMatchObject({id:"r",name:"Read",results:[{text:"body"}]});
  const agy = registry.get("antigravity").plugin.decoder();
  expect(agy({event:"step_update",step_update:{step_index:4,conversation_id:"s",step_type:"tool",tool_name:"read",state:"DONE",
    tool_info:{parameters:{path:"p"},output:"returned text"}}}).at(-1)).toMatchObject({
      id:"step-4",argumentsText:expect.stringContaining('"p"'),results:[{text:"returned text"}],
    });
});

it("emits a missing final suffix exactly once and rejects contradictory summaries", () => {
  const decode = registry.get("antigravity").plugin.decoder();
  decode({ event: "step_update", step_update: { conversation_id: "id", step_type: "agent_response", text_delta: "abc" } });
  const result = (response: string) => decode({ event: "result", result: { conversation_id: "id", response, status: "SUCCESS" } });
  expect(result("abcde")).toContainEqual({ type: "text", text: "de" });
  expect(() => result("different")).toThrow("differs");
});
