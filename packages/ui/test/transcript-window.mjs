// Run with pnpm --filter @coverse/ui exec electron test/transcript-window.mjs after building.
import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DriverRegistry } from "@coverse/drivers";
import { createAdapterRegistry, registerIpcHandlers, UiService, UiStore } from "../dist/main/core.js";

const ui = path.resolve(import.meta.dirname, "..");
const tmp = path.resolve(ui, "../../.tmp");
await fs.mkdir(tmp, {recursive: true});
const root = await fs.mkdtemp(path.join(tmp, "transcript-window-"));
app.setPath("userData", path.join(root, "profile"));
app.whenReady().then(async () => {
let win;
try {
  await fs.writeFile(path.join(root, "two lines.md"), "first line\nsecond line");
  const store = new UiStore(path.join(root, "state"));
  const service = new UiService(createAdapterRegistry(), new DriverRegistry(), store, root);
  const at = new Date().toISOString();
  const session = {id: "test-session", agent: "codex", cwd: root, title: "Window fixture", createdAt: at, updatedAt: at};
  await store.upsertSession({...session, messages: [
    {id: "u", role: "user", createdAt: at, content: "<instruction> [source](<two lines.md:2>)",
      reviews:[{path:"two lines.md",comment:"Recheck this line",selections:[{side:"modified",text:"second line",start:1}]}]},
    {id: "a", role: "assistant", agent: "codex", createdAt: at, content: "[source](two%20lines.md#L2)",
      changedFiles: [{path:"two lines.md", added:1, removed:1, patches:["@@ -2 +2 @@\n-deleted historical line\n+added historical line"]}]},
  ]});
  registerIpcHandlers(ipcMain, service, {pickDirectory: async () => null, pickSessionFiles: async () => []});
  win = new BrowserWindow({show: false, webPreferences: {
    preload: path.join(ui, "dist/preload/index.cjs"), sandbox: true, contextIsolation: true,
  }});
  await win.loadFile(path.join(ui, "dist/renderer/index.html"));
  async function exercise(id) {
    return win.webContents.executeJavaScript('(' + (async function (id, sessionId) {
      async function find(selector) {
        for (let i = 0; i < 150; i++) {
          const el = document.querySelector(selector);
          if (el) return el;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error("Missing " + selector);
      }
      (await find('[data-testid="session-item-' + sessionId + '"]')).click();
      (await find('[data-testid="message-' + id + '"] button[title="two lines.md"]')).click();
      const line = await find('[data-file-line="2"]');
      const value = line.textContent;
      (await find('[role="dialog"] button[aria-label="Close"]')).click();
      return value;
    }).toString() + ')(' + JSON.stringify(id) + ',' + JSON.stringify(session.id) + ')');
  }
  assert.match(await exercise("user-u"), /second line/);
  assert.match(await exercise("assistant-a"), /second line/);
  console.log("Verified file and line navigation from both message roles in Electron");
  const diff = await win.webContents.executeJavaScript('(' + (() => {
    const details = document.querySelector('[data-testid="message-assistant-a"] details');
    details.querySelector("summary").click();
    if (!details.open) throw new Error("Diff remained collapsed");
    return details.querySelector("pre").innerText;
  }).toString() + ')()');
  assert.match(diff, /-deleted historical line\n\+added historical line/);
  console.log("Verified opening the historical patch in Electron");
  const reviewed = await win.webContents.executeJavaScript('(' + (async () => {
    const review = document.querySelector('[data-testid="message-user-u"] section');
    if (!review.innerText.includes("Recheck this line")) throw new Error("Review body missing");
    review.querySelector(":scope > div button").click();
    for (let i=0; i<100; i++) {
      const highlighted = document.querySelector('[role="dialog"] [data-file-line="2"]');
      if (highlighted) return highlighted.textContent;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error("Historical selection did not resolve to its new line");
  }).toString() + ')()');
  assert.match(reviewed, /second line/);
  console.log("Verified jumping from a review selection after the cited line moved");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  win?.destroy();
  app.exit(process.exitCode ?? 0);
}
}).catch(error => { console.error(error); app.exit(1); });
