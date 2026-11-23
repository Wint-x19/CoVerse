import {isRecord, type JsonValue, type RecordedPlan} from "@coverse/core";

export function readToolPlan(name:string, args:JsonValue,result?:JsonValue): RecordedPlan | undefined {
  if (!isRecord(args)) return;
  let items: JsonValue | undefined;
  switch (name) {
    case "TodoWrite": items = args.todos; break;
    case "TaskList": items = isRecord(result) ? result.tasks : undefined; break;
    case "TaskGet": items = isRecord(result) && isRecord(result.task) ? [result.task] : undefined; break;
    case "TaskCreate": case "TaskUpdate": items = [args]; break;
    case "ExitPlanMode": return typeof args.plan === "string" ? {text:args.plan,steps:[]} : undefined;
    default: return;
  }
  if (!Array.isArray(items)) return;
  const steps: RecordedPlan["steps"] = [];
  for (const item of items) {
    if (!isRecord(item)) return;
    const title = item.subject ?? item.content ?? item.taskId ?? item.id;
    if (typeof title !== "string") return;
    steps.push({title,...(typeof item.status === "string" ? {status:item.status} : {}),
      ...(typeof item.description === "string" ? {detail:item.description} : {})});
  }
  return {steps};
}
