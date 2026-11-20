import { ArrowRight, FileUp, Plus, Search, Settings, Trash2 } from "lucide-react";
import type { DriverSummary, UiSession } from "../../shared/types.js";
import type { I18nMessages } from "@/lib/i18n";
import { api } from "@/lib/api";
import { agentLabel, cn, relativeTime } from "@/lib/utils";
import { AgentGlyph, BrandMark } from "./AgentGlyph";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface SidebarProps {
  sessions: UiSession[];
  activeSessionId: string | null;
  drivers: DriverSummary[];
  runningSessionId: string | null;
  t: I18nMessages;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onImportClick: () => void;
  onDeleteSession: (id: string) => void;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
}

function shortAgentName(id: string): string {
  if (id === "claude-code") return "Claude";
  if (id === "antigravity") return "AGY";
  if (id === "codex") return "Codex";
  return id;
}

export function Sidebar({
  sessions,
  activeSessionId,
  drivers,
  runningSessionId,
  t,
  onSelectSession,
  onNewSession,
  onImportClick,
  onDeleteSession,
  onOpenPalette,
  onOpenSettings,
}: SidebarProps) {
  return (
    <aside
      data-testid="sidebar"
      className="flex h-full w-[236px] shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sidebar)] select-none"
    >
      {/* Header (draggable native desktop titlebar region) */}
      <div
        className={cn(
          "cv-drag flex h-11 items-center justify-between border-b border-[var(--border-subtle)] pr-3",
          api.platform === "darwin" ? "pl-[76px]" : "pl-3",
        )}
      >
        <div className="flex items-center gap-2 text-[13px] font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
          <BrandMark className="text-[var(--text-primary)]" />
          <span>CoVerse</span>
        </div>
        <div className="cv-no-drag flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t.import}
                data-testid="sidebar-import-btn"
                onClick={onImportClick}
              >
                <FileUp className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t.import}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t.newSession}
                data-testid="sidebar-new-btn"
                onClick={onNewSession}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t.newSession}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Quick switch trigger */}
      <div className="px-2.5 pt-2.5 pb-1.5">
        <button
          type="button"
          onClick={onOpenPalette}
          data-testid="command-palette-trigger"
          className="flex h-7 w-full items-center justify-between rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-[12px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] cursor-pointer"
        >
          <span className="flex items-center gap-1.5">
            <Search className="h-3 w-3" />
            <span>{t.search}</span>
          </span>
          <kbd className="font-mono text-[10.5px] text-[var(--text-tertiary)]">⌘K</kbd>
        </button>
      </div>

      {/* Session list */}
      <ScrollArea className="flex-1 px-2 py-1">
        <div className="flex flex-col gap-0.5" role="list" aria-label="Sessions" data-testid="session-list">
          {sessions.map((session) => {
            const active = session.id === activeSessionId;
            const running = session.id === runningSessionId;
            return (
              <div
                key={session.id}
                role="listitem"
                data-testid={`session-item-${session.id}`}
                data-state={active ? "active" : "inactive"}
                onClick={() => onSelectSession(session.id)}
                className={cn(
                  "group relative flex h-8 items-center gap-2 rounded-md px-2 text-[12.5px] transition-colors cursor-pointer",
                  active
                    ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
                )}
              >
                <div className="flex items-center gap-1 shrink-0">
                  <AgentGlyph
                    agent={session.agent}
                    className={cn(
                      "h-3.5 w-3.5",
                      active ? "text-[var(--text-primary)]" : "text-[var(--text-tertiary)]",
                      running && "text-[#5e6ad2] animate-pulse",
                    )}
                  />
                  {session.handoff && (
                    <ArrowRight className="h-2.5 w-2.5 text-[var(--text-tertiary)]" aria-label="Converted" />
                  )}
                </div>
                <span className="min-w-0 flex-1 truncate">{session.title}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-[var(--text-tertiary)] group-hover:hidden">
                  {relativeTime(session.updatedAt)}
                </span>
                <button
                  type="button"
                  aria-label={`Delete ${session.title}`}
                  data-testid={`delete-session-${session.id}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteSession(session.id);
                  }}
                  className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] group-hover:flex cursor-pointer"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Footer: agent dots + Settings trigger */}
      <div className="flex h-10 w-full items-center justify-between border-t border-[var(--border-subtle)] px-2.5">
        <button
          type="button"
          onClick={onOpenSettings}
          data-testid="environment-trigger"
          className="flex min-w-0 items-center gap-2.5 rounded-md px-1 py-1 text-[11.5px] transition-colors hover:bg-[var(--bg-hover)] cursor-pointer"
        >
          {drivers.map((driver) => (
            <span
              key={driver.id}
              title={`${agentLabel(driver.id)}${driver.version ? ` · ${driver.version}` : ""}`}
              className="flex items-center gap-1"
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  driver.available ? "bg-[#3ecf8e]" : "bg-[var(--status-muted)]",
                )}
              />
              <span className={driver.available ? "text-[var(--text-secondary)]" : "text-[var(--text-tertiary)]"}>
                {shortAgentName(driver.id)}
              </span>
            </span>
          ))}
        </button>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t.settings}
              data-testid="sidebar-settings-btn"
              onClick={onOpenSettings}
              className="h-7 w-7 shrink-0"
            >
              <Settings className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{t.settings}</TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
}
