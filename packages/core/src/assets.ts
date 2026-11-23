import type {ContentBlock, RecordedAsset, RecordedSource} from "./types.js";

export function imageAsset(value: string, label?: string): RecordedAsset {
  const mime = /^data:(image\/[\w+.-]+)[;,]/i.exec(value)?.[1];
  return {location:mime ? "embedded" : /^https?:\/\//i.test(value) ? "remote" : "project",
    value,mediaType:mime ?? "image/*",...(label ? {label} : {})};
}

export function webSource(url:unknown, title?:unknown, excerpt?:unknown): RecordedSource[] {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return [];
  try {new URL(url);} catch {return [];}
  return [{url,...(typeof title === "string" ? {title} : {}),...(typeof excerpt === "string" ? {excerpt} : {})}];
}

export function blockAsset(block: ContentBlock): RecordedAsset | undefined {
  if (block.type === "image") return imageAsset(block.url);
  if (block.type === "media") return block.asset;
  if (block.type === "attachment") return {location:"attachment",value:block.path,mediaType:block.mediaType,label:block.path};
}
