import {type ContentBlock, type JsonValue, type RecordedAsset} from "@coverse/core";
import {nestedRecord} from "./wire.js";

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
