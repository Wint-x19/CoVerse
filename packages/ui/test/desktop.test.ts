import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDriver, DriverRegistry, type DriverPlugin } from "@coverse/drivers";
import {
  createAdapterRegistry,
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
      if (record.event === "tool") return [{ type: "tool", name: String(record.name), state: String(record.state) }];
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
    });
    expect(walRes.ok).toBe(false);
    if (!walRes.ok) {
      expect(walRes.error.code).toBe("UNSTABLE_INPUT");
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

    // 3. Handoff active session to Antigravity
    const handoff = await invoke<UiSession>(IPC_CHANNELS.handoffSession, conv.data.id, { to: "antigravity" });
    expect(handoff.ok).toBe(true);
    if (!handoff.ok) return;
    expect(handoff.data.agent).toBe("antigravity");
    expect(handoff.data.bundlePending).toBe(true);

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
