import * as React from "react";
import { FileUp } from "lucide-react";
import type {
  AdapterSummary,
  AppSettings,
  DriverSummary,
  LocalSessionRef,
  PickedFile,
  ToolActivity,
  UiSession,
} from "../shared/types.js";
import { api, ApiClientError } from "@/lib/api";
import { getMessages } from "@/lib/i18n";
import { agentLabel, cn, filesToPayloads } from "@/lib/utils";
import { AgentGlyph } from "@/components/AgentGlyph";
import { CommandPalette } from "@/components/CommandPalette";
import { Composer } from "@/components/Composer";
import { ConvertDialog, type PendingImportSource } from "@/components/ConvertDialog";
import { DropOverlay } from "@/components/DropOverlay";
import { HandoffDialog } from "@/components/HandoffDialog";
import { ImportDialog } from "@/components/ImportDialog";
import { InspectorDrawer } from "@/components/InspectorDrawer";
import { SettingsView } from "@/components/SettingsView";
import { Sidebar } from "@/components/Sidebar";
import { ThreadView } from "@/components/ThreadView";
import { FileViewer } from "@/components/FileViewer";
import { TopBar } from "@/components/TopBar";
import { TooltipProvider } from "@/components/ui/tooltip";

interface StreamingState {
  sessionId: string;
  text: string;
  tools: ToolActivity[];
}

const INITIAL_SETTINGS: AppSettings = {
  theme: "dark",
  language: "zh-CN",
  disabledAdapters: [],
  driverExecutables: {},
};

