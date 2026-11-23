import {isRecord, stringifyWireJson, type ContentBlock, type JsonValue, type RecordedReview} from "@coverse/core";
import {nestedRecord} from "./wire.js";

const reviewFields = {file_comments:"FileComment", file_diff_comments:"FileDiffComment", artifact_comments:"ArtifactComment"} as const;
type Selection = RecordedReview["selections"][number];
function selection(side: Selection["side"], value: JsonValue | undefined): Selection[] {
  if (!isRecord(value)) return [];
  return [{side, ...(typeof value.content === "string" ? {text:value.content} : {}),
    ...(typeof value.start_line === "number" ? {start:value.start_line} : {}),
    ...(typeof value.end_line === "number" ? {end:value.end_line} : {})}];
}

export function readReviews(user: Record<string, JsonValue>, content: ContentBlock[], at: string) {
  const reviews: RecordedReview[] = [];
  for (const [field, type] of Object.entries(reviewFields)) {
    const items = user[field];
    if (!Array.isArray(items)) continue;
    for (const encoded of items) {
      const record = nestedRecord(type, encoded, at);
      const path = record?.file_uri ?? record?.artifact_uri;
      if (!record || typeof path !== "string") {
        content.push({type:"opaque",source:"antigravity:" + field,value:encoded});
        continue;
      }
      const entries = record.file_comment_infos ?? record.diff_comment_infos ?? [record];
      const first = reviews.length;
      let containsMedia = false;
      if (Array.isArray(entries)) for (const info of entries) {
        if (!isRecord(info)) continue;
        const selections = [...selection("file", info.selection), ...selection("original", info.original_selection),
          ...selection("modified", info.modified_selection)];
        const group = info.selections;
        if (isRecord(group) && Array.isArray(group.selections)) for (const part of group.selections) {
          if (isRecord(part)) {
            selections.push(...selection("file", part.text_selection));
            if (part.image_selection) containsMedia = true;
          }
        }
        if (info.image_selection || info.full_file) containsMedia = true;
        if (typeof info.comment === "string") reviews.push({path,comment:info.comment,selections});
      }
      if (containsMedia) {
        content.push({type:"opaque",source:"antigravity:" + field,value:encoded});
        for (const review of reviews.slice(first)) content.push({type:"text",displayAs:"review",
          text:"Historical review:\n" + JSON.stringify(review)});
      } else {
        // Keep surrounding text and approval metadata in the transferable history.
        content.push({type:"text",...(reviews.length > first ? {displayAs:"review" as const} : {}),
          text:"Historical review:\n" + stringifyWireJson(record, null, 2)});
      }
    }
  }
  return reviews;
}
