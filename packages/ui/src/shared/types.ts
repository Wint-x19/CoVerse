import type { AdapterCapabilities, LossLedger, ProtocolUsage, SessionDiagnostic } from "@coverse/core";

export interface AdapterSummary {
  id: string;
  displayName: string;
  status: "scaffold" | "ready";
  supportedVersions: readonly string[];
  capabilities: Readonly<AdapterCapabilities>;
}

export interface DriverSummary {
  id: string;
  available: boolean;
  version: string | null;
  verifiedVersions: readonly string[];
  verifiedCapabilities: readonly string[];
}

export interface CapabilitiesResponse {
  adapters: AdapterSummary[];
  drivers: DriverSummary[];
  defaultCwd: string;
}

export interface LossCounts {
  dropped: number;
  downgraded: number;
  approximated: number;
}

export interface BundleStatistics {
  turns: number;
  characters: number;
  utf8Bytes: number;
  truncated: boolean;
}

export interface BundleFileEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface HandoffMetadata {
  bundleId: string;
  bundlePath: string;
  from: string;
  fromFormat: string;
  to: string;
  nativeResume: false;
  statistics: BundleStatistics;
  losses: LossCounts;
  ledger: LossLedger;
  diagnostics: SessionDiagnostic[];
  files: BundleFileEntry[];
  sourceSessionId?: string;
}

export interface ToolActivity {
  name: string;
  state: string;
  timestamp: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  agent?: string;
  model?: string;
  tools?: ToolActivity[];
  usage?: ProtocolUsage;
  error?: SessionDiagnostic;
  aborted?: boolean;
}

export interface UiSession {
  id: string;
  title: string;
  agent: string;
  model?: string;
  cwd: string;
  targetSessionId?: string;
  bundlePending?: boolean;
  handoff?: HandoffMetadata;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface UploadedFilePayload {
  path: string;
  contentBase64: string;
}

export interface PickedFile {
  path: string;
  name: string;
  size: number;
}

export interface InspectCandidate {
  id: string;
  displayName: string;
  confidence: number;
  formatVersion?: string;
  diagnostics?: SessionDiagnostic[];
}

export interface InspectPreview {
  agent: string;
  agentFormatVersion: string;
  turns: number;
  cwd?: string;
  sourceCwd?: string;
  model?: string;
  createdAt?: string;
  losses: LossCounts;
}

export interface InspectResponse {
  candidates: InspectCandidate[];
  detected: string | null;
  ambiguous: boolean;
  preview?: InspectPreview;
  previewError?: SessionDiagnostic;
}

export interface ConvertRequest {
  from: string;
  to: string;
  files?: UploadedFilePayload[];
  paths?: string[];
  cwd?: string;
  model?: string;
  title?: string;
}

export interface BundleDetailResponse {
  bundleId: string;
  bundlePath: string;
  manifest: Record<string, unknown>;
  report: {
    schemaVersion: string;
    target: string;
    outputKind: string;
    nativeResume: boolean;
    ledger: LossLedger;
    diagnostics: SessionDiagnostic[];
    statistics: BundleStatistics;
  };
  context: string;
  files: BundleFileEntry[];
}

export type StreamEventPayload =
  | { type: "bundle"; report: string; losses: LossCounts }
  | { type: "session"; id: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; state: string }
  | { type: "usage"; usage: ProtocolUsage }
  | { type: "done"; session: UiSession }
  | { type: "error"; diagnostic: SessionDiagnostic; sessionId?: string; session?: UiSession };

export type IpcEnvelope<T> = { ok: true; data: T } | { ok: false; error: SessionDiagnostic };

export interface RunMessageInput {
  sessionId: string;
  prompt: string;
  model?: string;
  cwd?: string;
}

export interface CoverseDesktopBridge {
  readonly platform: string;
  capabilities(): Promise<CapabilitiesResponse>;
  listSessions(): Promise<UiSession[]>;
  getSession(id: string): Promise<UiSession>;
  createSession(input: { agent: string; model?: string; cwd?: string; title?: string }): Promise<UiSession>;
  updateSession(
    id: string,
    patch: { title?: string; model?: string | null; cwd?: string; agent?: string },
  ): Promise<UiSession>;
  deleteSession(id: string): Promise<void>;
  inspectSource(input: { paths?: string[]; files?: UploadedFilePayload[] }): Promise<InspectResponse>;
  convertSource(input: ConvertRequest): Promise<UiSession>;
  handoffSession(
    id: string,
    input: { to: string; model?: string; cwd?: string; title?: string },
  ): Promise<UiSession>;
  getBundle(bundleId: string): Promise<BundleDetailResponse>;
  abortSession(id: string): Promise<{ aborted: boolean }>;
  streamMessage(
    id: string,
    input: { prompt: string; model?: string; cwd?: string },
    onEvent: (event: StreamEventPayload) => void,
  ): Promise<void>;
  pickDirectory(defaultPath?: string): Promise<string | null>;
  pickSessionFiles(): Promise<PickedFile[]>;
  getPathForFile(file: File): string;
}
