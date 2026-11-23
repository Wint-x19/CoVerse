import {isRecord, stringifyWireJson, type ContentBlock, type FileSet, type JsonValue, type RecordedAsset} from "@coverse/core";
import {nestedRecord} from "./wire.js";
import {companionForUri, linkedAssets} from "./companions.js";

export function readMedia(source: Record<string,JsonValue>, blocks: ContentBlock[], at: string) {
  for (const field of ["images","media"]) {
    const entries = source[field];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const item = nestedRecord(field === "images" ? "ImageData" : "Media",entry,at);
      const type = item?.mime_type;
      const data = item?.base64_data ?? item?.data;
      const uri = item?.uri;
      let asset: RecordedAsset | undefined;
      if (typeof data === "string" && typeof type === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(type)) {
        asset = {location:"embedded",mediaType:type,value:"data:" + type + ";base64," + data};
      } else if (typeof uri === "string") {
        asset = {location:/^https?:\/\//i.test(uri) ? "remote" : "project",mediaType:typeof type === "string" ? type : "image/*",value:uri};
      }
      if (!asset) {
        blocks.push({type:"opaque",source:"antigravity:" + field,value:entry});
        continue;
      }
      if (typeof item?.caption === "string") asset.label = item.caption;
      blocks.push({type:"media",asset});
    }
  }
}

export function readArtifactSnapshots(checkpoint: Record<string,JsonValue>, content: ContentBlock[], files: FileSet, at: string) {
  if (!Array.isArray(checkpoint.artifact_snapshots)) return;
  for (const bytes of checkpoint.artifact_snapshots) {
    const snapshot = nestedRecord("ArtifactSnapshot",bytes,at);
    const uri = snapshot?.artifact_absolute_uri;
    if (!snapshot || typeof uri !== "string") {
      content.push({type:"opaque",source:"antigravity:artifact_snapshots",value:bytes});
      continue;
    }
    const name = typeof snapshot.artifact_name === "string" ? snapshot.artifact_name : uri.split("/").at(-1) ?? uri;
    const meta = snapshot.artifact_metadata;
    const common = {sourceUri:uri,label:name,...(isRecord(meta) && typeof meta.summary === "string" ? {description:meta.summary} : {})};
    let asset: RecordedAsset;
    if (typeof snapshot.content === "string") {
      asset = {...common,location:"text",mediaType:/\.md(?:$|[?#])/i.test(uri) ? "text/markdown" : "text/plain",value:snapshot.content};
    } else if (isRecord(snapshot.url_artifact_payload) && typeof snapshot.url_artifact_payload.url === "string") {
      asset = {...common,location:"remote",mediaType:"text/uri-list",value:snapshot.url_artifact_payload.url};
    } else {
      const file = companionForUri(uri,files);
      asset = {...common,location:file ? "attachment" : "project",mediaType:"application/octet-stream",value:file?.path ?? uri};
    }
    content.push({type:"media",asset});
    const markdown = snapshot.content ?? (/\.md$/i.test(uri) && asset.location === "attachment"
      ? new TextDecoder().decode(files.find(f => f.path === asset.value)?.bytes) : undefined);
    if (typeof markdown === "string") for (const linked of linkedAssets(markdown,files,uri)) content.push({type:"media",asset:linked});
    const {content:_text,...metadata} = snapshot;
    content.push({type:"text",text:"Historical artifact metadata:\n" + stringifyWireJson(metadata,null,2)});
  }
}
