import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import initSqlJs from "sql.js";
import { beforeEach, afterEach, expect, it } from "vitest";
import { buildInjectionBundle, type DesktopPublication, type CSR } from "@coverse/core";
import { findDesktopProject, publishToStore } from "../src/desktop.js";
import { wireRoot } from "../src/wire.js";

const require = createRequire(import.meta.url);
const sql = initSqlJs({ locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm") });
const source: CSR = {
  schemaVersion: "1.0", meta: { id: "source", agent: "codex", agentFormatVersion: "test" }, xExtensions: {},
  turns: [
    { id: "old", role: "user", content: [{ type: "text", text: "Superseded context" }] },
    { id: "user", role: "user", content: [{ type: "text", text: "Our mascot is Cedar." }] },
    { id: "assistant", role: "assistant", content: [{ type: "text", text: "Recorded Cedar." }] },
  ],
  continuation: { boundaryId: "old", retainedIds: [], replacement: [] },
};
let base: string, projects: string, desktop: string, index: string, cli: string, input: DesktopPublication;
const originalIndex = Buffer.from([0x78, 1]); // An existing unknown field.

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "coverse-desktop-publish-"));
  projects = path.join(base, "config", "projects");
  desktop = path.join(base, "antigravity");
  index = path.join(desktop, "agyhub_summaries_proto.pb");
  cli = path.join(base, "antigravity-cli", "conversations");
  for (const folder of [projects, cli, path.join(desktop, "conversations")]) await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(index, originalIndex);
  const cliSessionId = randomUUID();
  const db = new (await sql).Database(await fs.readFile(new URL("../../../../fixtures/antigravity/sqlite-2_32_1-step0/sample.db", import.meta.url)));
  try {
    db.run("PRAGMA user_version=1");
    db.run("UPDATE trajectory_meta SET cascade_id=?", [cliSessionId]);
    db.run("INSERT OR REPLACE INTO executor_metadata VALUES (0,x'0804')");
    db.run("INSERT OR REPLACE INTO gen_metadata VALUES (0,x'',0)");
    await fs.writeFile(path.join(cli, cliSessionId + ".db"), db.export());
  } finally { db.close(); }
  input = { cliSessionId, transferId: "new-chat", title: "Project transcript", cwd: base,
    bundleDirectory: base, loadArtifacts: async () => buildInjectionBundle(source, "antigravity").artifacts };
});
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

it("publishes native version-one history into its project and preserves resumed conversations across retries", async () => {
  const id = await publishToStore(input, base, await sql);
  const publishedIndex = await fs.readFile(index);
  expect(publishedIndex.subarray(0, originalIndex.length)).toEqual(originalIndex);
  const type = wireRoot.lookupType("DesktopIndex");
  const entries = type.toObject(type.decode(publishedIndex)).entries;
  const project = await findDesktopProject(projects, base);
  expect(entries).toMatchObject([{ key: id, value: { summary: input.title, step_count: 2, trajectory_metadata: { project_id: project.id } } }]);
  const file = path.join(desktop, "conversations", id + ".db");
  const db = new (await sql).Database(await fs.readFile(file));
  try {
    expect(db.exec("PRAGMA user_version")[0]?.values).toEqual([[1]]);
    expect(db.exec("SELECT cascade_id,trajectory_id FROM trajectory_meta")[0]?.values).toEqual([[id, entries[0].value.trajectory_id]]);
    const steps = db.exec("SELECT step_payload FROM steps ORDER BY idx")[0]!.values;
    const step = wireRoot.lookupType("Step");
    const history = steps.map(([bytes]) => step.toObject(step.decode(bytes as Uint8Array)));
    expect(history).toMatchObject([{ type: 14, user_input: { user_response: "Our mascot is Cedar." } },
      { type: 15, planner_response: { response: "Recorded Cedar." } }]);
    db.run("INSERT INTO steps (idx) VALUES (2)");
    await fs.writeFile(file, db.export());
  } finally { db.close(); }
  const resumed = await fs.readFile(file);
  await fs.unlink(path.join(cli, input.cliSessionId + ".db"));
  expect(await publishToStore(input, base, await sql)).toBe(id);
  expect((await fs.readFile(file)).equals(resumed)).toBe(true);
  expect(await fs.readFile(index)).toEqual(publishedIndex);
  expect(await fs.readFile(path.join(desktop, "annotations", id + ".pbtxt"), "utf8")).toContain(input.title);
});

