import type {ProtocolUsage} from "./protocol.js";
/** CoVerse IR v1. Protocol wire formats belong to codecs, not core. */
export type JsonValue = null | boolean | number | bigint | string | JsonValue[] | { [key: string]: JsonValue };

/** Paths are portable relative paths; contents may be binary or compressed. */
export interface Artifact {
  path: string;
  bytes: Uint8Array;
}
export type FileSet = readonly Artifact[];

export interface LossItem {
  code: string;
  path: string;
  reason: string;
}
export interface LossLedger {
  dropped: LossItem[];
  downgraded: LossItem[];
  approximated: LossItem[];
}

export type ContentBlock =
  | { type: "text" | "reasoning"; text: string; displayAs?: "review" | "sources"; sources?: RecordedSource[] }
  | { type: "tool_call"; id: string; name: string; arguments: JsonValue; argumentsText?: string }
  | { type: "tool_result"; callId: string; callTurnId?: string; content: JsonValue; isError?: boolean; assets?: RecordedAsset[]; displayText?: string; sources?:RecordedSource[] }
  | { type: "attachment"; path: string; mediaType: string }
  | { type: "image"; url: string; detail?: string }
  | { type: "media"; asset: RecordedAsset }
  | { type: "opaque"; source: string; value: JsonValue; requiredForContinuation?: boolean }
  | { type: "unknown"; raw: JsonValue };

export interface MessageMetadata {
  createdAt?: string;
  model?: string;
  usage?: ProtocolUsage;
  usageScope?: "message" | "request" | "session";
  durationMs?: number;
}

export interface Turn extends MessageMetadata {
  id: string;
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: ContentBlock[];
  raw?: JsonValue;
  /** Presentation details derived from the original record, separate from continuation content. */
  changedFiles?: TranscriptMessage["changedFiles"];
  plan?: RecordedPlan;
  event?: HistoryEvent;
  childTrajectory?: {id:string;turns:Turn[]};
  assets?: RecordedAsset[];
  reviews?: RecordedReview[];
  /** Stable provenance; parent/branch references must not be flattened away. */
  origin?: { artifact: string; record: number; parentId?: string; parentTurnId?: string; branchId?: string; subsession?:boolean; reverted?: boolean; kind?: "message" | "compaction" | "reverted" | "subsession" };
}

/** Native conversation surface, independent of the model's compacted input window. */
export interface RecordedFileChange {
  path: string;
  added: number | null;
  removed: number | null;
  patches?: string[];
}

export interface RecordedReview {
  path: string;
  comment: string;
  selections: {side: "original" | "modified" | "file"; text?: string; start?: number; end?: number}[];
}

export interface RecordedAsset {
  location: "embedded" | "remote" | "project" | "attachment" | "text";
  value: string;
  mediaType: string;
  label?: string;
  sourceUri?: string;
  description?: string;
}

export interface RecordedSource {url:string;title?:string;excerpt?:string}

export interface RecordedTool {
  sources?: RecordedSource[];
  changedFiles?: RecordedFileChange[];
  plan?: RecordedPlan;
  id?: string;
  name: string;
  state: string;
  argumentsText?: string;
  results?: {text: string; failed?: boolean; assets?: RecordedAsset[]; displayText?: string}[];
  details?: string;
}

export interface RecordedPlan {
  text?: string;
  steps: {title: string; status?: string; detail?: string}[];
}

export interface HistoryEvent extends MessageMetadata {
  id: string;
  anchorId?: string;
  sourceRole?: Turn["role"];
  kind: "system" | "developer" | "context" | "progress" | "attachment" | "compaction" | "checkpoint" | "error" | "rollback" | "opaque";
  text: string;
}

export interface MessageLineage {
  branchId?: string;
  parentId?: string;
  subsession?: boolean;
  reverted?: boolean;
}

export interface TranscriptMessage extends MessageMetadata {
  id: string;
  role: "user" | "assistant";
  text: string;
  activity?: string;
  sources?: RecordedSource[];
  plan?: RecordedPlan;
  before?: HistoryEvent[];
  lineage?: MessageLineage;
  after?: HistoryEvent[];
  assets?: RecordedAsset[];
  tools?: RecordedTool[];
  changedFiles?: RecordedFileChange[];
  reviews?: RecordedReview[];
}
export interface CSR {
  schemaVersion: "1.0";
  meta: {
    id: string;
    agent: string;
    agentFormatVersion: string;
    createdAt?: string;
    cwd?: string;
    model?: string;
    vcs?: { root: string; branch?: string; commit?: string };
  };
  turns: Turn[];
  transcript?: TranscriptMessage[];
  /** At the boundary the source replaced earlier history. Later turns remain live. */
  continuation?: { boundaryId: string; retainedIds: string[]; replacement: Turn[] };
  xExtensions: Record<string, JsonValue>;
  raw?: JsonValue;
  /** Retain exact bytes as well as parsed records when the source needs them. */
  sourceArtifacts?: FileSet;
}

export interface AdapterCapabilities {
  import: boolean;
  export: boolean;
  nativeResume: boolean;
  importFormats?: readonly string[];
  exportFormats?: readonly ("injection-bundle")[];
}
export interface SessionDiagnostic {
  code: string;
  path: string;
  message: string;
  severity: "warning" | "error";
}
export interface Detection {
  confidence: number;
  formatVersion?: string;
  diagnostics?: SessionDiagnostic[];
}
export interface ImportResult { session: CSR; ledger: LossLedger; diagnostics?: SessionDiagnostic[] }
export interface ExportLossPolicy {
  /** Explicitly allow omitting uninterpreted opaque/unknown blocks (archived in source/ and logged in LossLedger.dropped). */
  omitOpaque?: boolean;
}
export interface ExportContext {
  ledger?: LossLedger;
  diagnostics?: readonly SessionDiagnostic[];
  lossPolicy?: ExportLossPolicy;
}
export interface ExportResult { artifacts: FileSet; ledger: LossLedger; diagnostics?: SessionDiagnostic[] }

export interface DesktopPublication {
  cliSessionId?: string;
  transferId: string;
  title: string;
  cwd: string;
  bundleDirectory: string;
  loadArtifacts(): Promise<FileSet>;
}

/** All agent format knowledge lives in implementations outside core. */
export interface SessionAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly status: "scaffold" | "ready";
  readonly supportedVersions: readonly string[];
  readonly capabilities: Readonly<AdapterCapabilities>;
  readToolPlan?(name: string, args: JsonValue, result?: JsonValue): RecordedPlan | undefined;
  readToolChanges?(name:string, args:JsonValue, result?:JsonValue): RecordedFileChange[] | undefined;
  /** Catalog metadata for formats whose workspace is not available from the native session index. */
  readProjectDirectory?(input: FileSet): string | undefined | Promise<string | undefined>;
  prepareLocalImport?(input: FileSet, resolve: (sessionId: string) => Promise<FileSet>, sourcePath?: string): Promise<FileSet>;
  /** Resolve a CLI-resumable identity when the native store distinguishes sessions from trajectories. */
  localResumeId?(session: CSR, sourcePath: string): string | undefined;
  /** Publish a separate, resumable snapshot when the desktop and CLI have separate native stores. */
  publishDesktopSession?(input: DesktopPublication): Promise<string>;
  detect(input: FileSet): Detection | Promise<Detection>;
  import(input: FileSet): ImportResult | Promise<ImportResult>;
  export(session: CSR, context?: ExportContext): ExportResult | Promise<ExportResult>;
}
