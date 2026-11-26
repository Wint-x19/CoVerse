import * as React from "react";
import { AlertCircle, ArrowRight, FolderOpen, Loader2 } from "lucide-react";
import type { SessionDiagnostic } from "@coverse/core";
import type { AdapterSummary, DriverSummary, UiSession } from "../../shared/types.js";
import type { I18nMessages } from "@/lib/i18n";
import { api, ApiClientError } from "@/lib/api";
import { agentLabel, cn } from "@/lib/utils";
import { AgentGlyph } from "./AgentGlyph";
import { ModelPicker } from "./ModelPicker";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

interface HandoffDialogProps {
  open: boolean;
  session: UiSession | null;
  adapters: AdapterSummary[];
  drivers: DriverSummary[];
  t: I18nMessages;
  onOpenChange: (open: boolean) => void;
  onHandedOff: (session: UiSession) => void;
}

export function HandoffDialog({
  open,
  session,
  adapters,
  drivers,
  t,
  onOpenChange,
  onHandedOff,
}: HandoffDialogProps) {
  const [to, setTo] = React.useState("");
  const [model, setModel] = React.useState("");
  const [cwd, setCwd] = React.useState("");
  const [materialize, setMaterialize] = React.useState(true);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<SessionDiagnostic | null>(null);

  React.useEffect(() => {
    if (!open || !session) return;
    setError(null);
    setModel("");
    setMaterialize(true);
    setCwd(session.cwd);
    const enabledExport = adapters.filter((a) => a.enabled && a.capabilities.export);
    const availableOther = drivers.find(
      (d) => d.available && d.id !== session.agent && enabledExport.some((a) => a.id === d.id),
    );
    const anyOther = enabledExport.find((a) => a.id !== session.agent);
    setTo(availableOther?.id ?? anyOther?.id ?? enabledExport[0]?.id ?? "");
  }, [open, session, drivers, adapters]);

  if (!session) return null;

  const targetDriver = drivers.find((d) => d.id === to);
  const targetModels = targetDriver?.models ?? [];

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!to || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await api.handoffSession(session.id, {
        to,
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        materialize,
      });
      onHandedOff(created);
      onOpenChange(false);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.diagnostic
          : { code: "HANDOFF_ERROR", path: "/handoff", message: String(err), severity: "error" },
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={next => {if (!submitting) onOpenChange(next);}}>
      <DialogContent data-testid="handoff-dialog" hideClose={submitting} className="max-h-[90vh] max-w-[460px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t.handoffSession}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3.5">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <div className="flex h-8 items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-2.5 text-[13px] text-[var(--text-secondary)]">
              <AgentGlyph agent={session.agent} className="h-3.5 w-3.5" />
              <span className="truncate">{agentLabel(session.agent)}</span>
            </div>

            <ArrowRight className="h-3.5 w-3.5 text-[var(--text-tertiary)]" />

            <Select
              value={to}
              onValueChange={(next) => {
                setTo(next);
                setModel("");
              }}
            >
              <SelectTrigger aria-label="Target agent" data-testid="handoff-to-select">
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

          <p className="text-xs text-[var(--text-secondary)]">{materialize && targetDriver?.available ? t.expectedNative : t.expectedBundle}</p>
          <details className="cv-options" open={error?.path === "/cwd" || undefined}><summary>{t.moreOptions}</summary>
          <div className="flex items-center gap-1.5">
            <Input
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              placeholder={t.workspaceDirectory}
              aria-label={t.workspaceDirectory}
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
            testId="handoff-model-picker"
          />

          {targetDriver?.available && (
            <label className="flex items-center justify-between rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-2.5 py-2 text-[12px] text-[var(--text-secondary)] cursor-pointer select-none">
              <span>{t.syncToTarget}</span>
              <input
                type="checkbox"
                checked={materialize}
                onChange={(e) => setMaterialize(e.target.checked)}
                className="h-3.5 w-3.5 accent-[#5e6ad2] cursor-pointer"
              />
            </label>
          )}

          </details>
          {to === "antigravity" && materialize && targetDriver?.available && <p className="text-xs text-[var(--text-secondary)]">{t.desktopHint}</p>}
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-[#e5484d]/30 bg-[#e5484d]/[0.08] px-3 py-2 text-[12px] text-[#e5484d]"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0">
                <span className="font-mono font-medium">{error.code}</span>
                <span className="mx-1.5 opacity-40">·</span>
                <span>{error.message}</span>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" disabled={submitting} onClick={() => onOpenChange(false)}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={submitting || !to} data-testid="handoff-submit-btn">
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>{t.continueIn(agentLabel(to))}</span>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
