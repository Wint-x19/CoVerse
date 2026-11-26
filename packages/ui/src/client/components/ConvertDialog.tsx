import * as React from "react";
import { AlertCircle, ArrowRight, FileText, FolderOpen, Link2, Loader2 } from "lucide-react";
import type { SessionDiagnostic } from "@coverse/core";
import type {
  AdapterSummary,
  DriverSummary,
  InspectResponse,
  PickedFile,
  UiSession,
  UploadedFilePayload,
} from "../../shared/types.js";
import type { I18nMessages } from "@/lib/i18n";
import { api, ApiClientError } from "@/lib/api";
import { agentLabel, cn, formatBytes } from "@/lib/utils";
import { AgentGlyph } from "./AgentGlyph";
import { ModelPicker } from "./ModelPicker";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export interface PendingImportSource {
  items: PickedFile[];
  paths?: string[];
  files?: UploadedFilePayload[];
  originalCwd?: string;
  target?:string;
}

interface ConvertDialogProps {
  open: boolean;
  source: PendingImportSource | null;
  adapters: AdapterSummary[];
  drivers: DriverSummary[];
  defaultCwd: string;
  t: I18nMessages;
  onOpenChange: (open: boolean) => void;
  onConverted: (session: UiSession) => void;
  onAddCompanions: (files:PickedFile[]) => void;
}

