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
  | { type: "text" | "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: JsonValue; argumentsText?: string }
  | { type: "tool_result"; callId: string; content: JsonValue; isError?: boolean }
  | { type: "attachment"; path: string; mediaType: string }
  | { type: "image"; url: string; detail?: string }
  | { type: "opaque"; source: string; value: JsonValue; requiredForContinuation?: boolean }
  | { type: "unknown"; raw: JsonValue };

export interface Turn {
  id: string;
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: ContentBlock[];
  raw?: JsonValue;
  /** Stable provenance; parent/branch references must not be flattened away. */
  origin?: { artifact: string; record: number; parentId?: string; branchId?: string; kind?: "message" | "compaction" | "reverted" | "subsession" };
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

/** All agent format knowledge lives in implementations outside core. */
export interface SessionAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly status: "scaffold" | "ready";
  readonly supportedVersions: readonly string[];
  readonly capabilities: Readonly<AdapterCapabilities>;
  /** Catalog metadata for formats whose workspace is not available from the native session index. */
  readProjectDirectory?(input: FileSet): string | undefined | Promise<string | undefined>;
  detect(input: FileSet): Detection | Promise<Detection>;
  import(input: FileSet): ImportResult | Promise<ImportResult>;
  export(session: CSR, context?: ExportContext): ExportResult | Promise<ExportResult>;
}
