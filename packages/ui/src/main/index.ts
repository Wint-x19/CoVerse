import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import type { PickedFile, ThemeMode } from "../shared/types.js";
import { createAdapterRegistry, registerIpcHandlers, UiService, UiStore, type DesktopDialogs } from "./core.js";

let mainWindow: BrowserWindow | null = null;
let service: UiService | null = null;

const isSmokeCheck = process.argv.includes("--smoke-check");

function getArgValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function resolveDataDir(): string {
  if (process.env.COVERSE_DATA_DIR) {
    return path.resolve(process.env.COVERSE_DATA_DIR);
  }
  return path.join(app.getPath("userData"), "data");
}

function resolveDefaultCwd(): string {
  if (process.env.COVERSE_CWD) {
    return path.resolve(process.env.COVERSE_CWD);
  }
  return app.isPackaged ? os.homedir() : process.cwd();
}

function applyWindowTheme(win: BrowserWindow | null, theme: ThemeMode): void {
  nativeTheme.themeSource = theme;
  if (!win || win.isDestroyed()) return;
  const bg = theme === "light" ? "#ffffff" : "#08090a";
  const symbol = theme === "light" ? "#5f6672" : "#8a8f98";
  win.setBackgroundColor(bg);
  if (process.platform !== "darwin") {
    try {
      win.setTitleBarOverlay({ color: bg, symbolColor: symbol, height: 43 });
    } catch {
      // Unsupported on some Linux window managers
    }
  }
}

function createWindow(initialTheme: ThemeMode): BrowserWindow {
  const isMac = process.platform === "darwin";
  const bg = initialTheme === "light" ? "#ffffff" : "#08090a";
  const symbol = initialTheme === "light" ? "#5f6672" : "#8a8f98";
  nativeTheme.themeSource = initialTheme;

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 580,
    backgroundColor: bg,
    show: false,
    autoHideMenuBar: true,
    title: "CoVerse",
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 15 } }
      : {
          titleBarOverlay: {
            color: bg,
            symbolColor: symbol,
            height: 43,
          },
        }),
    webPreferences: {
      preload: path.resolve(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => {
    if (!isSmokeCheck) win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  const devUrl = process.env.COVERSE_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.resolve(import.meta.dirname, "../renderer/index.html"));
  }

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  return win;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    const store = new UiStore(resolveDataDir());
    const initialSettings = await store.getSettings();
    service = new UiService(createAdapterRegistry(), null, store, resolveDefaultCwd());

    const dialogs: DesktopDialogs = {
      async pickDirectory(defaultPath?: string) {
        const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
          ...(defaultPath ? { defaultPath } : {}),
          properties: ["openDirectory"],
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0] ?? null;
      },

      async pickSessionFiles(): Promise<PickedFile[]> {
        const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
          properties: ["openFile", "multiSelections"],
          filters: [
            { name: "Agent Sessions", extensions: ["jsonl", "zst", "db"] },
            { name: "All Files", extensions: ["*"] },
          ],
        });
        if (result.canceled || result.filePaths.length === 0) return [];
        const picked: PickedFile[] = [];
        for (const filePath of result.filePaths) {
          try {
            const info = await fs.stat(filePath);
            picked.push({ path: filePath, name: path.basename(filePath), size: info.size });
          } catch {
            picked.push({ path: filePath, name: path.basename(filePath), size: 0 });
          }
        }
        return picked;
      },

      async pickExecutable(defaultPath?: string) {
        const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
          ...(defaultPath ? { defaultPath } : {}),
          properties: ["openFile"],
          ...(process.platform === "win32"
            ? {
                filters: [
                  { name: "Executables", extensions: ["exe", "cmd", "bat"] },
                  { name: "All Files", extensions: ["*"] },
                ],
              }
            : {}),
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0] ?? null;
      },

      async setWindowTheme(theme: ThemeMode) {
        applyWindowTheme(mainWindow, theme);
      },
    };

    registerIpcHandlers(ipcMain, service, dialogs);
    mainWindow = createWindow(initialSettings.theme);

    if (isSmokeCheck) {
      const fixturePath = getArgValue("--smoke-fixture");
      const consoleErrors: string[] = [];
      mainWindow.webContents.on("console-message", (event) => {
        if (event.level === "error") consoleErrors.push(event.message);
      });
      mainWindow.webContents.once("did-finish-load", () => {
        void (async () => {
          try {
            const result = await mainWindow!.webContents.executeJavaScript(
              `(async () => {
                if (!window.coverse) throw new Error("Missing window.coverse preload bridge");
                const unwrap = (env) => { if (!env || !env.ok) throw new Error(env?.error?.message || "IPC failed"); return env.data; };
                const caps = unwrap(await window.coverse.capabilities());
                const settings = unwrap(await window.coverse.getSettings());
                const local = unwrap(await window.coverse.listLocalSessions());
                let converted = null;
                const fixture = ${JSON.stringify(fixturePath ?? null)};
                if (fixture) {
                  const session = unwrap(await window.coverse.convertSource({ from: "auto", to: "codex", paths: [fixture], materialize: false }));
                  converted = { id: session.id, from: session.handoff?.from, to: session.handoff?.to, turns: session.handoff?.statistics.turns, messages: session.messages.length, losses: session.handoff?.losses };
                }
                return { platform: window.coverse.platform, theme: settings.theme, language: settings.language, adapters: caps.adapters.map(a => a.id), drivers: caps.drivers.map(d => ({ id: d.id, available: d.available, models: d.models.length })), localSessionsCount: local.length, converted };
              })()`,
            );
            if (consoleErrors.length > 0) {
              process.stderr.write(JSON.stringify({ consoleErrors }) + "\n");
              app.exit(1);
              return;
            }
            process.stdout.write(JSON.stringify({ smoke: "ok", ...result }) + "\n");
            app.exit(0);
          } catch (error) {
            process.stderr.write(String(error) + "\n");
            app.exit(1);
          }
        })();
      });
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void store.getSettings().then((s) => {
          mainWindow = createWindow(s.theme);
        });
      }
    });
  });

  app.on("before-quit", () => {
    service?.abortAll();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
