import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SessionError, type FileSet } from "@coverse/core";
import type { AppSettings, LocalSessionRef, UiSession } from "../shared/types.js";

const SAFE_ID = /^[a-zA-Z0-9_-]{4,64}$/;

interface PersistedState {
  schemaVersion: "1.0";
  sessions: UiSession[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  leftWidth: 240, rightWidth: 420, leftOpen: true, rightOpen: false,
  theme: "dark",
  language: "zh-CN",
  disabledAdapters: [],
  driverExecutables: {},
};

export function readLayout(values: Partial<AppSettings>, defaults = DEFAULT_SETTINGS) {
  function width(value: unknown, min: number, max: number, fallback: number) {
    return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
  }
  return {
    leftWidth: width(values.leftWidth, 170, 440, defaults.leftWidth),
    rightWidth: width(values.rightWidth, 280, 1200, defaults.rightWidth),
    leftOpen: typeof values.leftOpen === "boolean" ? values.leftOpen : defaults.leftOpen,
    rightOpen: typeof values.rightOpen === "boolean" ? values.rightOpen : defaults.rightOpen,
  };
}

export class UiStore {
  private writeQueue: Promise<void> = Promise.resolve();
  readonly bundlesDir: string;
  readonly statePath: string;
  readonly settingsPath: string;

  constructor(readonly dataDir: string) {
    this.bundlesDir = path.join(dataDir, "bundles");
    this.statePath = path.join(dataDir, "sessions.json");
    this.settingsPath = path.join(dataDir, "settings.json");
  }

  private assertSafeId(id: string, field: string): void {
    if (!SAFE_ID.test(id)) {
      throw new SessionError("INVALID_INPUT", field, `Invalid identifier: ${id}`);
    }
  }

  private async ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }

