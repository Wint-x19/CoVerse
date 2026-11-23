import protobuf from "protobufjs";
import { SessionError, type JsonValue } from "@coverse/core";

/** Independently transcribed field facts from the 2.32.1 local release descriptors.
 * bytes fields are explicitly archived native state, never guessed as plaintext.
 * Unknown wire fields are reported, including those nested in known messages. */
const schema = `syntax = "proto3";
message Timestamp { int64 seconds = 1; int32 nanos = 2; }
// TrajectoryFileDiff fields verified against the 2.34.0 desktop descriptors.
message TrajectoryFileDiff { string uri = 1; string original_content = 2; string modified_content = 3; bool is_artifact_file = 4; bool is_knowledge_file = 5; Timestamp last_modified_at = 6; bool has_model_edited = 7; uint32 first_touched_step_index = 8; uint32 last_touched_step_index = 9; bool is_noop = 10; bytes original_content_hash = 11; }
message ReviewSelection { string content = 1; int32 start_line = 2; int32 end_line = 3; string before_text = 4; string after_text = 5; }
message DiffCommentInfo { ReviewSelection original_selection = 1; ReviewSelection modified_selection = 2; string comment = 3; }
message FileCommentInfo { string comment = 1; ReviewSelection selection = 2; bytes image_selection = 3; }
message FileComment { string file_uri = 1; repeated FileCommentInfo file_comment_infos = 2; }
message FileDiffComment { string file_uri = 1; repeated DiffCommentInfo diff_comment_infos = 3; }
message ArtifactSelection { ReviewSelection text_selection = 1; bytes image_selection = 2; }
message ArtifactSelections { repeated ArtifactSelection selections = 1; }
message ArtifactComment { string artifact_uri = 1; string comment = 4; bytes full_file = 5; ArtifactSelections selections = 6; int32 approval_status = 7; string page_title = 8; }
message Pair { string key = 1; string value = 2; }
message DataPair { string key = 1; bytes value = 2; }
message Call { string id = 1; string name = 2; string arguments_json = 3; string invalid_json_str = 4; string invalid_json_err = 5; string thought_signature = 6; bytes thinking_signature = 7; string original_arguments_json = 8; string original_name = 9; repeated bytes function_call_parts = 10; }
message Metadata { Timestamp created_at = 1; int32 source = 3; Call tool_call = 4; repeated string arguments_order = 5; Timestamp viewable_at = 6; Timestamp finished_generating_at = 7; Timestamp completed_at = 8; bytes model_usage = 9; float model_cost = 10; int32 generator_model = 11; string execution_id = 12; bytes requested_model = 13; int32 flow_credits_used = 14; int32 prompt_credits_used = 15; repeated Call tool_call_choices = 16; string tool_call_choice_reason = 17; repeated int32 non_standard_credit_reasons = 18; int32 cortex_request_source = 19; bytes source_trajectory_step_info = 20; uint32 step_generation_version = 21; Timestamp last_completed_chunk_at = 22; int32 tool_call_output_tokens = 23; bytes model_info = 24; bytes snapshot_metadata = 25; bytes internal_metadata = 26; bool wait_for_previous_tools = 27; repeated bytes retry_infos = 28; Call modified_tool_call = 29; string tool_summary = 30; string tool_action = 31; Timestamp started_at = 32; bool is_interrupting_step = 33; repeated bytes pre_tool_hook_results = 34; string model_api_content_id = 35; bytes data_access = 36; bytes remote_control_details = 37; int32 tool_source = 38; int32 sensitivity_level = 39; }
message TextItem { string text = 1; bytes item = 2; }
message UserInput { string query = 1; string user_response = 2; repeated TextItem items = 3; bytes active_user_state = 4; repeated bytes images = 5; bool is_queued_message = 6; repeated bytes artifact_comments = 7; int32 client_type = 8; repeated bytes media = 9; repeated bytes file_diff_comments = 10; repeated bytes file_comments = 11; bytes user_config = 12; bytes last_user_config = 13; repeated bytes side_channels = 15; repeated string tags = 16; bytes user_identity = 17; bytes user_agent_spec = 18; string client_message_id = 19; }
message Planner { string response = 1; repeated bytes knowledge_base_items = 2; string thinking = 3; string signature = 4; bool thinking_redacted = 5; string message_id = 6; repeated Call tool_calls = 7; string modified_response = 8; Timestamp thinking_duration = 11; int32 stop_reason = 12; bytes recitation_metadata = 13; bytes thinking_signature = 14; string provider_assigned_message_id = 15; string raw_thinking = 16; repeated bytes side_channels = 17; repeated bytes passback_context = 18; bytes grounding_metadata = 19; repeated bytes media = 20; }
message ErrorDetails { string user_error_message = 1; string short_error = 2; string full_error = 3; bool is_benign = 4; string details = 5; string error_id = 6; uint32 error_code = 7; repeated bytes structured_error_parts = 8; string model_error_message = 9; repeated string rpc_error_details = 10; string sherlog_link = 11; string user_error_number = 12; }
message ErrorMessage { ErrorDetails error = 3; bool should_show_model = 4; bool should_show_user = 5; }
message Checkpoint { uint32 checkpoint_index = 1; repeated uint32 included_step_indices = 3; string user_intent = 4; string session_summary = 5; string code_change_summary = 6; repeated bytes edited_file_map = 7; string memory_summary = 8; bool intent_only = 9; string conversation_title = 10; uint32 included_step_index_start = 11; uint32 included_step_index_end = 12; repeated bytes artifact_snapshots = 14; repeated string conversation_log_uris = 15; bool model_summarization_failed = 16; bool used_fallback_summary = 17; repeated bytes trajectory_file_diffs = 18; repeated string user_requests = 19; repeated bytes subagent_snapshots = 20; repeated bytes running_task_snapshots = 21; bool render_latest_checkpoint = 24; int64 render_user_message_step_index = 25; repeated bytes accumulated_sections = 26; uint32 total_subagent_count = 27; string summary_prompt_content_id = 28; string summary_content_id = 29; repeated bytes captured_user_requests = 30; repeated bytes captured_parent_messages = 31; }
message SystemMessage { string message = 1; bytes render_info = 2; string event_type = 3; bytes agent_message = 4; repeated Pair metadata = 5; repeated bytes media = 6; }
message Result { string result = 1; repeated Pair metadata = 2; bytes step_render_info = 3; repeated bytes media = 4; repeated DataPair data = 5; bytes payload = 6; string full_output_uri = 7; bytes tool_call_step = 8; bytes tool_result_step = 9; bytes result_struct = 10; bytes result_value = 11; }
message Generic { repeated Pair args = 1; Result result = 2; }
message Step { int32 type = 1; int32 status = 4; Metadata metadata = 5; UserInput user_input = 19; Planner planner_response = 20; ErrorMessage error_message = 24; Checkpoint checkpoint = 30; ErrorDetails error = 31; SystemMessage system_message = 114; bytes permissions = 133; Generic generic = 140; repeated bytes completed_interactions = 147; bytes task_details = 148; }
message Workspace { string workspace_folder_absolute_uri = 1; string git_root_absolute_uri = 2; bytes repository = 3; string branch_name = 4; }
message DesktopExecutor { int32 termination_reason = 1; uint32 last_step_idx = 3; string execution_id = 9; }
message DesktopStepOrigin { string trajectory_id = 1; uint32 step_index = 2; string cascade_id = 4; }
message DesktopAnnotation { string title = 1; }
message DesktopSummary { string summary = 1; uint32 step_count = 2; Timestamp last_modified_time = 3; string trajectory_id = 4; int32 status = 5; Timestamp created_time = 7; repeated Workspace workspaces = 9; Timestamp last_user_input_time = 10; DesktopAnnotation annotations = 15; uint32 last_user_input_step_index = 16; TrajectoryMetadata trajectory_metadata = 17; int32 trajectory_type = 22; int32 latest_executor_termination_reason = 28; }
message DesktopEntry { string key = 1; DesktopSummary value = 2; }
message DesktopIndex { repeated DesktopEntry entries = 1; }
message TrajectoryMetadata { repeated Workspace workspaces = 1; Timestamp created_at = 2; string initialization_state_id = 3; bytes agent_script = 4; string parent_conversation_id = 5; string root_conversation_id = 6; repeated string workspace_uris = 7; bytes subagent_spec = 8; bytes static_config = 10; bytes executable_spec = 11; bytes source_metadata = 12; repeated int32 mendel_experiment_ids = 15; bool is_battle_mode_fork = 16; int32 nesting_depth = 17; string project_id = 18; string environment_id = 19; repeated string tags = 20; repeated bytes replacements = 21; bytes battle_mode_metadata = 22; bytes remote_control_details = 23; }
`;
export const wireRoot = protobuf.parse(schema, { keepCase: true }).root.resolveAll();

