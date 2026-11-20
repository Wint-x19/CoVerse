import * as React from "react";
import { ArrowRightLeft, Cpu, FileUp, PanelRight, Plus, Search } from "lucide-react";
import type { UiSession } from "../../shared/types.js";
import { agentLabel, cn } from "@/lib/utils";
import { AgentGlyph } from "./AgentGlyph";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

interface CommandPaletteProps {
  open: boolean;
  sessions: UiSession[];
  hasActiveSession: boolean;
  canHandoff: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onImport: () => void;
  onHandoff: () => void;
  onToggleInspector: () => void;
  onOpenEnvironment: () => void;
}

interface PaletteItem {
  id: string;
  label: string;
  meta?: string;
  icon: React.ReactNode;
  onSelect: () => void;
}

export function CommandPalette({
  open,
  sessions,
  hasActiveSession,
  canHandoff,
  onOpenChange,
  onSelectSession,
  onNewSession,
  onImport,
  onHandoff,
  onToggleInspector,
  onOpenEnvironment,
}: CommandPaletteProps) {
  const [query, setQuery] = React.useState("");
  const [selectedIndex, setSelectedIndex] = React.useState(0);

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
    }
  }, [open]);

  const items = React.useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      {
        id: "action-new",
        label: "New session",
        icon: <Plus className="h-3.5 w-3.5 text-[#8a8f98]" />,
        onSelect: () => {
          onNewSession();
          onOpenChange(false);
        },
      },
      {
        id: "action-import",
        label: "Import session file",
        icon: <FileUp className="h-3.5 w-3.5 text-[#8a8f98]" />,
        onSelect: () => {
          onOpenChange(false);
          onImport();
        },
      },
    ];

    if (canHandoff) {
      actions.push({
        id: "action-handoff",
        label: "Handoff active session",
        icon: <ArrowRightLeft className="h-3.5 w-3.5 text-[#8a8f98]" />,
        onSelect: () => {
          onOpenChange(false);
          onHandoff();
        },
      });
    }

    if (hasActiveSession) {
      actions.push({
        id: "action-inspector",
        label: "Toggle inspector",
        icon: <PanelRight className="h-3.5 w-3.5 text-[#8a8f98]" />,
        onSelect: () => {
          onOpenChange(false);
          onToggleInspector();
        },
      });
    }

    actions.push({
      id: "action-env",
      label: "Drivers & adapters",
      icon: <Cpu className="h-3.5 w-3.5 text-[#8a8f98]" />,
      onSelect: () => {
        onOpenChange(false);
        onOpenEnvironment();
      },
    });

    const sessionItems: PaletteItem[] = sessions.map((session) => ({
      id: `session-${session.id}`,
      label: session.title,
      meta: agentLabel(session.agent),
      icon: <AgentGlyph agent={session.agent} className="text-[#8a8f98]" />,
      onSelect: () => {
        onSelectSession(session.id);
        onOpenChange(false);
      },
    }));

    const all = [...actions, ...sessionItems];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (item) =>
        item.label.toLowerCase().includes(q) || (item.meta ? item.meta.toLowerCase().includes(q) : false),
    );
  }, [
    query,
    sessions,
    hasActiveSession,
    canHandoff,
    onNewSession,
    onImport,
    onHandoff,
    onToggleInspector,
    onOpenEnvironment,
    onSelectSession,
    onOpenChange,
  ]);

  React.useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((prev) => (items.length ? (prev + 1) % items.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((prev) => (items.length ? (prev - 1 + items.length) % items.length : 0));
    } else if (event.key === "Enter" && items[selectedIndex]) {
      event.preventDefault();
      items[selectedIndex]!.onSelect();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        data-testid="command-palette"
        className="top-[24%] translate-y-0 max-w-[480px] overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <div className="flex items-center gap-2 border-b border-white/[0.07] px-3.5 h-11">
          <Search className="h-3.5 w-3.5 text-[#6d727c]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Jump to session or action…"
            aria-label="Search commands and sessions"
            autoFocus
            className="flex-1 bg-transparent text-[13.5px] text-[#f7f8f8] placeholder:text-[#5b6069] focus:outline-none"
          />
          <kbd className="font-mono text-[10.5px] text-[#555a63]">ESC</kbd>
        </div>

        <div className="max-h-[300px] overflow-y-auto p-1.5">
          {items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={item.onSelect}
              className={cn(
                "flex h-8 w-full items-center justify-between gap-2 rounded-md px-2.5 text-[13px] transition-colors cursor-pointer",
                index === selectedIndex ? "bg-[#1a1c22] text-[#f7f8f8]" : "text-[#a8aeb8]",
              )}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                {item.icon}
                <span className="truncate">{item.label}</span>
              </span>
              {item.meta && <span className="shrink-0 font-mono text-[11px] text-[#6d727c]">{item.meta}</span>}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
