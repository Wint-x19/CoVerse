import * as React from "react";
import { AlertCircle, ArrowRight, FileText, FolderOpen, Loader2 } from "lucide-react";
import type { SessionDiagnostic } from "@coverse/core";
import type {
  AdapterSummary,
  DriverSummary,
  InspectResponse,
  PickedFile,
  UiSession,
  UploadedFilePayload,
} from "../../shared/types.js";
import { api, ApiClientError } from "@/lib/api";
import { agentLabel, cn, formatBytes } from "@/lib/utils";
import { AgentGlyph } from "./AgentGlyph";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export interface PendingImportSource {
  items: PickedFile[];
  paths?: string[];
  files?: UploadedFilePayload[];
}

interface ConvertDialogProps {
  open: boolean;
  source: PendingImportSource | null;
  adapters: AdapterSummary[];
  drivers: DriverSummary[];
  defaultCwd: string;
  onOpenChange: (open: boolean) => void;
  onConverted: (session: UiSession) => void;
}

export function ConvertDialog({
  open,
  source,
  adapters,
  drivers,
  defaultCwd,
  onOpenChange,
  onConverted,
}: ConvertDialogProps) {
  const [inspecting, setInspecting] = React.useState(false);
  const [inspectResult, setInspectResult] = React.useState<InspectResponse | null>(null);
  const [from, setFrom] = React.useState("auto");
  const [to, setTo] = React.useState("");
  const [model, setModel] = React.useState("");
  const [cwd, setCwd] = React.useState(defaultCwd);
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
    setCwd(defaultCwd);

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
        if (result.preview?.cwd) setCwd(result.preview.cwd);

        const availableOther = drivers.find((d) => d.available && d.id !== detected);
        const anyOther = adapters.find((a) => a.capabilities.export && a.id !== detected);
        const firstAvailable = drivers.find((d) => d.available);
        setTo(availableOther?.id ?? anyOther?.id ?? firstAvailable?.id ?? adapters[0]?.id ?? "claude-code");
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

  const handleConvert = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!to || !source) return;
    setConverting(true);
    setError(null);
    try {
      const session = await api.convertSource({
        from,
        to,
        ...(source.paths ? { paths: source.paths } : {}),
        ...(source.files ? { files: source.files } : {}),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="convert-dialog" className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Convert session</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleConvert} className="mt-4 flex flex-col gap-4">
          <div className="flex flex-wrap gap-1.5">
            {(source?.items ?? []).map((item) => (
              <div
                key={item.path}
                title={item.path}
                className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-[#0b0c0e] px-2 py-1 font-mono text-[11.5px] text-[#c8cdd6]"
              >
                <FileText className="h-3 w-3 text-[#6d727c]" />
                <span className="max-w-[220px] truncate">{item.name}</span>
                {item.size > 0 && <span className="text-[#5b6069]">{formatBytes(item.size)}</span>}
              </div>
            ))}
          </div>

          {inspecting ? (
            <div className="flex items-center gap-2 py-3 text-[12.5px] text-[#8a8f98]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Detecting format…</span>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                <Select value={from} onValueChange={setFrom}>
                  <SelectTrigger aria-label="Source adapter" data-testid="convert-from-select">
                    <SelectValue placeholder="Source" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    {adapters
                      .filter((a) => a.capabilities.import)
                      .map((adapter) => {
                        const match = inspectResult?.candidates.find((c) => c.id === adapter.id);
                        return (
                          <SelectItem key={adapter.id} value={adapter.id}>
                            <span className="flex items-center gap-2">
                              <AgentGlyph agent={adapter.id} className="h-3.5 w-3.5 text-[#8a8f98]" />
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

                <ArrowRight className="h-3.5 w-3.5 text-[#5b6069]" />

                <Select value={to} onValueChange={setTo}>
                  <SelectTrigger aria-label="Target adapter" data-testid="convert-to-select">
                    <SelectValue placeholder="Target" />
                  </SelectTrigger>
                  <SelectContent>
                    {adapters
                      .filter((a) => a.capabilities.export)
                      .map((adapter) => {
                        const driver = drivers.find((d) => d.id === adapter.id);
                        return (
                          <SelectItem key={adapter.id} value={adapter.id}>
                            <span className="flex items-center gap-2">
                              <span
                                className={cn(
                                  "h-1.5 w-1.5 rounded-full",
                                  driver?.available ? "bg-[#3ecf8e]" : "bg-[#3f434a]",
                                )}
                              />
                              <span>{agentLabel(adapter.id)}</span>
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
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-white/[0.07] bg-[#0b0c0e] px-2.5 py-2 font-mono text-[11.5px] text-[#8a8f98]"
                >
                  <span className="text-[#d0d6e0]">{inspectResult.preview.agentFormatVersion}</span>
                  <span>{inspectResult.preview.turns} turns</span>
                  {inspectResult.preview.model && <span>{inspectResult.preview.model}</span>}
                </div>
              )}

              {inspectResult?.previewError && !error && (
                <div className="flex items-start gap-2 rounded-lg border border-[#e5a93b]/30 bg-[#e5a93b]/[0.07] px-3 py-2 text-[12px] text-[#f0be67]">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div className="min-w-0">
                    <span className="font-mono">{inspectResult.previewError.code}</span>
                    <span className="mx-1.5 opacity-40">·</span>
                    <span>{inspectResult.previewError.message}</span>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 gap-2.5">
                <div className="flex items-center gap-1.5">
                  <Input
                    value={cwd}
                    onChange={(event) => setCwd(event.target.value)}
                    placeholder="Workspace directory"
                    aria-label="Workspace directory"
                    data-testid="convert-cwd-input"
                    className="font-mono text-[12px]"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    aria-label="Choose workspace directory"
                    onClick={async () => {
                      const picked = await api.pickDirectory(cwd).catch(() => null);
                      if (picked) setCwd(picked);
                    }}
                    className="h-8 w-8 shrink-0"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <Input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="Model (optional)"
                  aria-label="Model"
                  data-testid="convert-model-input"
                  className="font-mono text-[12px]"
                />
              </div>
            </>
          )}

          {error && (
            <div
              role="alert"
              data-testid="convert-error"
              className="flex items-start gap-2 rounded-lg border border-[#e5484d]/30 bg-[#e5484d]/[0.08] px-3 py-2 text-[12px] text-[#ff878b]"
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
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={inspecting || converting || !to}
              data-testid="convert-submit-btn"
            >
              {converting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>Convert</span>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
