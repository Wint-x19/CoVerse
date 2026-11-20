import type { SessionDiagnostic } from "@coverse/core";
import type {
  ApiErrorEnvelope,
  BundleDetailResponse,
  CapabilitiesResponse,
  ConvertRequest,
  InspectResponse,
  StreamEventPayload,
  UiSession,
  UploadedFilePayload,
} from "../../shared/types.js";

export class ApiClientError extends Error {
  constructor(readonly diagnostic: SessionDiagnostic, readonly status: number) {
    super(diagnostic.message);
    this.name = "ApiClientError";
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    const envelope = payload as Partial<ApiErrorEnvelope>;
    const diagnostic: SessionDiagnostic = envelope.error ?? {
      code: "HTTP_ERROR",
      path: url,
      message: response.statusText || `Request failed (${response.status})`,
      severity: "error",
    };
    throw new ApiClientError(diagnostic, response.status);
  }
  return payload as T;
}

export const api = {
  capabilities: () => requestJson<CapabilitiesResponse>("/api/capabilities"),

  listSessions: async () => (await requestJson<{ sessions: UiSession[] }>("/api/sessions")).sessions,

  getSession: async (id: string) =>
    (await requestJson<{ session: UiSession }>(`/api/sessions/${encodeURIComponent(id)}`)).session,

  createSession: async (input: { agent: string; model?: string; cwd?: string; title?: string }) =>
    (
      await requestJson<{ session: UiSession }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify(input),
      })
    ).session,

  updateSession: async (
    id: string,
    patch: { title?: string; model?: string | null; cwd?: string; agent?: string },
  ) =>
    (
      await requestJson<{ session: UiSession }>(`/api/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      })
    ).session,

  deleteSession: (id: string) =>
    requestJson<{ deleted: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  inspectFiles: (files: UploadedFilePayload[]) =>
    requestJson<InspectResponse>("/api/sessions/inspect", {
      method: "POST",
      body: JSON.stringify({ files }),
    }),

  convertFiles: async (input: ConvertRequest) =>
    (
      await requestJson<{ session: UiSession }>("/api/sessions/convert", {
        method: "POST",
        body: JSON.stringify(input),
      })
    ).session,

  handoffSession: async (
    id: string,
    input: { to: string; model?: string; cwd?: string; title?: string },
  ) =>
    (
      await requestJson<{ session: UiSession }>(`/api/sessions/${encodeURIComponent(id)}/handoff`, {
        method: "POST",
        body: JSON.stringify(input),
      })
    ).session,

  getBundle: (bundleId: string) =>
    requestJson<BundleDetailResponse>(`/api/bundles/${encodeURIComponent(bundleId)}`),

  abortSession: (id: string) =>
    requestJson<{ aborted: boolean }>(`/api/sessions/${encodeURIComponent(id)}/abort`, {
      method: "POST",
      body: "{}",
    }),

  async streamMessage(
    id: string,
    input: { prompt: string; model?: string; cwd?: string },
    onEvent: (event: StreamEventPayload) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      const text = await response.text();
      const envelope = (text ? JSON.parse(text) : {}) as Partial<ApiErrorEnvelope>;
      throw new ApiClientError(
        envelope.error ?? {
          code: "HTTP_ERROR",
          path: `/api/sessions/${id}/messages`,
          message: response.statusText || `Request failed (${response.status})`,
          severity: "error",
        },
        response.status,
      );
    }

    if (!response.body) {
      throw new ApiClientError(
        { code: "STREAM_ERROR", path: "/stream", message: "Empty event stream", severity: "error" },
        500,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const flushBlock = (block: string) => {
      const dataLines = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());
      if (dataLines.length === 0) return;
      const parsed = JSON.parse(dataLines.join("\n")) as StreamEventPayload;
      onEvent(parsed);
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (block.trim()) flushBlock(block);
          boundary = buffer.indexOf("\n\n");
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) flushBlock(buffer);
    } finally {
      reader.releaseLock();
    }
  },
};
