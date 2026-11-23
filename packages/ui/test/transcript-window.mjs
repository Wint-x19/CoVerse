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
  const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aZkAAAAASUVORK5CYII=";
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i,body] of ["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>"].entries()) {
    offsets.push(pdf.length);
    pdf += (i+1) + " 0 obj\n" + body + "\nendobj\n";
  }
  const xref = pdf.length;
  pdf += "xref\n0 5\n0000000000 65535 f \n" + offsets.slice(1).map(n => String(n).padStart(10,"0") + " 00000 n \n").join("")
    + "trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
  await fs.writeFile(path.join(root,"review.pdf"), pdf);
  const store = new UiStore(path.join(root, "state"));
  const service = new UiService(createAdapterRegistry(), new DriverRegistry(), store, root);
  const at = new Date().toISOString();
  const session = {id: "test-session", agent: "codex", cwd: root, title: "Window fixture", createdAt: at, updatedAt: at};
  await store.upsertSession({...session, messages: [
    {id: "u", role: "user", createdAt: at, content: "<instruction> [source](<two lines.md:2>)",
      reviews:[{path:"two lines.md",comment:"Recheck this line",selections:[{side:"modified",text:"second line",start:1}]}],
      assets:[{location:"embedded",value:pixel,label:"Screenshot",mediaType:"image/png"},
        {location:"project",value:"review.pdf",mediaType:"application/pdf"},
        {location:"project",value:"clip.webm",mediaType:"video/webm"}]},
    {id: "a", role: "assistant", agent: "codex", createdAt: at, content: "[source](two%20lines.md#L2)\n\n" +
      '::code-comment{title="Check line" body="Recorded finding" file="two lines.md" start=2 end=2}',
      tools:[{id:"call",name:"Read",state:"completed",argumentsText:'{"path":"two lines.md"}',
        results:[{text:"Recorded tool output"}],timestamp:at}],
      changedFiles: [{path:"two lines.md", added:1, removed:1, patches:["@@ -2 +2 @@\n-deleted historical line\n+added historical line"]}]},
  ]});
  registerIpcHandlers(ipcMain, service, {pickDirectory: async () => null, pickSessionFiles: async () => []});
  win = new BrowserWindow({show: false, webPreferences: {
    preload: path.join(ui, "dist/preload/index.cjs"), sandbox: true, contextIsolation: true, backgroundThrottling:false,
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
  const finding = await win.webContents.executeJavaScript('(' + (async () => {
    const card = document.querySelector('[data-testid="message-assistant-a"] section');
    if (!card?.textContent.includes("Recorded finding")) throw new Error("Missing review finding");
    card.querySelector("button").click();
    for (let i=0; i<100; i++) {
      const line = document.querySelector('[role="dialog"] [data-file-line="2"]');
      if (line) {
        document.querySelector('[role="dialog"] button[aria-label="Close"]').click();
        return line.textContent;
      }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error("Review finding link did not open");
  }).toString() + ')()');
  assert.match(finding, /second line/);
  console.log("Verified file and line navigation from both message roles in Electron");
  const diff = await win.webContents.executeJavaScript('(' + (() => {
    const details = [...document.querySelectorAll('[data-testid="message-assistant-a"] details')].find(el => el.querySelector("pre"));
    details.querySelector("summary").click();
    if (!details.open) throw new Error("Diff remained collapsed");
    return details.querySelector("pre").innerText;
  }).toString() + ')()');
  assert.match(diff, /-deleted historical line\n\+added historical line/);
  console.log("Verified opening the historical patch in Electron");
  const tool = await win.webContents.executeJavaScript('(' + (async () => {
    const row = document.querySelector('[data-testid="message-assistant-a"]');
    [...row.querySelectorAll("button")].find(el => el.querySelector("svg.lucide-terminal")).click();
    for (let i=0; i<100; i++) {
      const entry = [...row.querySelectorAll("summary")].find(el => el.textContent.includes("Read"));
      if (entry) {entry.click(); return entry.parentElement.querySelector("dl").innerText;}
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error("Tool details did not open");
  }).toString() + ')()');
  assert.match(tool, /two lines\.md/);
  assert.match(tool, /Recorded tool output/);
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
  const pages = await win.webContents.executeJavaScript('(' + (async () => {
    async function find(selector) {
      for (let i=0; i<200; i++) {
        const element = document.querySelector(selector);
        if (element) return element;
        const problem = document.querySelector('[role="dialog"] [role="alert"]');
        if (problem) throw new Error(problem.textContent);
        await new Promise(resolve => setTimeout(resolve,30));
      }
      throw new Error("Missing " + selector);
    }
    const close = () => document.querySelector('[role="dialog"] button[aria-label="Close"]').click();
    close();
    (await find('button[title="Screenshot"]')).click();
    const image = await find('[role="dialog"] img');
    await image.decode();
    if (image.naturalWidth !== 1) throw new Error("Image did not decode");
    close();
    (await find('button[title="review.pdf"]')).click();
    const first = await find('canvas[data-rendered-page="1"]');
    const size = first.height;
    document.querySelector('[role="dialog"] nav button:last-child').click();
    const next = await find('canvas[data-rendered-page="2"]');
    return [size,next.height];
  }).toString() + ')()');
  assert.deepEqual(pages,[150,300]);
  console.log("Verified native image decoding and both PDF pages in Electron");
  // Three synthetic 48 × 24 solid-color frames, encoded as VP8 WebM with FFmpeg.
  await fs.writeFile(path.join(root,"clip.webm"), Buffer.from(
    "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAJdEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZU"
    + "rmtTrIHWTbuMU6uEElTDZ1OsggEnTbuMU6uEHFO7a1OsggJH7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxM"
    + "YXZmNjEuMS4xMDBXQYxMYXZmNjEuMS4xMDBEiYhAXgAAAAAAABZUrmvMrgEAAAAAAABD14EBc8WIHPt0vX3ZZk6cgQAitZyDdW5k"
    + "iIEAhoVWX1ZQOIOBASPjg4QCYloA4JSwgTC6gRiagQJVsIhVt4ECVbiBAhJUw2f6c3OfY8CAZ8iZRaOHRU5DT0RFUkSHjExhdmY2"
    + "MS4xLjEwMHNz1WPAi2PFiBz7dL192WZOZ8igRaOHRU5DT0RFUkSHk0xhdmM2MS4zLjEwMCBsaWJ2cHhnyKFFo4hEVVJBVElPTkSH"
    + "kzAwOjAwOjAwLjEyMDAwMDAwMAAfQ7Z1QJvngQCjv4EAAIAwAwCdASowABgAAEcIhYWIhYSIAgICdaoD+AP6AgfG8CpwQP79bvP/"
    + "45k3MMT/jm3/8WE8DijI//FRAKOmgQAoABECAAUQrAAYDNDKXCJbkCSPWkDpr/++Agv/gIL/4E/22ACjrYEAUADxAQAFEKwAGAAc"
    + "Q/f0AGDyjCD+645f/7xkq/8ZKv/Gf/L7+RMSPSSEABxTu2uRu4+zgQC3iveBAfGCAabwgQM=", "base64"));
  const width = await win.webContents.executeJavaScript('(' + (async () => {
    document.querySelector('[role="dialog"] button[aria-label="Close"]').click();
    document.querySelector('button[title="clip.webm"]').click();
    for (let i=0; i<150; i++) {
      const media = document.querySelector('[role="dialog"] video');
      if (media?.videoWidth) return media.videoWidth;
      await new Promise(resolve => setTimeout(resolve,30));
    }
    throw new Error("Recording did not load");
  }).toString() + ')()');
  assert.equal(width,48);
  console.log("Verified opening a generated WebM recording in Electron");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  win?.destroy();
  app.exit(process.exitCode ?? 0);
}
}).catch(error => { console.error(error); app.exit(1); });
