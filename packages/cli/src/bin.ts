#!/usr/bin/env node
import { runCli } from "./index.js";
import { defaultIO } from "./protocol-cli.js";

const controller = new AbortController();
const interrupt = () => controller.abort();
process.once("SIGINT", interrupt);
try { process.exitCode = await runCli(process.argv.slice(2), text => console.log(text), { ...defaultIO, signal: controller.signal }); }
catch (error) { console.error(error instanceof Error ? error.message : "CLI failed"); process.exitCode = 1; }
finally { process.removeListener("SIGINT", interrupt); }
