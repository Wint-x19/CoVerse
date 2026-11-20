import path from "node:path";
import type { AddressInfo } from "node:net";
import { AdapterRegistry } from "@coverse/core";
import codex from "@coverse/adapter-codex";
import claudeCode from "@coverse/adapter-claude-code";
import antigravity from "@coverse/adapter-antigravity";
import { createDriverRegistry, type DriverRegistry } from "@coverse/drivers";
import { UiStore } from "./store.js";
import { UiService } from "./service.js";
import { createUiHttpServer } from "./server.js";

export * from "../shared/types.js";
export { UiStore } from "./store.js";
export { UiService, decodeUploadedFiles, toDiagnostic } from "./service.js";
export { createUiHttpServer } from "./server.js";

/** Composition root for UI server; core remains vendor-free. */
export function createAdapterRegistry(): AdapterRegistry {
  return new AdapterRegistry().register(codex).register(claudeCode).register(antigravity);
}

export interface StartUiServerOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  defaultCwd?: string;
  staticDir?: string;
  adapters?: AdapterRegistry;
  drivers?: DriverRegistry;
}

export async function startUiServer(options: StartUiServerOptions = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4173;
  const defaultCwd = path.resolve(options.defaultCwd ?? process.cwd());
  const dataDir = path.resolve(options.dataDir ?? path.join(defaultCwd, ".local", "ui"));
  const staticDir = options.staticDir ?? path.resolve(import.meta.dirname, "../client");

  const store = new UiStore(dataDir);
  const service = new UiService(
    options.adapters ?? createAdapterRegistry(),
    options.drivers ?? createDriverRegistry(),
    store,
    defaultCwd,
  );
  const server = createUiHttpServer({ service, staticDir });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const url = `http://${address.address}:${address.port}`;

  return {
    server,
    service,
    store,
    url,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
