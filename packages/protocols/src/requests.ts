import type { JsonValue, ProtocolRequest, ProtocolTool } from "@coverse/core";
import { ConversionContext, type ProtocolId } from "./contracts.js";
import { decodeMessages, encodeMessages } from "./messages.js";
import { array, boolean, fields, literal, nonempty, number, object, string, validateHistory, type Obj } from "./validation.js";

export function decodeRequest(input: unknown, id: ProtocolId, c: ConversionContext): ProtocolRequest {
  const o = object(input, c, "/");
  fields(o, ["model", "tools", "temperature", "top_p", "stream", "tool_choice", ...(id === "responses" ? ["input", "instructions", "max_output_tokens", "parallel_tool_calls", "text"] : id === "chat-completions" ? ["messages", "max_tokens", "max_completion_tokens", "parallel_tool_calls", "stop", "response_format"] : ["messages", "system", "max_tokens", "stop_sequences", "output_config"])], c, "");
  const result: ProtocolRequest = { schemaVersion: "1.0", model: nonempty(o.model, c, "/model"), messages: decodeMessages(o, id, c), tools: [], parameters: {} };
  validateHistory(result.messages, c);
  const p = result.parameters;
  if (o.temperature !== undefined) p.temperature = number(o.temperature, c, "/temperature");
  if (o.top_p !== undefined) p.topP = number(o.top_p, c, "/top_p");
  if (o.stream !== undefined) p.stream = boolean(o.stream, c, "/stream");
  if (o.parallel_tool_calls !== undefined) p.parallelTools = boolean(o.parallel_tool_calls, c, "/parallel_tool_calls");
  const tokenKey = id === "responses" ? "max_output_tokens" : id === "chat-completions" && o.max_completion_tokens !== undefined ? "max_completion_tokens" : "max_tokens";
  if (o.max_tokens !== undefined && o.max_completion_tokens !== undefined) c.fail("INVALID_INPUT", "/max_tokens", "Conflicting output limits");
  if (o[tokenKey] !== undefined) {
    const value = number(o[tokenKey], c, `/${tokenKey}`);
    if (!Number.isSafeInteger(value) || value <= 0) c.fail("INVALID_INPUT", `/${tokenKey}`, "Token limit must be a positive integer");
    p.tokenLimit = { value, semantics: tokenKey === "max_tokens" && id === "chat-completions" ? "legacy-output" : "completion" };
  } else if (id === "anthropic-messages") c.fail("INVALID_INPUT", "/max_tokens", "Anthropic requests require max_tokens");
  const stopKey = id === "anthropic-messages" ? "stop_sequences" : "stop";
  if (o[stopKey] !== undefined) p.stop = typeof o[stopKey] === "string" ? [o[stopKey] as string] : array(o[stopKey], c, `/${stopKey}`).map((v, i) => string(v, c, `/${stopKey}/${i}`));
  if (o.tools !== undefined) result.tools = array(o.tools, c, "/tools").flatMap((v, i): ProtocolTool[] => {
    const path = `/tools/${i}`; let t = object(v, c, path);
    if (id !== "anthropic-messages") {
      if (t.type !== "function") { c.unsupported(path, v, "Only function tools are supported"); return []; }
      if (id === "chat-completions") { fields(t, ["type", "function"], c, path); t = object(t.function, c, path + "/function"); }
    }
    fields(t, ["name", "description", "strict", id === "anthropic-messages" ? "input_schema" : "parameters", ...(id === "responses" ? ["type"] : [])], c, path);
    const schema = t[id === "anthropic-messages" ? "input_schema" : "parameters"];
    object(schema, c, path + "/parameters");
    return [{ name: nonempty(t.name, c, path + "/name"), parameters: schema!, ...(t.description !== undefined ? { description: string(t.description, c, path + "/description") } : {}), ...(t.strict !== undefined ? { strict: boolean(t.strict, c, path + "/strict") } : {}) }];
  });
  if (new Set(result.tools.map(t => t.name)).size !== result.tools.length) c.fail("INVALID_INPUT", "/tools", "Duplicate tool names");
  if (o.tool_choice !== undefined) {
    if (typeof o.tool_choice === "string") { literal(o.tool_choice, ["auto", "none", "required"], c, "/tool_choice"); p.toolChoice = o.tool_choice as "auto" | "none" | "required"; }
    else {
      const t = object(o.tool_choice, c, "/tool_choice");
      if (id === "anthropic-messages") {
        fields(t, ["type", "name", "disable_parallel_tool_use"], c, "/tool_choice");
        literal(t.type, ["auto", "any", "tool", "none"], c, "/tool_choice/type");
        p.toolChoice = t.type === "tool" ? { name: nonempty(t.name, c, "/tool_choice/name") } : t.type === "any" ? "required" : t.type as "auto" | "none";
        if (t.disable_parallel_tool_use !== undefined) p.parallelTools = !boolean(t.disable_parallel_tool_use, c, "/tool_choice/disable_parallel_tool_use");
        if (t.name !== undefined && t.type !== "tool") c.fail("INVALID_INPUT", "/tool_choice/name", "Name only applies to a selected tool");
      } else {
        fields(t, id === "responses" ? ["type", "name"] : ["type", "function"], c, "/tool_choice"); literal(t.type, ["function"], c, "/tool_choice/type");
        const f = id === "responses" ? t : object(t.function, c, "/tool_choice/function");
        if (id !== "responses") fields(f, ["name"], c, "/tool_choice/function");
        p.toolChoice = { name: nonempty(f.name, c, "/tool_choice/name") };
      }
    }
  }
  if (typeof p.toolChoice === "object" && !result.tools.some(t => t.name === (p.toolChoice as {name:string}).name)) c.fail("INVALID_INPUT", "/tool_choice", "Selected tool is not defined");
  let format: JsonValue | undefined;
  if (id === "responses" && o.text !== undefined) { const t = object(o.text, c, "/text"); fields(t, ["format"], c, "/text"); format = t.format; }
  if (id === "anthropic-messages" && o.output_config !== undefined) { const t = object(o.output_config, c, "/output_config"); fields(t, ["format"], c, "/output_config"); format = t.format; }
  if (id === "chat-completions") format = o.response_format;
  if (format !== undefined) {
    let f = object(format, c, "/format");
    if (f.type !== "json_schema") c.fail("UNSUPPORTED_CAPABILITY", "/format/type", "Only JSON Schema output format is supported");
    if (id === "chat-completions") { fields(f, ["type", "json_schema"], c, "/response_format"); f = object(f.json_schema, c, "/response_format/json_schema"); }
    fields(f, id === "anthropic-messages" ? ["type", "schema"] : ["type", "name", "schema", "strict"], c, "/format");
    object(f.schema, c, "/format/schema");
    p.outputFormat = { type: "json_schema", name: id === "anthropic-messages" ? "response" : nonempty(f.name, c, "/format/name"), schema: f.schema!, ...(f.strict !== undefined ? { strict: boolean(f.strict, c, "/format/strict") } : id === "anthropic-messages" ? { strict: true } : {}) };
  }
  return result;
}