  private async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    await this.ensureDir(this.dataDir);
    const temp = path.join(this.dataDir, `.tmp-${randomUUID()}.json`);
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, filePath);
  }

  private async readState(): Promise<PersistedState> {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (parsed && parsed.schemaVersion === "1.0" && Array.isArray(parsed.sessions)) {
        return { schemaVersion: "1.0", sessions: parsed.sessions };
      }
      return { schemaVersion: "1.0", sessions: [] };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { schemaVersion: "1.0", sessions: [] };
      }
      throw error;
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(fn, fn);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private catalogPath(agent: string): string {
    this.assertSafeId(agent, "/agent");
    return path.join(this.dataDir, `local-catalog-v1-${agent}.json`);
  }

  async readLocalCatalog(agent: string, root?: string): Promise<LocalSessionRef[]> {
    try {
      const catalog = JSON.parse(await fs.readFile(this.catalogPath(agent), "utf8"));
      if (catalog?.root !== (root ?? null) || !Array.isArray(catalog.sessions)) return [];
      const rows: unknown[] = catalog.sessions;
      return rows.filter((value): value is LocalSessionRef => {
        const row = value as Partial<LocalSessionRef> | null;
        return !!row && row.agent === agent && typeof row.id === "string" && typeof row.title === "string" &&
        typeof row.path === "string" && typeof row.updatedAt === "string" && typeof row.size === "number" &&
        (row.cwd === undefined || typeof row.cwd === "string") && (row.active === undefined || typeof row.active === "boolean");
      });
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async saveLocalCatalog(agent: string, rows: LocalSessionRef[], root?: string): Promise<void> {
    const summaries = rows.map(({ id, title, path, cwd, size, updatedAt, active, parentSessionId }) =>
      ({ id, agent, title, path, cwd, size, updatedAt, active, parentSessionId }));
    await this.writeJsonAtomic(this.catalogPath(agent), { root: root ?? null, sessions: summaries });
  }

  async getSettings(): Promise<AppSettings> {
    try {
      const raw = await fs.readFile(this.settingsPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return {
        ...readLayout(parsed),
        theme: parsed.theme === "light" ? "light" : "dark",
        language: parsed.language === "en" ? "en" : "zh-CN",
        disabledAdapters: Array.isArray(parsed.disabledAdapters)
          ? parsed.disabledAdapters.filter((v): v is string => typeof v === "string")
          : [],
        driverExecutables:
          parsed.driverExecutables && typeof parsed.driverExecutables === "object"
            ? Object.fromEntries(
                Object.entries(parsed.driverExecutables).filter(
                  ([k, v]) => typeof k === "string" && typeof v === "string" && v.trim().length > 0,
                ),
              )
            : {},
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { ...DEFAULT_SETTINGS, disabledAdapters: [], driverExecutables: {} };
      }
      throw error;
    }
  }

  async updateSettings(update: (current: AppSettings) => AppSettings): Promise<AppSettings> {
    return this.enqueue(async () => {
      const settings = update(await this.getSettings());
      await this.writeJsonAtomic(this.settingsPath, settings);
      return settings;
    });
  }

  async listSessions(): Promise<UiSession[]> {
    const state = await this.readState();
    return [...state.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getSession(id: string): Promise<UiSession | undefined> {
    this.assertSafeId(id, "/sessionId");
    const state = await this.readState();
    return state.sessions.find((session) => session.id === id);
  }

  async upsertSession(session: UiSession): Promise<UiSession> {
    this.assertSafeId(session.id, "/sessionId");
    return this.enqueue(async () => {
      const state = await this.readState();
      const index = state.sessions.findIndex((item) => item.id === session.id);
      if (index >= 0) {
        state.sessions[index] = session;
      } else {
        state.sessions.unshift(session);
      }
      await this.writeJsonAtomic(this.statePath, state);
      return session;
    });
  }

  async mutateSession(id: string, updater: (session: UiSession) => UiSession): Promise<UiSession> {
    this.assertSafeId(id, "/sessionId");
    return this.enqueue(async () => {
      const state = await this.readState();
      const index = state.sessions.findIndex((item) => item.id === id);
      if (index < 0) {
        throw new SessionError("NOT_FOUND", `/sessions/${id}`, `Session not found: ${id}`);
      }
      const next = updater(state.sessions[index]!);
      state.sessions[index] = next;
      await this.writeJsonAtomic(this.statePath, state);
      return next;
    });
  }

  async deleteSession(id: string): Promise<boolean> {
    this.assertSafeId(id, "/sessionId");
    return this.enqueue(async () => {
      const state = await this.readState();
      const before = state.sessions.length;
      state.sessions = state.sessions.filter((item) => item.id !== id);
      if (state.sessions.length === before) return false;
      await this.writeJsonAtomic(this.statePath, state);
      return true;
    });
  }

  bundlePath(bundleId: string): string {
    this.assertSafeId(bundleId, "/bundleId");
    return path.join(this.bundlesDir, bundleId);
  }

  async saveBundle(bundleId: string, artifacts: FileSet): Promise<string> {
    this.assertSafeId(bundleId, "/bundleId");
    await this.ensureDir(this.bundlesDir);
    const destination = path.join(this.bundlesDir, bundleId);
    const staging = await fs.mkdtemp(path.join(this.bundlesDir, ".staging-"));
    let committed = false;
    try {
      for (const artifact of artifacts) {
        const target = path.join(staging, ...artifact.path.split("/"));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, artifact.bytes, { flag: "wx", mode: 0o600 });
      }
      await fs.mkdir(destination);
      const entries = (await fs.readdir(staging)).filter((name) => name !== "manifest.json");
      for (const entry of [...entries, "manifest.json"]) {
        await fs.rename(path.join(staging, entry), path.join(destination, entry));
      }
      committed = true;
      return destination;
    } finally {
      if (!committed) {
        await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
      }
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async loadBundleFiles(bundleId: string): Promise<FileSet> {
    const root = this.bundlePath(bundleId);
    const files: { path: string; bytes: Uint8Array }[] = [];
    async function walk(current: string, relative: string): Promise<void> {
      const entries = (await fs.readdir(current)).sort();
      for (const entry of entries) {
        const full = path.join(current, entry);
        const rel = relative ? `${relative}/${entry}` : entry;
        const info = await fs.lstat(full);
        if (info.isSymbolicLink()) {
          throw new SessionError("INVALID_BUNDLE", rel, "Symlinks are not permitted inside a bundle");
        }
        if (info.isDirectory()) {
          await walk(full, rel);
        } else if (info.isFile()) {
          files.push({ path: rel, bytes: await fs.readFile(full) });
        }
      }
    }
    try {
      await walk(root, "");
    } catch (error) {
      if (error instanceof SessionError) throw error;
      throw new SessionError("NOT_FOUND", `/bundles/${bundleId}`, `Bundle not found: ${bundleId}`);
    }
    return files;
  }
}
