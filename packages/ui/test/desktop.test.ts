import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInjectionBundle, SessionError, type SessionAdapter } from "@coverse/core";
import { AgentDriver, createDriverRegistry, DriverRegistry, type DriverPlugin } from "@coverse/drivers";
import { pathToFileURL } from "node:url";
import { groupByProject } from "../src/client/lib/projects.js";
import {fileReference, fileTokens, locateQuote} from "../src/client/lib/file-references.js";
import {reviewSegments} from "../src/client/lib/review-directives.js";
import {visibleBranch} from "../src/client/lib/branches.js";
import {restoreHistory} from "../src/main/history.js";
import {
  createAdapterRegistry,
  csrTurnsToChatMessages,
  IPC_CHANNELS,
  registerIpcHandlers,
  runEventChannel,
  UiService,
  UiStore,
  type AppSettings,
  type BundleDetailResponse,
  type CapabilitiesResponse,
  type DesktopDialogs,
  type InspectResponse,
  type IpcEnvelope,
  type IpcInvokeEventLike,
  type IpcMainLike,
  type LocalSessionRef,
  type StreamEventPayload,
  type UiSession,
} from "../dist/main/core.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createFakeDriverPlugin(id: string): DriverPlugin {
  return {
    id,
    command: "node",
    verifiedVersions: ["fake 1.0.0"],
    invocation({ prompt, session, model }) {
      const script = [
        "(() => {",
        'const fs = require("node:fs");',
        'const input = fs.readFileSync(0, "utf8");',
        "const req = JSON.parse(input);",
        'if (req.prompt.includes("__HANG__")) {',
        '  process.stdout.write(JSON.stringify({ event: "session", id: req.session }) + "\\n");',
        "  setTimeout(() => {}, 30000);",
        "  return;",
        "}",
        'process.stdout.write(JSON.stringify({ event: "session", id: req.session }) + "\\n");',
        'process.stdout.write(JSON.stringify({ event: "tool", name: "read_file", state: "completed" }) + "\\n");',
        'const hasHistory = req.prompt.includes("# CoVerse conversation context");',
        'const reply = `echo:${req.id}:${req.resumed ? "resumed" : hasHistory ? "injected" : "direct"}:${req.model || "default"}`;',
        'process.stdout.write(JSON.stringify({ event: "text", text: reply.slice(0, 10) }) + "\\n");',
        'process.stdout.write(JSON.stringify({ event: "text", text: reply.slice(10) }) + "\\n");',
        'process.stdout.write(JSON.stringify({ event: "usage", input: 42, output: 17 }) + "\\n");',
        'process.stdout.write(JSON.stringify({ event: "done" }) + "\\n");',
        "})();",
      ].join("\n");
      const sessionId = session ?? "11111111-2222-4333-8444-555555555555";
      return {
        args: ["-e", script],
        input: JSON.stringify({
          id,
          session: sessionId,
          resumed: Boolean(session),
          model: model ?? null,
          prompt,
        }),
      };
    },
    decoder: () => (record) => {
      if (record.event === "session") return [{ type: "session", id: String(record.id) }];
      if (record.event === "tool") return [
        {type:"model",model:"actual-test-model"}, {type:"reasoning",text:"Visible thought"},
        {type:"tool",id:"read-1",name:String(record.name),state:"started",argumentsText:'{"path":"live.txt"}'},
        {type:"tool",id:"read-1",name:String(record.name),state:String(record.state),results:[{text:"live result body"}]},
      ];
      if (record.event === "text") return [{ type: "text", text: String(record.text) }];
      if (record.event === "usage") {
        return [
          {
            type: "usage",
            usage: { input: Number(record.input), output: Number(record.output) },
            nativeUsage: record,
          },
        ];
      }
      if (record.event === "done") return [{ type: "done" }];
      return [];
    },
    listModels: async () => [{ id: `${id}-model-1`, label: `${id} Model 1`, isDefault: true }],
    listLocalSessions: async () => [
      {
        id: `local-${id}-1`,
        agent: id,
        title: `Sample ${id} local session`,
        path: path.join(REPO_ROOT, "fixtures/codex/rollout-2026-11-17/sample.jsonl"),
        updatedAt: "2026-11-20T00:00:00.000Z",
        size: 1024,
      },
    ],
  };
}

function createFakeDrivers(): DriverRegistry {
  const registry = new DriverRegistry();
  for (const id of ["codex", "claude-code", "antigravity"]) {
    registry.register(new AgentDriver(createFakeDriverPlugin(id), { command: process.execPath }));
  }
  return registry;
}

function createMockIpc(service: UiService, dialogs?: Partial<DesktopDialogs>) {
  const handlers = new Map<string, (event: IpcInvokeEventLike, ...args: unknown[]) => Promise<unknown>>();
  const emitted = new Map<string, StreamEventPayload[]>();

  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  };

  registerIpcHandlers(ipcMain, service, {
    pickDirectory: dialogs?.pickDirectory ?? (async () => null),
    pickSessionFiles: dialogs?.pickSessionFiles ?? (async () => []),
  });

  async function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcEnvelope<T>> {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
    const event: IpcInvokeEventLike = {
      sender: {
        send(targetChannel, payload) {
          const list = emitted.get(targetChannel) ?? [];
          list.push(payload as StreamEventPayload);
          emitted.set(targetChannel, list);
        },
      },
    };
    return (await handler(event, ...args)) as IpcEnvelope<T>;
  }

  return { invoke, emitted };
}

