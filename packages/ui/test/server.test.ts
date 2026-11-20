import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDriver, DriverRegistry, type DriverPlugin } from "@coverse/drivers";
import { startUiServer } from "../dist/server/index.js";
import type {
  BundleDetailResponse,
  CapabilitiesResponse,
  InspectResponse,
  StreamEventPayload,
  UiSession,
} from "../dist/server/index.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

const tempDirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    await closers.pop()!();
  }
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

async function readFixtureUpload(relativePath: string) {
  const bytes = await fs.readFile(path.join(REPO_ROOT, "fixtures", relativePath));
  return {
    path: path.basename(relativePath),
    contentBase64: bytes.toString("base64"),
  };
}

function createFakeDriverPlugin(id: string): DriverPlugin {
  return {
    id,
    command: "node",
    verifiedVersions: ["fake 1.0.0"],
    invocation({ prompt, session, model }) {
      const script = [
        '(() => {',
        'const fs = require("node:fs");',
        'const input = fs.readFileSync(0, "utf8");',
        'const req = JSON.parse(input);',
        'if (req.prompt.includes("__HANG__")) {',
        '  process.stdout.write(JSON.stringify({ event: "session", id: req.session }) + "\\n");',
        '  setTimeout(() => {}, 30000);',
        '  return;',
        '}',
        'process.stdout.write(JSON.stringify({ event: "session", id: req.session }) + "\\n");',
        'process.stdout.write(JSON.stringify({ event: "tool", name: "read_file", state: "completed" }) + "\\n");',
        'const hasHistory = req.prompt.includes("# CoVerse conversation context");',
        'const reply = `echo:${req.id}:${req.resumed ? "resumed" : hasHistory ? "injected" : "direct"}:${req.model || "default"}`;',
        'process.stdout.write(JSON.stringify({ event: "text", text: reply.slice(0, 10) }) + "\\n");',
        'process.stdout.write(JSON.stringify({ event: "text", text: reply.slice(10) }) + "\\n");',
        'process.stdout.write(JSON.stringify({ event: "usage", input: 42, output: 17 }) + "\\n");',
        'process.stdout.write(JSON.stringify({ event: "done" }) + "\\n");',
        '})();',
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
  };
}

function createFakeDrivers(): DriverRegistry {
  const registry = new DriverRegistry();
  for (const id of ["codex", "claude-code", "antigravity"]) {
    registry.register(
      new AgentDriver(createFakeDriverPlugin(id), {
        command: process.execPath,
      }),
    );
  }
  return registry;
}

async function parseSse(response: Response): Promise<StreamEventPayload[]> {
  const text = await response.text();
  const events: StreamEventPayload[] = [];
  for (const block of text.split("\n\n")) {
    const dataLine = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (dataLine) events.push(JSON.parse(dataLine) as StreamEventPayload);
  }
  return events;
}

describe("CoVerse M4 UI server", () => {
  it("exposes health, capabilities, session CRUD, and honest agent-switch boundaries", async () => {
    const dataDir = await makeTempDir("coverse-ui-data-");
    const workDir = await makeTempDir("coverse-ui-cwd-");
    const instance = await startUiServer({
      port: 0,
      dataDir,
      defaultCwd: workDir,
      drivers: createFakeDrivers(),
    });
    closers.push(instance.close);

    const health = await fetch(`${instance.url}/api/health`).then((r) => r.json());
    expect(health.status).toBe("ok");

    const caps = (await fetch(`${instance.url}/api/capabilities`).then((r) => r.json())) as CapabilitiesResponse;
    expect(caps.adapters.map((a) => a.id).sort()).toEqual(["antigravity", "claude-code", "codex"]);
    expect(caps.drivers.every((d) => d.available)).toBe(true);

    // Create session
    const createdRes = await fetch(`${instance.url}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "claude-code", model: "claude-sonnet-4-6" }),
    });
    expect(createdRes.status).toBe(201);
    const { session } = (await createdRes.json()) as { session: UiSession };
    expect(session.agent).toBe("claude-code");
    expect(session.model).toBe("claude-sonnet-4-6");

    // Patch empty session agent and title
    const patchedRes = await fetch(`${instance.url}/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "antigravity", title: "Renamed" }),
    });
    expect(patchedRes.status).toBe(200);
    const { session: patched } = (await patchedRes.json()) as { session: UiSession };
    expect(patched.agent).toBe("antigravity");
    expect(patched.title).toBe("Renamed");

    // Delete session
    const delRes = await fetch(`${instance.url}/api/sessions/${session.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    const list = (await fetch(`${instance.url}/api/sessions`).then((r) => r.json())) as { sessions: UiSession[] };
    expect(list.sessions).toHaveLength(0);
  });

  it("inspects and converts real Codex, Claude Code, and binary Antigravity SQLite fixtures with LossLedger", async () => {
    const dataDir = await makeTempDir("coverse-ui-convert-");
    const workDir = await makeTempDir("coverse-ui-cwd-");
    const instance = await startUiServer({
      port: 0,
      dataDir,
      defaultCwd: workDir,
      drivers: createFakeDrivers(),
    });
    closers.push(instance.close);

    const routes = [
      { fixture: "codex/rollout-2026-11-17/sample.jsonl", expectedFrom: "codex", to: "claude-code" },
      { fixture: "claude-code/transcript-sdk-0_3_326/sample.jsonl", expectedFrom: "claude-code", to: "antigravity" },
      { fixture: "antigravity/sqlite-2_32_1-step0/sample.db", expectedFrom: "antigravity", to: "codex" },
    ] as const;

    for (const route of routes) {
      const upload = await readFixtureUpload(route.fixture);
      const inspect = (await fetch(`${instance.url}/api/sessions/inspect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files: [upload] }),
      }).then((r) => r.json())) as InspectResponse;

      expect(inspect.detected).toBe(route.expectedFrom);
      expect(inspect.ambiguous).toBe(false);
      expect(inspect.preview?.turns).toBeGreaterThan(0);

      const convertRes = await fetch(`${instance.url}/api/sessions/convert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "auto", to: route.to, files: [upload] }),
      });
      expect(convertRes.status).toBe(201);
      const { session } = (await convertRes.json()) as { session: UiSession };
      expect(session.agent).toBe(route.to);
      expect(session.bundlePending).toBe(true);
      expect(session.handoff?.from).toBe(route.expectedFrom);
      expect(session.handoff?.nativeResume).toBe(false);
      expect(session.handoff?.losses.dropped).toBe(0);
      expect(session.handoff?.losses.downgraded).toBeGreaterThan(0);
      expect(session.handoff?.statistics.truncated).toBe(false);

      const bundle = (await fetch(`${instance.url}/api/bundles/${session.handoff!.bundleId}`).then((r) =>
        r.json(),
      )) as BundleDetailResponse;
      expect(bundle.context).toContain("# CoVerse conversation context");
      expect(bundle.report.nativeResume).toBe(false);
      expect(bundle.files.some((f) => f.path === "context.md")).toBe(true);
    }

    // Unrecognized file fails explicitly with structured diagnostic
    const badRes = await fetch(`${instance.url}/api/sessions/convert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "auto",
        to: "claude-code",
        files: [{ path: "unknown.txt", contentBase64: Buffer.from("not a session").toString("base64") }],
      }),
    });
    expect(badRes.status).toBe(422);
    const badBody = (await badRes.json()) as { error: { code: string } };
    expect(badBody.error.code).toBe("UNSUPPORTED_FORMAT");
  });

  it("injects bundle on first turn, resumes by target UUID on follow-up, and supports UI session handoff + abort", async () => {
    const dataDir = await makeTempDir("coverse-ui-stream-");
    const workDir = await makeTempDir("coverse-ui-cwd-");
    const instance = await startUiServer({
      port: 0,
      dataDir,
      defaultCwd: workDir,
      drivers: createFakeDrivers(),
    });
    closers.push(instance.close);

    // 1. Convert Codex fixture -> Claude Code
    const upload = await readFixtureUpload("codex/rollout-2026-11-17/sample.jsonl");
    const { session: converted } = (await fetch(`${instance.url}/api/sessions/convert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "auto", to: "claude-code", files: [upload], model: "claude-sonnet-4-6" }),
    }).then((r) => r.json())) as { session: UiSession };

    // 2. First turn injects bundle
    const turn1Res = await fetch(`${instance.url}/api/sessions/${converted.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "What happened earlier?" }),
    });
    expect(turn1Res.status).toBe(200);
    const turn1Events = await parseSse(turn1Res);
    expect(turn1Events.some((e) => e.type === "bundle")).toBe(true);
    expect(turn1Events.some((e) => e.type === "tool" && e.name === "read_file")).toBe(true);
    const done1 = turn1Events.find((e) => e.type === "done");
    expect(done1?.type).toBe("done");
    if (done1?.type === "done") {
      expect(done1.session.bundlePending).toBe(false);
      expect(done1.session.targetSessionId).toBe("11111111-2222-4333-8444-555555555555");
      expect(done1.session.messages).toHaveLength(2);
      expect(done1.session.messages[1]?.content).toBe("echo:claude-code:injected:claude-sonnet-4-6");
      expect(done1.session.messages[1]?.usage?.input).toBe(42);
    }

    // 3. Second turn resumes by target session UUID (no bundle re-injection)
    const turn2Res = await fetch(`${instance.url}/api/sessions/${converted.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Follow-up question" }),
    });
    const turn2Events = await parseSse(turn2Res);
    expect(turn2Events.some((e) => e.type === "bundle")).toBe(false);
    const done2 = turn2Events.find((e) => e.type === "done");
    expect(done2?.type).toBe("done");
    if (done2?.type === "done") {
      expect(done2.session.messages).toHaveLength(4);
      expect(done2.session.messages[3]?.content).toBe("echo:claude-code:resumed:claude-sonnet-4-6");
    }

    // 4. Handoff active session from Claude Code -> Antigravity
    const handoffRes = await fetch(`${instance.url}/api/sessions/${converted.id}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "antigravity" }),
    });
    expect(handoffRes.status).toBe(201);
    const { session: handedOff } = (await handoffRes.json()) as { session: UiSession };
    expect(handedOff.agent).toBe("antigravity");
    expect(handedOff.bundlePending).toBe(true);
    expect(handedOff.handoff?.from).toBe("claude-code");
    expect(handedOff.handoff?.to).toBe("antigravity");
    expect(handedOff.handoff?.statistics.turns).toBeGreaterThanOrEqual(4);

    // 5. Abort a hanging turn cleanly
    const streamPromise = fetch(`${instance.url}/api/sessions/${handedOff.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "__HANG__" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const abortRes = await fetch(`${instance.url}/api/sessions/${handedOff.id}/abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(abortRes.status).toBe(200);
    const abortEvents = await parseSse(await streamPromise);
    const errEvent = abortEvents.find((e) => e.type === "error");
    expect(errEvent?.type).toBe("error");
    if (errEvent?.type === "error") {
      expect(errEvent.diagnostic.code).toBe("CANCELLED");
      expect(errEvent.session?.messages.at(-1)?.aborted).toBe(true);
    }
  });
});