export function encodeRequest(r: ProtocolRequest, id: ProtocolId, c: ConversionContext): JsonValue {
  validateHistory(r.messages, c);
  const o: Obj = { model: c.options.targetModel ?? r.model, ...encodeMessages(r.messages, id, c) }; const p = r.parameters;
  if (p.temperature !== undefined) o.temperature = p.temperature;
  if (p.topP !== undefined) o.top_p = p.topP;
  if (p.stream !== undefined) o.stream = p.stream;
  if (p.stop !== undefined) {
    if (id === "responses") c.unsupported("/parameters/stop", p.stop, "Responses does not expose stop sequences");
    else o[id === "anthropic-messages" ? "stop_sequences" : "stop"] = p.stop;
  }
  const override = c.options.maxOutputTokens;
  if (override !== undefined && (!Number.isSafeInteger(override) || override <= 0)) c.fail("INVALID_INPUT", "/maxOutputTokens", "Token limit must be a positive integer");
  if (p.tokenLimit?.semantics === "legacy-output" && id !== "chat-completions" && override === undefined) c.fail("UNSUPPORTED_CAPABILITY", "/parameters/tokenLimit", "Legacy output limit differs from completion budget; specify maxOutputTokens");
  if (override !== undefined && p.tokenLimit && override !== p.tokenLimit.value) c.preserve("/parameters/tokenLimit", p.tokenLimit as unknown as JsonValue, "Explicit caller output-limit override");
  const limit = override ?? p.tokenLimit?.value;
  if (limit !== undefined) o[id === "responses" ? "max_output_tokens" : id === "anthropic-messages" || (p.tokenLimit?.semantics === "legacy-output" && override === undefined) ? "max_tokens" : "max_completion_tokens"] = limit;
  else if (id === "anthropic-messages") c.fail("MISSING_PARAMETER", "/max_tokens", "Target requires an explicit output token limit");
  if (r.tools.length) o.tools = r.tools.map(t => {
    const f: Obj = { name: t.name, [id === "anthropic-messages" ? "input_schema" : "parameters"]: t.parameters, ...(t.description !== undefined ? { description: t.description } : {}), ...(t.strict !== undefined ? { strict: t.strict } : {}) };
    return id === "chat-completions" ? { type: "function", function: f } : id === "responses" ? { type: "function", ...f } : f;
  });
  if (p.toolChoice !== undefined || p.parallelTools !== undefined && id === "anthropic-messages") {
    const choice = p.toolChoice ?? "auto";
    if (id === "anthropic-messages") o.tool_choice = { type: typeof choice === "object" ? "tool" : choice === "required" ? "any" : choice, ...(typeof choice === "object" ? { name: choice.name } : {}), ...(p.parallelTools !== undefined ? { disable_parallel_tool_use: !p.parallelTools } : {}) };
    else o.tool_choice = typeof choice === "object" ? id === "responses" ? { type: "function", name: choice.name } : { type: "function", function: { name: choice.name } } : choice;
  }
  if (p.parallelTools !== undefined && id !== "anthropic-messages") o.parallel_tool_calls = p.parallelTools;
  if (p.outputFormat) {
    const f = p.outputFormat;
    if (id === "anthropic-messages") {
      if (f.strict === false) c.fail("UNSUPPORTED_CAPABILITY", "/parameters/outputFormat/strict", "Anthropic JSON output cannot promise non-strict schema behavior");
      c.preserve("/parameters/outputFormat/name", f.name, "Schema label retained in report; target schema is unnamed");
      o.output_config = { format: { type: "json_schema", schema: f.schema } };
    } else {
      const schema = { name: f.name, schema: f.schema, ...(f.strict !== undefined ? { strict: f.strict } : {}) };
      if (id === "responses") o.text = { format: { type: "json_schema", ...schema } };
      else o.response_format = { type: "json_schema", json_schema: schema };
    }
  }
  return o;
}
