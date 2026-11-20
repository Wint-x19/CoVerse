import * as React from "react";
import { ArrowUp, Cpu, FileUp, Folder, Square } from "lucide-react";
import type { DriverSummary } from "../../shared/types.js";
import { agentLabel, cn, shortPath } from "@/lib/utils";
import { AgentGlyph } from "./AgentGlyph";
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
  onAgentChange: (agent: string) => void;
  onModelChange: (model: string) => void;
  onCwdChange: (cwd: string) => void;
  onSend: (prompt: string) => void;
  onStop: () => void;
  onImportClick: () => void;
}

export function Composer({
  agent,
  agentLocked,
  drivers,
  model,
  cwd,
  running,
  centered = false,
  onAgentChange,
  onModelChange,
  onCwdChange,
  onSend,
  onStop,
  onImportClick,
}: ComposerProps) {
  const [value, setValue] = React.useState("");
  const [modelDraft, setModelDraft] = React.useState(model);
  const [cwdDraft, setCwdDraft] = React.useState(cwd);
  const [modelOpen, setModelOpen] = React.useState(false);
  const [cwdOpen, setCwdOpen] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    setModelDraft(model);
  }, [model]);

  React.useEffect(() => {
    setCwdDraft(cwd);
  }, [cwd]);

  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || running) return;
    setValue("");
    onSend(trimmed);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const currentDriver = drivers.find((d) => d.id === agent);

  return (
    <div
      data-testid="composer"
      className={cn(
        "w-full rounded-xl border border-white/[0.09] bg-[#101114] shadow-[0_12px_40px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors focus-within:border-white/[0.17]",
        centered ? "max-w-[680px]" : "max-w-[740px]",
      )}
    >
      <textarea
        ref={textareaRef}
        rows={centered ? 3 : 2}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={running}
        placeholder={`Message ${agentLabel(agent)}…`}
        aria-label="Prompt"
        data-testid="composer-input"
        className="w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[14px] leading-relaxed text-[#f7f8f8] placeholder:text-[#555a63] focus:outline-none disabled:opacity-60"
      />

      <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {/* Agent selector */}
          {agentLocked ? (
            <div
              data-testid="composer-agent-locked"
              className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-white/[0.07] bg-[#0b0c0e] px-2 text-[12px] text-[#b8bec8]"
            >
              <AgentGlyph agent={agent} className="h-3.5 w-3.5 text-[#8a8f98]" />
              <span>{agentLabel(agent)}</span>
            </div>
          ) : (
            <Select value={agent} onValueChange={onAgentChange}>
              <SelectTrigger
                aria-label="Agent"
                data-testid="composer-agent-select"
                className="h-7 w-auto shrink-0 gap-1.5 whitespace-nowrap border-transparent bg-transparent px-2 text-[12px] text-[#b8bec8] hover:border-white/[0.08] hover:bg-white/[0.04]"
              >
                <span className="flex items-center gap-1.5 whitespace-nowrap">
                  <AgentGlyph agent={agent} className="h-3.5 w-3.5 text-[#8a8f98]" />
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
                          driver.available ? "bg-[#3ecf8e]" : "bg-[#3f434a]",
                        )}
                      />
                      <span>{agentLabel(driver.id)}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* Model popover */}
          <Popover open={modelOpen} onOpenChange={setModelOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="composer-model-btn"
                className="inline-flex h-7 min-w-0 max-w-[140px] shrink items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12px] text-[#8a8f98] transition-colors hover:bg-white/[0.05] hover:text-[#d0d6e0] cursor-pointer"
              >
                <Cpu className="h-3 w-3 shrink-0" />
                <span className="truncate font-mono text-[11.5px]">{model || "Default"}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-2.5">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  onModelChange(modelDraft.trim());
                  setModelOpen(false);
                }}
                className="flex flex-col gap-2"
              >
                <Input
                  value={modelDraft}
                  onChange={(event) => setModelDraft(event.target.value)}
                  placeholder="Model name"
                  aria-label="Model name"
                  data-testid="composer-model-input"
                  className="font-mono text-[12px]"
                  autoFocus
                />
                <div className="flex justify-end gap-1.5">
                  {model && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        setModelDraft("");
                        onModelChange("");
                        setModelOpen(false);
                      }}
                    >
                      Reset
                    </Button>
                  )}
                  <Button type="submit" size="xs">
                    Apply
                  </Button>
                </div>
              </form>
            </PopoverContent>
          </Popover>

          {/* Working directory popover */}
          <Popover open={cwdOpen} onOpenChange={setCwdOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="composer-cwd-btn"
                title={cwd}
                className="hidden sm:inline-flex h-7 min-w-0 flex-1 max-w-[200px] items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12px] text-[#8a8f98] transition-colors hover:bg-white/[0.05] hover:text-[#d0d6e0] cursor-pointer"
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
                  placeholder="Absolute directory path"
                  aria-label="Working directory"
                  data-testid="composer-cwd-input"
                  className="font-mono text-[12px]"
                  autoFocus
                />
                <div className="flex justify-end">
                  <Button type="submit" size="xs">
                    Apply
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
                aria-label="Import session file"
                data-testid="composer-import-btn"
                onClick={onImportClick}
              >
                <FileUp className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Import session</TooltipContent>
          </Tooltip>

          {running ? (
            <Button
              type="button"
              variant="secondary"
              size="icon"
              aria-label="Stop"
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
              aria-label="Send"
              data-testid="composer-send-btn"
              disabled={!value.trim() || (currentDriver !== undefined && !currentDriver.available)}
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
