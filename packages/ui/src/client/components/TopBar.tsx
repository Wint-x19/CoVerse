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
  onDetails: () => void;
  t: I18nMessages;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onOpenHandoff: () => void;
}

export function TopBar({
  session,
  sidebarOpen,
  inspectorOpen, onDetails,
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
        {(
          <Button variant="ghost" size="icon" aria-label={t.sessionsLabel} aria-expanded={sidebarOpen} onClick={onToggleSidebar}>
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
            onClick={onDetails}
            data-testid="ledger-pill"
            aria-label={t.ledger}
            className={cn(
              "inline-flex h-7 items-center gap-2 rounded-md border px-2 font-mono text-[11.5px] transition-colors cursor-pointer",
              inspectorOpen
                ? "border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                : "border-[var(--border-subtle)] bg-[var(--bg-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]",
            )}
          >
            <span>{t.detailsTitle}</span>
            {session.bundlePending && !handoff.desktopSessionId && <span>{t.pendingSync}</span>}
            {handoff.desktopError && <span>{t.desktopPending}</span>}
            {(["dropped","downgraded","approximated"] as const).filter(kind => handoff.losses[kind]>0).map(kind =>
              <span key={kind}>{t[kind]} {handoff.losses[kind]}</span>)}
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
                aria-label={t.filePanel} aria-expanded={inspectorOpen}
                data-testid="inspector-toggle-btn"
                onClick={onToggleInspector}
                className={cn(inspectorOpen && "bg-[var(--bg-elevated)] text-[var(--text-primary)]")}
              >
                <PanelRight className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t.filePanel}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  );
}
