import { spawn } from "node:child_process";
import path from "node:path";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");

const bundle = spawn(process.execPath, [path.join(root, "scripts/bundle-electron.mjs")], {
  cwd: root,
  stdio: "inherit",
});
await new Promise((resolve, reject) => {
  bundle.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Bundle failed (${code})`))));
});

const server = await createServer({ configFile: path.join(root, "vite.config.ts") });
await server.listen();
const address = server.resolvedUrls?.local[0] ?? "http://127.0.0.1:5173";

const electronCmd = process.platform === "win32" ? "electron.cmd" : "electron";
const electronBin = path.join(root, "node_modules", ".bin", electronCmd);
const child = spawn(electronBin, ["."], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, COVERSE_RENDERER_URL: address },
});

child.once("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
