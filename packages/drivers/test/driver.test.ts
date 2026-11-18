import { describe, it, expect } from "vitest";
import { AgentDriver, type DriverPlugin, type DriverEvent } from "../src/driver.js";

const id = "11111111-1111-4111-8111-111111111111";
const plugin: DriverPlugin = { id: "sample", command: "sample", verifiedVersions: [],
  invocation: o => ({ args: [], input: o.prompt }), decoder: () => r => [r as DriverEvent] };
function execute(code: string, signal?: AbortSignal, session?: string) {
  const driver = new AgentDriver(plugin, { command: process.execPath, prefix: ["-e", code] });
  return driver.run({ cwd: process.cwd(), prompt: "测试".repeat(60000), ...(signal && { signal }), ...(session && { session }) });
}
const start = "console.log(JSON.stringify({type:'session',id:'" + id + "'}));";
const end = "console.log(JSON.stringify({type:'done'}));";
async function collect(events: AsyncIterable<DriverEvent>) {
  const all = [];
  for await (const event of events) all.push(event);
  return all;
}
describe("driver subprocess lifecycle", () => {
  it("delivers a long stdin and decodes Chinese across byte boundaries", async () => {
    const code = `process.stdin.setEncoding('utf8'); let s=''; process.stdin.on('data',c=>s+=c);
      process.stdin.on('end',()=>{ ${start}
      const b=Buffer.from(JSON.stringify({type:'text',text:s})+'\\n');const split=b.indexOf(Buffer.from('测'))+1;process.stdout.write(b.subarray(0,split));
      setTimeout(()=>{process.stdout.write(b.subarray(split)); ${end}},10); });`;
    const events = await collect(execute(code));
    expect(events).toEqual([{ type: "session", id }, { type: "text", text: "测试".repeat(60000) }, { type: "done" }]);
  });
  it("rejects partial output and nonzero exit even after a terminal record", async () => {
    for (const tail of ["", end + "process.exitCode=7;"]) {
      await expect(collect(execute("process.stdin.resume();" + start + tail))).rejects.toThrow();
    }
  });
  it("cancels a launcher and its child with inherited output pipes", async () => {
    const abort = new AbortController();
    const events = execute("require('node:child_process').spawn(process.execPath, ['-e','setTimeout(()=>{},15000)'], {stdio:'inherit'});" + start + "process.stdin.resume();", abort.signal);
    expect((await events.next()).value).toEqual({ type: "session", id });
    abort.abort();
    await expect(events.next()).rejects.toThrow("cancelled");
  });
  it("rejects a mismatched resume and terminates on abort", async () => {
    await expect(collect(execute(start + end, undefined, id.replace(/^1/, "2")))).rejects.toThrow("unexpected session");
    const abort = new AbortController();
    const events = execute(start + "setInterval(()=>{},1000)", abort.signal);
    expect((await events.next()).value).toEqual({ type: "session", id });
    abort.abort();
    await expect(events.next()).rejects.toThrow("cancelled");
  });
});
