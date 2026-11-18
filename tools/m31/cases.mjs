import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const cases = JSON.parse(readFileSync(new URL("./cases-v1.json", import.meta.url)));
export const agents = ["codex", "claude-code", "antigravity"];
export const models = { codex: "gpt-6.2-sol", "claude-code": "claude-sonnet-4-6", antigravity: "gemini-3.8-flash-medium" };
export const alternates = { codex: "gpt-6.1-sol", "claude-code": "claude-haiku-4-5-20251001", antigravity: "gemini-3.8-flash-low" };
export const hash = value => createHash("sha256").update(value).digest("hex");
export const fixture = (agent, seed) => path.join(root, "fixtures", agent, "m31-v1", "seed-" + seed + (agent === "antigravity" ? ".db" : ".jsonl"));
export const reference = history => history.map(([role, text]) => role + " said: " + JSON.stringify(text)).join("\n");
export function score(answer, expected) {
  let parsed, prose = false;
  try { parsed = JSON.parse(answer.trim()); } catch {
    const blocks=[...answer.matchAll(/\x60{3}(?:json)?\s*([\s\S]*?)\x60{3}/gi)];
    if(blocks.length===1){
      try { parsed=JSON.parse(blocks[0][1]); prose=answer.trim()!==blocks[0][0].trim(); } catch { /* Retain for manual review. */ }
    }
  }
  const normal = x => String(x).trim().toLowerCase();
  const matches = {};
  for (const [key, value] of Object.entries(expected)) {
    const actual = parsed?.[key];
    matches[key] = actual != null && (normal(actual) === normal(value) ||
      value === "unknown" && ["unspecified","not disclosed","not specified","not provided"].includes(normal(actual)));
  }
  const keys=Object.keys(parsed && typeof parsed === "object" ? parsed : {});
  return { parsed: !!parsed, prose, matches, wrong:keys.filter(k=>k in expected && !matches[k]),
    missing:Object.keys(expected).filter(k=>!keys.includes(k)),extraKeys:keys.filter(k=>!(k in expected)) };
}
export function codexFile(history) {
  const header = { type: "session_meta", payload: {id:"m31-specimen", cli_version:"0.169.0-alpha.11.1", cwd:"/sample/workspace"} };
  return [header, ...history.map(([role,text]) => ({type:"response_item",payload:{type:"message",role,content:[{type:role==="user"?"input_text":"output_text",text}]}}))].map(r => JSON.stringify(r)).join("\n")+"\n";
}
