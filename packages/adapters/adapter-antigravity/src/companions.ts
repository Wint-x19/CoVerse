import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {isRecord, SessionError, type Artifact, type FileSet, type JsonValue, type RecordedAsset} from "@coverse/core";
import {nestedRecord} from "./wire.js";

export function localLinks(text:string, base?:string):string[] {
  const links = new Set<string>();
  const matches = text.matchAll(/\]\(\s*(?:<([^>\n]+)>|([^\s)]+))|<(file:\/\/[^>\n]+)>|(file:\/\/[^\s"'<>)]+)/gi);
  for (const m of matches) {
    const raw = m[1] ?? m[2] ?? m[3] ?? m[4]!;
    try {
      const uri = new URL(raw,base);
      if (uri.protocol === "file:") {uri.hash=""; links.add(uri.href);}
    } catch { /* A bare relative link has no known historical directory. */ }
  }
  return [...links];
}

export function companionForUri(uri:string,files:FileSet):Artifact | undefined {
  let pathname = uri.replaceAll("\\","/");
  try {pathname = decodeURIComponent(new URL(uri).pathname);} catch { /* Plain paths are accepted in older records. */ }
  const inBrain = /\/brain\/[\da-f-]{36}\/(.+)$/i.exec(pathname);
  const exact = inBrain && files.find(f => f.path === "artifacts/" + inBrain[1]);
  if (exact) return exact;
  const basename = pathname.split("/").at(-1);
  const candidates = files.filter(f => f.path === uri || f.path.split("/").at(-1) === basename);
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function linkedAssets(text:string,files:FileSet,base?:string):RecordedAsset[] {
  return localLinks(text,base).flatMap(uri => {
    const file = companionForUri(uri,files);
    return file ? [{location:"attachment" as const,value:file.path,mediaType:"application/octet-stream",
      sourceUri:uri,label:file.path.split("/").at(-1) ?? file.path}] : [];
  });
}

export function localArtifactPath(sourcePath:string,resource:string,stores=path.join(os.homedir(),".gemini")) {
  const id = path.basename(sourcePath,".db");
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id) || !resource.startsWith("artifacts/")) return;
  for (const store of ["antigravity","antigravity-cli"]) {
    if (path.relative(path.join(stores,store,"conversations",id+".db"),sourcePath) === "") {
      return {root:path.join(stores,store,"brain",id),relative:resource.slice("artifacts/".length)};
    }
  }
}

export async function nativeCompanions(files:FileSet,sourcePath:string,id:string,steps:Record<string,JsonValue>[],
  stores = path.join(os.homedir(),".gemini")):Promise<FileSet> {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) return files;
  const store = ["antigravity","antigravity-cli"].map(dir => path.join(stores,dir))
    .find(dir => path.relative(path.join(dir,"conversations",id + ".db"),path.resolve(sourcePath)) === "");
  if (!store) return files;
  const brain = path.join(store,"brain",id), uris = new Set<string>();
  for (const step of steps) {
    if (isRecord(step.generic) && isRecord(step.generic.result) && typeof step.generic.result.full_output_uri === "string")
      uris.add(step.generic.result.full_output_uri);
    if (isRecord(step.planner_response) && typeof step.planner_response.response === "string")
      for (const uri of localLinks(step.planner_response.response)) uris.add(uri);
    if (isRecord(step.checkpoint) && Array.isArray(step.checkpoint.artifact_snapshots)) for (const entry of step.checkpoint.artifact_snapshots) {
      const snapshot = nestedRecord("ArtifactSnapshot",entry,"/artifacts");
      if (typeof snapshot?.artifact_absolute_uri !== "string") continue;
      uris.add(snapshot.artifact_absolute_uri);
      if (typeof snapshot.content === "string") for (const uri of localLinks(snapshot.content,snapshot.artifact_absolute_uri)) uris.add(uri);
    }
    if (isRecord(step.checkpoint) && Array.isArray(step.checkpoint.subagent_snapshots)) for (const entry of step.checkpoint.subagent_snapshots) {
      const child = nestedRecord("SubagentSnapshot",entry,"/subsessions");
      if (isRecord(child?.result) && typeof child.result.log_absolute_uri === "string") uris.add(child.result.log_absolute_uri);
    }
  }
  const result = [...files];
  for (const uri of uris) {
    let local: string;
    try {local = uri.startsWith("file:") ? fileURLToPath(uri) : uri;} catch {continue;}
    if (!path.isAbsolute(local)) continue;
    const relative = path.relative(brain,local);
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) continue;
    const name = "artifacts/" + relative.split(path.sep).join("/");
    if (result.some(f => f.path === name)) continue;
    try {
      const real = await fs.realpath(local);
      if (path.relative(await fs.realpath(brain),real) !== relative) continue;
      const handle = await fs.open(real,"r");
      try {
        const before = await handle.stat();
        if (!before.isFile()) continue;
        const bytes = new Uint8Array(await handle.readFile()), after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new SessionError("UNSTABLE_INPUT",name,"Referenced artifact changed during import");
        result.push({path:name,bytes});
        if (/\.md$/i.test(local)) for (const target of localLinks(new TextDecoder().decode(bytes),pathToFileURL(local).href)) uris.add(target);
      } finally {await handle.close();}
    } catch (e) {if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;}
  }
  return result;
}
