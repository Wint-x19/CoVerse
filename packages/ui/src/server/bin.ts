#!/usr/bin/env node
import path from "node:path";
import { startUiServer } from "./index.js";

function parseArgs(argv: readonly string[]) {
  let host = process.env.COVERSE_UI_HOST ?? "127.0.0.1";
  let port = Number(process.env.COVERSE_UI_PORT ?? "4173");
  let dataDir = process.env.COVERSE_UI_DATA_DIR;
  let defaultCwd = process.env.COVERSE_UI_CWD ?? process.cwd();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: coverse-ui [--host 127.0.0.1] [--port 4173] [--cwd <dir>] [--data-dir <dir>]\n",
      );
      process.exit(0);
    }
    const next = argv[++i];
    if (!next) {
      process.stderr.write(`Missing value for ${arg}\n`);
      process.exit(2);
    }
    if (arg === "--host") host = next;
    else if (arg === "--port") port = Number(next);
    else if (arg === "--data-dir") dataDir = path.resolve(next);
    else if (arg === "--cwd") defaultCwd = path.resolve(next);
    else {
      process.stderr.write(`Unknown option: ${arg}\n`);
      process.exit(2);
    }
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`Invalid port: ${String(port)}\n`);
    process.exit(2);
  }
  return { host, port, ...(dataDir ? { dataDir } : {}), defaultCwd };
}

const config = parseArgs(process.argv.slice(2));
const instance = await startUiServer(config);
process.stdout.write(`CoVerse UI running at ${instance.url}\n`);

const shutdown = () => {
  void instance.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