describe("CoVerse M4 desktop IPC & service", () => {
  it("upgrades an old archive from original bytes while retaining later local messages and the original packet",async () => {
    const root = await makeTempDir("coverse-history-upgrade-"), store = new UiStore(path.join(root,"state"));
    const registry = createAdapterRegistry(), service = new UiService(registry,createFakeDrivers(),store,root);
    const source = path.join(root,"rollout.jsonl");
    const item = (value:object) => ({type:"event_msg",payload:{type:"item_completed",turn_id:"t",item:value}});
    const text = [
      {type:"session_meta",payload:{id:"sample",cli_version:"0.169.0-alpha.11.1",cwd:root}},
      {type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"change"}]}},
      item({id:"u",type:"UserMessage",content:[{type:"text",text:"change"}]}),
      item({id:"edit",type:"FileChange",status:"completed",changes:{"test.ts":{type:"update",unified_diff:"@@ -1 +1 @@\n-old\n+new"}}}),
      item({id:"a",type:"AgentMessage",content:[{type:"text",text:"changed"}]}),
    ].map(r => JSON.stringify(r)).join("\n");
    await fs.writeFile(source,text);
    const session = await service.convertSource({from:"codex",to:"claude-code",paths:[source],materialize:false});
    const {session:csr} = await registry.get("codex").import([{path:"rollout.jsonl",bytes:new TextEncoder().encode(text)}]);
    delete csr.transcript!.at(-1)!.changedFiles![0]!.patches;
    const packet = buildInjectionBundle(csr,"claude-code").artifacts;
    const folder = await store.saveBundle("legacy",packet);
    const live = {id:"local",role:"user" as const,content:"later",createdAt:"now"};
    await store.mutateSession(session.id,current => {
      delete current.historyVersion;
      current.handoff = {...current.handoff!,bundleId:"legacy",bundlePath:folder};
      current.messages = [...csrTurnsToChatMessages(csr.turns,"codex","now",csr.transcript),live];
      return current;
    });
    const manifest = await fs.readFile(path.join(folder,"manifest.json"));
    const updated = await service.getSession(session.id,true);
    expect(updated.messages.find(m => m.id === "a")?.changedFiles?.[0]?.patches).toEqual(["@@ -1 +1 @@\n-old\n+new"]);
    expect(updated.messages.at(-1)).toEqual(live);
    expect(await service.getSession(session.id,true)).toEqual(updated);
    expect(await fs.readFile(path.join(folder,"manifest.json"))).toEqual(manifest);
  });
  it("does not append a native copy of an already recorded live turn when upgrading old reference IDs", () => {
    const history = (id:string,content:string,role:"user"|"assistant"="user") => ({id,content,role,historical:true,createdAt:"old"});
    const live = {...history("live","new turn"),historical:false};
    const old = [history("random1","ask"),history("random2","answer","assistant"),live];
    const fresh = [history("native1","ask"),history("native2","answer","assistant"),history("native3","new turn")];
    expect(restoreHistory(old,fresh,false).map(m=>m.id)).toEqual(["native1","native2","live"]);
    expect(() => restoreHistory(old,[history("other","unrelated")],false)).toThrow("retained");
  });
  it("recovers status-only live file changes from the matching native turn and never substitutes another turn", async () => {
    const root = await makeTempDir("coverse-live-diff-");
    const id = "11111111-2222-4333-8444-555555555555";
    const file = path.join(root,"rollout-test.jsonl");
    const done = (item:object) => ({type:"event_msg",payload:{type:"item_completed",turn_id:"turn-1",item}});
    await fs.writeFile(file,[
      {type:"session_meta",payload:{id,cli_version:"0.169.0-alpha.11.1",cwd:root}},
      done({type:"UserMessage",id:"u",content:[{type:"text",text:"edit it"}]}),
      done({type:"FileChange",id:"f",status:"completed",changes:{"note.txt":{type:"update",unified_diff:"@@ -1 +1 @@\n-old\n+written"}}}),
      done({type:"AgentMessage",id:"a",content:[{type:"text",text:"echo:codex:direct:default"}]}),
    ].map(row => JSON.stringify(row)).join("\n"));
    const plugin = createFakeDriverPlugin("codex");
    const decode = plugin.decoder();
    plugin.decoder = () => record => record.event === "tool" ? [{type:"tool",name:"file_change",state:"completed",
      changedFiles:[{path:"note.txt",added:null,removed:null}]}] : decode(record);
    plugin.listLocalSessions = async () => [{id,agent:"codex",title:"fixture",cwd:root,path:file,size:100,updatedAt:new Date().toISOString()}];
    const drivers = new DriverRegistry().register(new AgentDriver(plugin,{command:process.execPath}));
    const service = new UiService(createAdapterRegistry(),drivers,new UiStore(path.join(root,"ui")),root);
    for (const prompt of ["edit it","different turn"]) {
      const session = await service.createSession({agent:"codex",cwd:root});
      await service.runTurn(session.id,{prompt},() => {});
      const final = (await service.getSession(session.id)).messages.at(-1);
      if (prompt === "edit it") expect(final?.changedFiles?.[0]?.patches).toEqual(["@@ -1 +1 @@\n-old\n+written"]);
      else expect(final?.changedFiles).toBeUndefined();
    }
  });
  it("opens nested histories on a separate path and maintains a jump back to the outer turn", () => {
    const messages = csrTurnsToChatMessages([{id:"outer",role:"user",content:[{type:"text",text:"outer question"}],
      origin:{artifact:"a.db",record:0,branchId:"main"},childTrajectory:{id:"child",turns:[
        {id:"nested",role:"assistant",content:[{type:"text",text:"nested reply"}],origin:{
          artifact:"a.db",record:0,parentId:"outer",branchId:"child",subsession:true,
        }},
      ]}}],"antigravity","now");
    expect(messages[0]?.childBranch).toBe("child");
    expect(visibleBranch(messages,"main").map(m=>m.id)).toEqual(["outer"]);
    expect(visibleBranch(messages,"child").map(m=>m.id)).toEqual(["outer","nested"]);
  });
  it("keeps common ancestors and excludes sibling and subagent replies from a selected branch", () => {
    const messages: UiSession["messages"] = [
      {id:"root",role:"user",content:"ask",createdAt:"now",lineage:{branchId:"main"}},
      {id:"left",role:"assistant",content:"left",createdAt:"now",lineage:{branchId:"A",parentId:"root"}},
      {id:"right",role:"assistant",content:"right",createdAt:"now",lineage:{branchId:"B",parentId:"root"}},
      {id:"child",role:"assistant",content:"child",createdAt:"now",lineage:{branchId:"sub",parentId:"left",subsession:true}},
    ];
    expect(visibleBranch(messages,"B").map(m=>m.id)).toEqual(["root","right"]);
    expect(visibleBranch(messages,"sub").map(m=>m.id)).toEqual(["root","left","child"]);
    expect(visibleBranch(messages,"")).toEqual(messages);
  });
  it("renders standalone code-review directives without interpreting quoted examples and malformed directives", () => {
    const review = '::code-comment{title="[P1] Check range" body="First \\"note\\"." file="src/a.ts" start=3 end=4 priority=1}';
    const first = "~~~md\n" + review + "\n~~~\n\n";
    expect(reviewSegments(first + review + "\nEnd.")).toEqual([{text:first},
      {title:"[P1] Check range",body:'First "note".',file:"src/a.ts",start:3,end:4},{text:"End."}]);
    expect(reviewSegments("::code-comment{file=\"only\"}")).toEqual([{text:"::code-comment{file=\"only\"}"}]);
  });
  it("locates historical review selections after edits and detects missing or ambiguous text", () => {
    expect(locateQuote("new\r\nline\r\nchosen\r\nlast", "chosen\nlast", 1)).toBe(3);
    expect(locateQuote("a\nsame\nc\nsame","same")).toBeUndefined();
    expect(locateQuote("changed","missing", 1)).toBeUndefined();
  });
  it("opens file references relative to the selected project and limits archive access to listed files", async () => {
    const root = await makeTempDir("coverse-preview-");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "two lines.md"), "one\ntwo");
    const service = new UiService(createAdapterRegistry(), createFakeDrivers(), new UiStore(root), workspace);
    const session = await service.createSession({agent: "codex", cwd: workspace});
    const {invoke} = createMockIpc(service);
    const preview = (ref: string, scope = "project") => invoke(IPC_CHANNELS.previewFile, session.id, ref, scope);
    expect(await preview("two lines.md")).toMatchObject({ok: true, data: {content: "one\ntwo"}});
    expect(await preview(pathToFileURL(path.join(workspace, "two lines.md")).href)).toMatchObject({ok: true});
    expect(await preview(".")).toMatchObject({ok: true, data: {entries: ["two lines.md"]}});
    expect(await preview("../settings.json")).toMatchObject({ok: false});
    expect(await preview("missing.md")).toMatchObject({ok: false});
    expect(await preview("two lines.md", "bundle")).toMatchObject({ok: false});
    expect(fileReference("two%20lines.md#L2", true)).toEqual({path: "two lines.md", line: 2});
    expect(fileReference("sample.ts:8:2")).toEqual({path: "sample.ts", line: 8});
    expect(fileReference("C:\\project\\file.ts:18")).toEqual({path: "C:\\project\\file.ts", line: 18});
    expect(fileTokens("see src/file.ts:3, then https://example.org/a.ts").filter(p => p.reference))
      .toEqual([{text: "src/file.ts:3", reference: {path: "src/file.ts", line: 3}}]);
  });
  it("restores only catalog metadata after restart and reconciles changed, renamed and deleted sessions", async () => {
    const home = await makeTempDir("coverse-incremental-");
    vi.stubEnv("CODEX_HOME", home);
    const dir = path.join(home, "sessions");
    await fs.mkdir(dir);
    const dataDir = path.join(home, "store");
    const header = (id: string, cwd: string) => JSON.stringify({
      type: "session_meta", payload: { id, cwd, base_instructions: { text: "private-body-marker" } },
    });
    const original = path.join(dir, "rollout-one.jsonl");
    const compressed = path.join(dir, "rollout-archive.jsonl.zst");
    await fs.writeFile(original, header("one", home));
    await fs.copyFile(path.join(REPO_ROOT, "fixtures/codex/rollout-2026-11-17/sample.jsonl.zst"), compressed);
    const drivers = createDriverRegistry();
    const adapters = createAdapterRegistry();
    const codex = adapters.get("codex");
    const readMetadata = vi.fn(codex.readProjectDirectory!);
    const originalReader = codex.readProjectDirectory!;
    codex.readProjectDirectory = readMetadata;
    const scan = vi.spyOn(drivers.get("codex"), "listLocalSessions");
    try {
      const first = new UiService(adapters, drivers, new UiStore(dataDir), home);
      const [initial, concurrent] = await Promise.all([first.listLocalSessions("codex"), first.listLocalSessions("codex")]);
      expect(initial).toEqual(concurrent);
      expect(scan).toHaveBeenCalledTimes(1);
      expect(readMetadata).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(path.join(dataDir, "local-catalog-v1-codex.json"), "utf8")).not.toContain("private-body-marker");

      const reopened = new UiService(adapters, drivers, new UiStore(dataDir), home);
      await fs.writeFile(path.join(home, "session_index.jsonl"), JSON.stringify({ id: "one", thread_name: "Renamed" }));
      expect(await reopened.listLocalSessions("codex", true)).toEqual(initial);
      expect(scan).toHaveBeenCalledTimes(1);
      expect((await reopened.listLocalSessions("codex")).find(item => item.id === "one")?.title).toBe("Renamed");
      expect(readMetadata).toHaveBeenCalledTimes(1);
      const moved = path.join(home, "changed-project");
      await fs.writeFile(original, header("one", moved));
      await fs.writeFile(path.join(dir, "rollout-two.jsonl"), header("two", home));
      await fs.unlink(compressed);
      const updated = await reopened.listLocalSessions("codex");
      expect(updated.map(item => item.id).sort()).toEqual(["one", "two"]);
      expect(updated.find(item => item.id === "one")?.cwd).toBe(moved);
      expect(await reopened.listLocalSessions("codex", true)).toEqual(updated);
      scan.mockRejectedValueOnce(new Error("Catalog unavailable"));
      await expect(reopened.listLocalSessions("codex")).rejects.toThrow("Catalog unavailable");
      expect(await reopened.listLocalSessions("codex", true)).toEqual(updated);
      vi.stubEnv("CODEX_HOME", path.join(home, "other-profile"));
      expect(await reopened.listLocalSessions("codex", true)).toEqual([]);
    } finally {
      codex.readProjectDirectory = originalReader;
      scan.mockRestore();
    }
  });

  it("groups all configured native sessions by full project path, including archives and long headers", async () => {
    const home = await makeTempDir("coverse-catalog-");
    vi.stubEnv("CODEX_HOME", home);
    vi.stubEnv("CLAUDE_CONFIG_DIR", home);
    const workspace = path.join(home, "client A", "app");
    const other = path.join(home, "client B", "app");
    const sessionsDir = path.join(home, "sessions");
    const archived = path.join(home, "archived_sessions");
    const claudeProject = path.join(home, "projects", "encoded-project");
    for (const dir of [sessionsDir, archived, claudeProject]) await fs.mkdir(dir, { recursive: true });
    const header = JSON.stringify({ type: "session_meta", payload: { padding: "x".repeat(5000), cwd: workspace } });
    for (let i = 0; i < 81; i++) await fs.writeFile(path.join(sessionsDir, "rollout-" + i + ".jsonl"), header);
    await fs.writeFile(path.join(archived, "rollout-old.jsonl"), header);
    await fs.copyFile(path.join(REPO_ROOT, "fixtures/codex/rollout-2026-11-17/sample.jsonl.zst"), path.join(archived, "rollout-compressed.jsonl.zst"));
    const row = { type: "user", padding: "y".repeat(17000), cwd: pathToFileURL(workspace).href, message: { content: "Shared project" } };
    await fs.writeFile(path.join(claudeProject, "one.jsonl"), JSON.stringify(row));
    await fs.writeFile(path.join(claudeProject, "two.jsonl"), JSON.stringify({ ...row, cwd: other }));
    await fs.writeFile(path.join(claudeProject, "missing.jsonl"), JSON.stringify({ type: "user", message: { content: "No workspace" } }));
    const service = new UiService(createAdapterRegistry(), createDriverRegistry(), new UiStore(path.join(home, "store")), home);
    await service.updateSettings({ disabledAdapters: ["antigravity"] });
    const catalog = await service.listLocalSessions();
    const groups = groupByProject(catalog);
    expect(catalog).toHaveLength(86);
    expect(groups.find(group => group.directory === workspace)?.sessions).toHaveLength(83);
    expect(groups.find(group => group.directory === other)?.sessions[0]?.id).toBe("two");
    expect(groups.find(group => group.directory === "")?.sessions[0]?.id).toBe("missing");
    expect(catalog.find(item => item.path.endsWith(".zst"))?.cwd).toBe("/sample/workspace");
    expect(await service.listLocalSessions("antigravity")).toEqual([]);
  });

  it("registers each conversion in its recorded project and leaves missing projects available for remapping", async () => {
    const root = await makeTempDir("coverse-project-routing-");
    const store = new UiStore(path.join(root, "store"));
    const drivers = createFakeDrivers();
    const invocation = vi.spyOn(drivers.get("claude-code").plugin, "invocation");
    const service = new UiService(createAdapterRegistry(), drivers, store, root);
    const raw = await fs.readFile(path.join(REPO_ROOT, "fixtures/codex/rollout-2026-11-17/sample.jsonl"), "utf8");
    const lines = raw.trim().split(/\r?\n/);
    const header = JSON.parse(lines[0]!);
    const source = path.join(root, "source.jsonl");
    const request = { from: "codex", to: "claude-code", paths: [source], cwd: root, useSourceProject: true };
    for (const project of ["first", "second", "moved"]) {
      const cwd = path.join(root, project);
      header.payload.cwd = pathToFileURL(cwd).href.replace(/^file:\/\/\/([a-z]):/i, "file:///$1%3A");
      await fs.writeFile(source, [JSON.stringify(header), ...lines.slice(1)].join("\n"));
      if (project === "moved") {
        await expect(service.convertSource(request)).rejects.toThrow("Directory does not exist");
        break;
      }
      await fs.mkdir(cwd);
      const converted = await service.convertSource(request);
      expect(converted.cwd).toBe(await fs.realpath(cwd));
      expect(invocation.mock.lastCall?.[0].cwd).toBe(converted.cwd);
      expect(converted.handoff?.materialized).toBe(true);
      expect(converted.targetSessionId).toBeTruthy();
    }
    expect(await store.listSessions()).toHaveLength(2);
    expect(await fs.readdir(store.bundlesDir)).toHaveLength(2);
  });

  it("retries desktop publication after restart without registering or billing a second CLI session", async () => {
    const root = await makeTempDir("coverse-desktop-retry-");
    const adapters = createAdapterRegistry(), drivers = createFakeDrivers();
    const store = new UiStore(path.join(root, "state"));
    const service = new UiService(adapters, drivers, store, root);
    const invocation = vi.spyOn(drivers.get("antigravity").plugin, "invocation");
    const adapter = adapters.get("antigravity") as SessionAdapter & Required<Pick<SessionAdapter, "publishDesktopSession">>;
    const publish = vi.spyOn(adapter, "publishDesktopSession")
      .mockRejectedValueOnce(new SessionError("DESKTOP_OPEN", "/desktop", "Close desktop"))
      .mockResolvedValue("desktop-id");
    try {
      const source = path.join(REPO_ROOT, "fixtures/codex/rollout-2026-11-17/sample.jsonl");
      const result = await service.convertSource({ from: "codex", to: "antigravity", paths: [source], cwd: root });
      expect(result.handoff?.desktopError?.code).toBe("DESKTOP_OPEN");
      const reopened = new UiService(adapters, drivers, store, root);
      const [first, second] = await Promise.all([reopened.materializeSession(result.id), reopened.materializeSession(result.id)]);
      expect(first.handoff?.desktopSessionId).toBe("desktop-id");
      expect(first.handoff?.desktopError).toBeUndefined();
      expect(first.targetSessionId).toBe(result.targetSessionId);
      expect(second).toEqual(first);
      await reopened.materializeSession(result.id);
      expect(publish).toHaveBeenCalledTimes(2);
      expect(invocation).toHaveBeenCalledTimes(1);
    } finally { publish.mockRestore(); invocation.mockRestore(); }
  });

  it("keeps references to the same native ID in separate project folders", async () => {
    const root = await makeTempDir("coverse-project-references-");
    const service = new UiService(createAdapterRegistry(), createFakeDrivers(), new UiStore(root), root);
    const original = await fs.readFile(path.join(REPO_ROOT, "fixtures/codex/rollout-2026-11-17/sample.jsonl"), "utf8");
    const lines = original.trim().split(/\r?\n/);
    const header = JSON.parse(lines[0]!);
    for (const name of ["one", "two"]) {
      const folder = path.join(root, name);
      await fs.mkdir(folder);
      header.payload.cwd = folder;
      const file = path.join(folder, "source.jsonl");
      await fs.writeFile(file, [JSON.stringify(header), ...lines.slice(1)].join("\n"));
      const request = { from: "codex", to: "codex", paths: [file], useSourceProject: true };
      const imported = await service.convertSource(request);
      expect((await service.convertSource(request)).id).toBe(imported.id);
    }
    expect(await service.listSessions()).toHaveLength(2);
  });
  it("handles capabilities, session CRUD, dialogs, and honest agent-switch boundaries over IPC", async () => {
    const dataDir = await makeTempDir("coverse-desktop-data-");
    const workDir = await makeTempDir("coverse-desktop-cwd-");
    const service = new UiService(createAdapterRegistry(), createFakeDrivers(), new UiStore(dataDir), workDir);
    const { invoke } = createMockIpc(service, {
      pickDirectory: async () => workDir,
    });

    const capsRes = await invoke<CapabilitiesResponse>(IPC_CHANNELS.capabilities);
    expect(capsRes.ok).toBe(true);
    if (capsRes.ok) {
      expect(capsRes.data.adapters.map((a) => a.id).sort()).toEqual(["antigravity", "claude-code", "codex"]);
      expect(capsRes.data.drivers.every((d) => d.available)).toBe(true);
      expect(capsRes.data.drivers.every((d) => d.models.length === 1)).toBe(true);
    }

    // Settings: appearance, language, adapter plugin enable/disable
    const defaultSettings = await invoke<AppSettings>(IPC_CHANNELS.getSettings);
    expect(defaultSettings.ok).toBe(true);
    const updatedSettings = await invoke<AppSettings>(IPC_CHANNELS.updateSettings, {
      theme: "light",
      language: "en",
      disabledAdapters: ["codex"],
    });
    expect(updatedSettings.ok).toBe(true);
    if (updatedSettings.ok) {
      expect(updatedSettings.data.theme).toBe("light");
      expect(updatedSettings.data.language).toBe("en");
      expect(updatedSettings.data.disabledAdapters).toEqual(["codex"]);
    }
    const capsAfterDisable = await invoke<CapabilitiesResponse>(IPC_CHANNELS.capabilities, true);
    expect(capsAfterDisable.ok).toBe(true);
    if (capsAfterDisable.ok) {
      expect(capsAfterDisable.data.adapters.find((a) => a.id === "codex")?.enabled).toBe(false);
    }

    // Local session discovery per agent
    const localSessions = await invoke<LocalSessionRef[]>(IPC_CHANNELS.listLocalSessions, "claude-code");
    expect(localSessions.ok).toBe(true);
    if (localSessions.ok) {
      expect(localSessions.data).toHaveLength(1);
      expect(localSessions.data[0]?.agent).toBe("claude-code");
    }

    const picked = await invoke<string | null>(IPC_CHANNELS.pickDirectory, workDir);
    expect(picked).toEqual({ ok: true, data: workDir });

    const created = await invoke<UiSession>(IPC_CHANNELS.createSession, {
      agent: "claude-code",
      model: "claude-sonnet-4-6",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const patched = await invoke<UiSession>(IPC_CHANNELS.updateSession, created.data.id, {
      agent: "antigravity",
      title: "Desktop session",
    });
    expect(patched.ok).toBe(true);
    if (patched.ok) {
      expect(patched.data.agent).toBe("antigravity");
      expect(patched.data.title).toBe("Desktop session");
    }

    const deleted = await invoke<{ deleted: boolean }>(IPC_CHANNELS.deleteSession, created.data.id);
    expect(deleted).toEqual({ ok: true, data: { deleted: true } });
    const list = await invoke<UiSession[]>(IPC_CHANNELS.listSessions);
    expect(list).toEqual({ ok: true, data: [] });
  });

  it("inspects and converts real local fixture paths (including SQLite + companion WAL detection)", async () => {
    const dataDir = await makeTempDir("coverse-desktop-convert-");
    const workDir = await makeTempDir("coverse-desktop-cwd-");
    const service = new UiService(createAdapterRegistry(), createFakeDrivers(), new UiStore(dataDir), workDir);
    const { invoke } = createMockIpc(service);

    const routes = [
      { fixture: "codex/rollout-2026-11-17/sample.jsonl", expectedFrom: "codex", to: "claude-code" },
      { fixture: "claude-code/transcript-sdk-0_3_326/sample.jsonl", expectedFrom: "claude-code", to: "antigravity" },
      { fixture: "antigravity/sqlite-2_32_1-step0/sample.db", expectedFrom: "antigravity", to: "codex" },
    ] as const;

    for (const route of routes) {
      const fixturePath = path.join(REPO_ROOT, "fixtures", route.fixture);
      const inspectRes = await invoke<InspectResponse>(IPC_CHANNELS.inspectSource, { paths: [fixturePath] });
      expect(inspectRes.ok).toBe(true);
      if (inspectRes.ok) {
        expect(inspectRes.data.detected).toBe(route.expectedFrom);
        expect(inspectRes.data.preview?.turns).toBeGreaterThan(0);
        // Fictional source path '/sample/workspace' must NOT overwrite local default cwd
        expect(inspectRes.data.preview?.cwd).toBeUndefined();
      }

      const convertRes = await invoke<UiSession>(IPC_CHANNELS.convertSource, {
        from: "auto",
        to: route.to,
        paths: [fixturePath],
        materialize: false,
      });
      expect(convertRes.ok).toBe(true);
      if (!convertRes.ok) continue;

      expect(convertRes.data.agent).toBe(route.to);
      expect(convertRes.data.bundlePending).toBe(true);
      expect(convertRes.data.handoff?.nativeResume).toBe(false);
      expect(convertRes.data.handoff?.losses.dropped).toBe(0);
      expect(convertRes.data.handoff?.losses.downgraded).toBeGreaterThan(0);
      // Converted conversation must populate readable historical user & assistant messages
      expect(convertRes.data.messages.some((m) => m.role === "user" && m.historical)).toBe(true);
      expect(convertRes.data.messages.some((m) => m.role === "assistant" && m.historical)).toBe(true);
      const read = convertRes.data.messages.flatMap(m => m.tools ?? []).find(tool => /read/i.test(tool.name));
      expect(read).toMatchObject({state:"completed",argumentsText:expect.stringContaining("example.txt"),
        results:[{text:"Hello from the sample."}]});
      if (route.expectedFrom === "antigravity") {
        const events = convertRes.data.messages.flatMap(m => [...m.before ?? [],...m.after ?? []]);
        expect(events.map(e => e.kind)).toEqual(["system","compaction","error"]);
        expect(events.at(-1)?.text).toContain("synthetic diagnostic");
      }

      const bundleRes = await invoke<BundleDetailResponse>(IPC_CHANNELS.getBundle, convertRes.data.handoff!.bundleId);
      expect(bundleRes.ok).toBe(true);
      if (bundleRes.ok) {
        expect(bundleRes.data.context).toContain("# CoVerse conversation context");
        expect(bundleRes.data.report.nativeResume).toBe(false);
      }
    }

    // Companion non-empty SQLite -wal file must be detected and rejected honestly
    const walDir = await makeTempDir("coverse-wal-");
    const dbCopy = path.join(walDir, "sample.db");
    await fs.copyFile(path.join(REPO_ROOT, "fixtures/antigravity/sqlite-2_32_1-step0/sample.db"), dbCopy);
    await fs.writeFile(dbCopy + "-wal", Buffer.from("nonempty-wal"));
    const walRes = await invoke<UiSession>(IPC_CHANNELS.convertSource, {
      from: "antigravity",
      to: "codex",
      paths: [dbCopy],
      materialize: false,
    });
    expect(walRes.ok).toBe(false);
    if (!walRes.ok) {
      expect(walRes.error.code).toBe("UNSTABLE_INPUT");
    }
  });

  it("restores legacy display on selection and carries the same visible messages into a desktop handoff", async () => {
    const root = await makeTempDir("coverse-visible-history-");
    const store = new UiStore(path.join(root, "state"));
    const service = new UiService(createAdapterRegistry(), createFakeDrivers(), store, root);
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const file = path.join(root, "rollout-test.jsonl");
    const done = (item: object) => ({ type: "event_msg", payload: { type: "item_completed", turn_id: "round", item } });
    await fs.writeFile(file, [
      {type:"session_meta",payload:{id,cwd:root,cli_version:"0.169.0-alpha.11.1"}},
      {type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"hidden workspace"}]}},
      done({type:"UserMessage",id:"question",content:[{type:"text",text:"Original question\n"}]}),
      done({type:"AgentMessage",id:"reply",content:[{type:"Text",text:"**Original reply**"}],phase:"final_answer"}),
    ].map(r => JSON.stringify(r)).join("\n"));
    const source = await service.convertSource({from:"codex",to:"codex",paths:[file],cwd:root});
    await store.mutateSession(source.id, current => {
      const reference = {...current.reference!};
      delete reference.displayVersion;
      const legacy = {...current, reference, messages:[]};
      delete legacy.historyVersion;
      return legacy;
    });
    const refreshed = await service.getSession(source.id, true);
    expect(refreshed.messages.map(m=>[m.role,m.content])).toEqual([["user","Original question\n"],["assistant","**Original reply**"]]);
    const target = await service.handoffSession(source.id,{to:"antigravity", materialize:false});
    expect(target.messages.map(m=>m.content)).toEqual(refreshed.messages.map(m=>m.content));
    const files = await store.loadBundleFiles(target.handoff!.bundleId);
    const csr = JSON.parse(new TextDecoder().decode(files.find(f=>f.path==="session.json")!.bytes));
    expect(csr.transcript.map((m: {text:string})=>m.text)).toEqual(refreshed.messages.map(m=>m.content));
    expect(csr.turns[0].content[0].text).toBe("hidden workspace");
  });

  it("imports same-agent same-path local sessions by reference only (zero copy) and materializes converted sessions into target agent", async () => {
    const dataDir = await makeTempDir("coverse-desktop-ref-");
    const projectDir = await makeTempDir("coverse-desktop-proj-");
    const realProjectDir = await fs.realpath(projectDir);
    const store = new UiStore(dataDir);
    const service = new UiService(createAdapterRegistry(), createFakeDrivers(), store, realProjectDir);
    const { invoke, emitted } = createMockIpc(service);

    // Create a local Codex rollout whose meta.cwd points to realProjectDir
    const rawFixture = await fs.readFile(path.join(REPO_ROOT, "fixtures/codex/rollout-2026-11-17/sample.jsonl"), "utf8");
    const lines = rawFixture.trim().split(/\r?\n/);
    const head = JSON.parse(lines[0]!) as { type: string; payload: Record<string, unknown> };
    const nativeUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    head.payload.id = nativeUuid;
    head.payload.cwd = realProjectDir;
    const localSessionFile = path.join(projectDir, `rollout-2026-11-20-${nativeUuid}.jsonl`);
    await fs.writeFile(localSessionFile, [JSON.stringify(head), ...lines.slice(1)].join("\n") + "\n", "utf8");

    // 1. Same format (codex -> codex) + same cwd => reference-only import with ZERO bundle files created
    const refRes = await invoke<UiSession>(IPC_CHANNELS.convertSource, {
      from: "auto",
      to: "codex",
      paths: [localSessionFile],
      cwd: realProjectDir,
    });
    expect(refRes.ok).toBe(true);
    if (!refRes.ok) return;
    expect(refRes.data.reference?.sourcePath).toBe(path.resolve(localSessionFile));
    expect(refRes.data.handoff).toBeUndefined();
    expect(refRes.data.bundlePending).toBe(false);
    expect(refRes.data.targetSessionId).toBe(nativeUuid);
    expect(refRes.data.messages.some((m) => m.role === "user" && m.historical)).toBe(true);
    await expect(fs.readdir(store.bundlesDir)).rejects.toThrow();

    // Follow-up on referenced session resumes original UUID directly
    const refTurn = await invoke(IPC_CHANNELS.runStart, "ref-run", {
      sessionId: refRes.data.id,
      prompt: "Continue original session",
    });
    expect(refTurn.ok).toBe(true);
    const refEvents = emitted.get(runEventChannel("ref-run")) ?? [];
    const refDone = refEvents.find((e) => e.type === "done");
    expect(refDone?.type).toBe("done");
    if (refDone?.type === "done") {
      expect(refDone.session.messages.at(-1)?.content).toBe("echo:codex:resumed:default");
    }

    // 2. Cross-agent conversion (codex -> claude-code) with default materialize=true registers target session immediately
    const matRes = await invoke<UiSession>(IPC_CHANNELS.convertSource, {
      from: "auto",
      to: "claude-code",
      paths: [localSessionFile],
      cwd: realProjectDir,
    });
    expect(matRes.ok).toBe(true);
    if (!matRes.ok) return;
    expect(matRes.data.agent).toBe("claude-code");
    expect(matRes.data.handoff?.materialized).toBe(true);
    expect(matRes.data.bundlePending).toBe(false);
    expect(matRes.data.targetSessionId).toBe("11111111-2222-4333-8444-555555555555");

    // 3. Session with encrypted reasoning (opaque block): inspect reports it, strict mode rejects with UNINTERPRETED_CONTENT,
    // and explicit omitOpaque archives it and logs OPAQUE_ARCHIVED_ONLY in LossLedger.dropped
    const opaqueFile = path.join(projectDir, "rollout-encrypted.jsonl");
    const encryptedRow = JSON.stringify({
      type: "response_item",
      payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Plan step." }], encrypted_content: "ciphertext" },
    });
    await fs.writeFile(opaqueFile, [JSON.stringify(head), ...lines.slice(1), encryptedRow].join("\n") + "\n", "utf8");

    const opaqueInspect = await invoke<InspectResponse>(IPC_CHANNELS.inspectSource, { paths: [opaqueFile] });
    expect(opaqueInspect.ok).toBe(true);
    if (opaqueInspect.ok) {
      expect(opaqueInspect.data.preview?.opaqueBlocks).toEqual([{ source: "codex:encrypted-reasoning", count: 1 }]);
    }

    const strictOpaque = await invoke<UiSession>(IPC_CHANNELS.convertSource, {
      from: "auto",
      to: "antigravity",
      paths: [opaqueFile],
      cwd: realProjectDir,
      materialize: false,
    });
    expect(strictOpaque.ok).toBe(false);
    if (!strictOpaque.ok) {
      expect(strictOpaque.error.code).toBe("UNINTERPRETED_CONTENT");
    }

    const allowedOpaque = await invoke<UiSession>(IPC_CHANNELS.convertSource, {
      from: "auto",
      to: "antigravity",
      paths: [opaqueFile],
      cwd: realProjectDir,
      materialize: false,
      omitOpaque: true,
    });
    expect(allowedOpaque.ok).toBe(true);
    if (allowedOpaque.ok) {
      expect(allowedOpaque.data.handoff?.losses.dropped).toBe(1);
      expect(allowedOpaque.data.handoff?.ledger.dropped[0]?.code).toBe("OPAQUE_ARCHIVED_ONLY");
    }
  });

  it("streams bundle injection, resumes by target UUID, supports handoff, and cancels cleanly over IPC", async () => {
    const dataDir = await makeTempDir("coverse-desktop-stream-");
    const workDir = await makeTempDir("coverse-desktop-cwd-");
    const service = new UiService(createAdapterRegistry(), createFakeDrivers(), new UiStore(dataDir), workDir);
    const { invoke, emitted } = createMockIpc(service);

    const fixturePath = path.join(REPO_ROOT, "fixtures/codex/rollout-2026-11-17/sample.jsonl");
    const conv = await invoke<UiSession>(IPC_CHANNELS.convertSource, {
      from: "auto",
      to: "claude-code",
      paths: [fixturePath],
      model: "claude-sonnet-4-6",
      materialize: false,
    });
    expect(conv.ok).toBe(true);
    if (!conv.ok) return;

    // 1. First turn injects bundle
    const run1 = await invoke(IPC_CHANNELS.runStart, "r1", {
      sessionId: conv.data.id,
      prompt: "What happened earlier?",
    });
    expect(run1.ok).toBe(true);
    const events1 = emitted.get(runEventChannel("r1")) ?? [];
    expect(events1.some((e) => e.type === "bundle")).toBe(true);
    expect(events1.some((e) => e.type === "tool" && e.name === "read_file")).toBe(true);
    const done1 = events1.find((e) => e.type === "done");
    expect(done1?.type).toBe("done");
    if (done1?.type === "done") {
      expect(done1.session.bundlePending).toBe(false);
      expect(done1.session.targetSessionId).toBe("11111111-2222-4333-8444-555555555555");
      expect(done1.session.messages.at(-1)?.content).toBe("echo:claude-code:injected:claude-sonnet-4-6");
      expect(done1.session.messages.at(-1)).toMatchObject({reasoning:"Visible thought",model:"actual-test-model"});
      expect(events1).toContainEqual({type:"reasoning",text:"Visible thought"});
      expect(done1.session.messages.at(-1)?.tools).toMatchObject([{id:"read-1",argumentsText:'{"path":"live.txt"}',results:[{text:"live result body"}]}]);
    }

    // 2. Follow-up resumes by UUID without re-injecting bundle
    const run2 = await invoke(IPC_CHANNELS.runStart, "r2", {
      sessionId: conv.data.id,
      prompt: "Follow-up",
    });
    expect(run2.ok).toBe(true);
    const events2 = emitted.get(runEventChannel("r2")) ?? [];
    expect(events2.some((e) => e.type === "bundle")).toBe(false);
    const done2 = events2.find((e) => e.type === "done");
    if (done2?.type === "done") {
      expect(done2.session.messages.at(-1)?.content).toBe("echo:claude-code:resumed:claude-sonnet-4-6");
    }

    // 3. Handoff active session to Antigravity (deferred materialization)
    const handoff = await invoke<UiSession>(IPC_CHANNELS.handoffSession, conv.data.id, {
      to: "antigravity",
      materialize: false,
    });
    expect(handoff.ok).toBe(true);
    if (!handoff.ok) return;
    expect(handoff.data.agent).toBe("antigravity");
    expect(handoff.data.bundlePending).toBe(true);
    const bundle = await invoke<BundleDetailResponse>(IPC_CHANNELS.getBundle, handoff.data.handoff!.bundleId);
    expect(bundle).toMatchObject({ok:true,data:{context:expect.stringContaining("live result body")}});

    // 4. Abort hanging run cleanly
    const hangPromise = invoke(IPC_CHANNELS.runStart, "r3", {
      sessionId: handoff.data.id,
      prompt: "__HANG__",
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const aborted = await invoke<{ aborted: boolean }>(IPC_CHANNELS.runAbort, handoff.data.id);
    expect(aborted).toEqual({ ok: true, data: { aborted: true } });
    await hangPromise;
    const events3 = emitted.get(runEventChannel("r3")) ?? [];
    const err3 = events3.find((e) => e.type === "error");
    expect(err3?.type).toBe("error");
    if (err3?.type === "error") {
      expect(err3.diagnostic.code).toBe("CANCELLED");
      expect(err3.session?.messages.at(-1)?.aborted).toBe(true);
    }
  });
});
