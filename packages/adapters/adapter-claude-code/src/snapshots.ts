import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {compareFileVersions,isRecord,parseJsonLines,SessionError,stringifyWireJson,type FileSet,type JsonValue,type Turn} from "@coverse/core";

const backupName = /^[a-f0-9]{16}@v\d+$/i;
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

export async function supplyNativeBackups(files:FileSet,_resolve:(id:string) => Promise<FileSet>,sourcePath?:string):Promise<FileSet> {
  if (!sourcePath) return files;
  const sessionId = path.basename(sourcePath,".jsonl");
  if (!uuid.test(sessionId)) return files;
  const root = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(),".claude");
  const relative = path.relative(path.join(root,"projects"),sourcePath);
  if (relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return files;
  const log = files.find(f => f.path === path.basename(sourcePath));
  if (!log) return files;
  const rows = parseJsonLines(log.bytes,log.path);
  if (!rows.some(({value:r}) => r.sessionId === sessionId && (r.type === "user" || r.type === "assistant"))) return files;
  const names = new Set<string>();
  for (const {value:r} of rows) {
    if (r.type !== "file-history-snapshot" || !isRecord(r.snapshot) || !isRecord(r.snapshot.trackedFileBackups)) continue;
    for (const record of Object.values(r.snapshot.trackedFileBackups)) {
      if (isRecord(record) && typeof record.backupFileName === "string" && backupName.test(record.backupFileName)) names.add(record.backupFileName);
    }
  }
  const supplied = [...files], folder = path.join(root,"file-history",sessionId);
  for (const name of names) {
    if (supplied.some(f => f.path.split("/").at(-1) === name)) continue;
    try {
      const file = path.join(folder,name);
      if (path.relative(await fs.realpath(folder),await fs.realpath(file)) !== name) continue;
      const handle = await fs.open(file,"r");
      try {
        const before = await handle.stat();
        if (!before.isFile()) continue;
        const bytes = new Uint8Array(await handle.readFile());
        const after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new SessionError("UNSTABLE_INPUT",name,"File checkpoint changed during import");
        supplied.push({path:"file-history/" + name,bytes});
      } finally {await handle.close();}
    } catch (error) {if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;}
  }
  return supplied;
}

type Revision = {name:string | null; text?:string};
export class SnapshotHistory {
  private readonly versions = new Map<string,Map<string,Revision>>();
  constructor(private readonly files:FileSet) {}

  read(turn:Turn,row:Record<string,JsonValue>,chain:string[]) {
    const snapshot = row.snapshot;
    if (!isRecord(snapshot) || !isRecord(snapshot.trackedFileBackups)) {
      turn.content = [{type:"opaque",source:"claude-code:file-history-snapshot",value:row}];
      return;
    }
    const messageId = typeof snapshot.messageId === "string" ? snapshot.messageId : typeof row.messageId === "string" ? row.messageId : turn.id;
    const prior = [messageId,...chain].map(id => this.versions.get(id)).find(Boolean);
    const current = new Map(prior);
    const notes: string[] = [];
    for (const [file,raw] of Object.entries(snapshot.trackedFileBackups)) {
      if (!isRecord(raw) || !(typeof raw.backupFileName === "string" || raw.backupFileName === null)) {
        turn.content.push({type:"opaque",source:"claude-code:file-backup",value:raw}); continue;
      }
      const name = raw.backupFileName;
      const matches = name === null ? [] : this.files.filter(f => f.path.split("/").at(-1) === name);
      const bytes = matches.length === 1 ? matches[0]!.bytes : undefined;
      const version: Revision = {name};
      if (name === null) version.text = "";
      if (bytes && !bytes.includes(0)) {
        try {version.text = new TextDecoder("utf-8",{fatal:true}).decode(bytes);} catch { /* Binary backup. */ }
      }
      const old = prior?.get(file);
      const label = file + (raw.version !== undefined ? " · v" + String(raw.version) : "");
      notes.push(label + (name === null ? " · absent" : bytes ? "" : " · backup unavailable: " + name));
      if (name !== null && version.text !== undefined) (turn.assets ??= []).push({location:"text",mediaType:"text/plain",label,value:version.text});
      if (old && old.name !== name) (turn.changedFiles ??= []).push(
        old.text !== undefined && version.text !== undefined ? compareFileVersions(file,old.text,version.text) : {path:file,added:null,removed:null});
      current.set(file,version);
    }
    this.versions.set(messageId,current);
    turn.event = {id:turn.id,kind:"checkpoint",text:notes.join("\n") || stringifyWireJson(snapshot,null,2)};
    if (typeof snapshot.timestamp === "string") turn.createdAt = snapshot.timestamp;
  }
}