function samePathLoose(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const na = norm(a);
  const nb = norm(b);
  return api.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

export function ConvertDialog({
  open,
  source,
  adapters,
  drivers,
  defaultCwd,
  t,
  onOpenChange,
  onConverted,
  onAddCompanions,
}: ConvertDialogProps) {
  const [inspecting, setInspecting] = React.useState(false);
  const [inspectResult, setInspectResult] = React.useState<InspectResponse | null>(null);
  const [from, setFrom] = React.useState("auto");
  const [to, setTo] = React.useState("");
  const [model, setModel] = React.useState("");
  const [cwd, setCwd] = React.useState(defaultCwd);
  const [materialize, setMaterialize] = React.useState(true);
  const [omitOpaque, setOmitOpaque] = React.useState(false);
  const [converting, setConverting] = React.useState(false);
  const [error, setError] = React.useState<SessionDiagnostic | null>(null);

  React.useEffect(() => {
    if (!open || !source || source.items.length === 0) return;
    let active = true;
    setInspecting(true);
    setInspectResult(null);
    setError(null);
    setFrom("auto");
    setModel("");
    setMaterialize(true);
    setOmitOpaque(false);
    setCwd(source.originalCwd || defaultCwd);

    api
      .inspectSource({
        ...(source.paths ? { paths: source.paths } : {}),
        ...(source.files ? { files: source.files } : {}),
      })
      .then((result) => {
        if (!active) return;
        setInspectResult(result);
        const detected = result.detected;
        if (detected) setFrom(detected);
        if (result.preview?.opaqueBlocks && result.preview.opaqueBlocks.length > 0) {
          setOmitOpaque(true);
        }

        // Default to original project directory whenever available
        if (result.preview?.cwd) setCwd(result.preview.cwd);
        else if (source.originalCwd) setCwd(source.originalCwd);
        else if (result.preview?.sourceCwd) setCwd(result.preview.sourceCwd);
        else setCwd(defaultCwd);

        // Default target to same agent (no forced conversion; user may switch to any other agent)
        const enabledExport = adapters.filter((a) => a.enabled && a.capabilities.export);
        if (source.target && enabledExport.some(a => a.id === source.target)) setTo(source.target);
        else if (detected && enabledExport.some((a) => a.id === detected)) {
          setTo(detected);
        } else {
          const firstAvailable = drivers.find(
            (d) => d.available && enabledExport.some((a) => a.id === d.id),
          );
          setTo(firstAvailable?.id ?? enabledExport[0]?.id ?? "");
        }
      })
      .catch((err) => {
        if (!active) return;
        setError(
          err instanceof ApiClientError
            ? err.diagnostic
            : { code: "INSPECT_ERROR", path: "/inspect", message: String(err), severity: "error" },
        );
      })
      .finally(() => {
        if (active) setInspecting(false);
      });

    return () => {
      active = false;
    };
  }, [open, source, defaultCwd, drivers, adapters]);

  const effectiveSource = from === "auto" ? inspectResult?.detected ?? null : from;
  const targetDriver = drivers.find((d) => d.id === to);
  const targetModels = targetDriver?.models ?? [];

  const originalCwd = inspectResult?.preview?.cwd;
  const pathUnchanged = originalCwd
    ? samePathLoose(cwd, originalCwd)
    : !inspectResult?.preview?.sourceCwd;
  const isReferenceImport = Boolean(
    effectiveSource &&
      to === effectiveSource &&
      inspectResult?.preview?.canReference &&
      pathUnchanged,
  );

  const handleConvert = async (event: React.SyntheticEvent, viewOnly=false) => {
    event.preventDefault();
    if (!to || !source || converting) return;
    setConverting(true);
    setError(null);
    try {
      const session = await api.convertSource({
        from,
        to:viewOnly ? inspectResult?.detected ?? to : to,
        ...(viewOnly ? {viewOnly:true} : {}),
        ...(source.paths ? { paths: source.paths } : {}),
        ...(source.files ? { files: source.files } : {}),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        materialize: isReferenceImport ? false : materialize,
        ...(omitOpaque ? { omitOpaque: true } : {}),
      });
      onConverted(session);
      onOpenChange(false);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.diagnostic
          : { code: "CONVERT_ERROR", path: "/convert", message: String(err), severity: "error" },
      );
    } finally {
      setConverting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={next => {if (!converting) onOpenChange(next);}}>
      <DialogContent data-testid="convert-dialog" hideClose={converting} className="max-h-[90vh] max-w-[500px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isReferenceImport ? t.importSession : t.convertSession}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleConvert} className="mt-4 flex flex-col gap-4">
          <div className="flex flex-wrap gap-1.5">
            {(source?.items ?? []).map((item) => (
              <div
                key={item.path}
                title={item.path}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-2 py-1 font-mono text-[11.5px] text-[var(--text-primary)]"
              >
                <FileText className="h-3 w-3 text-[var(--text-tertiary)]" />
                <span className="max-w-[220px] truncate">{item.name}</span>
                {item.size > 0 && <span className="text-[var(--text-tertiary)]">{formatBytes(item.size)}</span>}
              </div>
            ))}
          </div>

          {inspecting ? (
            <div className="flex items-center gap-2 py-3 text-[12.5px] text-[var(--text-secondary)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{t.detecting}</span>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                <Select value={from} onValueChange={setFrom}>
                  <SelectTrigger aria-label="Source adapter" data-testid="convert-from-select">
                    <SelectValue placeholder={t.auto} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">{t.auto}</SelectItem>
                    {adapters
                      .filter((a) => a.enabled && a.capabilities.import)
                      .map((adapter) => {
                        const match = inspectResult?.candidates.find((c) => c.id === adapter.id);
                        return (
                          <SelectItem key={adapter.id} value={adapter.id}>
                            <span className="flex items-center gap-2">
                              <AgentGlyph agent={adapter.id} className="h-3.5 w-3.5" />
                              <span>{agentLabel(adapter.id)}</span>
                              {match && match.confidence >= 0.9 && (
                                <span className="font-mono text-[10.5px] text-[#3ecf8e]">
                                  {Math.round(match.confidence * 100)}%
                                </span>
                              )}
                            </span>
                          </SelectItem>
                        );
                      })}
                  </SelectContent>
                </Select>

                <ArrowRight className="h-3.5 w-3.5 text-[var(--text-tertiary)]" />

                <Select
                  value={to}
                  onValueChange={(next) => {
                    setTo(next);
                    setModel("");
                  }}
                >
                  <SelectTrigger aria-label="Target adapter" data-testid="convert-to-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {adapters
                      .filter((a) => a.enabled && a.capabilities.export)
                      .map((adapter) => {
                        const driver = drivers.find((d) => d.id === adapter.id);
                        return (
                          <SelectItem key={adapter.id} value={adapter.id}>
                            <span className="flex items-center gap-2">
                              <AgentGlyph agent={adapter.id} className="h-3.5 w-3.5" />
                              <span>{agentLabel(adapter.id)}</span>
                              <span
                                className={cn(
                                  "h-1.5 w-1.5 rounded-full",
                                  driver?.available ? "bg-[#3ecf8e]" : "bg-[var(--status-muted)]",
                                )}
                              />
                            </span>
                          </SelectItem>
                        );
                      })}
                  </SelectContent>
                </Select>
              </div>

              {inspectResult?.preview && (
                <div
                  data-testid="convert-preview"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-2.5 py-2 font-mono text-[11.5px] text-[var(--text-secondary)]"
                >
                  <span className="flex items-center gap-2">
                    <span className="text-[var(--text-primary)]">{inspectResult.preview.agentFormatVersion}</span>
                    <span>{t.turns(inspectResult.preview.turns)}</span>
                  </span>
                  <span>{t.sourceLoss} · {(["dropped","downgraded","approximated"] as const).map(k => t[k] + " " + inspectResult.preview!.losses[k]).join(" · ")}</span>
                  {isReferenceImport && (
                    <span className="inline-flex items-center gap-1 text-[#3ecf8e]" data-testid="reference-indicator">
                      <Link2 className="h-3 w-3" />
                      <span>{t.referenceMode}</span>
                    </span>
                  )}
                </div>
              )}

              {inspectResult?.previewError && !error && (
                <div className="flex items-start gap-2 rounded-lg border border-[#e5a93b]/30 bg-[#e5a93b]/[0.08] px-3 py-2 text-[12px] text-[#d4921e]">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div className="min-w-0">
                    <span className="font-mono">{inspectResult.previewError.code}</span>
                    {inspectResult.previewError.path && (
                      <span className="ml-1.5 font-mono opacity-70">{inspectResult.previewError.path}</span>
                    )}
                    <span className="mx-1.5 opacity-40">·</span>
                    <span>{inspectResult.previewError.message}</span>
                  </div>
                </div>
              )}

              {!isReferenceImport && <p className="text-xs text-[var(--text-secondary)]">{materialize && targetDriver?.available ? t.expectedNative : t.expectedBundle}</p>}
              <div className="grid grid-cols-1 gap-2.5">
                <details className="cv-options" open={error?.path === "/cwd" || undefined}><summary>{t.moreOptions}</summary>
                <div className="flex items-center gap-1.5">
                  <Input
                    value={cwd}
                    onChange={(event) => setCwd(event.target.value)}
                    placeholder={t.workspaceDirectory}
                    aria-label={t.workspaceDirectory}
                    data-testid="convert-cwd-input"
                    className="font-mono text-[12px]"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    aria-label={t.browse}
                    onClick={async () => {
                      const picked = await api.pickDirectory(cwd).catch(() => null);
                      if (picked) setCwd(picked);
                    }}
                    className="h-8 w-8 shrink-0"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                  </Button>
                </div>

                <ModelPicker
                  value={model}
                  models={targetModels}
                  t={t}
                  compact={false}
                  onChange={setModel}
                  testId="convert-model-picker"
                />

                </details>
                {!isReferenceImport &&
                  ((inspectResult?.preview?.opaqueBlocks && inspectResult.preview.opaqueBlocks.length > 0) ||
                    error?.code === "UNINTERPRETED_CONTENT") && (
                    <div
                      data-testid="convert-opaque-notice"
                      className="flex flex-col gap-2 rounded-md border border-[#e5a93b]/35 bg-[#e5a93b]/[0.07] px-2.5 py-2 text-[12px]"
                    >
                      {inspectResult?.preview?.opaqueBlocks && inspectResult.preview.opaqueBlocks.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 font-mono text-[11px] text-[#d4921e]">
                          {inspectResult.preview.opaqueBlocks.map((item) => (
                            <span key={item.source}>
                              {item.source} × {item.count}
                            </span>
                          ))}
                        </div>
                      )}
                      <label className="flex items-center justify-between gap-2 text-[var(--text-primary)] cursor-pointer select-none">
                        <span>{t.omitOpaque}</span>
                        <input
                          type="checkbox"
                          checked={omitOpaque}
                          onChange={(e) => setOmitOpaque(e.target.checked)}
                          data-testid="convert-omit-opaque-checkbox"
                          className="h-3.5 w-3.5 accent-[#5e6ad2] cursor-pointer"
                        />
                      </label>
                    </div>
                  )}

                {!isReferenceImport && targetDriver?.available && (
                  <label className="flex items-center justify-between rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-2.5 py-2 text-[12px] text-[var(--text-secondary)] cursor-pointer select-none">
                    <span>{t.syncToTarget}</span>
                    <input
                      type="checkbox"
                      checked={materialize}
                      onChange={(e) => setMaterialize(e.target.checked)}
                      data-testid="convert-materialize-checkbox"
                      className="h-3.5 w-3.5 accent-[#5e6ad2] cursor-pointer"
                    />
                  </label>
                )}
                  {!isReferenceImport && to === "antigravity" && materialize && targetDriver?.available &&
                    <p className="text-xs text-[var(--text-secondary)]">{t.desktopHint}</p>}
              </div>
            </>
          )}

          {error && (
            <div
              role="alert"
              data-testid="convert-error"
              className="flex items-start gap-2 rounded-lg border border-[#e5484d]/30 bg-[#e5484d]/[0.08] px-3 py-2 text-[12px] text-[#e5484d]"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0">
                <span className="font-mono font-medium">{error.code}</span>
                {error.path && <span className="ml-1.5 font-mono opacity-70">{error.path}</span>}
                <div className="mt-0.5">{error.message}</div>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            {inspectResult?.previewError?.code === "MISSING_ATTACHMENT" && <Button type="button" variant="outline" onClick={async () => {
              try { const picked = await api.pickSessionFiles(); if (picked.length) onAddCompanions(picked); }
              catch (cause) { setError({code:"PICK_FAILED",path:"/files",message:String(cause),severity:"error"}); }
            }}>{t.addCompanions}</Button>}
            {inspectResult?.canReadPartial && <Button type="button" disabled={converting} onClick={e => void handleConvert(e,true)}>{t.readAvailable}</Button>}
            <Button type="button" variant="ghost" disabled={converting} onClick={() => onOpenChange(false)}>
              {t.cancel}
            </Button>
            <Button
              type="submit"
              disabled={inspecting || converting || !to}
              data-testid="convert-submit-btn"
            >
              {converting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>
                {converting && !isReferenceImport && materialize
                  ? t.syncing
                  : isReferenceImport
                    ? t.importReference
                    : t.convert}
              </span>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
