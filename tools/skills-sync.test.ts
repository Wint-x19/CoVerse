import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryRoot } from "./test-helpers.js";

async function listFiles(root: string, prefix = ""): Promise<Map<string, Buffer>> {
  const info = await lstat(root);
  expect(info.isSymbolicLink(), `${root} must be a real directory, not a symlink`).toBe(false);
  const files = new Map<string, Buffer>();
  for (const entry of (await readdir(root)).sort()) {
    const full = path.join(root, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    const entryStat = await lstat(full);
    expect(entryStat.isSymbolicLink(), `${rel} must not be a symlink`).toBe(false);
    if (entryStat.isDirectory()) {
      for (const [k, v] of await listFiles(full, rel)) files.set(k, v);
    } else if (entryStat.isFile()) {
      files.set(rel, await readFile(full));
    }
  }
  return files;
}

describe("collaboration workflow skills sync", () => {
  it("keeps .claude/skills and .agents/skills byte-identical without symlinks", async () => {
    const claudeSkills = await listFiles(path.join(repositoryRoot, ".claude", "skills"));
    const agentSkills = await listFiles(path.join(repositoryRoot, ".agents", "skills"));
    expect([...claudeSkills.keys()]).toEqual(["create-issue/SKILL.md", "create-pr/SKILL.md", "self-review/SKILL.md"]);
    expect([...agentSkills.keys()]).toEqual([...claudeSkills.keys()]);
    for (const [rel, content] of claudeSkills) {
      expect(agentSkills.get(rel)?.equals(content), `${rel} differs between .claude/skills and .agents/skills`).toBe(true);
    }
  });
});
