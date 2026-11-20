import { ArrowRight, FileUp, Plus, Search, Trash2 } from "lucide-react";
import type { DriverSummary, UiSession } from "../../shared/types.js";
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
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onImportClick: () => void;
  onDeleteSession: (id: string) => void;
  onOpenPalette: () => void;
  onOpenEnvironment: () => void;
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
  onSelectSession,
  onNewSession,
  onImportClick,
  onDeleteSession,
  onOpenPalette,
  onOpenEnvironment,
}: SidebarProps) {
  return (
    <aside
      data-testid="sidebar"
      className="flex h-full w-[236px] shrink-0 flex-col border-r border-white/[0.07] bg-[#0b0c0e] select-none"
    >
      {/* Header */}
      <div className="flex h-11 items-center justify-between px-3 border-b border-white/[0.06]">
        <div className="flex items-center gap-2 text-[13px] font-semibold tracking-[-0.02em] text-[#f7f8f8]">
          <BrandMark className="text-[#f7f8f8]" />
          <span>CoVerse</span>
        </div>
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Import session"
                data-testid="sidebar-import-btn"
                onClick={onImportClick}
              >
                <FileUp className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Import</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="New session"
                data-testid="sidebar-new-btn"
                onClick={onNewSession}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">New</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Quick switch trigger */}
      <div className="px-2.5 pt-2.5 pb-1.5">
        <button
          type="button"
          onClick={onOpenPalette}
          data-testid="command-palette-trigger"
          className="flex h-7 w-full items-center justify-between rounded-md border border-white/[0.07] bg-[#101114] px-2 text-[12px] text-[#6d727c] transition-colors hover:border-white/[0.12] hover:text-[#9ba1ab] cursor-pointer"
        >
          <span className="flex items-center gap-1.5">
            <Search className="h-3 w-3" />
            <span>Search</span>
          </span>
          <kbd className="font-mono text-[10.5px] text-[#5b6069]">⌘K</kbd>
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
                    ? "bg-[#16181d] text-[#f7f8f8] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
                    : "text-[#8a8f98] hover:bg-white/[0.035] hover:text-[#d0d6e0]",
                )}
              >
                <div className="flex items-center gap-1 shrink-0 text-[#8a8f98]">
                  <AgentGlyph
                    agent={session.agent}
                    className={cn(
                      "h-3.5 w-3.5",
                      active ? "text-[#f7f8f8]" : "text-[#6d727c]",
                      running && "text-[#5e6ad2] animate-pulse",
                    )}
                  />
                  {session.handoff && (
                    <ArrowRight className="h-2.5 w-2.5 text-[#5b6069]" aria-label="Converted session" />
                  )}
                </div>
                <span className="min-w-0 flex-1 truncate">{session.title}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-[#555a63] group-hover:hidden">
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
                  className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-[#6d727c] hover:bg-white/[0.08] hover:text-[#f7f8f8] group-hover:flex cursor-pointer"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Minimal local driver status footer */}
      <button
        type="button"
        onClick={onOpenEnvironment}
        data-testid="environment-trigger"
        className="flex h-10 w-full items-center justify-between border-t border-white/[0.06] px-3 text-[11.5px] text-[#8a8f98] transition-colors hover:bg-white/[0.03] hover:text-[#d0d6e0] cursor-pointer"
      >
        <div className="flex items-center gap-3">
          {drivers.map((driver) => (
            <span
              key={driver.id}
              title={`${agentLabel(driver.id)}${driver.version ? ` · ${driver.version}` : " · unavailable"}`}
              className="flex items-center gap-1.5"
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  driver.available ? "bg-[#3ecf8e]" : "bg-[#3f434a]",
                )}
              />
              <span className={cn(driver.available ? "text-[#b8bec8]" : "text-[#555a63]")}>
                {shortAgentName(driver.id)}
              </span>
            </span>
          ))}
        </div>
      </button>
    </aside>
  );
}
