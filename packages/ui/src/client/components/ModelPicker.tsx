import * as React from "react";
import { Check, Cpu, Search } from "lucide-react";
import type { ModelOption } from "../../shared/types.js";
import type { I18nMessages } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

interface ModelPickerProps {
  value: string;
  models: ModelOption[];
  t: I18nMessages;
  onChange: (model: string) => void;
  compact?: boolean;
  testId?: string;
}

export function ModelPicker({
  value,
  models,
  t,
  onChange,
  compact = true,
  testId = "model-picker-trigger",
}: ModelPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [customDraft, setCustomDraft] = React.useState("");

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setCustomDraft(value);
    }
  }, [open, value]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q),
    );
  }, [models, query]);

  const selectedModel = models.find((m) => m.id === value);
  const displayLabel = selectedModel ? selectedModel.label : value || t.defaultModel;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {compact ? (
          <button
            type="button"
            data-testid={testId}
            title={value || t.defaultModel}
            className="inline-flex h-7 min-w-0 max-w-[168px] shrink items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer"
          >
            <Cpu className="h-3 w-3 shrink-0" />
            <span className="truncate font-mono text-[11.5px]">{displayLabel}</span>
          </button>
        ) : (
          <button
            type="button"
            data-testid={testId}
            className="flex h-8 w-full items-center justify-between gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-2.5 text-[12.5px] text-[var(--text-primary)] transition-colors hover:border-[var(--border-strong)] cursor-pointer"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Cpu className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
              <span className={cn("truncate font-mono text-[12px]", !value && "text-[var(--text-secondary)]")}>
                {displayLabel}
              </span>
            </span>
            {models.length > 0 && (
              <span className="shrink-0 font-mono text-[10.5px] text-[var(--text-tertiary)]">
                {models.length}
              </span>
            )}
          </button>
        )}
      </PopoverTrigger>

      <PopoverContent className="w-72 p-0 overflow-hidden" align="start">
        {models.length > 4 && (
          <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-2.5 h-9">
            <Search className="h-3.5 w-3.5 text-[var(--text-tertiary)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.filterModelsPlaceholder}
              className="flex-1 bg-transparent text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none"
              autoFocus
            />
          </div>
        )}

        <div className="max-h-[220px] overflow-y-auto p-1">
          <button
            type="button"
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--bg-hover)] cursor-pointer",
              !value ? "text-[var(--text-primary)] font-medium" : "text-[var(--text-secondary)]",
            )}
          >
            <span>{t.defaultModel}</span>
            {!value && <Check className="h-3.5 w-3.5 shrink-0" />}
          </button>

          {filtered.map((item) => {
            const active = value === item.id;
            return (
              <button
                key={item.id}
                type="button"
                data-testid={`model-option-${item.id}`}
                onClick={() => {
                  onChange(item.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] cursor-pointer",
                  active ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] text-[var(--text-primary)]">{item.label}</div>
                  {item.label !== item.id && (
                    <div className="truncate font-mono text-[10.5px] text-[var(--text-tertiary)]">{item.id}</div>
                  )}
                </div>
                {active && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--text-primary)]" />}
              </button>
            );
          })}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onChange(customDraft.trim());
            setOpen(false);
          }}
          className="flex items-center gap-1.5 border-t border-[var(--border-subtle)] p-2"
        >
          <Input
            value={customDraft}
            onChange={(e) => setCustomDraft(e.target.value)}
            placeholder={t.customModelPlaceholder}
            aria-label={t.customModelPlaceholder}
            className="h-7 font-mono text-[11.5px]"
          />
          <Button type="submit" size="xs" className="h-7 shrink-0">
            {t.apply}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
