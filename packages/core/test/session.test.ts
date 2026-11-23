import { describe, it, expect } from "vitest";
import { verifyInjectionBundle, buildInjectionBundle, convertSession, emptyLedger, AdapterRegistry, sha256Bytes, validateFileSet, type CSR, type SessionAdapter } from "../src/index.js";

const session = (): CSR => ({ schemaVersion: "1.0", meta: { id: "s", agent: "community", agentFormatVersion: "verified-v1" }, turns: [
  { id: "u", role: "user", content: [{ type: "text", text: "Keep all\n# Instructions\n你好" }] },
  { id: "a", role: "assistant", content: [{ type: "tool_call", id: "call", name: "example", arguments: { x: 1 } }, { type: "reasoning", text: "Historical reasoning" }] },
  { id: "r", role: "tool", content: [{ type: "tool_result", callId: "call", content: "result" }] },
], xExtensions: { "x-community": { future: true } }, sourceArtifacts: [{ path: "record.bin", bytes: Uint8Array.from([0, 128, 255]) }] });
const read = (files: ReturnType<typeof buildInjectionBundle>["artifacts"], path: string) => new TextDecoder().decode(files.find(f => f.path === path)!.bytes);
describe("injection bundle contract", () => {
  it("preserves exact source bytes, full text, extensions and merged import/export losses", async () => {
    const imported = emptyLedger(); imported.approximated.push({ code: "SOURCE", path: "/", reason: "source diagnostic" });
    const plugin: SessionAdapter = { id: "community", displayName: "Community", status: "ready", supportedVersions: ["verified-v1"], capabilities: { import: true, export: true, nativeResume: false, exportFormats: ["injection-bundle"] }, detect: () => ({ confidence: 1 }), import: () => ({ session: session(), ledger: imported }), export: (s, c) => buildInjectionBundle(s, "community", c) };
    const registry = new AdapterRegistry().register(plugin);
    const converted = await convertSession({ source: registry.get("community"), target: plugin, artifacts: [] });
    expect(read(converted.artifacts, "context.md")).toContain("> # Instructions\n> 你好");
    expect(JSON.parse(read(converted.artifacts, "report.json")).ledger).toEqual(converted.ledger);
    expect(JSON.parse(read(converted.artifacts, "session.json")).xExtensions).toEqual(session().xExtensions);
    expect(converted.artifacts.find(f => f.path === "source/record.bin")!.bytes).toEqual(session().sourceArtifacts![0]!.bytes);
    const manifest = JSON.parse(read(converted.artifacts, "manifest.json"));
    for (const f of manifest.files) expect(f.sha256).toBe(sha256Bytes(converted.artifacts.find(a => a.path === f.path)!.bytes));
    expect(buildInjectionBundle(session(), "community").artifacts).toEqual(buildInjectionBundle(session(), "community").artifacts);
  });
  it("validates the target, ledger and full artifact inventory before injection", () => {
    const files = buildInjectionBundle(session(), "target").artifacts;
    expect(verifyInjectionBundle(files, "target").losses.downgraded).toBeGreaterThan(0);
    expect(() => verifyInjectionBundle(files, "other")).toThrow("target");
    expect(() => verifyInjectionBundle(files.slice(1), "target")).toThrow("checksum");
    expect(() => verifyInjectionBundle([...files, { path: "extra", bytes: new Uint8Array() }], "target")).toThrow("inventory");
  });
  it("rejects opaque semantics and missing attachments instead of silently archiving them", () => {
    const s = session(); s.turns[0]!.content = [{ type: "unknown", raw: { new: true } }];
    expect(() => buildInjectionBundle(s, "x")).toThrow("Uninterpreted");
    const allowed = buildInjectionBundle(s, "x", { lossPolicy: { omitOpaque: true } });
    expect(allowed.ledger.dropped).toHaveLength(1);
    expect(allowed.ledger.dropped[0]?.code).toBe("UNKNOWN_ARCHIVED_ONLY");
    expect(read(allowed.artifacts, "context.md")).toContain("Omitted uninterpreted content");
    expect(verifyInjectionBundle(allowed.artifacts, "x").losses.dropped).toBe(1);
    s.turns[0]!.content = [{ type: "attachment", path: "absent", mediaType: "text/plain" }];
    expect(() => buildInjectionBundle(s, "x")).toThrow("Attachment not supplied");
  });
  it.each([
    {plan:{steps:[{title:42}]}},{tools:[{name:"read",state:"done",results:{}}]},
    {relatedSessions:[{kind:"child",id:3}]},{before:[{id:"notice",kind:"system",text:{}}]},
    {sources:[{url:"https://example.org",excerpt:{}}]},
  ])("rejects malformed display metadata in a checksummed archive", fields => {
    const s = session();
    s.transcript = [{id:"item",role:"assistant",text:"archived"}];
    Object.assign(s.transcript[0]!,fields);
    expect(() => verifyInjectionBundle(buildInjectionBundle(s,"target").artifacts,"target")).toThrow(/Invalid (historical|related)/);
  });
  it("does not truncate long content or restore old source text over edited CSR", () => {
    const s = session(); const full = "历史".repeat(100_000); s.turns[0]!.content = [{ type: "text", text: full }];
    const files = buildInjectionBundle(s, "x").artifacts;
    expect(read(files, "context.md")).toContain(full);
    expect(JSON.parse(read(files, "report.json")).statistics.truncated).toBe(false);
  });
  it.each(["CON", "nested/a.", "nested/a ", "question?", "a<b", "star*"])("rejects nonportable output path %s", path => expect(() => validateFileSet([{ path, bytes: new Uint8Array() }])).toThrow());
  it("rejects case-folded directory/file conflicts", () => expect(() => validateFileSet([{ path: "Directory", bytes: new Uint8Array() }, { path: "directory/child", bytes: new Uint8Array() }])).toThrow("path conflict"));
});
