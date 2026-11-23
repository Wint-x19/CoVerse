import { blockAsset, SessionError, stringifyWireJson, type CSR, type HistoryEvent, type RecordedAsset, type Turn } from "@coverse/core";
import type { ChatMessage, ToolActivity } from "../shared/types.js";

export function restoreHistory(existing:ChatMessage[], recorded:ChatMessage[], frozen:boolean) {
  const live = existing.filter(m => !m.historical);
  if (frozen || !live.length) return [...recorded,...live];
  const prior = existing.filter(m => m.historical);
  const last = prior.at(-1);
  let boundary = last ? recorded.findIndex(m => m.id === last.id && m.role === last.role) : -1;
  if (last && boundary < 0) {
    // Early desktop versions generated random history IDs and merged tool-only messages.
    // Match their visible text in order. A changed source must not erase locally appended turns.
    for (const old of prior.filter(m => m.content.trim())) {
      const next = recorded.findIndex((m,i) => i > boundary && m.role === old.role && m.content.trim() === old.content.trim());
      if (next < 0) throw new SessionError("HISTORY_BOUNDARY_UNKNOWN","/history","Source history changed. The saved conversation has been retained.");
      boundary = next;
    }
  }
  const nextUser = recorded.findIndex((m,i) => i > boundary && m.role === "user");
  const firstLive = live.find(m => m.role === "user");
  const stop = nextUser >= 0 && firstLive && recorded[nextUser]!.content.trim() === firstLive.content.trim() ? nextUser : boundary + 1;
  if (last && stop === 0) throw new SessionError("HISTORY_BOUNDARY_UNKNOWN","/history","Cannot identify the original import boundary.");
  return [...recorded.slice(0,stop),...live];
}

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
    const tool = {id:block.id, name:block.name, state:"called", timestamp:turn.createdAt ?? timestamp,
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
    if (block.sources?.length) tool.sources = [...tool.sources ?? [],...block.sources];
    (tool.results ??= []).push({text:typeof block.content === "string" ? block.content : stringifyWireJson(block.content,null,2),
      ...(block.assets ? {assets:block.assets} : {}), ...(block.displayText !== undefined ? {displayText:block.displayText} : {}),
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
    ...(m.createdAt ? {recordedTime:true} : {}), ...(m.model ? {model:m.model} : {}), ...(m.usage ? {usage:m.usage,usageScope:m.usageScope} : {}),
    ...(m.role === "assistant" ? {agent:sourceAgent} : {}), ...(m.activity ? {reasoning:m.activity} : {}),
    ...(m.changedFiles ? {changedFiles:m.changedFiles} : {}), ...(m.reviews ? {reviews:m.reviews} : {}),
    ...(m.assets?.length ? {assets:m.assets} : {}),
    ...(m.plan ? {plan:m.plan} : {}),
    ...(m.sources ? {sources:m.sources} : {}),
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
    const assets: RecordedAsset[] = [...turn.assets ?? []];
    const sources = turn.content.flatMap(b => b.type === "text" ? b.sources ?? [] : []);
    let event = turn.event;
    if (!event && (turn.role === "system" || turn.role === "developer" || turn.origin?.kind === "compaction")) {
      const text = turn.content.flatMap(b => b.type === "text" ? [b.text] : []).join("\n\n");
      if (text) event = {id:turn.id,kind:turn.origin?.kind === "compaction" ? "compaction" : turn.role === "developer" ? "developer" : "system",text};
    }
    if (event) pending.push({...event,sourceRole:turn.role,...(turn.createdAt ? {createdAt:turn.createdAt} : {})});
    for (const block of turn.content) {
      if (block.type === "opaque" || block.type === "unknown") pending.push({id:turn.id + ":opaque:" + pending.length,
        kind:"opaque",text:block.type === "opaque" ? block.source : "Unknown source block"});
    }
    for (const block of turn.content) {
      const asset = blockAsset(block);
      if (asset) assets.push(asset);
    }
    if (!displayOnly) for (const block of turn.content) {
      if (block.type === "text" && event?.kind !== "compaction" && !(block.displayAs === "review" && turn.reviews?.length) &&
          !(block.displayAs === "sources" && sources.length)) parts.push(block.text);
      if (block.type === "reasoning") reasoning.push(block.text);
    }
    const content = parts.join("\n\n");
    if (!content && !sources.length && !turn.childTrajectory && !turn.plan && !assets.length && !reasoning.length && !tools?.length && !turn.changedFiles?.length && !turn.reviews?.length) continue;
    const role = turn.role === "user" && (content || assets.length || turn.reviews?.length) ? "user" : "assistant";
    const base = {id:turn.id,content,createdAt:turn.createdAt ?? timestamp,historical:true,
      ...(turn.createdAt ? {recordedTime:true} : {}), ...(turn.model ? {model:turn.model} : {}),
      ...(turn.usage ? {usage:turn.usage,usageScope:turn.usageScope} : {}),
      ...(turn.durationMs !== undefined ? {durationMs:turn.durationMs} : {}), ...(pending.length ? {before:pending.splice(0)} : {})};
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
      ...(sources.length ? {sources} : {}),
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
