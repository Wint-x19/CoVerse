import * as React from "react";
import { ArrowUp, FileUp, Folder, FolderOpen, Square } from "lucide-react";
import type { DriverSummary } from "../../shared/types.js";
import type { I18nMessages } from "@/lib/i18n";
import { api } from "@/lib/api";
import { agentLabel, cn, shortPath } from "@/lib/utils";
import { AgentGlyph } from "./AgentGlyph";
import { ModelPicker } from "./ModelPicker";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface ComposerProps {
  agent: string;
  agentLocked: boolean;
  drivers: DriverSummary[];
  model: string;
  cwd: string;
  running: boolean;
  centered?: boolean;
  value:string;
  onDraft:(value:string) => void;
  busy:boolean;
  t: I18nMessages;
  onAgentChange: (agent: string) => void;
  onModelChange: (model: string) => void;
  onCwdChange: (cwd: string) => void;
  onSend: (prompt: string) => void;
  onStop: () => void;
  onConfigure:() => void;
  onImportClick: () => void;
}

export function Composer({
  agent,
  agentLocked,
  drivers,
  model,
  cwd,
  running,
  centered = false, value, onDraft, busy,
  t,
  onAgentChange,
  onModelChange,
  onCwdChange,
  onSend,
  onStop,onConfigure,
  onImportClick,
}: ComposerProps) {
  const [cwdDraft, setCwdDraft] = React.useState(cwd);
  const [cwdOpen, setCwdOpen] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    setCwdDraft(cwd);
  }, [cwd]);

  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  const currentDriver = drivers.find((d) => d.id === agent);
  const canSend = Boolean(value.trim() && !busy && currentDriver?.available);
  const submit = () => {
    if (canSend) onSend(value);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const models = currentDriver?.models ?? [];

  return (
    <div
      data-testid="composer"
      className={cn(
        "w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)] transition-colors focus-within:border-[var(--border-strong)]",
        centered ? "max-w-[680px]" : "max-w-[740px]",
      )}
    >
      {currentDriver && !currentDriver.available && <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs">
        <span>{agentLabel(agent)} CLI · {t.unavailable}</span><button type="button" className="cv-action" onClick={onConfigure}>{t.driverConfig}</button>
      </div>}
      <textarea
        ref={textareaRef}
        rows={centered ? 3 : 2}
        value={value}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={running}
        placeholder={t.messageAgent(agentLabel(agent))}
        aria-label={t.messageAgent(agentLabel(agent))}
        data-testid="composer-input"
        className="w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[14px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none disabled:opacity-60"
      />

      <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {agentLocked ? (
            <div
              data-testid="composer-agent-locked"
              className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-2 text-[12px] text-[var(--text-secondary)]"
            >
              <AgentGlyph agent={agent} className="h-3.5 w-3.5" />
              <span>{agentLabel(agent)}</span>
            </div>
          ) : (
            <Select value={agent} onValueChange={onAgentChange}>
              <SelectTrigger
                aria-label="Agent"
                data-testid="composer-agent-select"
                className="h-7 w-auto shrink-0 gap-1.5 whitespace-nowrap border-transparent bg-transparent px-2 text-[12px] text-[var(--text-secondary)] hover:border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <span className="flex items-center gap-1.5 whitespace-nowrap">
                  <AgentGlyph agent={agent} className="h-3.5 w-3.5" />
                  <SelectValue />
                </span>
              </SelectTrigger>
              <SelectContent>
                {drivers.map((driver) => (
                  <SelectItem key={driver.id} value={driver.id}>
                    <span className="flex items-center gap-2">
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          driver.available ? "bg-[#3ecf8e]" : "bg-[var(--status-muted)]",
                        )}
                      />
                      <span>{agentLabel(driver.id)}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* Auto-discovered Model Picker */}
          <ModelPicker
            value={model}
            models={models}
            t={t}
            onChange={onModelChange}
            testId="composer-model-btn"
          />

          {/* Working directory popover */}
          <Popover open={cwdOpen} onOpenChange={setCwdOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="composer-cwd-btn"
                title={cwd}
                className="hidden sm:inline-flex h-7 min-w-0 flex-1 max-w-[200px] items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                <Folder className="h-3 w-3 shrink-0" />
                <span className="truncate font-mono text-[11.5px]">{shortPath(cwd)}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-80 p-2.5">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (cwdDraft.trim()) onCwdChange(cwdDraft.trim());
                  setCwdOpen(false);
                }}
                className="flex flex-col gap-2"
              >
                <Input
                  value={cwdDraft}
                  onChange={(event) => setCwdDraft(event.target.value)}
                  placeholder={t.workspaceDirectory}
                  aria-label={t.workspaceDirectory}
                  data-testid="composer-cwd-input"
                  className="font-mono text-[12px]"
                  autoFocus
                />
                <div className="flex justify-between gap-1.5">
                  <Button
                    type="button"
                    variant="secondary"
                    size="xs"
                    onClick={async () => {
                      const picked = await api.pickDirectory(cwdDraft || cwd).catch(() => null);
                      if (picked) {
                        setCwdDraft(picked);
                        onCwdChange(picked);
                        setCwdOpen(false);
                      }
                    }}
                  >
                    <FolderOpen className="h-3 w-3" />
                    <span>{t.browse}</span>
                  </Button>
                  <Button type="submit" size="xs">
                    {t.apply}
                  </Button>
                </div>
              </form>
            </PopoverContent>
          </Popover>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t.importSession}
                data-testid="composer-import-btn"
                onClick={onImportClick}
              >
                <FileUp className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t.importSession}</TooltipContent>
          </Tooltip>

          {running ? (
            <Button
              type="button"
              variant="secondary"
              size="icon"
              aria-label={t.stopMessage}
              data-testid="composer-stop-btn"
              onClick={onStop}
              className="h-7 w-7 rounded-md"
            >
              <Square className="h-3 w-3 fill-current" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              aria-label={t.sendMessage}
              data-testid="composer-send-btn"
              disabled={!canSend}
              onClick={submit}
              className="h-7 w-7 rounded-md"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
