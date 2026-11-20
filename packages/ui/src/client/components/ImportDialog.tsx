import * as React from "react";
import { FileUp, Loader2, RefreshCw, Search } from "lucide-react";
import type { LocalSessionRef, PickedFile } from "../../shared/types.js";
import type { I18nMessages } from "@/lib/i18n";
import { api } from "@/lib/api";
import { agentLabel, cn, formatBytes, relativeTime, shortPath } from "@/lib/utils";
import { AgentGlyph } from "./AgentGlyph";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

interface ImportDialogProps {
  open: boolean;
  t: I18nMessages;
  onOpenChange: (open: boolean) => void;
  onSelectLocalSession: (session: LocalSessionRef) => void;
  onPickedFiles: (files: PickedFile[]) => void;
}

const AGENT_FILTERS = ["all", "codex", "claude-code", "antigravity"] as const;

export function ImportDialog({
  open,
  t,
  onOpenChange,
  onSelectLocalSession,
  onPickedFiles,
}: ImportDialogProps) {
  const [sessions, setSessions] = React.useState<LocalSessionRef[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [agentFilter, setAgentFilter] = React.useState<string>("all");
  const [query, setQuery] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listLocalSessions();
      setSessions(list);
    } catch {
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!open) return;
    setQuery("");
    void load();
  }, [open, load]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((item) => {
      if (agentFilter !== "all" && item.agent !== agentFilter) return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.id.toLowerCase().includes(q) ||
        (item.cwd ? item.cwd.toLowerCase().includes(q) : false)
      );
    });
  }, [sessions, agentFilter, query]);

  const handleBrowseFiles = async () => {
    const picked = await api.pickSessionFiles().catch(() => []);
    if (picked.length > 0) {
      onOpenChange(false);
      onPickedFiles(picked);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="import-dialog" className="max-w-[580px] p-0 overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3 pr-10">
          <DialogHeader className="p-0 pr-0">
            <DialogTitle>{t.importSession}</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="icon" onClick={() => void load()} disabled={loading} aria-label={t.refresh}>
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void handleBrowseFiles()} data-testid="import-browse-btn">
              <FileUp className="h-3.5 w-3.5" />
              <span>{t.selectFilesButton}</span>
            </Button>
          </div>
        </div>

        {/* Agent filter + search */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5">
          <div className="inline-flex items-center rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-0.5">
            {AGENT_FILTERS.map((id) => (
              <button
                key={id}
                type="button"
                data-testid={`local-filter-${id}`}
                onClick={() => setAgentFilter(id)}
                className={cn(
                  "h-6 rounded-[4px] px-2 text-[11.5px] font-medium transition-colors cursor-pointer",
                  agentFilter === id
                    ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                )}
              >
                {id === "all" ? t.all : agentLabel(id)}
              </button>
            ))}
          </div>

          <div className="flex h-7 w-48 items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-2">
            <Search className="h-3 w-3 text-[var(--text-tertiary)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.filterSessionsPlaceholder}
              className="flex-1 min-w-0 bg-transparent text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none"
            />
          </div>
        </div>

        {/* Discovered local sessions list */}
        <div className="max-h-[380px] overflow-y-auto p-2" data-testid="local-sessions-list">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-[12.5px] text-[var(--text-secondary)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{t.loading}</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center text-[12.5px] text-[var(--text-tertiary)]">
              {t.noLocalSessions}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {filtered.map((item) => (
                <button
                  key={`${item.agent}:${item.path}`}
                  type="button"
                  data-testid={`local-session-${item.id}`}
                  onClick={() => {
                    onOpenChange(false);
                    onSelectLocalSession(item);
                  }}
                  className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--bg-hover)] cursor-pointer"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2.5">
                    <AgentGlyph agent={item.agent} className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px] text-[var(--text-primary)]">{item.title}</span>
                        {item.active && (
                          <span className="shrink-0 font-mono text-[10px] text-[#e5a93b]">{t.activeDb}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 font-mono text-[11px] text-[var(--text-tertiary)]">
                        <span>{agentLabel(item.agent)}</span>
                        {item.cwd && (
                          <>
                            <span>·</span>
                            <span className="truncate">{shortPath(item.cwd, 2)}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-col items-end font-mono text-[11px] text-[var(--text-tertiary)]">
                    <span>{relativeTime(item.updatedAt)}</span>
                    <span>{formatBytes(item.size)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
