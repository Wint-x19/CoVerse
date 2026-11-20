import { ArrowRight, ArrowRightLeft, PanelLeft, PanelRight } from "lucide-react";
import type { UiSession } from "../../shared/types.js";
import { api } from "@/lib/api";
import { agentLabel, cn } from "@/lib/utils";
import { AgentGlyph } from "./AgentGlyph";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface TopBarProps {
  session: UiSession | null;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onOpenHandoff: () => void;
}

export function TopBar({
  session,
  sidebarOpen,
  inspectorOpen,
  onToggleSidebar,
  onToggleInspector,
  onOpenHandoff,
}: TopBarProps) {
  const handoff = session?.handoff;
  const canHandoff = Boolean(session && (session.messages.length > 0 || session.handoff));

  const isMac = api.platform === "darwin";

  return (
    <header
      data-testid="topbar"
      className={cn(
        "cv-drag flex h-11 shrink-0 items-center justify-between border-b border-white/[0.07] bg-[#08090a] pl-3",
        isMac ? "pr-3" : "pr-[140px]",
        !sidebarOpen && isMac && "pl-[76px]",
      )}
    >
      <div className="cv-no-drag flex min-w-0 items-center gap-2">
        {!sidebarOpen && (
          <Button variant="ghost" size="icon" aria-label="Show sidebar" onClick={onToggleSidebar}>
            <PanelLeft className="h-3.5 w-3.5" />
          </Button>
        )}

        {session ? (
          <div className="flex min-w-0 items-center gap-2 text-[13px]">
            <AgentGlyph agent={session.agent} className="text-[#8a8f98]" />
            <span className="truncate font-medium text-[#f7f8f8]" data-testid="session-title">
              {session.title}
            </span>
            {handoff && (
              <span className="hidden sm:inline-flex items-center gap-1 font-mono text-[11.5px] text-[#6d727c]">
                <span>{agentLabel(handoff.from)}</span>
                <ArrowRight className="h-3 w-3" />
                <span>{agentLabel(handoff.to)}</span>
              </span>
            )}
          </div>
        ) : (
          <span className="text-[13px] font-medium text-[#8a8f98]">New session</span>
        )}
      </div>

      <div className="cv-no-drag flex items-center gap-1.5">
        {handoff && (
          <button
            type="button"
            onClick={onToggleInspector}
            data-testid="ledger-pill"
            aria-label="Inspect loss ledger"
            className={cn(
              "inline-flex h-7 items-center gap-2 rounded-md border px-2 font-mono text-[11.5px] transition-colors cursor-pointer",
              inspectorOpen
                ? "border-white/[0.15] bg-[#16181d] text-[#f7f8f8]"
                : "border-white/[0.07] bg-[#0e0f12] text-[#8a8f98] hover:border-white/[0.13] hover:text-[#d0d6e0]",
            )}
          >
            <span className="flex items-center gap-1" title="Dropped">
              <span className={cn("h-1.5 w-1.5 rounded-full", handoff.losses.dropped > 0 ? "bg-[#e5484d]" : "bg-[#3f434a]")} />
              {handoff.losses.dropped}
            </span>
            <span className="flex items-center gap-1" title="Downgraded">
              <span className={cn("h-1.5 w-1.5 rounded-full", handoff.losses.downgraded > 0 ? "bg-[#e5a93b]" : "bg-[#3f434a]")} />
              {handoff.losses.downgraded}
            </span>
            <span className="flex items-center gap-1" title="Approximated">
              <span className={cn("h-1.5 w-1.5 rounded-full", handoff.losses.approximated > 0 ? "bg-[#5e6ad2]" : "bg-[#3f434a]")} />
              {handoff.losses.approximated}
            </span>
          </button>
        )}

        {canHandoff && (
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenHandoff}
            data-testid="handoff-btn"
            className="gap-1.5 text-[#d0d6e0]"
          >
            <ArrowRightLeft className="h-3 w-3" />
            <span>Handoff</span>
          </Button>
        )}

        {session && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Toggle inspector"
                data-testid="inspector-toggle-btn"
                onClick={onToggleInspector}
                className={cn(inspectorOpen && "bg-white/[0.07] text-[#f7f8f8]")}
              >
                <PanelRight className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Inspector</TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  );
}
