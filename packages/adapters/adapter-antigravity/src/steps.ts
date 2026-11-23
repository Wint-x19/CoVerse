import {compareFileVersions, isRecord, parseWireJson, requireString, SessionError, stringifyWireJson, validateToolLinks, webSource,
  type ContentBlock, type CSR, type FileSet, type JsonValue, type LossLedger, type RecordedFileChange, type Turn} from "@coverse/core";
import {decodeWire, nestedRecord} from "./wire.js";
import {readReviews} from "./reviews.js";
import {readArtifactSnapshots, readMedia} from "./media.js";
import {stepMetadata} from "./metadata.js";
import {companionForUri,linkedAssets} from "./companions.js";

export type StepRow = Record<string,string | number | Uint8Array | null>;
interface StepSource { file:{path:string}; files:FileSet; ledger:LossLedger }

function object(value: JsonValue | undefined, at: string): Record<string, JsonValue> {
  if (!isRecord(value)) throw new SessionError("INVALID_INPUT", at, "Required protobuf message is missing");
  return value;
}
const populated = (v: JsonValue | undefined) => v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && !v.length);
function opaqueFields(content: ContentBlock[], value: Record<string, JsonValue>, fields: readonly string[]) {
  for (const field of fields) if (populated(value[field])) content.push({ type: "opaque", source: `antigravity:${field}`, value: value[field]! });
}
function callBlock(value: JsonValue, at: string): Extract<ContentBlock, { type: "tool_call" }> {
  const call = object(value, at);
  if (populated(call.invalid_json_str) || populated(call.invalid_json_err)) throw new SessionError("INVALID_INPUT", at, "Native tool arguments are marked invalid");
  const text = requireString(call.arguments_json, at);
  let args: JsonValue;
  try { args = parseWireJson(text) as JsonValue; } catch { throw new SessionError("INVALID_INPUT", at, "Invalid tool argument JSON"); }
  return { type: "tool_call", id: requireString(call.id, at), name: requireString(call.name, at), arguments: args, argumentsText: text };
}

