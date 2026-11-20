import { RefreshCw } from "lucide-react";
import type { AdapterSummary, DriverSummary } from "../../shared/types.js";
import { agentLabel, cn } from "@/lib/utils";
import { AgentGlyph } from "./AgentGlyph";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

interface EnvironmentDialogProps {
  open: boolean;
  adapters: AdapterSummary[];
  drivers: DriverSummary[];
  refreshing: boolean;
  onOpenChange: (open: boolean) => void;
  onRefresh: () => void;
}

export function EnvironmentDialog({
  open,
  adapters,
  drivers,
  refreshing,
  onOpenChange,
  onRefresh,
}: EnvironmentDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="environment-dialog" className="max-w-[540px]">
        <DialogHeader className="flex-row items-center justify-between pr-8">
          <DialogTitle>Drivers &amp; Adapters</DialogTitle>
          <Button variant="ghost" size="xs" onClick={onRefresh} disabled={refreshing} aria-label="Refresh capabilities">
            <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
          </Button>
        </DialogHeader>

        <div className="mt-4 flex flex-col gap-2">
          {drivers.map((driver) => {
            const adapter = adapters.find((a) => a.id === driver.id);
            return (
              <div
                key={driver.id}
                className="flex flex-col gap-1.5 rounded-lg border border-white/[0.07] bg-[#0b0c0e] px-3 py-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-[13px] font-medium text-[#f7f8f8]">
                    <AgentGlyph agent={driver.id} className="text-[#8a8f98]" />
                    <span>{agentLabel(driver.id)}</span>
                  </div>
                  <div className="flex items-center gap-2 font-mono text-[11.5px]">
                    <span className={driver.available ? "text-[#b8bec8]" : "text-[#5b6069]"}>
                      {driver.version ?? "unavailable"}
                    </span>
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        driver.available ? "bg-[#3ecf8e]" : "bg-[#3f434a]",
                      )}
                    />
                  </div>
                </div>

                {adapter && (
                  <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-[#6d727c]">
                    <span>{adapter.supportedVersions.join(", ") || "—"}</span>
                    <span>
                      {[
                        adapter.capabilities.import ? "import" : null,
                        adapter.capabilities.export ? "injection-bundle" : null,
                        adapter.capabilities.nativeResume ? "native-resume" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
