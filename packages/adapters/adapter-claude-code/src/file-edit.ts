import {compareFileVersions, fileChangeFromHunks, isRecord, type ContentBlock, type JsonValue, type RecordedFileChange} from "@coverse/core";

type Hunk = Parameters<typeof fileChangeFromHunks>[1][number];
function validHunk(value: JsonValue): value is Hunk & Record<string, JsonValue> {
  return isRecord(value) && ["oldStart", "oldLines", "newStart", "newLines"].every(key =>
    typeof value[key] === "number" && Number.isSafeInteger(value[key]) && Number(value[key]) >= 0) &&
    Array.isArray(value.lines) && value.lines.every(line => typeof line === "string");
}

export function recordedEdit(call: Extract<ContentBlock, {type:"tool_call"}>, output?: JsonValue): RecordedFileChange | undefined {
  if (call.name !== "Write" && call.name !== "Edit") return;
  const result = isRecord(output) ? output : {};
  const input = isRecord(call.arguments) ? call.arguments : {};
  const path = result.filePath ?? input.file_path;
  if (typeof path !== "string" || !path) return;
  const hunks = result.structuredPatch;
  if (Array.isArray(hunks) && hunks.length && hunks.every(validHunk)) return fileChangeFromHunks(path, hunks);
  if (call.name === "Write" && typeof result.content === "string") {
    if (result.type === "create") return compareFileVersions(path, "", result.content);
    if (typeof result.originalFile === "string") return compareFileVersions(path, result.originalFile, result.content);
  }
  // An edit request alone cannot identify which occurrence changed or whether the user modified it.
  return {path, added: null, removed: null};
}
