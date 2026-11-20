import * as React from "react";
import { AlertCircle, ArrowRight, Loader2 } from "lucide-react";
import type { SessionDiagnostic } from "@coverse/core";
import type { AdapterSummary, DriverSummary, UiSession } from "../../shared/types.js";
import { api, ApiClientError } from "@/lib/api";
import { agentLabel, cn } from "@/lib/utils";
import { AgentGlyph } from "./AgentGlyph";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

interface HandoffDialogProps {
  open: boolean;
  session: UiSession | null;
  adapters: AdapterSummary[];
  drivers: DriverSummary[];
  onOpenChange: (open: boolean) => void;
  onHandedOff: (session: UiSession) => void;
}

export function HandoffDialog({
  open,
  session,
  adapters,
  drivers,
  onOpenChange,
  onHandedOff,
}: HandoffDialogProps) {
  const [to, setTo] = React.useState("");
  const [model, setModel] = React.useState("");
  const [cwd, setCwd] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<SessionDiagnostic | null>(null);

  React.useEffect(() => {
    if (!open || !session) return;
    setError(null);
    setModel("");
    setCwd(session.cwd);
    const availableOther = drivers.find((d) => d.available && d.id !== session.agent);
    const anyOther = adapters.find((a) => a.capabilities.export && a.id !== session.agent);
    setTo(availableOther?.id ?? anyOther?.id ?? session.agent);
  }, [open, session, drivers, adapters]);

  if (!session) return null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!to) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await api.handoffSession(session.id, {
        to,
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="handoff-dialog" className="max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Handoff session</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3.5">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <div className="flex h-8 items-center gap-2 rounded-md border border-white/[0.08] bg-[#0b0c0e] px-2.5 text-[13px] text-[#b8bec8]">
              <AgentGlyph agent={session.agent} className="h-3.5 w-3.5 text-[#8a8f98]" />
              <span className="truncate">{agentLabel(session.agent)}</span>
            </div>

            <ArrowRight className="h-3.5 w-3.5 text-[#5b6069]" />

            <Select value={to} onValueChange={setTo}>
              <SelectTrigger aria-label="Target agent" data-testid="handoff-to-select">
                <SelectValue />
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

          <Input
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            placeholder="Workspace directory"
            aria-label="Workspace directory"
            className="font-mono text-[12px]"
          />

          <Input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="Model (optional)"
            aria-label="Model"
            className="font-mono text-[12px]"
          />

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-[#e5484d]/30 bg-[#e5484d]/[0.08] px-3 py-2 text-[12px] text-[#ff878b]"
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
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !to} data-testid="handoff-submit-btn">
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>Continue in {agentLabel(to)}</span>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
