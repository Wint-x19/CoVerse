import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const tempRoot = path.resolve(repositoryRoot, ".tmp");

export async function createSandbox(): Promise<string> {
  await mkdir(tempRoot, { recursive: true });
  return mkdtemp(path.join(tempRoot, "fixture-test-"));
}

export async function removeSandbox(sandbox: string): Promise<void> {
  const target = path.resolve(sandbox);
  const relative = path.relative(tempRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Refusing to delete outside the repository test sandbox");
  }
  await rm(target, { recursive: true, force: true });
}