it("exports the native display transcript locally even when compaction removed messages from the model window", async () => {
  const { cliSessionId: _cli, ...offline } = input;
  const transcript: CSR["transcript"] = [
    { id:"u", role:"user", text:"Before compaction", createdAt:"2026-01-01T00:00:00Z",
      assets:[{location:"embedded",mediaType:"image/png",value:"data:image/png;base64,AQID"}] },
    { id:"a", role:"assistant", text:"| A | B |\n|---|---|\n| x | y |", activity:"Progress", changedFiles:[{path:"example.md",added:2,removed:1}],
      tools:[{name:"Read",state:"completed",argumentsText:"example.md",results:[{text:"recorded file output"}]}] },
  ];
  const id = await publishToStore({...offline, loadArtifacts: async () => buildInjectionBundle({...source,transcript},"antigravity").artifacts}, base, await sql);
  const db = new (await sql).Database(await fs.readFile(path.join(desktop,"conversations",id+".db")));
  try {
    const type = wireRoot.lookupType("Step");
    const native = db.exec("SELECT step_payload FROM steps ORDER BY idx")[0]!.values.map(([bytes]) => type.toObject(type.decode(bytes as Uint8Array)));
    expect(native).toHaveLength(2);
    expect(native[0]!.user_input.user_response).toBe(transcript[0]!.text);
    const media = wireRoot.lookupType("Media");
    expect(media.toObject(media.decode(native[0]!.user_input.media[0]),{bytes:String})).toEqual({mime_type:"image/png",data:"AQID"});
    expect(native[1]!.planner_response.response).toContain(transcript[1]!.text);
    expect(native[1]!.planner_response.response).toContain("example.md");
    expect(native[1]!.planner_response.response).toContain("recorded file output");
    expect(native[1]!.planner_response.thinking).toBe("Progress");
  } finally { db.close(); }
});

it("matches git folders by path and creates distinct projects for identically named directories", async () => {
  const a = path.join(base, "a", "workspace"), b = path.join(base, "b", "workspace");
  for (const folder of [a, b]) await fs.mkdir(folder, { recursive: true });
  const id = randomUUID(), uri = pathToFileURL(a).href;
  await fs.writeFile(path.join(projects, id + ".json"), JSON.stringify({ id, projectResources: { resources: [{ gitFolder: { folderUri: uri } }] } }));
  expect(await findDesktopProject(projects, a)).toEqual({ id, uri });
  const created = await findDesktopProject(projects, b);
  expect(created.id).not.toBe(id);
  expect(await findDesktopProject(projects, b)).toEqual(created);
});

it("reuses the registered ID and URI when a folder has another filesystem path", async () => {
  const folder = path.join(base, "workspace");
  const alias = path.join(base, "workspace-alias");
  await fs.mkdir(folder);
  await fs.symlink(folder, alias, process.platform === "win32" ? "junction" : "dir");
  const id = randomUUID();
  const uri = pathToFileURL(alias).href;
  const resources = [{ folderUri: pathToFileURL(path.join(base, "moved")).href }, { folderUri: uri }];
  await fs.writeFile(path.join(projects, id + ".json"), JSON.stringify({ id, projectResources: { resources } }));
  expect(await findDesktopProject(projects, folder)).toEqual({ id, uri });
  expect(await findDesktopProject(projects, alias)).toEqual({ id, uri });
  expect(await fs.readdir(projects)).toEqual([id + ".json"]);
});

it("leaves the desktop index untouched when the CLI snapshot is unstable", async () => {
  await fs.writeFile(path.join(cli, input.cliSessionId + ".db-wal"), "busy");
  await expect(publishToStore(input, base, await sql)).rejects.toMatchObject({ code: "UNSTABLE_INPUT" });
  expect(await fs.readFile(index)).toEqual(originalIndex);
  expect(await fs.readdir(path.join(desktop, "conversations"))).toEqual([]);
});
