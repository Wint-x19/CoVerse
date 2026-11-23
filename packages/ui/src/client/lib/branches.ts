import type {ChatMessage} from "../../shared/types.js";

export function conversationBranches(messages: readonly ChatMessage[]) {
  const branches = new Map<string,{id:string;subsession:boolean;sample:string}>();
  for (const message of messages) {
    const id = message.lineage?.branchId;
    if (!id) continue;
    const branch = branches.get(id) ?? {id,subsession:false,sample:""};
    if (message.lineage?.subsession) branch.subsession = true;
    if (!branch.sample && message.content.trim()) branch.sample = message.content.trim().split("\n")[0]!.slice(0,48);
    branches.set(id,branch);
  }
  return [...branches.values()];
}

export function visibleBranch(messages: ChatMessage[], id: string | undefined) {
  if (!id) return messages;
  const byId = new Map(messages.map(m => [m.id,m]));
  const included = new Set<string>();
  for (const message of messages) {
    if (message.lineage?.branchId !== id) continue;
    let current: ChatMessage | undefined = message;
    while (current && !included.has(current.id)) {
      included.add(current.id);
      current = current.lineage?.parentId ? byId.get(current.lineage.parentId) : undefined;
    }
  }
  return messages.filter(m => included.has(m.id));
}
