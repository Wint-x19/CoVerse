import * as React from "react";
import { FileUp, Folder, Loader2, RefreshCw, Search, Settings2 } from "lucide-react";
import type { AdapterSummary, LocalSessionRef, PickedFile, UiSession } from "../../shared/types.js";
import type { I18nMessages } from "@/lib/i18n";
import { api, ApiClientError } from "@/lib/api";
import { agentLabel, cn, formatBytes, relativeTime } from "@/lib/utils";
import { groupByProject } from "@/lib/projects";
import { AgentGlyph } from "./AgentGlyph";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

interface ImportDialogProps {
  open: boolean;
  adapters: AdapterSummary[];
  onImported: (session: UiSession) => void;
  t: I18nMessages;
  onOpenChange: (open: boolean) => void;
  onSelectLocalSession: (session: LocalSessionRef) => void;
  onPickedFiles: (files: PickedFile[]) => void;
}

const sessionKey = (item: LocalSessionRef) => item.agent + ":" + item.path;

export function ImportDialog({
  open,
  adapters,
  onImported,
  t,
  onOpenChange,
  onSelectLocalSession,
  onPickedFiles,
}: ImportDialogProps) {
  const [sessions, setSessions] = React.useState<LocalSessionRef[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [agentFilter, setAgentFilter] = React.useState<string>("all");
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState(new Set<string>());
  const [target, setTarget] = React.useState("");
  const [omitOpaque, setOmitOpaque] = React.useState(false);
  const [progress, setProgress] = React.useState("");
  const [issues, setIssues] = React.useState<string[]>([]);
  const generation = React.useRef(0);

  const adaptersRef = React.useRef(adapters);
  adaptersRef.current = adapters;

  const load = React.useCallback(async (showCached = false) => {
    const current = ++generation.current;
    setLoading(true);
    setIssues([]);
    try {
      if (showCached) {
        const cached = await api.listLocalSessions(undefined, true);
        if (generation.current !== current) return;
        setSessions(cached);
      }
      const enabled = adaptersRef.current.filter(a => a.enabled && a.capabilities.import).map(a => a.id);
      // Capabilities may still be probing executables when the dialog first opens.
      const targets = adaptersRef.current.length ? enabled : [undefined];
      await Promise.all(targets.map(async agent => {
        try {
          const list = await api.listLocalSessions(agent);
          if (generation.current !== current) return;
          setSessions(previous => [...previous.filter(row => agent && row.agent !== agent), ...list]
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
          const keys = new Set(list.map(sessionKey));
          setSelected(previous => new Set([...previous].filter(key =>
            (agent && !key.startsWith(agent + ":")) || keys.has(key))));
        } catch (error) {
          if (generation.current === current) setIssues(previous => [...previous, String(error)]);
        }
      }));
    } catch (error) {
      if (generation.current === current) setIssues([String(error)]);
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!open) return;
    setQuery("");
    setAgentFilter("all");
    setSelected(new Set());
    setTarget("");
    setOmitOpaque(false);
    setIssues([]);
    void load(true);
    return () => { generation.current++; };
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

  function select(items: LocalSessionRef[], checked: boolean) {
    setSelected(previous => {
      const next = new Set(previous);
      for (const item of items) {
        if (checked) next.add(sessionKey(item));
        else next.delete(sessionKey(item));
      }
      return next;
    });
  }

  async function importSelected() {
    const batch = sessions.filter(item => selected.has(sessionKey(item)));
    if (!batch.length || progress) return;
    const messages: string[] = [];
    setIssues([]);
    for (const [index, item] of batch.entries()) {
      setProgress(t.importingBatch(index + 1, batch.length));
      const label = [item.cwd, agentLabel(item.agent), item.title].filter(Boolean).join(" · ");
      try {
        const session = await api.convertSource({
          from: item.agent,
          to: target || item.agent,
          paths: [item.path],
          title: item.title,
          ...(item.cwd ? { cwd: item.cwd } : {}),
          useSourceProject: true,
          materialize: true,
          ...(target && omitOpaque ? {omitOpaque: true} : {}),
        });
        onImported(session);
        select([item], false);
        if (session.handoff?.desktopError) {
          const error = session.handoff.desktopError;
          messages.push(label + " · " + (error.code === "DESKTOP_OPEN" ? t.closeDesktop : error.message));
        } else if (session.bundlePending && !session.handoff?.desktopSessionId) {
          messages.push([label, t.pendingSync, session.handoff?.materializationError?.message].filter(Boolean).join(" · "));
        }
      } catch (error) {
        const detail = error instanceof ApiClientError && error.diagnostic.path === "/cwd"
          ? t.locateProject
          : error instanceof Error ? error.message : String(error);
        messages.push(label + " · " + detail);
      }
    }
    setProgress("");
    setIssues(messages);
    if (!messages.length) onOpenChange(false);
  }

  const handleBrowseFiles = async () => {
    const picked = await api.pickSessionFiles().catch(() => []);
    if (picked.length > 0) {
      onOpenChange(false);
      onPickedFiles(picked);
    }
  };

  return (
    <Dialog open={open} onOpenChange={next => { if (!progress) onOpenChange(next); }}>
      <DialogContent hideClose={Boolean(progress)} data-testid="import-dialog" className="flex h-[min(84vh,800px)] w-[94vw] max-w-[960px] flex-col overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3 pr-10">
          <DialogHeader className="p-0 pr-0">
            <DialogTitle>{t.importSession}</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="icon" onClick={() => void load()} disabled={loading || Boolean(progress)} aria-label={t.refresh}>
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </Button>
            <Button variant="secondary" size="sm" disabled={Boolean(progress)} onClick={() => void handleBrowseFiles()} data-testid="import-browse-btn">
              <FileUp className="h-3.5 w-3.5" />
              <span>{t.selectFilesButton}</span>
            </Button>
          </div>
        </div>

        {/* Agent filter + search */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5">
          <div className="inline-flex items-center rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-0.5">
            {["all", ...adapters.filter(a => a.enabled && a.capabilities.import).map(a => a.id)].map((id) => (
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
        <div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="local-sessions-list" aria-busy={loading}>
          {loading && sessions.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-12 text-[12.5px] text-[var(--text-secondary)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{t.loading}</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center text-[12.5px] text-[var(--text-tertiary)]">
              {t.noLocalSessions}
            </div>
          ) : (
            groupByProject(filtered).map(group => {
              const count = group.sessions.filter(item => selected.has(sessionKey(item))).length;
              return <section key={group.directory} className="mb-2">
                <label className="flex items-center gap-2 rounded bg-[var(--bg-subtle)] px-2.5 py-2 text-xs">
                  <input type="checkbox" disabled={Boolean(progress)}
                    checked={count === group.sessions.length}
                    ref={node => { if (node) node.indeterminate = count > 0 && count < group.sessions.length; }}
                    onChange={e => select(group.sessions, e.target.checked)} />
                  <Folder className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate font-mono" title={group.directory}>{group.directory || t.unknownProject}</span>
                  <span className="ml-auto text-[var(--text-tertiary)]">{group.sessions.length}</span>
                </label>
                {group.sessions.map(item => (
                  <div key={sessionKey(item)} className="flex items-center gap-2 rounded px-2.5 hover:bg-[var(--bg-hover)]">
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 py-2">
                      <input type="checkbox" data-testid={`local-session-${item.id}`}
                        checked={selected.has(sessionKey(item))} disabled={Boolean(progress)}
                        onChange={e => select([item], e.target.checked)} />
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
                          {item.parentSessionId !== undefined && <span>{item.parentSessionId ? t.forkedSession : t.originalSession} · {item.id.slice(0, 13)}</span>}
                        </div>
                      </div>

                      <div className="flex shrink-0 flex-col items-end font-mono text-[11px] text-[var(--text-tertiary)]">
                        <span>{relativeTime(item.updatedAt)}</span>
                        <span>{formatBytes(item.size)}</span>
                      </div>
                    </label>
                    <Button variant="ghost" size="icon" aria-label={t.openIndividually + " · " + item.title}
                      title={t.openIndividually} disabled={Boolean(progress)} onClick={() => {
                        onOpenChange(false);
                        onSelectLocalSession(item);
                      }}><Settings2 className="h-3.5 w-3.5" /></Button>
                  </div>
                ))}
              </section>;
            })
          )}
        </div>
        {issues.length > 0 && <div role="alert" className="max-h-28 shrink-0 overflow-auto px-4 py-2 text-xs text-[var(--text-secondary)]">
          {issues.map((message, i) => <p key={i}>{message}</p>)}
        </div>}
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--border-subtle)] px-4 py-3">
          <label className="flex items-center gap-2 text-xs">
            {t.targetAgent}
            <select value={target} disabled={Boolean(progress)} onChange={e => setTarget(e.target.value)}
              className="rounded border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-2 py-1">
              <option value="">{t.sourceAgents}</option>
              {adapters.filter(a => a.enabled && a.capabilities.export).map(a =>
                <option key={a.id} value={a.id}>{agentLabel(a.id)}</option>)}
            </select>
          </label>
          {target && <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={omitOpaque} disabled={Boolean(progress)} onChange={e => setOmitOpaque(e.target.checked)} />
            {t.omitOpaque}
          </label>}
          {target === "antigravity" && <span className="flex-1 text-xs text-[var(--text-secondary)]">{t.desktopHint}</span>}
          <Button disabled={!selected.size || Boolean(progress)} onClick={() => void importSelected()}>
            {progress || t.importSelected(selected.size)}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
