import { blockAsset, stringifyWireJson, type CSR, type HistoryEvent, type RecordedAsset, type Turn } from "@coverse/core";
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
    ...(m.before ? {before:m.before} : {}), ...(m.after ? {after:m.after} : {}),
    ...(m.lineage ? {lineage:m.lineage} : {}),
    ...(m.tools?.length ? {tools:m.tools.map(tool => ({...tool,timestamp:m.createdAt ?? timestamp}))} : {}),
    ...(m.durationMs !== undefined ? {durationMs:m.durationMs} : {}),
  }));
  const ordered: Turn[] = [];
  function visit(items:readonly Turn[]) {
    for (const turn of items) {
      ordered.push(turn);
      if (turn.childTrajectory) visit(turn.childTrajectory.turns);
    }
  }
  visit(turns);
  const toolsByTurn = historicalTools(ordered, timestamp);
  const messages: ChatMessage[] = [];
  const eventGroups = new Map<string,HistoryEvent[]>();
  const branches = new Set(ordered.map(t => t.origin?.branchId).filter(Boolean));
  const byId = new Map(ordered.map(t => [t.id,t]));
  for (const turn of ordered) {
    const scope = turn.origin?.branchId ?? "";
    const pending = eventGroups.get(scope) ?? [];
    eventGroups.set(scope,pending);
    const tools = toolsByTurn.get(turn);
    const displayOnly = turn.role === "system" || turn.role === "developer" || turn.role === "tool";
    const parts: string[] = [], reasoning: string[] = [];
    const assets: RecordedAsset[] = [];
    let event = turn.event;
    if (!event && (turn.role === "system" || turn.role === "developer" || turn.origin?.kind === "compaction")) {
      const text = turn.content.flatMap(b => b.type === "text" ? [b.text] : []).join("\n\n");
      if (text) event = {id:turn.id,kind:turn.origin?.kind === "compaction" ? "compaction" : turn.role === "developer" ? "developer" : "system",text};
    }
    if (event) pending.push({...event,sourceRole:turn.role});
    for (const block of turn.content) {
      if (block.type === "opaque" || block.type === "unknown") pending.push({id:turn.id + ":opaque:" + pending.length,
        kind:"opaque",text:block.type === "opaque" ? block.source : "Unknown source block"});
    }
    for (const block of turn.content) {
      const asset = blockAsset(block);
      if (asset) assets.push(asset);
    }
    if (!displayOnly) for (const block of turn.content) {
      if (block.type === "text" && event?.kind !== "compaction" && !(block.displayAs === "review" && turn.reviews?.length)) parts.push(block.text);
      if (block.type === "reasoning") reasoning.push(block.text);
    }
    const content = parts.join("\n\n");
    if (!content && !turn.childTrajectory && !turn.plan && !assets.length && !reasoning.length && !tools?.length && !turn.changedFiles?.length && !turn.reviews?.length) continue;
    const role = turn.role === "user" && (content || assets.length || turn.reviews?.length) ? "user" : "assistant";
    const base = {id:turn.id, content, createdAt:timestamp, historical:true, ...(pending.length ? {before:pending.splice(0)} : {})};
    const origin = turn.origin;
    const lineage = origin && {
      ...(origin.branchId && (branches.size > 1 || origin.kind === "subsession") ? {branchId:origin.branchId} : {}),
      ...(origin.parentTurnId || origin.parentId ? {parentId:origin.parentTurnId ?? origin.parentId!} : {}),
      ...(origin.kind === "subsession" || origin.subsession ? {subsession:true} : {}),
      ...(origin.reverted || origin.kind === "reverted" ? {reverted:true} : {}),
    };
    // A Claude user record can contain both an actual user message and the results of earlier work.
    if (role === "user" && (turn.changedFiles?.length || tools?.length)) {
      messages.push({id:turn.id + ":activity",createdAt:timestamp,historical:true,role:"assistant",agent:sourceAgent,content:"",
        ...(turn.changedFiles?.length ? {changedFiles:turn.changedFiles} : {}), ...(tools?.length ? {tools} : {})});
    }
    messages.push({...base,role,...(assets.length ? {assets} : {}), ...(role === "assistant" ? {agent:sourceAgent,
      ...(tools?.length ? {tools} : {}), ...(turn.changedFiles?.length ? {changedFiles:turn.changedFiles} : {})} : {}),
      ...(reasoning.length ? {reasoning:reasoning.join("\n\n")} : {}),
      ...(turn.plan ? {plan:turn.plan} : {}),
      ...(lineage && Object.keys(lineage).length ? {lineage} : {}),
      ...(turn.childTrajectory?.turns.length ? {childBranch:turn.childTrajectory.id} : {}),
      ...(turn.reviews?.length ? {reviews:turn.reviews} : {})});
  }
  const visible = new Set(messages.map(m => m.id));
  for (const message of messages) {
    if (!message.lineage?.parentId) continue;
    let parent: string | undefined = message.lineage.parentId;
    const seen = new Set<string>([message.id]);
    while (parent && !visible.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      const origin: Turn["origin"] = byId.get(parent)?.origin;
      parent = origin?.parentTurnId ?? origin?.parentId;
    }
    if (parent && visible.has(parent) && !seen.has(parent)) message.lineage.parentId = parent;
    else delete message.lineage.parentId;
  }
  for (const [scope,pending] of eventGroups) if (pending.length) {
    const last = messages.slice().reverse().find(m => (byId.get(m.id)?.origin?.branchId ?? "") === scope);
    if (last) last.after = pending;
    else messages.push({id:pending[0]!.id + ":events",role:"assistant",agent:sourceAgent,content:"",historical:true,createdAt:timestamp,after:pending,
      ...(scope && branches.size > 1 ? {lineage:{branchId:scope}} : {})});
  }
  return messages;
}
