import * as React from "react";
import { ArrowRightLeft, FileUp, PanelRight, Plus, Search, Settings } from "lucide-react";
import type { UiSession } from "../../shared/types.js";
import type { I18nMessages } from "@/lib/i18n";
import { agentLabel, cn } from "@/lib/utils";
import { AgentGlyph } from "./AgentGlyph";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

interface CommandPaletteProps {
  open: boolean;
  sessions: UiSession[];
  hasActiveSession: boolean;
  canHandoff: boolean;
  t: I18nMessages;
  onOpenChange: (open: boolean) => void;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onImport: () => void;
  onHandoff: () => void;
  onToggleInspector: () => void;
  onOpenSettings: () => void;
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
  t,
  onOpenChange,
  onSelectSession,
  onNewSession,
  onImport,
  onHandoff,
  onToggleInspector,
  onOpenSettings,
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
        label: t.actionNew,
        icon: <Plus className="h-3.5 w-3.5 text-[var(--text-secondary)]" />,
        onSelect: () => {
          onNewSession();
          onOpenChange(false);
        },
      },
      {
        id: "action-import",
        label: t.actionImport,
        icon: <FileUp className="h-3.5 w-3.5 text-[var(--text-secondary)]" />,
        onSelect: () => {
          onOpenChange(false);
          onImport();
        },
      },
    ];

    if (canHandoff) {
      actions.push({
        id: "action-handoff",
        label: t.actionHandoff,
        icon: <ArrowRightLeft className="h-3.5 w-3.5 text-[var(--text-secondary)]" />,
        onSelect: () => {
          onOpenChange(false);
          onHandoff();
        },
      });
    }

    if (hasActiveSession) {
      actions.push({
        id: "action-inspector",
        label: t.actionInspector,
        icon: <PanelRight className="h-3.5 w-3.5 text-[var(--text-secondary)]" />,
        onSelect: () => {
          onOpenChange(false);
          onToggleInspector();
        },
      });
    }

    actions.push({
      id: "action-settings",
      label: t.actionSettings,
      icon: <Settings className="h-3.5 w-3.5 text-[var(--text-secondary)]" />,
      onSelect: () => {
        onOpenChange(false);
        onOpenSettings();
      },
    });

    const sessionItems: PaletteItem[] = sessions.map((session) => ({
      id: `session-${session.id}`,
      label: session.title,
      meta: agentLabel(session.agent) + " · " + session.cwd,
      icon: <AgentGlyph agent={session.agent} className="text-[var(--text-secondary)]" />,
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
    t,
    onNewSession,
    onImport,
    onHandoff,
    onToggleInspector,
    onOpenSettings,
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
        <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3.5 h-11">
          <Search className="h-3.5 w-3.5 text-[var(--text-tertiary)]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t.jumpPlaceholder}
            aria-label={t.jumpPlaceholder}
            autoFocus
            className="flex-1 bg-transparent text-[13.5px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none"
          />
          <kbd className="max-w-[48%] truncate font-mono text-[10.5px] text-[var(--text-tertiary)]">ESC</kbd>
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
                index === selectedIndex
                  ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)]",
              )}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                {item.icon}
                <span className="truncate">{item.label}</span>
              </span>
              {item.meta && <span title={item.meta} className="max-w-[48%] truncate font-mono text-[11px] text-[var(--text-tertiary)]">{item.meta}</span>}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
