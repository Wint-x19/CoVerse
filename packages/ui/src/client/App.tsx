import * as React from "react";
import { FileUp } from "lucide-react";
import type {
  AdapterSummary,
  DriverSummary,
  ToolActivity,
  UiSession,
  UploadedFilePayload,
} from "../shared/types.js";
import { api, ApiClientError } from "@/lib/api";
import { agentLabel, cn, filesToPayloads } from "@/lib/utils";
import { AgentGlyph } from "@/components/AgentGlyph";
import { CommandPalette } from "@/components/CommandPalette";
import { Composer } from "@/components/Composer";
import { ConvertDialog } from "@/components/ConvertDialog";
import { DropOverlay } from "@/components/DropOverlay";
import { EnvironmentDialog } from "@/components/EnvironmentDialog";
import { HandoffDialog } from "@/components/HandoffDialog";
import { InspectorDrawer } from "@/components/InspectorDrawer";
import { Sidebar } from "@/components/Sidebar";
import { ThreadView } from "@/components/ThreadView";
import { TopBar } from "@/components/TopBar";
import { TooltipProvider } from "@/components/ui/tooltip";

interface StreamingState {
  sessionId: string;
  text: string;
  tools: ToolActivity[];
}

export function App() {
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
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [environmentOpen, setEnvironmentOpen] = React.useState(false);
  const [handoffOpen, setHandoffOpen] = React.useState(false);
  const [refreshingCaps, setRefreshingCaps] = React.useState(false);

  // Drag & drop conversion
  const [dragging, setDragging] = React.useState(false);
  const dragCounter = React.useRef(0);
  const [pendingFiles, setPendingFiles] = React.useState<UploadedFilePayload[]>([]);
  const [pendingSizes, setPendingSizes] = React.useState<Record<string, number>>({});
  const [convertOpen, setConvertOpen] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Streaming execution
  const [streaming, setStreaming] = React.useState<StreamingState | null>(null);
  const streamAbortRef = React.useRef<AbortController | null>(null);
  const [bannerError, setBannerError] = React.useState<string | null>(null);

  const loadCapabilities = React.useCallback(async () => {
    setRefreshingCaps(true);
    try {
      const caps = await api.capabilities();
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

  React.useEffect(() => {
    void loadCapabilities();
    void loadSessions();
  }, [loadCapabilities, loadSessions]);

  const activeSession = React.useMemo(
    () => sessions.find((item) => item.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );

  // Global keyboard shortcuts (Cmd/Ctrl+K, Escape to abort)
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((prev) => !prev);
      } else if (
        event.key === "Escape" &&
        streaming &&
        !convertOpen &&
        !handoffOpen &&
        !paletteOpen &&
        !environmentOpen
      ) {
        event.preventDefault();
        streamAbortRef.current?.abort();
        void api.abortSession(streaming.sessionId).catch(() => undefined);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [streaming, convertOpen, handoffOpen, paletteOpen, environmentOpen]);

  // Global drag-and-drop listeners
  const openFilesForConversion = React.useCallback(async (fileList: FileList | File[]) => {
    const list = Array.from(fileList);
    if (list.length === 0) return;
    const payloads = await filesToPayloads(list);
    const sizes: Record<string, number> = {};
    list.forEach((file, index) => {
      const key = payloads[index]?.path;
      if (key) sizes[key] = file.size;
    });
    setPendingFiles(payloads);
    setPendingSizes(sizes);
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
        void openFilesForConversion(event.dataTransfer.files);
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
  }, [openFilesForConversion]);

  const upsertLocalSession = React.useCallback((updated: UiSession) => {
    setSessions((prev) => {
      const rest = prev.filter((item) => item.id !== updated.id);
      return [updated, ...rest];
    });
  }, []);

  const handleNewSession = () => {
    setActiveSessionId(null);
    setInspectorOpen(false);
    setBannerError(null);
  };

  const handleSelectSession = (id: string) => {
    setActiveSessionId(id);
    setBannerError(null);
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
    setActiveSessionId(session.id);
    setInspectorOpen(true);
    setBannerError(null);
  };

  const handleAgentChange = async (nextAgent: string) => {
    if (!activeSession) {
      setDraftAgent(nextAgent);
      return;
    }
    try {
      const updated = await api.updateSession(activeSession.id, { agent: nextAgent });
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

      // Optimistic user turn
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

      const abortController = new AbortController();
      streamAbortRef.current = abortController;
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
        abortController.signal,
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        // Reload persisted state after abort
        if (target) {
          const fresh = await api.getSession(target.id).catch(() => null);
          if (fresh) upsertLocalSession(fresh);
        }
      } else if (error instanceof ApiClientError) {
        setBannerError(`${error.diagnostic.code}: ${error.diagnostic.message}`);
      } else {
        setBannerError(error instanceof Error ? error.message : "Request failed");
      }
    } finally {
      streamAbortRef.current = null;
      setStreaming(null);
    }
  };

  const handleStop = () => {
    if (!streaming) return;
    streamAbortRef.current?.abort();
    void api.abortSession(streaming.sessionId).catch(() => undefined);
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  const isRunningActive = Boolean(streaming && activeSession && streaming.sessionId === activeSession.id);
  const showEmptyStage = !activeSession || (activeSession.messages.length === 0 && !activeSession.handoff && !isRunningActive);

  const currentAgent = activeSession ? activeSession.agent : draftAgent;
  const currentModel = activeSession ? (activeSession.model ?? "") : draftModel;
  const currentCwd = activeSession ? activeSession.cwd : (draftCwd || defaultCwd);
  const agentLocked = Boolean(activeSession && (activeSession.targetSessionId || activeSession.handoff));

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex h-full w-full overflow-hidden bg-[#08090a] text-[#f7f8f8]">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          data-testid="hidden-file-input"
          onChange={(event) => {
            if (event.target.files && event.target.files.length > 0) {
              void openFilesForConversion(event.target.files);
              event.target.value = "";
            }
          }}
        />

        {sidebarOpen && (
          <Sidebar
            sessions={sessions}
            activeSessionId={activeSessionId}
            drivers={drivers}
            runningSessionId={streaming?.sessionId ?? null}
            onSelectSession={handleSelectSession}
            onNewSession={handleNewSession}
            onImportClick={triggerFileInput}
            onDeleteSession={handleDeleteSession}
            onOpenPalette={() => setPaletteOpen(true)}
            onOpenEnvironment={() => setEnvironmentOpen(true)}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            session={activeSession}
            sidebarOpen={sidebarOpen}
            inspectorOpen={inspectorOpen}
            onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
            onToggleInspector={() => setInspectorOpen((prev) => !prev)}
            onOpenHandoff={() => setHandoffOpen(true)}
          />

          {bannerError && (
            <div
              role="alert"
              data-testid="banner-error"
              className="flex items-center justify-between border-b border-[#e5484d]/25 bg-[#e5484d]/[0.08] px-4 py-2 text-[12px] text-[#ff878b]"
            >
              <span className="font-mono">{bannerError}</span>
              <button
                type="button"
                onClick={() => setBannerError(null)}
                className="text-[#ff878b]/70 hover:text-[#ff878b] cursor-pointer"
              >
                Dismiss
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
                  {/* Minimal segmented agent bar */}
                  <div
                    role="tablist"
                    aria-label="Select agent"
                    className="mb-4 inline-flex items-center rounded-lg border border-white/[0.08] bg-[#0d0e11] p-0.5"
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
                              ? "bg-[#1a1c22] text-[#f7f8f8] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
                              : "text-[#8a8f98] hover:text-[#d0d6e0]",
                          )}
                        >
                          <AgentGlyph agent={driver.id} className="h-3.5 w-3.5" />
                          <span>{agentLabel(driver.id)}</span>
                          <span
                            className={cn(
                              "h-1.5 w-1.5 rounded-full",
                              driver.available ? "bg-[#3ecf8e]" : "bg-[#3f434a]",
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
                    onAgentChange={handleAgentChange}
                    onModelChange={handleModelChange}
                    onCwdChange={handleCwdChange}
                    onSend={handleSend}
                    onStop={handleStop}
                    onImportClick={triggerFileInput}
                  />

                  <button
                    type="button"
                    onClick={triggerFileInput}
                    data-testid="empty-drop-trigger"
                    className="mt-4 inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 font-mono text-[11.5px] text-[#5b6069] transition-colors hover:bg-white/[0.03] hover:text-[#9ba1ab] cursor-pointer"
                  >
                    <FileUp className="h-3.5 w-3.5" />
                    <span>Drop .jsonl · .zst · .db</span>
                  </button>
                </div>
              ) : (
                <>
                  <ThreadView
                    session={activeSession!}
                    streaming={
                      isRunningActive && streaming ? { text: streaming.text, tools: streaming.tools } : null
                    }
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
                      onAgentChange={handleAgentChange}
                      onModelChange={handleModelChange}
                      onCwdChange={handleCwdChange}
                      onSend={handleSend}
                      onStop={handleStop}
                      onImportClick={triggerFileInput}
                    />
                  </div>
                </>
              )}
            </main>

            <InspectorDrawer
              open={inspectorOpen}
              session={activeSession}
              onClose={() => setInspectorOpen(false)}
            />
          </div>
        </div>

        <DropOverlay visible={dragging} />

        <ConvertDialog
          open={convertOpen}
          files={pendingFiles}
          fileSizes={pendingSizes}
          adapters={adapters}
          drivers={drivers}
          defaultCwd={defaultCwd}
          onOpenChange={setConvertOpen}
          onConverted={handleConvertedOrHandedOff}
        />

        <HandoffDialog
          open={handoffOpen}
          session={activeSession}
          adapters={adapters}
          drivers={drivers}
          onOpenChange={setHandoffOpen}
          onHandedOff={handleConvertedOrHandedOff}
        />

        <EnvironmentDialog
          open={environmentOpen}
          adapters={adapters}
          drivers={drivers}
          refreshing={refreshingCaps}
          onOpenChange={setEnvironmentOpen}
          onRefresh={() => void loadCapabilities()}
        />

        <CommandPalette
          open={paletteOpen}
          sessions={sessions}
          hasActiveSession={Boolean(activeSession)}
          canHandoff={Boolean(activeSession && (activeSession.messages.length > 0 || activeSession.handoff))}
          onOpenChange={setPaletteOpen}
          onSelectSession={handleSelectSession}
          onNewSession={handleNewSession}
          onImport={triggerFileInput}
          onHandoff={() => setHandoffOpen(true)}
          onToggleInspector={() => setInspectorOpen((prev) => !prev)}
          onOpenEnvironment={() => setEnvironmentOpen(true)}
        />
      </div>
    </TooltipProvider>
  );
}
