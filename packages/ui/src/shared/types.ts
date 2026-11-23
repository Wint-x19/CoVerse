import type { AdapterCapabilities, LossLedger, ProtocolUsage, RecordedTool, SessionDiagnostic } from "@coverse/core";

export type ThemeMode = "light" | "dark";
export type LanguageCode = "zh-CN" | "en";

export interface AppSettings {
  theme: ThemeMode;
  language: LanguageCode;
  disabledAdapters: string[];
  driverExecutables: Record<string, string>;
}

export interface ModelOption {
  id: string;
  label: string;
  isDefault?: boolean;
}

export interface LocalSessionRef {
  parentSessionId?: string | null;
  id: string;
  agent: string;
  title: string;
  path: string;
  cwd?: string;
  updatedAt: string;
  size: number;
  active?: boolean;
}

export interface AdapterSummary {
  id: string;
  displayName: string;
  status: "scaffold" | "ready";
  enabled: boolean;
  supportedVersions: readonly string[];
  capabilities: Readonly<AdapterCapabilities>;
}

export interface DriverSummary {
  id: string;
  available: boolean;
  version: string | null;
  executablePath: string | null;
  customExecutablePath?: string;
  verifiedVersions: readonly string[];
  verifiedCapabilities: readonly string[];
  models: ModelOption[];
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
  materialized?: boolean;
  materializationError?: SessionDiagnostic;
  desktopSessionId?: string;
  desktopFirst?: boolean;
  desktopError?: SessionDiagnostic;
  statistics: BundleStatistics;
  losses: LossCounts;
  ledger: LossLedger;
  diagnostics: SessionDiagnostic[];
  files: BundleFileEntry[];
  sourceSessionId?: string;
}

export interface SessionReference {
  sourceSessionId?: string;
  displayVersion?: 1 | 2;
  sourcePath: string;
  agent: string;
  formatVersion: string;
  originalCwd: string;
}

export interface ToolActivity extends RecordedTool {
  timestamp: string;
}

export type FileScope = "project" | "bundle" | "attachment";
export type FilePreview =
  | { kind: "text"; path: string; content: string }
  | { kind: "media"; path: string; url: string; mediaType: string }
  | { kind: "directory"; path: string; entries: string[] };

export interface ChatMessage {
  childBranch?: string;
  lineage?: import("@coverse/core").MessageLineage;
  before?: import("@coverse/core").HistoryEvent[];
  after?: import("@coverse/core").HistoryEvent[];
  plan?: import("@coverse/core").RecordedPlan;
  assets?: import("@coverse/core").RecordedAsset[];
  reviews?: import("@coverse/core").RecordedReview[];
  changedFiles?: import("@coverse/core").TranscriptMessage["changedFiles"];
  durationMs?: number;
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  agent?: string;
  model?: string;
  reasoning?: string;
  tools?: ToolActivity[];
  usage?: ProtocolUsage;
  error?: SessionDiagnostic;
  aborted?: boolean;
  historical?: boolean;
}

export interface UiSession {
  id: string;
  title: string;
  agent: string;
  model?: string;
  cwd: string;
  targetSessionId?: string;
  bundlePending?: boolean;
  reference?: SessionReference;
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

export interface OpaqueBlockSummary {
  source: string;
  count: number;
}

export interface InspectPreview {
  id: string;
  agent: string;
  agentFormatVersion: string;
  turns: number;
  cwd?: string;
  sourceCwd?: string;
  model?: string;
  createdAt?: string;
  canReference?: boolean;
  opaqueBlocks?: OpaqueBlockSummary[];
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
  /** Route by source metadata, falling back to the catalog cwd if the transcript omits it. */
  useSourceProject?: boolean;
  files?: UploadedFilePayload[];
  paths?: string[];
  cwd?: string;
  model?: string;
  title?: string;
  materialize?: boolean;
  omitOpaque?: boolean;
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
  | ({ type: "tool" } & ToolActivity)
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
  previewFile(sessionId: string, path: string, scope: FileScope): Promise<IpcEnvelope<FilePreview>>;
  readonly platform: string;
  capabilities(refresh?: boolean): Promise<IpcEnvelope<CapabilitiesResponse>>;
  getSettings(): Promise<IpcEnvelope<AppSettings>>;
  updateSettings(patch: Partial<AppSettings>): Promise<IpcEnvelope<AppSettings>>;
  listLocalSessions(agent?: string, cachedOnly?: boolean): Promise<IpcEnvelope<LocalSessionRef[]>>;
  listSessions(): Promise<IpcEnvelope<UiSession[]>>;
  getSession(id: string): Promise<IpcEnvelope<UiSession>>;
  createSession(input: { agent: string; model?: string; cwd?: string; title?: string }): Promise<IpcEnvelope<UiSession>>;
  updateSession(
    id: string,
    patch: { title?: string; model?: string | null; cwd?: string; agent?: string },
  ): Promise<IpcEnvelope<UiSession>>;
  deleteSession(id: string): Promise<IpcEnvelope<{ deleted: boolean }>>;
  inspectSource(input: { paths?: string[]; files?: UploadedFilePayload[] }): Promise<IpcEnvelope<InspectResponse>>;
  convertSource(input: ConvertRequest): Promise<IpcEnvelope<UiSession>>;
  handoffSession(
    id: string,
    input: { to: string; model?: string; cwd?: string; title?: string; materialize?: boolean; omitOpaque?: boolean },
  ): Promise<IpcEnvelope<UiSession>>;
  materializeSession(id: string): Promise<IpcEnvelope<UiSession>>;
  getBundle(bundleId: string): Promise<IpcEnvelope<BundleDetailResponse>>;
  abortSession(id: string): Promise<IpcEnvelope<{ aborted: boolean }>>;
  streamMessage(
    id: string,
    input: { prompt: string; model?: string; cwd?: string },
    onEvent: (event: StreamEventPayload) => void,
  ): Promise<IpcEnvelope<{ finished: boolean }>>;
  pickDirectory(defaultPath?: string): Promise<IpcEnvelope<string | null>>;
  pickSessionFiles(): Promise<IpcEnvelope<PickedFile[]>>;
  pickExecutable(defaultPath?: string): Promise<IpcEnvelope<string | null>>;
  setWindowTheme(theme: ThemeMode): Promise<IpcEnvelope<{ applied: boolean }>>;
  getPathForFile(file: File): string;
}
