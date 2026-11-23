import {isRecord, type JsonValue, type RecordedPlan} from "@coverse/core";

export function readToolPlan(name:string, args:JsonValue): RecordedPlan | undefined {
  if (!["update_plan","functions.update_plan","todo_list"].includes(name) || !isRecord(args)) return;
  const items = name === "todo_list" ? args.items : args.plan;
  if (!Array.isArray(items)) return;
  const steps: RecordedPlan["steps"] = [];
  for (const item of items) {
    if (!isRecord(item)) return;
    const title = item.step ?? item.text;
    if (typeof title !== "string") return;
    const status = item.status ?? (typeof item.completed === "boolean" ? item.completed ? "completed" : "pending" : undefined);
    steps.push({title,...(typeof status === "string" ? {status} : {})});
  }
  return {steps,...(typeof args.explanation === "string" ? {text:args.explanation} : {})};
}
