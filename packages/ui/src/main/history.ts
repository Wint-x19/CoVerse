import { blockAsset, stringifyWireJson, type CSR, type RecordedAsset, type Turn } from "@coverse/core";
import type { ChatMessage, ToolActivity } from "../shared/types.js";

function historicalTools(turns: readonly Turn[], timestamp: string) {
  const byTurn = new Map<Turn, ToolActivity[]>();
  const byOrigin = new Map<string, ToolActivity>();
  const byBranch = new Map<string, ToolActivity>();
  const key = (scope: string, id: string) => JSON.stringify([scope, id]);
  const add = (turn: Turn, tool: ToolActivity) => {
    const tools = byTurn.get(turn) ?? [];
    tools.push(tool);
    byTurn.set(turn, tools);
  };
  for (const turn of turns) for (const block of turn.content) {
    if (block.type !== "tool_call") continue;
    const tool = {id:block.id, name:block.name, state:"called", timestamp,
      argumentsText:block.argumentsText ?? stringifyWireJson(block.arguments, null, 2)};
    add(turn, tool);
    byOrigin.set(key(turn.id, block.id), tool);
    byBranch.set(key(turn.origin?.branchId ?? "main", block.id), tool);
  }
  for (const turn of turns) for (const block of turn.content) {
    if (block.type !== "tool_result") continue;
    let tool = block.callTurnId ? byOrigin.get(key(block.callTurnId,block.callId))
      : byBranch.get(key(turn.origin?.branchId ?? "main",block.callId));
    if (!tool) {
      tool = {id:block.callId, name:block.callId, state:"", timestamp};
      add(turn, tool);
    }
    tool.state = block.isError ? "failed" : "completed";
    (tool.results ??= []).push({text:typeof block.content === "string" ? block.content : stringifyWireJson(block.content,null,2),
      ...(block.assets ? {assets:block.assets,displayText:block.displayText ?? ""} : {}),
      ...(block.isError ? {failed:true} : {})});
    if (turn.role === "tool") {
      const details = turn.content.flatMap(b => b.type === "text" ? [b.text] : b.type === "attachment" ? [b.path] : []);
      if (details.length) tool.details = details.join("\n\n");
    }
  }
  return byTurn;
}

/** Project recorded events onto the desktop thread without changing the continuation window. */
export function csrTurnsToChatMessages(turns: readonly Turn[], sourceAgent: string, timestamp: string, transcript?: CSR["transcript"]): ChatMessage[] {
  if (transcript) return transcript.map(m => ({
    id:m.id, role:m.role, content:m.text, createdAt:m.createdAt ?? timestamp, historical:true,
    ...(m.role === "assistant" ? {agent:sourceAgent} : {}), ...(m.activity ? {reasoning:m.activity} : {}),
    ...(m.changedFiles ? {changedFiles:m.changedFiles} : {}), ...(m.reviews ? {reviews:m.reviews} : {}),
    ...(m.assets?.length ? {assets:m.assets} : {}),
    ...(m.plan ? {plan:m.plan} : {}),
    ...(m.tools?.length ? {tools:m.tools.map(tool => ({...tool,timestamp:m.createdAt ?? timestamp}))} : {}),
    ...(m.durationMs !== undefined ? {durationMs:m.durationMs} : {}),
  }));
  const toolsByTurn = historicalTools(turns, timestamp);
  const messages: ChatMessage[] = [];
  for (const turn of turns) {
    const tools = toolsByTurn.get(turn);
    const displayOnly = turn.role === "system" || turn.role === "developer" || turn.role === "tool";
    const parts: string[] = [], reasoning: string[] = [];
    const assets: RecordedAsset[] = [];
    for (const block of turn.content) {
      const asset = blockAsset(block);
      if (asset) assets.push(asset);
    }
    if (!displayOnly) for (const block of turn.content) {
      if (block.type === "text" && !(block.displayAs === "review" && turn.reviews?.length)) parts.push(block.text);
      if (block.type === "reasoning") reasoning.push(block.text);
    }
    const content = parts.join("\n\n");
    if (!content && !turn.plan && !assets.length && !reasoning.length && !tools?.length && !turn.changedFiles?.length && !turn.reviews?.length) continue;
    const role = turn.role === "user" && (content || assets.length || turn.reviews?.length) ? "user" : "assistant";
    const base = {id:turn.id, content, createdAt:timestamp, historical:true};
    // A Claude user record can contain both an actual user message and the results of earlier work.
    if (role === "user" && (turn.changedFiles?.length || tools?.length)) {
      messages.push({...base,id:turn.id + ":activity",role:"assistant",agent:sourceAgent,content:"",
        ...(turn.changedFiles?.length ? {changedFiles:turn.changedFiles} : {}), ...(tools?.length ? {tools} : {})});
    }
    messages.push({...base,role,...(assets.length ? {assets} : {}), ...(role === "assistant" ? {agent:sourceAgent,
      ...(tools?.length ? {tools} : {}), ...(turn.changedFiles?.length ? {changedFiles:turn.changedFiles} : {})} : {}),
      ...(reasoning.length ? {reasoning:reasoning.join("\n\n")} : {}),
      ...(turn.plan ? {plan:turn.plan} : {}),
      ...(turn.reviews?.length ? {reviews:turn.reviews} : {})});
  }
  return messages;
}