/** Decode an optional nested bytes field only when every wire field is recognized. */
export function nestedRecord(type: string, bytes: JsonValue, at: string) {
  if (typeof bytes !== "string") return;
  try {
    const decoded = decodeWire(type, Buffer.from(bytes, "base64"), at);
    if (!decoded.unknown.length) return decoded.value;
  } catch (error) {
    if (!(error instanceof SessionError)) throw error;
  }
}
export function decodeWire(name: string, bytes: Uint8Array, at: string): { value: Record<string, JsonValue>; unknown: string[] } {
  const unknown: string[] = [];
  function inspect(type: protobuf.Type, reader: protobuf.Reader, end: number, path: string, depth: number) {
    if (depth > 64) throw new Error("Protobuf nesting limit exceeded");
    while (reader.pos < end) {
      const tag = reader.uint32(), number = tag >>> 3, wire = tag & 7;
      if (!number) throw new Error("Invalid field number");
      const field = type.fieldsById[number];
      if (!field) { unknown.push(`${path}/${number}`); reader.skipType(wire); }
      else if (field.resolvedType instanceof protobuf.Type) {
        if (wire !== 2) throw new Error("Invalid nested message wire type");
        const length = reader.uint32(), stop = reader.pos + length;
        if (stop > end) throw new Error("Nested message exceeds parent");
        inspect(field.resolvedType, reader, stop, `${path}/${field.name}`, depth + 1);
      } else {
        const expected = field.type === "string" || field.type === "bytes" ? 2 : field.type === "double" || field.type === "fixed64" || field.type === "sfixed64" ? 1 : field.type === "float" || field.type === "fixed32" || field.type === "sfixed32" ? 5 : 0;
        if (wire !== expected && !(field.repeated && wire === 2 && expected !== 2)) throw new Error("Invalid scalar wire type");
        if (field.type === "string") new TextDecoder("utf-8", { fatal: true }).decode(reader.bytes());
        else reader.skipType(wire);
      }
      if (reader.pos > end) throw new Error("Field exceeds message boundary");
    }
  }
  try {
    const type = wireRoot.lookupType(name);
    inspect(type, protobuf.Reader.create(bytes), bytes.length, at, 0);
    const value = type.toObject(type.decode(bytes), { longs: String, bytes: String, defaults: false }) as Record<string, JsonValue>;
    return { value, unknown };
  } catch { throw new SessionError("INVALID_INPUT", at, "Corrupt protobuf payload or mismatched wire types"); }
}
