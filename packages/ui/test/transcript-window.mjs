// Run with pnpm --filter @coverse/ui exec electron test/transcript-window.mjs after building.
import { app, BrowserWindow, ipcMain, screen } from "electron";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { AgentDriver, DriverRegistry } from "@coverse/drivers";
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
  const fixtureFile = path.join(root, "sample.jsonl");
  const fixture = await fs.readFile(path.resolve(ui, "../../fixtures/codex/rollout-2026-11-17/sample.jsonl"),"utf8");
  const records = fixture.trim().split("\n").map(line => JSON.parse(line));
  records[0].payload.cwd = root;
  await fs.writeFile(fixtureFile,records.map(record => JSON.stringify(record)).join("\n"));
  const nativeId = "11111111-2222-4333-8444-555555555555";
  const catalog = ["good","broken"].map(id => ({id,agent:"codex",title:id,cwd:root,
    path:id === "good" ? fixtureFile : path.join(root,"missing.jsonl"),size:100,updatedAt:new Date().toISOString()}));
  class WindowDriver extends AgentDriver {
    async probe() {return {id:this.id,available:true,version:"fixture",executablePath:this.plugin.command,verifiedVersions:[],verifiedCapabilities:[]};}
    async *run({prompt}) {
      if (prompt === "fail this send") throw Error("Window fixture send failed");
      yield {type:"session",id:nativeId};
      if (prompt === "stream fixture") {
        for (let i=0;i<30;i++) {
          yield {type:"text",text:"Streaming paragraph " + i + "\n\n"};
          await new Promise(resolve => setTimeout(resolve,55));
        }
      } else yield {type:"text",text:"Ready"};
      yield {type:"done"};
    }
  }
  const drivers = new DriverRegistry();
  for (const id of ["codex","claude-code"]) drivers.register(new WindowDriver({id,command:id === "codex" ? "codex" : "claude",
    listLocalSessions:async () => id === "codex" ? catalog : [],resumeArgs:id => ["--resume",id]}));
  const service = new UiService(createAdapterRegistry(), drivers, store, root);
  const at = new Date().toISOString();
  const session = {id: "test-session", agent: "codex", cwd: root, title: "Window fixture", createdAt: at, updatedAt: at};
  await store.upsertSession({...session, messages: [
    {id:"parent",role:"user",content:"Choose a path",createdAt:at,historical:true,lineage:{branchId:"main"},childBranch:"left"},
    {id:"left",role:"assistant",content:"Child reply",createdAt:at,historical:true,lineage:{branchId:"left",parentId:"parent",subsession:true}},
    {id:"right",role:"assistant",content:"Second fork",createdAt:at,historical:true,lineage:{branchId:"right",parentId:"parent"}},
    {id: "u", role: "user", createdAt: at, content: "<instruction> [source](<two lines.md:2>) [moved](missing.md#L1-L2)",
      reviews:[{path:"two lines.md",comment:"Recheck this line",selections:[{side:"modified",text:"second line",start:1}]}],
      assets:[{location:"embedded",value:pixel,label:"Screenshot",mediaType:"image/png"},
        {location:"project",value:"review.pdf",mediaType:"application/pdf"},
        {location:"project",value:"clip.webm",mediaType:"video/webm",sourceUri:"file:///original/clip.webm"},
        {location:"text",value:"# Acceptance\n\n![Recorded verification](clip.webm)",mediaType:"text/markdown",
          label:"Walkthrough",sourceUri:"file:///original/walkthrough.md"}]},
    {id: "a", role: "assistant", agent: "codex", createdAt: at, content: "[source](two%20lines.md#L2)\n\n" +
      '::code-comment{title="Check line" body="Recorded finding" file="two lines.md" start=2 end=2}',
      tools:[{id:"call",name:"Read",state:"completed",argumentsText:'{"path":"two lines.md"}',
        results:[{text:"Recorded tool output"}],timestamp:at}],
      changedFiles: [{path:"two lines.md", added:1, removed:1, patches:["@@ -2 +2 @@\n-deleted historical line\n+added historical line"]}]},
    {id:"p",role:"assistant",agent:"codex",createdAt:at,content:"Review the change",
      changedFiles:[{path:"two lines.md",added:1,removed:0,patches:["@@ -1,0 +2 @@\n+later edit"]},
        {path:"deleted.txt",added:0,removed:1,patches:["@@ -1 +0,0 @@\n-removed file"]}],
      reviews:[{path:"deleted.txt",comment:"Original only",selections:[{side:"original",start:1,text:"removed file"}]}],
      relatedSessions:[{kind:"child",id:"linked-fixture",label:"Linked session"}],
      model:"model-test",durationMs:350,usage:{input:7,output:3,reasoning:1},usageScope:"request",
      sources:[{url:"https://example.org/fixture",title:"Recorded source"}],
      plan:{text:"Review the change",steps:[{title:"Run tests",status:"completed"}]},
      before:[{id:"checkpoint",kind:"compaction",text:"Recorded summary boundary"}]},
  ]});
  registerIpcHandlers(ipcMain, service, {pickDirectory: async () => null, pickSessionFiles: async () => [],
    locateFile:async () => path.join(root,"two lines.md")});
  await store.upsertSession({...session,id:"partial",targetSessionId:"linked-fixture",title:"Partial fixture",messages:[
    {id:"available",role:"user",content:"Kept part",createdAt:at,historical:true},
  ],readOnly:[{code:"MISSING_ATTACHMENT",path:"full.log",message:"Missing companion full.log",severity:"warning"}]});
  win = new BrowserWindow({width:1280,height:820,show: false, webPreferences: {
    preload: path.join(ui, "dist/preload/index.cjs"), sandbox: true, contextIsolation: true, backgroundThrottling:false,
  }});
  if (process.env.COVERSE_WINDOW_CAPTURE === "1") win.showInactive();
  console.log("Windows display scale:",screen.getPrimaryDisplay().scaleFactor);
  await win.loadFile(path.join(ui, "dist/renderer/index.html"));
  let externalLink;
  win.webContents.setWindowOpenHandler(({url}) => {externalLink = url;return {action:"deny"};});
  async function exercise(id) {
    return win.webContents.executeJavaScript('(' + (async function (id, sessionId) {
      async function find(selector) {
        for (let i = 0; i < 150; i++) {
          const el = document.querySelector(selector);
          if (el) return el;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error("Missing " + selector + " · " + document.body.innerText.slice(-1400));
      }
      (await find('[data-testid="session-item-' + sessionId + '"]')).click();
      (await find('[data-testid="message-' + id + '"] button[title="two lines.md"]')).click();
      const line = await find('[data-file-line="2"]');
      const value = line.textContent;
      (await find('[data-testid="close-file-panel"]')).click();
      return value;
    }).toString() + ')(' + JSON.stringify(id) + ',' + JSON.stringify(session.id) + ')');
  }
  assert.match(await exercise("user-u"), /second line/);
  assert.match(await exercise("assistant-a"), /second line/);
  const branch = await win.webContents.executeJavaScript('(' + (async () => {
    if (document.getElementById("timeline-left") || !document.getElementById("timeline-right")) throw new Error("Wrong initial branch");
    const picker = document.querySelector('[aria-label="浏览历史分支"]');
    document.getElementById("timeline-parent").querySelector("button").click();
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (picker.value !== "left") throw new Error("Child trajectory did not open");
    document.getElementById("timeline-left").querySelector("button").click();
    await new Promise(resolve => requestAnimationFrame(resolve));
    return [document.activeElement.id,!!document.getElementById("timeline-right")];
  }).toString() + ')()');
  assert.deepEqual(branch,["timeline-parent",false]);
  const plan = await win.webContents.executeJavaScript('document.querySelector(\'[data-testid="message-assistant-p"]\').innerText');
  assert.match(plan,/Run tests/);
  assert.match(plan,/已完成/);
  assert.equal(plan.split("Review the change").length,2);
  assert.match(plan,/model-test/); assert.match(plan,/350 ms/); assert.match(plan,/最近请求用量/); assert.match(plan,/推理 1/);
  await win.webContents.executeJavaScript('document.querySelector(\'a[href="https://example.org/fixture"]\').click()');
  assert.equal(externalLink,"https://example.org/fixture");
  const summary = await win.webContents.executeJavaScript('(' + (() => {
    const details = document.querySelector('[data-testid="message-assistant-p"]').parentElement.querySelector("details");
    details.querySelector("summary").click();
    return details.innerText;
  }).toString() + ')()');
  assert.match(summary,/Recorded summary boundary/);
  const finding = await win.webContents.executeJavaScript('(' + (async () => {
    const card = document.querySelector('[data-testid="message-assistant-a"] section');
    if (!card?.textContent.includes("Recorded finding")) throw new Error("Missing review finding");
    card.querySelector("button").click();
    for (let i=0; i<100; i++) {
      const line = document.querySelector('[data-testid="file-panel"] [data-file-line="2"]');
      if (line) {
        document.querySelector('[data-testid="close-file-panel"]').click();
        return line.textContent;
      }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error("Review finding link did not open");
  }).toString() + ')()');
  assert.match(finding, /second line/);
  console.log("Verified file and line navigation from both message roles in Electron");
  const diff = await win.webContents.executeJavaScript('(' + (async () => {
    document.querySelector('[data-testid="message-assistant-a"] .cv-change-row button').click();
    for (let i=0; i<100; i++) {
      const lines = document.querySelectorAll(".cv-diff .diff-cell code");
      if (lines.length) return [...lines].map(line => line.textContent);
      await new Promise(resolve => setTimeout(resolve,30));
    }
    throw new Error("Historical diff did not open");
  }).toString() + ')()');
  assert.deepEqual(diff, ["@@ -2 +2 @@","-deleted historical line","+added historical line"]);
  if (process.env.COVERSE_WINDOW_CAPTURE === "1") {
    await new Promise(resolve => setTimeout(resolve,200));
    await fs.writeFile(path.join(root,"historical-diff.png"),(await win.webContents.capturePage()).toPNG());
    console.log("Window capture directory:",root);
  }
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
      const highlighted = document.querySelector('[data-testid="file-panel"] [data-file-line="2"]');
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
        const problem = document.querySelector('[data-testid="file-panel"] [role="alert"]');
        if (problem) throw new Error(problem.textContent);
        await new Promise(resolve => setTimeout(resolve,30));
      }
      throw new Error("Missing " + selector);
    }
    const close = () => document.querySelector('[data-testid="close-file-panel"]').click();
    close();
    (await find('button[title="Screenshot"]')).click();
    const image = await find('[data-testid="file-panel"] img');
    await image.decode();
    if (image.naturalWidth !== 1) throw new Error("Image did not decode");
    close();
    (await find('button[title="review.pdf"]')).click();
    const first = await find('canvas[data-rendered-page="1"]');
    const size = first.height;
    document.querySelector('[data-testid="file-panel"] nav button:last-child').click();
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
    document.querySelector('[data-testid="close-file-panel"]').click();
    document.querySelector('button[title="Walkthrough"]').click();
    for (let i=0; i<100; i++) {
      const doc = document.querySelector('[data-testid="file-panel"] .cv-prose');
      if (doc?.querySelector("h1")?.textContent === "Acceptance") {
        doc.querySelector('button[title="clip.webm"]').click();
        break;
      }
      await new Promise(resolve => setTimeout(resolve,30));
    }
    for (let i=0; i<150; i++) {
      const media = document.querySelector('[data-testid="file-panel"] video');
      if (media?.videoWidth) return media.videoWidth;
      await new Promise(resolve => setTimeout(resolve,30));
    }
    throw new Error("Recording did not load: " + (document.querySelector('[data-testid="file-panel"]')?.innerText ?? "panel closed"));
  }).toString() + ')()');
  assert.equal(width,48);
  await win.webContents.executeJavaScript(`document.querySelector('[data-testid=message-user-u] button[title="review.pdf"]').click()`);
  await until(`!!document.querySelector('canvas[data-rendered-page="2"]')`);
  console.log("Verified opening a generated WebM recording in Electron");
  const located = await win.webContents.executeJavaScript('(' + (async () => {
    document.querySelector('[data-testid="close-file-panel"]').click();
    document.querySelector('button[title="missing.md"]').click();
    for (let i=0; i<100; i++) {
      const button = [...document.querySelectorAll('[data-testid="file-panel"] button')].find(el => el.textContent === "选择本机文件");
      if (button) {button.click();break;}
      await new Promise(resolve => setTimeout(resolve,30));
    }
    for (let i=0; i<100; i++) {
      const selected = document.querySelector('[data-file-line="1"]');
      if (selected) return selected.textContent;
      await new Promise(resolve => setTimeout(resolve,30));
    }
    throw new Error("Moved file did not open");
  }).toString() + ')()');
  assert.match(located,/first line\nsecond line/);
  const partial = await win.webContents.executeJavaScript('(' + (async () => {
    document.querySelector('[data-testid="close-file-panel"]').click();
    document.querySelector('button[title="linked-fixture"]').click();
    for (let i=0;i<100 && !document.body.innerText.includes("Missing companion full.log");i++) {
      await new Promise(resolve => setTimeout(resolve,30));
    }
    return [document.body.innerText.includes("Missing companion full.log"),!!document.querySelector('[data-testid="composer"]')];
  }).toString() + ')()');
  assert.deepEqual(partial,[true,false]);
  async function until(script) {
    for (let i=0;i<100;i++) {
      if (await win.webContents.executeJavaScript(script)) return;
      await new Promise(resolve => setTimeout(resolve,30));
    }
    const state = await win.webContents.executeJavaScript("(() => {const el = document.querySelector('[data-testid=thread-view]');return JSON.stringify([el?.scrollTop,el?.clientHeight,el?.scrollHeight,document.body.innerText.slice(-700)])})()");
    throw Error("Timed out: " + script + " " + state);
  }
  const js = async script => {
    try {return await win.webContents.executeJavaScript(script);}
    catch (cause) {
      const screen = await win.webContents.executeJavaScript("document.body.innerText.slice(-800)");
      throw new Error(script + " · " + screen,{cause});
    }
  };
  await js("document.querySelector('[data-testid=session-item-test-session]').click()");
  await js("document.querySelector('[data-testid=inspector-toggle-btn]').click()");
  await until("!!document.querySelector('[data-testid=file-panel]')");
  await js("document.querySelector('.cv-file-tabs > button').click()");
  await js("document.querySelector('.cv-file-switch button:last-child').click()");
  await until(`!!document.querySelector('.cv-tree button[title="review.pdf"]')`);
  await js("document.querySelector('.cv-divider.left').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
  await js("document.querySelector('.cv-divider.right').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))");
  await until("window.coverse.getSettings().then(r => r.data.leftWidth === 256 && r.data.rightWidth === 436)");
  win.setSize(860,580);
  await until("document.querySelector('.cv-file-dock')?.dataset.overlay === 'true'");
  win.webContents.setZoomFactor(1.25);
  await until("document.querySelector('[data-testid=topbar]').getBoundingClientRect().right <= innerWidth + 1");
  win.webContents.setZoomFactor(1);
  win.setSize(1280,820);
  await until("document.querySelector('.cv-file-dock')?.dataset.overlay === 'false'");
  await win.webContents.loadFile(path.join(ui,"dist/renderer/index.html"));
  await until("!!document.querySelector('[data-testid=session-item-test-session]')");
  await js("document.querySelector('[data-testid=session-item-test-session]').click()");
  await until("document.querySelector('.cv-divider.right')?.getAttribute('aria-valuenow') === '436'");
  await clickChange("[data-testid=message-assistant-a] .cv-change-row button","added historical line");
  await clickChange("[data-testid=message-assistant-p] .cv-change-row button","later edit");
  assert.equal(await js("document.querySelectorAll('.cv-file-tabs [title=\"two lines.md\"]').length"),2);
  await clickChange("[data-testid=message-assistant-p] section:last-of-type > div button","removed file");
  await until("!!document.querySelector('.diff-remove[data-selected]')");
  if (process.env.COVERSE_WINDOW_CAPTURE === "1") {
    win.focus();
    win.webContents.debugger.attach("1.3");
    try {
      for (const [side,delta] of [["left",24],["right",-24]]) {
        const {x,y,width} = await js(`(() => {
          const el = document.querySelector('.cv-divider.${side}');
          const rect = el.getBoundingClientRect(), x=Math.floor(rect.x+rect.width/2), y=Math.floor(rect.y+70);
          if (document.elementFromPoint(x,y) !== el) throw Error("Divider is obscured");
          return {x,y,width:Number(el.getAttribute("aria-valuenow"))};
        })()`);
        const mouse = event => win.webContents.debugger.sendCommand("Input.dispatchMouseEvent",event);
        await mouse({type:"mousePressed",x,y,button:"left",buttons:1,clickCount:1});
        await mouse({type:"mouseMoved",x:x+delta,y,buttons:1});
        await mouse({type:"mouseReleased",x:x+delta,y,button:"left",buttons:0,clickCount:1});
        const expected = width + Math.abs(delta);
        await until(`Math.abs(Number(document.querySelector('.cv-divider.${side}').getAttribute('aria-valuenow')) - ${expected}) <= 1`);
      }
    } finally { win.webContents.debugger.detach(); }
    console.log("Verified native pointer dragging on both dividers");
  }
  async function clickChange(selector,needle) {
    await js("document.querySelector(" + JSON.stringify(selector) + ").click()");
    await until("document.querySelector('.cv-diff')?.innerText.includes(" + JSON.stringify(needle) + ")");
  }
  const input = async (selector,value) => js(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),"value").set.call(el,${JSON.stringify(value)});
    el.dispatchEvent(new Event("input",{bubbles:true}));
  })()`);
  const click = selector => js("document.querySelector(" + JSON.stringify(selector) + ").click()");
  await click('[data-testid="close-file-panel"]');
  await input('[data-testid="composer-input"]',"draft for window fixture");
  await click('[data-testid="sidebar-new-btn"]');
  await until("document.querySelector('[data-testid=composer-input]')?.value === ''");
  await click('[data-testid="session-item-test-session"]');
  await until("document.querySelector('[data-testid=composer-input]')?.value === 'draft for window fixture'");
  await click('[data-testid="sidebar-settings-btn"]');
  await click('[data-testid="settings-nav-adapters"]');
  await click('[data-testid="adapter-card-codex"] summary');
  assert.match(await js("document.querySelector('[data-testid=adapter-card-codex]').innerText"),/0\.0\.0/);
  await click('[data-testid="settings-back-btn"]');
  await until("document.querySelector('[data-testid=composer-input]')?.value === 'draft for window fixture'");
  await input('[data-testid="composer-input"]',"fail this send");
  await click('[data-testid="composer-send-btn"]');
  await until("document.body.innerText.includes('Window fixture send failed') && document.querySelector('[data-testid=composer-input]').value === 'fail this send'");
  await input('[data-testid="composer-input"]',"stream fixture");
  await js("document.querySelector('[data-testid=composer-input]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true}))");
  assert.equal(await js("document.querySelector('[data-testid=composer-input]').value"),"stream fixture");
  await click('[data-testid="composer-send-btn"]');
  await until("!!document.querySelector('[data-testid=streaming-message]')");
  await until("document.querySelector('[data-testid=thread-view]').scrollTop > 80");
  await js("document.querySelector('[data-testid=thread-view]').scrollTop=0");
  await until("!!document.querySelector('.cv-jump')");
  await until("!document.querySelector('[data-testid=streaming-message]')");
  assert.ok(await js("document.querySelector('[data-testid=thread-view]').scrollTop < 20"));
  await click(".cv-jump");
  console.log("Verified conversation drafts, failed send, IME input and scroll during streaming");
  await click('[data-testid="sidebar-import-btn"]');
  await until("!!document.querySelector('[data-testid=local-session-broken]')");
  await click('[data-testid="local-session-broken"]');
  await click('[data-testid="local-session-good"]');
  await js("const sel=document.querySelector('[data-testid=import-dialog] footer select');sel.value='claude-code';sel.dispatchEvent(new Event('change',{bubbles:true}))");
  await click('[data-testid="import-dialog"] footer button');
  await until("document.querySelectorAll('.cv-batch-result').length === 2");
  assert.equal(await js("document.querySelectorAll('.cv-batch-result button').length"),2);
  await js("[...document.querySelectorAll('.cv-batch-result')].find(el=>el.querySelector('strong').textContent==='good').querySelector('button').click()");
  await until("!!document.querySelector('[data-testid=native-command]')");
  assert.match(await js("document.querySelector('[data-testid=native-command]').innerText"),/claude --resume 1111/);
  if (process.env.COVERSE_WINDOW_CAPTURE === "1") {
    await new Promise(resolve => setTimeout(resolve,200));
    await fs.writeFile(path.join(root,"native-handoff.png"),(await win.webContents.capturePage()).toPNG());
  }
  await js("document.querySelector('[data-testid=inspector-tab-files]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
  await until("document.querySelector('[data-testid=inspector-tab-files]').getAttribute('aria-selected') === 'true'");
  await until("!!document.querySelector('[data-testid=inspector-drawer] li button')");
  await click('[data-testid="inspector-drawer"] li button');
  await until("!!document.querySelector('[data-testid=file-panel] .cv-file-heading')");
  await js("[...document.querySelectorAll('[data-testid=file-panel] button')].find(el=>el.textContent.includes('返回交接详情')).click()");
  assert.equal(await js("document.querySelector('[data-testid=inspector-tab-files]').getAttribute('aria-selected')"),"true");
  await click('[data-testid="sidebar-settings-btn"]');
  await click('[data-testid="theme-light"]');
  await click('[data-testid="lang-en"]');
  await until("document.documentElement.lang === 'en' && !document.documentElement.classList.contains('dark')");
  await click('[data-testid="settings-nav-adapters"]');
  await click('[data-testid="adapter-card-codex"] summary');
  await until("document.querySelector('[data-testid=adapter-card-codex]').innerText.includes('Verified session formats')");
  await click('[data-testid="adapter-toggle-codex"]');
  await until("document.querySelector('[data-testid=adapter-toggle-codex]').getAttribute('aria-checked') === 'false'");
  if (process.env.COVERSE_WINDOW_CAPTURE === "1") {
    await new Promise(resolve => setTimeout(resolve,200));
    await fs.writeFile(path.join(root,"adapter-settings.png"),(await win.webContents.capturePage()).toPNG());
  }
  console.log("Verified mixed batch import, native continuation command, ledger and archive navigation");
  console.log("Verified directory browsing, keyboard resizing, compact layout, zoom and persisted widths");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  win?.destroy();
  app.exit(process.exitCode ?? 0);
}
}).catch(error => { console.error(error); app.exit(1); });