export function App() {
  const [settings, setSettings] = React.useState<AppSettings>(INITIAL_SETTINGS);
  const [adapters, setAdapters] = React.useState<AdapterSummary[]>([]);
  const [drivers, setDrivers] = React.useState<DriverSummary[]>([]);
  const [defaultCwd, setDefaultCwd] = React.useState("");
  const [sessions, setSessions] = React.useState<UiSession[]>([]);
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null);

  // Draft state for a fresh unsaved session
  const [draftAgent, setDraftAgent] = React.useState("claude-code");
  const [draftModel, setDraftModel] = React.useState("");
  const [draftCwd, setDraftCwd] = React.useState("");

  // Layout & modals
  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  const [inspectorOpen, setInspectorOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [handoffOpen, setHandoffOpen] = React.useState(false);
  const [refreshingCaps, setRefreshingCaps] = React.useState(false);

  // Drag & drop / import conversion
  const [dragging, setDragging] = React.useState(false);
  const dragCounter = React.useRef(0);
  const [pendingSource, setPendingSource] = React.useState<PendingImportSource | null>(null);
  const [convertOpen, setConvertOpen] = React.useState(false);

  // Streaming execution
  const [streaming, setStreaming] = React.useState<StreamingState | null>(null);
  const [bannerError, setBannerError] = React.useState<string | null>(null);

  const t = React.useMemo(() => getMessages(settings.language), [settings.language]);

  // Apply light/dark theme class to <html>
  React.useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    root.lang = settings.language;
  }, [settings.theme, settings.language]);

  const loadCapabilities = React.useCallback(async (refresh = false) => {
    setRefreshingCaps(true);
    try {
      const caps = await api.capabilities(refresh);
      setAdapters(caps.adapters);
      setDrivers(caps.drivers);
      setDefaultCwd(caps.defaultCwd);
      setDraftCwd((prev) => prev || caps.defaultCwd);
      setDraftAgent((prev) => {
        const prevDriver = caps.drivers.find((d) => d.id === prev);
        if (prevDriver?.available) return prev;
        const firstAvailable = caps.drivers.find((d) => d.available);
        return firstAvailable?.id ?? caps.drivers[0]?.id ?? prev;
      });
    } catch (error) {
      setBannerError(error instanceof Error ? error.message : "Failed to load capabilities");
    } finally {
      setRefreshingCaps(false);
    }
  }, []);

  const loadSessions = React.useCallback(async () => {
    try {
      const list = await api.listSessions();
      setSessions(list);
    } catch (error) {
      setBannerError(error instanceof Error ? error.message : "Failed to load sessions");
    }
  }, []);

  const loadSettings = React.useCallback(async () => {
    try {
      const loaded = await api.getSettings();
      setSettings(loaded);
    } catch {
      // Keep defaults
    }
  }, []);

  React.useEffect(() => {
    void loadSettings();
    void loadCapabilities();
    void loadSessions();
  }, [loadSettings, loadCapabilities, loadSessions]);

  const handleUpdateSettings = React.useCallback(
    async (patch: Partial<AppSettings>) => {
      try {
        const updated = await api.updateSettings(patch);
        setSettings(updated);
        if ("disabledAdapters" in patch || "driverExecutables" in patch) {
          await loadCapabilities(true);
        }
      } catch (error) {
        setBannerError(error instanceof Error ? error.message : "Failed to update settings");
      }
    },
    [loadCapabilities],
  );

  const activeSession = React.useMemo(
    () => sessions.find((item) => item.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );

  const waitingForDesktop = sessions.filter(session =>
    session.handoff?.desktopError?.code === "DESKTOP_OPEN" && !settings.disabledAdapters.includes(session.agent)
  ).map(session => session.id).join(",");
  React.useEffect(() => {
    if (!waitingForDesktop) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function retry() {
      for (const id of waitingForDesktop.split(",")) {
        if (cancelled) return;
        try {
          const updated = await api.materializeSession(id);
          if (!cancelled && updated.handoff && updated.handoff.desktopError?.code !== "DESKTOP_OPEN") {
            const handoff = updated.handoff;
            setSessions(previous => previous.map(s => s.id === id ? { ...s, handoff } : s));
          }
        } catch (cause) {
          if (!cancelled) setBannerError(cause instanceof Error ? cause.message : String(cause));
          return;
        }
      }
      if (!cancelled) timer = setTimeout(() => void retry(), 5000);
    }
    timer = setTimeout(() => void retry(), 5000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [waitingForDesktop]);

  // Global keyboard shortcuts (Cmd/Ctrl+K, Cmd/Ctrl+,, Escape)
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((prev) => !prev);
      } else if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setSettingsOpen((prev) => !prev);
      } else if (
        event.key === "Escape" &&
        settingsOpen &&
        !paletteOpen &&
        !convertOpen &&
        !importOpen &&
        !handoffOpen
      ) {
        event.preventDefault();
        setSettingsOpen(false);
      } else if (
        event.key === "Escape" &&
        streaming &&
        !convertOpen &&
        !handoffOpen &&
        !paletteOpen &&
        !importOpen &&
        !settingsOpen
      ) {
        event.preventDefault();
        void api.abortSession(streaming.sessionId).catch(() => undefined);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [streaming, convertOpen, handoffOpen, paletteOpen, importOpen, settingsOpen]);

  const openDroppedFiles = React.useCallback(async (fileList: FileList | File[]) => {
    const list = Array.from(fileList);
    if (list.length === 0) return;
    const nativePaths = list.map((file) => api.getPathForFile(file));
    if (nativePaths.every((p) => p.length > 0)) {
      setPendingSource({
        items: list.map((file, index) => ({
          path: nativePaths[index]!,
          name: file.name,
          size: file.size,
        })),
        paths: nativePaths,
      });
      setConvertOpen(true);
      return;
    }
    const payloads = await filesToPayloads(list);
    setPendingSource({
      items: list.map((file, index) => ({
        path: payloads[index]?.path ?? file.name,
        name: file.name,
        size: file.size,
      })),
      files: payloads,
    });
    setConvertOpen(true);
  }, []);

  const handleSelectLocalSession = React.useCallback((ref: LocalSessionRef) => {
    setPendingSource({
      items: [{ path: ref.path, name: ref.title, size: ref.size }],
      paths: [ref.path],
      ...(ref.cwd ? { originalCwd: ref.cwd } : {}),
    });
    setConvertOpen(true);
  }, []);

  const handlePickedFiles = React.useCallback((picked: PickedFile[]) => {
    if (picked.length === 0) return;
    setPendingSource({
      items: picked,
      paths: picked.map((item) => item.path),
    });
    setConvertOpen(true);
  }, []);

  React.useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragCounter.current += 1;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragCounter.current = 0;
      setDragging(false);
      if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
        void openDroppedFiles(event.dataTransfer.files);
      }
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [openDroppedFiles]);

  const upsertLocalSession = React.useCallback((updated: UiSession) => {
    setSessions((prev) => {
      const rest = prev.filter((item) => item.id !== updated.id);
      return [updated, ...rest];
    });
  }, []);

  const handleNewSession = () => {
    setSettingsOpen(false);
    setActiveSessionId(null);
    setInspectorOpen(false);
    setBannerError(null);
  };

  const handleSelectSession = (id: string) => {
    setSettingsOpen(false);
    setActiveSessionId(id);
    setBannerError(null);
    const ref = sessions.find(row => row.id === id)?.reference;
    if (ref && !ref.displayVersion) {
      void api.getSession(id).then(upsertLocalSession).catch(e => setBannerError(e instanceof Error ? e.message : String(e)));
    }
  };

  const handleDeleteSession = async (id: string) => {
    try {
      await api.deleteSession(id);
      setSessions((prev) => prev.filter((item) => item.id !== id));
      if (activeSessionId === id) {
        setActiveSessionId(null);
        setInspectorOpen(false);
      }
    } catch (error) {
      setBannerError(error instanceof Error ? error.message : "Failed to delete session");
    }
  };

  const handleConvertedOrHandedOff = (session: UiSession) => {
    upsertLocalSession(session);
    setSettingsOpen(false);
    setActiveSessionId(session.id);
    setInspectorOpen(Boolean(session.handoff));
    setBannerError(null);
  };

  const handleAgentChange = async (nextAgent: string) => {
    if (!activeSession) {
      setDraftAgent(nextAgent);
      setDraftModel("");
      return;
    }
    try {
      const updated = await api.updateSession(activeSession.id, { agent: nextAgent, model: null });
      upsertLocalSession(updated);
    } catch (error) {
      setBannerError(error instanceof Error ? error.message : "Failed to switch agent");
    }
  };

  const handleModelChange = async (nextModel: string) => {
    if (!activeSession) {
      setDraftModel(nextModel);
      return;
    }
    try {
      const updated = await api.updateSession(activeSession.id, { model: nextModel || null });
      upsertLocalSession(updated);
    } catch (error) {
      setBannerError(error instanceof Error ? error.message : "Failed to update model");
    }
  };

  const handleCwdChange = async (nextCwd: string) => {
    if (!activeSession) {
      setDraftCwd(nextCwd);
      return;
    }
    try {
      const updated = await api.updateSession(activeSession.id, { cwd: nextCwd });
      upsertLocalSession(updated);
      setBannerError(null);
    } catch (error) {
      setBannerError(error instanceof Error ? error.message : "Invalid workspace directory");
    }
  };

  const handleSend = async (prompt: string) => {
    setBannerError(null);
    let target = activeSession;

    try {
      if (!target) {
        target = await api.createSession({
          agent: draftAgent,
          ...(draftModel.trim() ? { model: draftModel.trim() } : {}),
          ...(draftCwd.trim() ? { cwd: draftCwd.trim() } : {}),
        });
        upsertLocalSession(target);
        setActiveSessionId(target.id);
      }

      const optimisticUser = {
        id: `pending_${Date.now()}`,
        role: "user" as const,
        content: prompt,
        createdAt: new Date().toISOString(),
      };
      const sessionId = target.id;
      setSessions((prev) =>
        prev.map((item) =>
          item.id === sessionId
            ? {
                ...item,
                title: item.messages.length === 0 && item.title === "New session" ? prompt.slice(0, 56) : item.title,
                messages: [...item.messages, optimisticUser],
              }
            : item,
        ),
      );

      setStreaming({ sessionId, text: "", tools: [] });

      await api.streamMessage(
        sessionId,
        {
          prompt,
          ...(target.model ? { model: target.model } : {}),
          cwd: target.cwd,
        },
        (event) => {
          if (event.type === "text") {
            setStreaming((prev) =>
              prev && prev.sessionId === sessionId ? { ...prev, text: prev.text + event.text } : prev,
            );
          } else if (event.type === "tool") {
            setStreaming((prev) =>
              prev && prev.sessionId === sessionId
                ? {
                    ...prev,
                    tools: [...prev.tools, { name: event.name, state: event.state, timestamp: new Date().toISOString() }],
                  }
                : prev,
            );
          } else if (event.type === "done") {
            upsertLocalSession(event.session);
          } else if (event.type === "error" && event.session) {
            upsertLocalSession(event.session);
          }
        },
      );
    } catch (error) {
      if (error instanceof ApiClientError) {
        setBannerError(`${error.diagnostic.code}: ${error.diagnostic.message}`);
      } else {
        setBannerError(error instanceof Error ? error.message : "Request failed");
      }
      if (target) {
        const fresh = await api.getSession(target.id).catch(() => null);
        if (fresh) upsertLocalSession(fresh);
      }
    } finally {
      setStreaming(null);
    }
  };

  const handleStop = () => {
    if (!streaming) return;
    void api.abortSession(streaming.sessionId).catch(() => undefined);
  };

  const isRunningActive = Boolean(streaming && activeSession && streaming.sessionId === activeSession.id);
  const showEmptyStage = !activeSession || (activeSession.messages.length === 0 && !activeSession.handoff && !isRunningActive);

  const currentAgent = activeSession ? activeSession.agent : draftAgent;
  const currentModel = activeSession ? (activeSession.model ?? "") : draftModel;
  const currentCwd = activeSession ? activeSession.cwd : (draftCwd || defaultCwd);
  const agentLocked = Boolean(activeSession && (activeSession.targetSessionId || activeSession.handoff));

  return (
    <TooltipProvider delayDuration={250}>
      <FileViewer sessionId={activeSession?.id} t={t}>
      {settingsOpen ? (
        <SettingsView
          settings={settings}
          adapters={adapters}
          drivers={drivers}
          refreshing={refreshingCaps}
          t={t}
          onBack={() => setSettingsOpen(false)}
          onUpdateSettings={handleUpdateSettings}
          onRefreshCapabilities={() => loadCapabilities(true)}
        />
      ) : (
        <div className="flex h-full w-full overflow-hidden bg-[var(--bg-app)] text-[var(--text-primary)]">
          {sidebarOpen && (
            <Sidebar
              sessions={sessions}
              activeSessionId={activeSessionId}
              drivers={drivers}
              runningSessionId={streaming?.sessionId ?? null}
              t={t}
              onSelectSession={handleSelectSession}
              onNewSession={handleNewSession}
              onImportClick={() => setImportOpen(true)}
              onDeleteSession={handleDeleteSession}
              onOpenPalette={() => setPaletteOpen(true)}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          )}

          <div className="flex min-w-0 flex-1 flex-col">
            <TopBar
              session={activeSession}
              sidebarOpen={sidebarOpen}
              inspectorOpen={inspectorOpen}
              t={t}
              onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
              onToggleInspector={() => setInspectorOpen((prev) => !prev)}
              onOpenHandoff={() => setHandoffOpen(true)}
            />

            {bannerError && (
              <div
                role="alert"
                data-testid="banner-error"
                className="flex items-center justify-between border-b border-[#e5484d]/25 bg-[#e5484d]/[0.08] px-4 py-2 text-[12px] text-[#e5484d]"
              >
                <span className="font-mono">{bannerError}</span>
                <button
                  type="button"
                  onClick={() => setBannerError(null)}
                  className="opacity-70 hover:opacity-100 cursor-pointer"
                >
                  {t.dismiss}
                </button>
              </div>
            )}

            <div className="flex min-h-0 flex-1 overflow-hidden">
              <main className="flex min-w-0 flex-1 flex-col">
                {showEmptyStage ? (
                  <div
                    data-testid="empty-stage"
                    className="flex flex-1 flex-col items-center justify-center px-6 pb-16"
                  >
                    <div
                      role="tablist"
                      aria-label="Select agent"
                      className="mb-4 inline-flex items-center rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-0.5"
                    >
                      {drivers.map((driver) => {
                        const selected = currentAgent === driver.id;
                        return (
                          <button
                            key={driver.id}
                            type="button"
                            role="tab"
                            aria-selected={selected}
                            data-testid={`agent-tab-${driver.id}`}
                            onClick={() => void handleAgentChange(driver.id)}
                            className={cn(
                              "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors cursor-pointer",
                              selected
                                ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                            )}
                          >
                            <AgentGlyph agent={driver.id} className="h-3.5 w-3.5" />
                            <span>{agentLabel(driver.id)}</span>
                            <span
                              className={cn(
                                "h-1.5 w-1.5 rounded-full",
                                driver.available ? "bg-[#3ecf8e]" : "bg-[var(--status-muted)]",
                              )}
                            />
                          </button>
                        );
                      })}
                    </div>

                    <Composer
                      centered
                      agent={currentAgent}
                      agentLocked={false}
                      drivers={drivers}
                      model={currentModel}
                      cwd={currentCwd}
                      running={isRunningActive}
                      t={t}
                      onAgentChange={handleAgentChange}
                      onModelChange={handleModelChange}
                      onCwdChange={handleCwdChange}
                      onSend={handleSend}
                      onStop={handleStop}
                      onImportClick={() => setImportOpen(true)}
                    />

                    <button
                      type="button"
                      onClick={() => setImportOpen(true)}
                      data-testid="empty-drop-trigger"
                      className="mt-4 inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 font-mono text-[11.5px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] cursor-pointer"
                    >
                      <FileUp className="h-3.5 w-3.5" />
                      <span>{t.dropHint}</span>
                    </button>
                  </div>
                ) : (
                  <>
                    <ThreadView
                      session={activeSession!}
                      streaming={
                        isRunningActive && streaming ? { text: streaming.text, tools: streaming.tools } : null
                      }
                      t={t}
                      onInspectHandoff={() => setInspectorOpen(true)}
                    />
                    <div className="shrink-0 px-6 pb-5 pt-2 flex justify-center">
                      <Composer
                        agent={currentAgent}
                        agentLocked={agentLocked}
                        drivers={drivers}
                        model={currentModel}
                        cwd={currentCwd}
                        running={isRunningActive}
                        t={t}
                        onAgentChange={handleAgentChange}
                        onModelChange={handleModelChange}
                        onCwdChange={handleCwdChange}
                        onSend={handleSend}
                        onStop={handleStop}
                        onImportClick={() => setImportOpen(true)}
                      />
                    </div>
                  </>
                )}
              </main>

              <InspectorDrawer
                open={inspectorOpen}
                session={activeSession}
                t={t}
                onClose={() => setInspectorOpen(false)}
                onSessionUpdated={upsertLocalSession}
              />
            </div>
          </div>
        </div>
      )}

      <DropOverlay visible={dragging} label={t.dropOverlay} />

      <ImportDialog
        open={importOpen}
        adapters={adapters}
        onImported={handleConvertedOrHandedOff}
        t={t}
        onOpenChange={setImportOpen}
        onSelectLocalSession={handleSelectLocalSession}
        onPickedFiles={handlePickedFiles}
      />

      <ConvertDialog
        open={convertOpen}
        source={pendingSource}
        adapters={adapters}
        drivers={drivers}
        defaultCwd={defaultCwd}
        t={t}
        onOpenChange={setConvertOpen}
        onConverted={handleConvertedOrHandedOff}
      />

      <HandoffDialog
        open={handoffOpen}
        session={activeSession}
        adapters={adapters}
        drivers={drivers}
        t={t}
        onOpenChange={setHandoffOpen}
        onHandedOff={handleConvertedOrHandedOff}
      />

      <CommandPalette
        open={paletteOpen}
        sessions={sessions}
        hasActiveSession={Boolean(activeSession)}
        canHandoff={Boolean(activeSession && (activeSession.messages.length > 0 || activeSession.handoff))}
        t={t}
        onOpenChange={setPaletteOpen}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        onImport={() => setImportOpen(true)}
        onHandoff={() => setHandoffOpen(true)}
        onToggleInspector={() => setInspectorOpen((prev) => !prev)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      </FileViewer>
    </TooltipProvider>
  );
}