export function readSteps(session: CSR, steps: StepRow[], context:StepSource, ancestors = new Set([session.meta.id]), parent?: string) {
  const {file,files,ledger} = context;
  const calls = new Map<string, ContentBlock>();
  let previousId = parent;
  for (const row of steps) {
    const at = `${file.path}/steps/${row.idx}`;
    if (row.step_format !== 0) throw new SessionError("UNSUPPORTED_VERSION", at, "Only verified step_format=0 is supported");
    if (!(row.step_payload instanceof Uint8Array)) throw new SessionError("INVALID_INPUT", at, "Missing step protobuf");
    const decoded = decodeWire("Step", row.step_payload, at), step = decoded.value;
    if (decoded.unknown.length) throw new SessionError("UNINTERPRETED_CONTENT", decoded.unknown[0]!, "Unknown protobuf field may contain conversation context");
    if (row.has_subtrajectory && !step.subtrajectory) throw new SessionError("MISSING_RELATED_RECORD",at,"Subtrajectory payload is missing");
    if (step.type !== row.step_type || step.status !== row.status) throw new SessionError("INVALID_INPUT", at, "SQLite and protobuf step type/status disagree");
    const contentFields: Record<number, string> = { 14: "user_input", 15: "planner_response", 17: "error_message", 23: "checkpoint", 81:"task_boundary", 101: "system_message", 132: "generic" };
    if (Object.values(contentFields).filter(key => step[key] !== undefined).join() !== contentFields[Number(step.type)]) throw new SessionError("INVALID_INPUT", at, "Step discriminator and payload variant disagree");
    if (![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12].includes(Number(step.status))) throw new SessionError("UNSUPPORTED_VERSION", at, "Unknown step status");
    const content: ContentBlock[] = [];
    const changedFiles: RecordedFileChange[] = [];
    let reviews: Turn["reviews"];
    let plan: Turn["plan"];
    let event: Turn["event"];
    let role: Turn["role"] = "system", kind: NonNullable<Turn["origin"]>["kind"] = "message";
    const recordCall = (value: JsonValue, inPlanner: boolean) => {
      const block = callBlock(value, at), old = calls.get(block.id);
      if (old && (inPlanner || stringifyWireJson(old) !== stringifyWireJson(block))) throw new SessionError("INVALID_INPUT", at, "Conflicting or duplicate native tool call");
      if (!old) { calls.set(block.id, block); content.push(block); }
      if (isRecord(value)) opaqueFields(content, value, ["function_call_parts"]);
      return block.id;
    };
    switch (step.type) {
      case 14: {
        role = "user"; const user = object(step.user_input, at);
        // CLI and desktop can mirror a single text item into user_response.
        const mirror = Array.isArray(user.items) && user.items.length === 1 &&
          isRecord(user.items[0]) && user.items[0].text === user.user_response;
        for (const key of ["query", "user_response"]) if (typeof user[key] === "string" && user[key]) content.push({ type: "text", text: user[key] });
        if (Array.isArray(user.items)) for (const item of user.items) {
          const entry = object(item, at); if (!mirror && typeof entry.text === "string") content.push({ type: "text", text: entry.text });
          opaqueFields(content, entry, ["item"]);
        }
        reviews = readReviews(user, content, at);
        readMedia(user, content, at);
        opaqueFields(content, user, ["active_user_state", "side_channels"]);
        break;
      }
      case 15: {
        role = "assistant"; const planner = object(step.planner_response, at);
        for (const key of ["thinking", "raw_thinking"]) if (typeof planner[key] === "string") content.push({ type: "reasoning", text: planner[key] });
        if (typeof planner.response === "string") content.push({ type: "text", text: planner.response });
        if (typeof planner.modified_response === "string" && planner.modified_response !== planner.response) content.push({ type: "text", text: `Modified historical response:\n${planner.modified_response}` });
        if (Array.isArray(planner.tool_calls)) for (const call of planner.tool_calls) recordCall(call, true);
        readMedia(planner, content, at);
        if (planner.grounding_metadata) {
          const grounding = nestedRecord("GroundingMetadata",planner.grounding_metadata,at);
          const sources = Array.isArray(grounding?.sources) ? grounding.sources.flatMap(s =>
            isRecord(s) && isRecord(s.web) ? webSource(s.web.uri,s.web.title,s.web.snippet) : []) : [];
          if (sources.length) content.push({type:"text",displayAs:"sources",sources,text:"Historical grounding:\n" + stringifyWireJson(grounding,null,2)});
          else opaqueFields(content,planner,["grounding_metadata"]);
        }
        opaqueFields(content, planner, ["thinking_redacted", "knowledge_base_items", "side_channels", "passback_context"]);
        break;
      }
      case 132: {
        role = "tool"; const generic = object(step.generic, at), metadata = object(step.metadata, at);
        const callId = recordCall(metadata.modified_tool_call ?? metadata.tool_call ?? null, false);
        if (isRecord(generic.result)) {
          const result = generic.result;
          content.push({ type: "tool_result", callId, content: typeof result.result === "string" ? result.result : "", isError: step.status === 7 });
          if (Array.isArray(result.metadata) || Array.isArray(result.data)) content.push({ type: "text", text: `Native tool result metadata:\n${stringifyWireJson({ metadata: result.metadata, data: result.data }, null, 2)}` });
          if (typeof result.full_output_uri === "string" && result.full_output_uri) {
            const file = companionForUri(result.full_output_uri,files);
            if (!file) throw new SessionError("MISSING_ATTACHMENT", at, "Supply the uniquely named full tool output referenced by full_output_uri");
            content.push({ type: "attachment", path: file.path, mediaType: "text/plain" });
          }
          readMedia(result, content, at);
          opaqueFields(content, result, ["payload", "data", "tool_call_step", "tool_result_step", "result_struct", "result_value"]);
        } else if (step.status === 3) throw new SessionError("INVALID_INPUT", at, "Completed tool step has no result");
        else content.push({ type: "text", text: `Historical tool step has no result; native status=${String(step.status)}` });
        break;
      }
      case 81: {
        const task = object(step.task_boundary,at);
        const title = task.task_name ?? task.task_summary ?? task.delta_summary;
        if (typeof title === "string") plan = {steps:[{title,
          ...(typeof task.task_status === "string" ? {status:task.task_status} : {}),
          ...(typeof task.task_summary === "string" ? {detail:task.task_summary} : {})}]};
        content.push({type:"text",text:"Historical task boundary:\n" + stringifyWireJson(task,null,2)});
        break;
      }
      case 101: {
        const system = object(step.system_message, at);
        if (typeof system.message === "string") content.push({ type: "text", text: system.message });
        if (system.metadata) content.push({ type: "text", text: `Historical system metadata:\n${stringifyWireJson(system.metadata)}` });
        readMedia(system, content, at);
        opaqueFields(content, system, ["agent_message"]); break;
      }
      case 17: {
        const error = object(step.error_message,at);
        content.push({type:"text",text:"Historical error:\n" + stringifyWireJson(error,null,2)});
        const detail = isRecord(error.error) ? error.error : error;
        const message = detail.user_error_message ?? detail.short_error ?? detail.full_error;
        event = {id:at,kind:"error",text:(typeof message === "string" ? message + "\n\n" : "") + stringifyWireJson(error,null,2)};
        break;
      }
      case 23: {
        kind = "compaction"; const checkpoint = object(step.checkpoint, at);
        const opaqueKeys = ["edited_file_map", "artifact_snapshots", "trajectory_file_diffs", "subagent_snapshots", "running_task_snapshots", "accumulated_sections", "captured_user_requests", "captured_parent_messages"];
        const readable = Object.fromEntries(Object.entries(checkpoint).filter(([key]) => !opaqueKeys.includes(key)));
        event = {id:at,kind:"compaction",text:stringifyWireJson(readable,null,2)};
        content.push({ type: "text", text: `Historical checkpoint:\n${stringifyWireJson(readable, null, 2)}` });
        if (step.status === 3) {
          const covered = new Set(Array.isArray(checkpoint.included_step_indices) ? checkpoint.included_step_indices : []);
          const start = checkpoint.included_step_index_start, end = checkpoint.included_step_index_end;
          const range = covered.size === 0 && typeof start === "number" && typeof end === "number" && start <= end && end < Number(row.idx);
          const knownCoverage = range || covered.size > 0;
          const previous = session.continuation;
          const priorBoundary = previous ? session.turns.findIndex(t => t.id === previous.boundaryId) : -1;
          const priorIds = new Set(previous?.retainedIds);
          const retainedIds = session.turns.filter((t, i) => {
            const index = t.origin!.record;
            return knownCoverage && (i > priorBoundary || priorIds.has(t.id)) && !covered.has(index) &&
              !(range && index >= start && index <= end);
          }).map(t => t.id);
          const boundaryId = `${session.meta.id}:${row.idx}`;
          session.continuation = { boundaryId, retainedIds: [...retainedIds, boundaryId], replacement: [] };
          if (!knownCoverage) ledger.approximated.push({ code: "UNVERIFIED_CHECKPOINT_COVERAGE", path: at,
            reason: "Only the checkpoint and later steps are forwarded; earlier retained steps could not be verified" });
        }
        for (const encoded of Array.isArray(checkpoint.trajectory_file_diffs) ? checkpoint.trajectory_file_diffs : []) {
          const diff = nestedRecord("TrajectoryFileDiff", encoded, at);
          if (!diff || typeof diff.uri !== "string") {
            content.push({type:"opaque", source:"antigravity:trajectory_file_diffs", value:encoded});
            continue;
          }
          // Hash-only checkpoints cannot establish that the original file was empty.
          changedFiles.push(typeof diff.original_content === "string" && typeof diff.modified_content === "string"
            ? compareFileVersions(diff.uri, diff.original_content, diff.modified_content)
            : {path: diff.uri, added: null, removed: null});
          content.push({type:"text", text:"Historical file change:\n" + stringifyWireJson(diff, null, 2)});
        }
        readArtifactSnapshots(checkpoint, content, files, at);
        if (Array.isArray(checkpoint.running_task_snapshots)) for (const bytes of checkpoint.running_task_snapshots) {
          const task = nestedRecord("TaskSnapshot",bytes,at);
          const title = task?.description ?? task?.tool_summary ?? task?.task_id;
          if (!task || typeof title !== "string") {
            content.push({type:"opaque",source:"antigravity:running_task_snapshots",value:bytes});
            continue;
          }
          (plan ??= {steps:[]}).steps.push({title,status:"in_progress"});
          content.push({type:"text",text:"Historical running task:\n" + stringifyWireJson(task,null,2)});
        }
        opaqueFields(content, checkpoint, opaqueKeys.filter(key => !["trajectory_file_diffs","artifact_snapshots","running_task_snapshots"].includes(key))); break;
      }
      default: throw new SessionError("UNSUPPORTED_VERSION", at, "Unverified Antigravity step type");
    }
    if (step.error) content.push({ type: "text", text: `Historical step error:\n${stringifyWireJson(step.error)}` });
    if (!event && step.error) event = {id:at,kind:"error",text:stringifyWireJson(step.error,null,2)};
    session.turns.push({ id: `${session.meta.id}:${row.idx}`, role, content, raw: step, ...stepMetadata(step.metadata,at),
      ...(changedFiles.length ? {changedFiles} : {}),
      ...(reviews?.length ? {reviews} : {}),
      ...(plan ? {plan} : {}),
      ...(event ? {event} : {}),
      origin: { artifact: file.path, record: Number(row.idx), branchId: session.meta.id, kind: step.status === 5 ? "reverted" : kind,
        ...(previousId ? {parentId:previousId} : {}), ...(parent ? {subsession:true} : {}) } });
    const current = session.turns.at(-1)!;
    if (role === "user" || role === "assistant") {
      const assets = content.flatMap(b => b.type === "text" ? linkedAssets(b.text,files) : []);
      if (assets.length) current.assets = assets;
    }
    previousId = current.id;
    if (step.subtrajectory) {
      const child = nestedRecord("ChildTrajectory",step.subtrajectory,at);
      if (!child || typeof child.trajectory_id !== "string" || !child.trajectory_id)
        throw new SessionError("UNINTERPRETED_CONTENT",at,"Unrecognized subtrajectory payload");
      const id = child.trajectory_id;
      if (ancestors.has(id) || ancestors.size >= 32) throw new SessionError("INVALID_INPUT",at,"Invalid subtrajectory ancestry");
      if (Array.isArray(child.parent_references) && child.parent_references.some(ref =>
        !isRecord(ref) || typeof ref.trajectory_id !== "string" || !ancestors.has(ref.trajectory_id))) {
        throw new SessionError("MISSING_RELATED_RECORD",at,"Subtrajectory references a separate parent");
      }
      const childRows = (Array.isArray(child.steps) ? child.steps : []).map((entry,idx) => {
        if (typeof entry !== "string") throw new SessionError("INVALID_INPUT",at,"Invalid child step bytes");
        const payload = Buffer.from(entry,"base64"), childStep = decodeWire("Step",payload,at).value;
        return {idx,step_format:0,step_type:Number(childStep.type),status:Number(childStep.status),step_payload:payload};
      });
      const branch = current.id + "/" + id;
      const nested: CSR = {schemaVersion:"1.0",meta:{...session.meta,id:branch},turns:[],xExtensions:{}};
      readSteps(nested,childRows,context,new Set([...ancestors,id]),current.id);
      current.childTrajectory = {id:branch,turns:nested.turns};
      ledger.downgraded.push({code:"SUBSESSION_ARCHIVED",path:at,reason:"Child trajectory is retained separately from the parent continuation window"});
    }
  }
  validateToolLinks(session.turns);
}
