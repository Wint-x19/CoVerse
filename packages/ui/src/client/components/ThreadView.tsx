import * as React from "react";
import { FileLink, MessageMarkdown, UserText } from "./FileViewer";
import { AlertCircle, ArrowRight, ChevronDown, ChevronRight, Sparkles, Terminal } from "lucide-react";
import type { ChatMessage, ToolActivity, UiSession } from "../../shared/types.js";
import type { I18nMessages } from "@/lib/i18n";
import { agentLabel, cn } from "@/lib/utils";
import { AgentGlyph } from "./AgentGlyph";

interface StreamingState {
  text: string;
  tools: ToolActivity[];
}

interface ThreadViewProps {
  session: UiSession;
  streaming: StreamingState | null;
  t: I18nMessages;
  onInspectHandoff: () => void;
}

function ToolTrace({ tools, t }: { tools: ToolActivity[]; t: I18nMessages }) {
  const [open, setOpen] = React.useState(false);
  if (tools.length === 0) return null;

  return (
    <div className="mb-2.5">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-2 py-1 font-mono text-[11.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] cursor-pointer"
      >
        <Terminal className="h-3 w-3" />
        <span>{t.toolCount(tools.length)}</span>
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      {open && (
        <div className="mt-1.5 flex flex-col gap-1 border-l border-[var(--border-subtle)] pl-3">
          {tools.map((tool, index) => (
            <div key={`${tool.name}-${index}`} className="flex items-center gap-2 font-mono text-[11.5px]">
              <span className="text-[var(--text-primary)]">{tool.name}</span>
              <span className="text-[var(--text-tertiary)]">{tool.state}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ReasoningTrace({ text, t, durationMs }: { text: string; t: I18nMessages; durationMs?: number | undefined }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="mb-2.5">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-2 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] cursor-pointer"
      >
        <Sparkles className="h-3 w-3" />
        <span>{durationMs === undefined ? t.reasoning : t.elapsed(Math.floor(durationMs / 60000), Math.floor(durationMs / 1000) % 60)}</span>
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      {open && (
        <div className="mt-1.5 border-l border-[var(--border-subtle)] pl-3 text-[12.5px] leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}

function ChangedFiles({ files, t }: { files: NonNullable<ChatMessage["changedFiles"]>; t: I18nMessages }) {
  const row = (f: typeof files[number]) => <div key={f.path} className="mt-2">
    <div className="flex justify-between gap-4">
      <FileLink target={{path: f.path}}><code>{f.path}</code></FileLink>
      {f.added !== null && f.removed !== null && <span>+{f.added} −{f.removed}</span>}
    </div>
    {f.patches?.length ? <details>
      <summary className="cursor-pointer text-[var(--text-secondary)]">{t.viewDiff}</summary>
      {f.patches.map((patch, index) => <pre key={index} className="my-2 max-h-96 overflow-auto rounded bg-[var(--bg-subtle)] p-2">
        {patch.split("\n").map((line, number) => <span key={number} className={
          line.startsWith("+") ? "text-emerald-600 dark:text-emerald-400" :
          line.startsWith("-") ? "text-red-600 dark:text-red-400" : undefined
        }>{line}{"\n"}</span>)}
      </pre>)}
    </details> : <span className="text-[var(--text-tertiary)]">{f.patches ? t.noChanges : t.diffUnavailable}</span>}
  </div>;
  return <div className="my-2 rounded-md border border-[var(--border-subtle)] p-3 text-xs">
    <span>{t.editedFiles(files.length)}　{files.every(f => f.added !== null && f.removed !== null) &&
      ("+" + files.reduce((n, f) => n + (f.added ?? 0), 0) + " −" + files.reduce((n, f) => n + (f.removed ?? 0), 0))}</span>
    {files.slice(0, 3).map(row)}
    {files.length > 3 && <details className="mt-2"><summary className="cursor-pointer">{t.moreFiles(files.length - 3)}</summary>{files.slice(3).map(row)}</details>}
  </div>;
}

function ReviewCards({reviews, t}: {reviews: ChatMessage["reviews"]; t: I18nMessages}) {
  return reviews?.map((review, index) => <section key={index} className="my-2 rounded-md border border-[var(--border-subtle)] p-3 text-sm">
    <FileLink target={{path:review.path}}>{review.path}</FileLink>
    <p className="my-1 whitespace-pre-wrap">{review.comment}</p>
    {review.selections.map((selection, i) => <div key={i} className="mt-2 border-l pl-2">
      <FileLink target={{path:review.path, ...(selection.text ? {quote:selection.text} : {}),
        ...(selection.start !== undefined ? {line:Math.max(1, selection.start)} : {})}}>
        {t.reviewSide[selection.side]} {selection.start}{selection.end !== undefined && selection.end !== selection.start ? "–" + selection.end : ""}
      </FileLink>
      {selection.text && <pre className="max-h-60 overflow-auto whitespace-pre-wrap">{selection.text}</pre>}
    </div>)}
  </section>);
}

function MessageRow({ message, t }: { message: ChatMessage; t: I18nMessages }) {
  if (message.role === "user") {
    return (
      <div data-testid={`message-user-${message.id}`} className="flex justify-end">
        <div className="max-w-[82%] rounded-xl border border-[var(--border-subtle)] bg-[var(--user-bubble)] px-3.5 py-2.5 text-[14px] leading-relaxed text-[var(--text-primary)] whitespace-pre-wrap">
          <UserText text={message.content}/>
          <ReviewCards reviews={message.reviews} t={t}/>
        </div>
      </div>
    );
  }

  return (
    <div data-testid={`message-assistant-${message.id}`} className="group flex flex-col gap-1">
      <div className="flex items-center gap-2 text-[11.5px] text-[var(--text-tertiary)]">
        <AgentGlyph agent={message.agent ?? ""} className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
        <span className="font-medium text-[var(--text-secondary)]">{agentLabel(message.agent ?? "")}</span>
        {message.model && <span className="font-mono text-[11px]">{message.model}</span>}
      </div>

      <div className="pl-[22px]">
        {message.reasoning && <ReasoningTrace text={message.reasoning} t={t} durationMs={message.durationMs} />}
        {message.tools && message.tools.length > 0 && <ToolTrace tools={message.tools} t={t} />}

        {message.content && (
          <div className="cv-prose">
            <MessageMarkdown text={message.content}/>
          </div>
        )}

        {message.changedFiles?.length ? <ChangedFiles files={message.changedFiles} t={t} /> : null}
        <ReviewCards reviews={message.reviews} t={t}/>
        {message.error && (
          <div
            role="alert"
            data-testid="message-error"
            className={cn(
              "mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px]",
              message.aborted
                ? "border-[var(--border-subtle)] bg-[var(--bg-subtle)] text-[var(--text-secondary)]"
                : "border-[#e5484d]/30 bg-[#e5484d]/[0.08] text-[#e5484d]",
            )}
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0">
              <span className="font-mono text-[11.5px] font-medium">{message.error.code}</span>
              <span className="mx-1.5 opacity-40">·</span>
              <span>{message.error.message}</span>
            </div>
          </div>
        )}

        {message.usage && (
          <div className="mt-2 font-mono text-[11px] text-[var(--text-tertiary)]">
            {[
              message.usage.input !== undefined ? `${message.usage.input} in` : null,
              message.usage.output !== undefined ? `${message.usage.output} out` : null,
              message.usage.cachedInput !== undefined ? `${message.usage.cachedInput} cached` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        )}
      </div>
    </div>
  );
}

export function ThreadView({ session, streaming, t, onInspectHandoff }: ThreadViewProps) {
  const bottomRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [session.messages.length, streaming?.text.length, streaming?.tools.length]);

  const handoff = session.handoff;
  const historicalMessages = session.messages.filter((m) => m.historical);
  const liveMessages = session.messages.filter((m) => !m.historical);

  const handoffStrip = handoff ? (
    <button
      type="button"
      onClick={onInspectHandoff}
      data-testid="handoff-strip"
      className="flex min-h-9 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-3 py-2 text-[12px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] cursor-pointer"
    >
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono">
        <span className="whitespace-nowrap text-[var(--text-primary)]">{agentLabel(handoff.from)}</span>
        <ArrowRight className="h-3 w-3 shrink-0 text-[var(--text-tertiary)]" />
        <span className="whitespace-nowrap text-[var(--text-primary)]">{agentLabel(handoff.to)}</span>
        <span className="text-[var(--text-tertiary)]">·</span>
        <span className="whitespace-nowrap">{t.turns(handoff.desktopFirst ? historicalMessages.filter(m => m.role === "user").length : handoff.statistics.turns)}</span>
        {handoff.to === "antigravity" && (session.targetSessionId || handoff.desktopFirst) && !handoff.desktopSessionId ? (
          <span className="text-[var(--accent-text)]">· {handoff.desktopError?.code === "DESKTOP_OPEN" ? t.closeDesktop : t.desktopPending}</span>
        ) : handoff.desktopSessionId || (handoff.materialized && session.targetSessionId) ? (
          <>
            <span className="text-[var(--text-tertiary)]">·</span>
            <span className="whitespace-nowrap text-[#3ecf8e]">{t.synced}</span>
          </>
        ) : session.bundlePending ? (
          <>
            <span className="text-[var(--text-tertiary)]">·</span>
            <span className="whitespace-nowrap text-[var(--accent-text)]">{t.ready}</span>
          </>
        ) : null}
      </span>
      <span className="flex items-center gap-2.5 font-mono text-[11.5px] whitespace-nowrap">
        <span className={handoff.losses.dropped > 0 ? "text-[#e5484d]" : "text-[var(--text-tertiary)]"}>
          {handoff.losses.dropped} {t.dropped}
        </span>
        <span className={handoff.losses.downgraded > 0 ? "text-[#e5a93b]" : "text-[var(--text-tertiary)]"}>
          {handoff.losses.downgraded} {t.downgraded}
        </span>
      </span>
    </button>
  ) : null;

  return (
    <div className="flex-1 overflow-y-auto" data-testid="thread-view">
      <div className="mx-auto flex w-full max-w-[740px] flex-col gap-6 px-6 py-6">
        {historicalMessages.map((message) => (
          <MessageRow key={message.id} message={message} t={t} />
        ))}

        {handoffStrip}

        {liveMessages.map((message) => (
          <MessageRow key={message.id} message={message} t={t} />
        ))}

        {streaming && (
          <div data-testid="streaming-message" className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-[11.5px] text-[var(--text-secondary)]">
              <AgentGlyph agent={session.agent} className="h-3.5 w-3.5 text-[#5e6ad2] animate-pulse" />
              <span className="font-medium text-[var(--text-primary)]">{agentLabel(session.agent)}</span>
              {session.model && <span className="font-mono text-[11px] text-[var(--text-tertiary)]">{session.model}</span>}
            </div>
            <div className="pl-[22px]">
              {streaming.tools.length > 0 && <ToolTrace tools={streaming.tools} t={t} />}
              {streaming.text ? (
                <div className="cv-prose">
                  <MessageMarkdown text={streaming.text}/>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 py-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#5e6ad2] animate-pulse" />
                  <span className="h-1.5 w-1.5 rounded-full bg-[#5e6ad2]/60 animate-pulse [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-[#5e6ad2]/30 animate-pulse [animation-delay:300ms]" />
                </div>
              )}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
