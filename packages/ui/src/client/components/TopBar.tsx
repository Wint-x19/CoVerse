import { ArrowRight, ArrowRightLeft, PanelLeft, PanelRight } from "lucide-react";
import type { UiSession } from "../../shared/types.js";
import type { I18nMessages } from "@/lib/i18n";
import { api } from "@/lib/api";
import { agentLabel, cn } from "@/lib/utils";
import { AgentGlyph } from "./AgentGlyph";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface TopBarProps {
  session: UiSession | null;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  t: I18nMessages;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onOpenHandoff: () => void;
}

export function TopBar({
  session,
  sidebarOpen,
  inspectorOpen,
  t,
  onToggleSidebar,
  onToggleInspector,
  onOpenHandoff,
}: TopBarProps) {
  const handoff = session?.handoff;
  const canHandoff = Boolean(session && !session.readOnly && (session.messages.length > 0 || session.handoff));
  const isMac = api.platform === "darwin";

  return (
    <header
      data-testid="topbar"
      className={cn(
        "cv-drag flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-app)] pl-3",
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
            <AgentGlyph agent={session.agent} className="text-[var(--text-secondary)]" />
            <span className="truncate font-medium text-[var(--text-primary)]" data-testid="session-title">
              {session.title}
            </span>
            {handoff && (
              <span className="hidden sm:inline-flex items-center gap-1 font-mono text-[11.5px] text-[var(--text-tertiary)]">
                <span>{agentLabel(handoff.from)}</span>
                <ArrowRight className="h-3 w-3" />
                <span>{agentLabel(handoff.to)}</span>
              </span>
            )}
          </div>
        ) : (
          <span className="text-[13px] font-medium text-[var(--text-secondary)]">{t.newSession}</span>
        )}
      </div>

      <div className="cv-no-drag flex items-center gap-1.5">
        {handoff && (
          <button
            type="button"
            onClick={onToggleInspector}
            data-testid="ledger-pill"
            aria-label={t.ledger}
            className={cn(
              "inline-flex h-7 items-center gap-2 rounded-md border px-2 font-mono text-[11.5px] transition-colors cursor-pointer",
              inspectorOpen
                ? "border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                : "border-[var(--border-subtle)] bg-[var(--bg-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]",
            )}
          >
            <span className="flex items-center gap-1" title={t.dropped}>
              <span className={cn("h-1.5 w-1.5 rounded-full", handoff.losses.dropped > 0 ? "bg-[#e5484d]" : "bg-[var(--status-muted)]")} />
              {handoff.losses.dropped}
            </span>
            <span className="flex items-center gap-1" title={t.downgraded}>
              <span className={cn("h-1.5 w-1.5 rounded-full", handoff.losses.downgraded > 0 ? "bg-[#e5a93b]" : "bg-[var(--status-muted)]")} />
              {handoff.losses.downgraded}
            </span>
            <span className="flex items-center gap-1" title={t.approximated}>
              <span className={cn("h-1.5 w-1.5 rounded-full", handoff.losses.approximated > 0 ? "bg-[#5e6ad2]" : "bg-[var(--status-muted)]")} />
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
            className="gap-1.5"
          >
            <ArrowRightLeft className="h-3 w-3" />
            <span>{t.handoff}</span>
          </Button>
        )}

        {session && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t.inspector}
                data-testid="inspector-toggle-btn"
                onClick={onToggleInspector}
                className={cn(inspectorOpen && "bg-[var(--bg-elevated)] text-[var(--text-primary)]")}
              >
                <PanelRight className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t.inspector}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  );
}
