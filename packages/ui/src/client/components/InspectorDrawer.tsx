import * as React from "react";
import { Check, Copy, X } from "lucide-react";
import type { LossItem } from "@coverse/core";
import type { BundleDetailResponse, UiSession } from "../../shared/types.js";
import type { I18nMessages } from "@/lib/i18n";
import { api } from "@/lib/api";
import { cn, formatBytes } from "@/lib/utils";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

interface InspectorDrawerProps {
  open: boolean;
  session: UiSession | null;
  t: I18nMessages;
  onClose: () => void;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable
    }
  };

  return (
    <Button variant="ghost" size="xs" onClick={handleCopy} aria-label={label} className="h-6 px-1.5">
      {copied ? <Check className="h-3 w-3 text-[#3ecf8e]" /> : <Copy className="h-3 w-3" />}
    </Button>
  );
}

function LedgerSection({
  title,
  tone,
  items,
}: {
  title: string;
  tone: "dropped" | "downgraded" | "approximated";
  items: LossItem[];
}) {
  const dotColor =
    tone === "dropped"
      ? items.length > 0
        ? "bg-[#e5484d]"
        : "bg-[var(--status-muted)]"
      : tone === "downgraded"
        ? items.length > 0
          ? "bg-[#e5a93b]"
          : "bg-[var(--status-muted)]"
        : items.length > 0
          ? "bg-[#5e6ad2]"
          : "bg-[var(--status-muted)]";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[11.5px]">
        <span className="flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
          <span className={cn("h-1.5 w-1.5 rounded-full", dotColor)} />
          {title}
        </span>
        <span className="font-mono text-[var(--text-tertiary)]">{items.length}</span>
      </div>
      {items.length > 0 && (
        <div className="flex flex-col gap-1">
          {items.map((item, idx) => (
            <div
              key={`${item.code}-${item.path}-${idx}`}
              className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-2.5 py-2 text-[11.5px]"
            >
              <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                <span className="text-[var(--text-primary)]">{item.code}</span>
                <span className="truncate text-[var(--text-tertiary)]">{item.path}</span>
              </div>
              <div className="mt-1 text-[var(--text-secondary)] leading-snug">{item.reason}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function InspectorDrawer({ open, session, t, onClose }: InspectorDrawerProps) {
  const [bundleDetail, setBundleDetail] = React.useState<BundleDetailResponse | null>(null);
  const bundleId = session?.handoff?.bundleId;

  React.useEffect(() => {
    if (!open || !bundleId) {
      setBundleDetail(null);
      return;
    }
    let active = true;
    api
      .getBundle(bundleId)
      .then((detail) => {
        if (active) setBundleDetail(detail);
      })
      .catch(() => {
        if (active) setBundleDetail(null);
      });
    return () => {
      active = false;
    };
  }, [open, bundleId]);

  if (!open || !session) return null;

  const handoff = session.handoff;
  const cliCommand = handoff
    ? `coverse run --agent ${handoff.to} --bundle ${JSON.stringify(handoff.bundlePath)} --cwd ${JSON.stringify(session.cwd)} --prompt "..."`
    : session.targetSessionId
      ? `coverse run --agent ${session.agent} --session ${session.targetSessionId} --cwd ${JSON.stringify(session.cwd)} --prompt "..."`
      : null;

  return (
    <aside
      data-testid="inspector-drawer"
      className="flex h-full w-[340px] shrink-0 flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-sidebar)]"
    >
      <div className="flex h-11 items-center justify-between border-b border-[var(--border-subtle)] px-3">
        <span className="text-[12.5px] font-medium text-[var(--text-primary)]">{t.inspector}</span>
        <Button variant="ghost" size="icon" aria-label="Close inspector" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex flex-col gap-1.5 border-b border-[var(--border-subtle)] px-3 py-2.5 font-mono text-[11px]">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[var(--text-tertiary)]">cwd</span>
          <span className="truncate text-[var(--text-primary)]" title={session.cwd}>
            {session.cwd}
          </span>
        </div>
        {session.targetSessionId && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[var(--text-tertiary)]">session</span>
            <span className="flex items-center gap-1 min-w-0">
              <span className="truncate text-[var(--text-primary)]">{session.targetSessionId}</span>
              <CopyButton value={session.targetSessionId} label="Copy session ID" />
            </span>
          </div>
        )}
        {handoff && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[var(--text-tertiary)]">mode</span>
            <span className="text-[var(--text-primary)]">injection-bundle</span>
          </div>
        )}
      </div>

      {handoff ? (
        <Tabs defaultValue="ledger" className="flex min-h-0 flex-1 flex-col">
          <div className="px-3 pt-2.5">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="ledger" data-testid="inspector-tab-ledger">
                {t.ledger}
              </TabsTrigger>
              <TabsTrigger value="context" data-testid="inspector-tab-context">
                {t.context}
              </TabsTrigger>
              <TabsTrigger value="files" data-testid="inspector-tab-files">
                {t.files}
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="ledger" className="min-h-0 flex-1 overflow-hidden">
            <ScrollArea className="h-full px-3 py-3">
              <div className="flex flex-col gap-4" data-testid="inspector-ledger">
                <LedgerSection title={t.dropped} tone="dropped" items={handoff.ledger.dropped} />
                <LedgerSection title={t.downgraded} tone="downgraded" items={handoff.ledger.downgraded} />
                <LedgerSection title={t.approximated} tone="approximated" items={handoff.ledger.approximated} />
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="context" className="min-h-0 flex-1 overflow-hidden">
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2 font-mono text-[11px] text-[var(--text-tertiary)]">
                <span>
                  {t.turns(handoff.statistics.turns)} · {formatBytes(handoff.statistics.utf8Bytes)}
                </span>
                {bundleDetail && <CopyButton value={bundleDetail.context} label="Copy context.md" />}
              </div>
              <ScrollArea className="flex-1 px-3 py-2.5">
                <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">
                  {bundleDetail?.context ?? t.loading}
                </pre>
              </ScrollArea>
            </div>
          </TabsContent>

          <TabsContent value="files" className="min-h-0 flex-1 overflow-hidden">
            <ScrollArea className="h-full px-3 py-3">
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  {handoff.files.map((file) => (
                    <div
                      key={file.path}
                      className="flex items-center justify-between gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-2.5 py-1.5 font-mono text-[11px]"
                    >
                      <span className="truncate text-[var(--text-primary)]">{file.path}</span>
                      <span className="shrink-0 text-[var(--text-tertiary)]">{formatBytes(file.bytes)}</span>
                    </div>
                  ))}
                </div>

                {cliCommand && (
                  <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-2.5">
                    <div className="flex items-center justify-between text-[11px] text-[var(--text-tertiary)] mb-1">
                      <span className="font-mono">CLI</span>
                      <CopyButton value={cliCommand} label="Copy CLI command" />
                    </div>
                    <pre className="whitespace-pre-wrap break-all font-mono text-[10.5px] text-[var(--text-secondary)]">
                      {cliCommand}
                    </pre>
                  </div>
                )}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      ) : (
        <div className="p-3">
          {cliCommand && (
            <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-2.5">
              <div className="flex items-center justify-between text-[11px] text-[var(--text-tertiary)] mb-1">
                <span className="font-mono">CLI</span>
                <CopyButton value={cliCommand} label="Copy CLI command" />
              </div>
              <pre className="whitespace-pre-wrap break-all font-mono text-[10.5px] text-[var(--text-secondary)]">
                {cliCommand}
              </pre>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
