import * as fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { SessionError } from "@coverse/core";
import type { ApiErrorEnvelope, ConvertRequest, StreamEventPayload, UploadedFilePayload } from "../shared/types.js";
import { toDiagnostic, UiService } from "./service.js";

const MAX_BODY_BYTES = 64 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function errorStatus(code: string): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "RUN_IN_PROGRESS":
      return 409;
    case "INVALID_INPUT":
    case "CLI_ARGUMENT":
    case "AMBIGUOUS_INPUT":
      return 400;
    case "UNSUPPORTED_FORMAT":
    case "UNINTERPRETED_CONTENT":
    case "MISSING_ATTACHMENT":
    case "INVALID_BUNDLE":
    case "ADAPTER_UNAVAILABLE":
    case "DRIVER_UNAVAILABLE":
      return 422;
    default:
      return 500;
  }
}

function sendError(res: ServerResponse, error: unknown, fallbackPath: string): void {
  const diagnostic = toDiagnostic(error, fallbackPath);
  const envelope: ApiErrorEnvelope = { error: diagnostic };
  sendJson(res, errorStatus(diagnostic.code), envelope);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new SessionError("INVALID_INPUT", "/body", "Request body exceeds 64 MiB limit");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SessionError("INVALID_INPUT", "/body", "Expected valid JSON request body");
  }
}

function writeSse(res: ServerResponse, event: StreamEventPayload): void {
  if (res.writableEnded) return;
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

async function serveStatic(res: ServerResponse, staticDir: string, pathname: string): Promise<boolean> {
  const normalized = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(staticDir, normalized);
  if (!resolved.startsWith(path.resolve(staticDir))) return false;
  try {
    const info = await fs.stat(resolved);
    if (info.isFile()) {
      const ext = path.extname(resolved).toLowerCase();
      const bytes = await fs.readFile(resolved);
      res.writeHead(200, {
        "content-type": MIME_TYPES[ext] ?? "application/octet-stream",
        "content-length": bytes.byteLength,
        "cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      });
      res.end(bytes);
      return true;
    }
  } catch {
    // Fall through to SPA index.html
  }
  if (!path.extname(normalized)) {
    try {
      const indexHtml = await fs.readFile(path.join(staticDir, "index.html"));
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": indexHtml.byteLength,
        "cache-control": "no-cache",
      });
      res.end(indexHtml);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export interface UiServerOptions {
  service: UiService;
  staticDir?: string;
}

export function createUiHttpServer(options: UiServerOptions): http.Server {
  const { service, staticDir } = options;

  return http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    try {
      if (pathname === "/api/health" && method === "GET") {
        sendJson(res, 200, { status: "ok", defaultCwd: service.defaultCwd });
        return;
      }

      if (pathname === "/api/capabilities" && method === "GET") {
        sendJson(res, 200, await service.getCapabilities());
        return;
      }

      if (pathname === "/api/sessions" && method === "GET") {
        sendJson(res, 200, { sessions: await service.listSessions() });
        return;
      }

      if (pathname === "/api/sessions" && method === "POST") {
        const body = await readJsonBody<{ agent?: string; model?: string; cwd?: string; title?: string }>(req);
        if (!body.agent || typeof body.agent !== "string") {
          throw new SessionError("INVALID_INPUT", "/agent", "agent is required");
        }
        const session = await service.createSession({
          agent: body.agent,
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
          ...(body.title !== undefined ? { title: body.title } : {}),
        });
        sendJson(res, 201, { session });
        return;
      }

      if (pathname === "/api/sessions/inspect" && method === "POST") {
        const body = await readJsonBody<{ files?: UploadedFilePayload[] }>(req);
        const result = await service.inspectFiles(body.files ?? []);
        sendJson(res, 200, result);
        return;
      }

      if (pathname === "/api/sessions/convert" && method === "POST") {
        const body = await readJsonBody<Partial<ConvertRequest>>(req);
        if (!body.to || typeof body.to !== "string") {
          throw new SessionError("INVALID_INPUT", "/to", "Target agent is required");
        }
        const session = await service.convertFiles({
          from: typeof body.from === "string" && body.from ? body.from : "auto",
          to: body.to,
          files: body.files ?? [],
          ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.title !== undefined ? { title: body.title } : {}),
        });
        sendJson(res, 201, { session });
        return;
      }

      const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1]!);
        if (method === "GET") {
          sendJson(res, 200, { session: await service.getSession(id) });
          return;
        }
        if (method === "PATCH") {
          const body = await readJsonBody<{ title?: string; model?: string | null; cwd?: string; agent?: string }>(req);
          const session = await service.updateSession(id, body);
          sendJson(res, 200, { session });
          return;
        }
        if (method === "DELETE") {
          await service.deleteSession(id);
          sendJson(res, 200, { deleted: true });
          return;
        }
      }

      const handoffMatch = /^\/api\/sessions\/([^/]+)\/handoff$/.exec(pathname);
      if (handoffMatch && method === "POST") {
        const id = decodeURIComponent(handoffMatch[1]!);
        const body = await readJsonBody<{ to?: string; model?: string; cwd?: string; title?: string }>(req);
        if (!body.to || typeof body.to !== "string") {
          throw new SessionError("INVALID_INPUT", "/to", "Target agent is required");
        }
        const session = await service.handoffSession(id, {
          to: body.to,
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
          ...(body.title !== undefined ? { title: body.title } : {}),
        });
        sendJson(res, 201, { session });
        return;
      }

      const abortMatch = /^\/api\/sessions\/([^/]+)\/abort$/.exec(pathname);
      if (abortMatch && method === "POST") {
        const id = decodeURIComponent(abortMatch[1]!);
        const aborted = service.abortRun(id);
        sendJson(res, 200, { aborted });
        return;
      }

      const messagesMatch = /^\/api\/sessions\/([^/]+)\/messages$/.exec(pathname);
      if (messagesMatch && method === "POST") {
        const id = decodeURIComponent(messagesMatch[1]!);
        const body = await readJsonBody<{ prompt?: string; model?: string; cwd?: string }>(req);
        if (typeof body.prompt !== "string" || !body.prompt.trim()) {
          throw new SessionError("INVALID_INPUT", "/prompt", "prompt is required");
        }
        // Validate session existence before switching to SSE response headers
        await service.getSession(id);

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });

        const clientAbort = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) clientAbort.abort();
        });

        await service.runTurn(
          id,
          {
            prompt: body.prompt,
            ...(body.model !== undefined ? { model: body.model } : {}),
            ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
          },
          (event) => writeSse(res, event),
          clientAbort.signal,
        );
        if (!res.writableEnded) res.end();
        return;
      }

      const bundleMatch = /^\/api\/bundles\/([^/]+)$/.exec(pathname);
      if (bundleMatch && method === "GET") {
        const bundleId = decodeURIComponent(bundleMatch[1]!);
        sendJson(res, 200, await service.getBundleDetail(bundleId));
        return;
      }

      if (pathname.startsWith("/api/")) {
        throw new SessionError("NOT_FOUND", pathname, `Unknown API endpoint: ${method} ${pathname}`);
      }

      if (staticDir && (method === "GET" || method === "HEAD")) {
        const served = await serveStatic(res, staticDir, pathname);
        if (served) return;
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch (error) {
      if (res.headersSent) {
        writeSse(res, { type: "error", diagnostic: toDiagnostic(error, pathname) });
        if (!res.writableEnded) res.end();
        return;
      }
      sendError(res, error, pathname);
    }
  });
}
