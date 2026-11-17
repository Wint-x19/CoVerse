import { fileURLToPath } from "node:url";
import { checkFixtures } from "./check.js";

try {
  const result = await checkFixtures(fileURLToPath(new URL("../../fixtures/", import.meta.url)));
  console.log(`Fixture check passed: ${result.manifests} reviewed manifests, ${result.files} artifacts.`);
} catch {
  console.error("Fixture check failed: verify reviewed manifests, checksums, file lists and JSON/JSONL syntax.");
  process.exitCode = 1;
}
