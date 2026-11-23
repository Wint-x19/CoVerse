import * as React from "react";
import { FileLink, MessageAssets, MessageMarkdown, MessageOrigin, UserText } from "./FileViewer";
import { AlertCircle, ArrowRight, ChevronDown, ChevronRight, Sparkles, Terminal } from "lucide-react";
import type { ChatMessage, ToolActivity, UiSession } from "../../shared/types.js";
import type { I18nMessages } from "@/lib/i18n";
import { agentLabel, cn } from "@/lib/utils";
import { AgentGlyph } from "./AgentGlyph";
import {conversationBranches, visibleBranch} from "@/lib/branches";

interface StreamingState {
  text: string;
  reasoning:string;
  model?:string;
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
            <details key={`${tool.name}-${index}`} className="font-mono text-[11.5px]">
              <summary className="cursor-pointer">
              <span className="text-[var(--text-primary)]">{tool.name}</span>
              <span className="ml-2 text-[var(--text-tertiary)]">{tool.state}</span>
              </summary>
              <dl className="ml-3 space-y-1 py-2">
                <dt>{t.toolInput}</dt><dd><pre className="max-h-80 overflow-auto whitespace-pre-wrap">{tool.argumentsText ?? t.unrecorded}</pre></dd>
                <dt>{t.toolOutput}</dt><dd>{tool.results?.length ? tool.results.map((result, i) =>
                  <div key={i}><pre className={cn("max-h-80 overflow-auto whitespace-pre-wrap",result.failed && "text-red-500")}>
                    {result.displayText ?? (result.text || t.emptyOutput)}
                  </pre><MessageAssets assets={result.assets}/></div>) : t.unrecorded}</dd>
                {tool.details && <><dt>{t.toolDetails}</dt><dd><pre className="max-h-80 overflow-auto whitespace-pre-wrap">{tool.details}</pre></dd></>}
              </dl>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function ReasoningTrace({ text, t }: { text: string; t: I18nMessages }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="mb-2.5">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-2 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] cursor-pointer"
      >
        <Sparkles className="h-3 w-3" />
        <span>{t.reasoning}</span>
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

function PlanCard({plan,t}: {plan: NonNullable<ChatMessage["plan"]>; t:I18nMessages}) {
  return <section className="my-2 rounded-lg border border-[var(--border-subtle)] p-3">
    <h3 className="mb-2 text-sm font-semibold">{t.plan}</h3>
    {plan.text && <div className="cv-prose"><MessageMarkdown text={plan.text}/></div>}
    <ol className="space-y-2 text-sm">{plan.steps.map((step,i) => <li key={i}>
      <div className="flex items-baseline justify-between gap-3"><span>{step.title}</span>
        {step.status && <span className="shrink-0 text-xs text-[var(--text-secondary)]">{Object.hasOwn(t.taskStates,step.status)
          ? t.taskStates[step.status as keyof typeof t.taskStates] : step.status}</span>}</div>
      {step.detail && <p className="whitespace-pre-wrap text-xs text-[var(--text-secondary)]">{step.detail}</p>}
    </li>)}</ol>
  </section>;
}

function ToolPlans({tools,t}: {tools:ToolActivity[] | undefined;t:I18nMessages}) {
  return tools?.map((tool,i) => tool.plan ? <PlanCard key={i} plan={tool.plan} t={t}/> : null);
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

function Stamp({at,t}: {at:string;t:I18nMessages}) {
  const date = new Date(at);
  return Number.isFinite(date.valueOf()) ? <time dateTime={at} title={at}>{date.toLocaleString(t.locale)}</time> : null;
}
function Metadata({message,t}: {message:ChatMessage;t:I18nMessages}) {
  const stamp = !message.historical || message.recordedTime;
  if (!stamp && !message.usage && message.durationMs === undefined) return null;
  return <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--text-tertiary)]">
    {stamp && <Stamp at={message.createdAt} t={t}/>}
    {message.durationMs !== undefined && <span>{t.duration} {message.durationMs < 1000
      ? message.durationMs + " ms" : Number((message.durationMs/1000).toFixed(2)) + " s"}</span>}
    {message.usage && <>
      {message.usageScope && <span>{t.usageScopes[message.usageScope]}</span>}
      {(Object.keys(t.tokenKinds) as (keyof typeof t.tokenKinds)[]).map(k => message.usage?.[k] !== undefined &&
        <span key={k}>{t.tokenKinds[k]} {message.usage[k]}</span>)}
    </>}
  </div>;
}

function MessageRow({ message, t }: { message: ChatMessage; t: I18nMessages }) {
  if (message.role === "user") {
    return (
      <div data-testid={`message-user-${message.id}`} className="flex justify-end">
        <div className="max-w-[82%] rounded-xl border border-[var(--border-subtle)] bg-[var(--user-bubble)] px-3.5 py-2.5 text-[14px] leading-relaxed text-[var(--text-primary)] whitespace-pre-wrap">
          <UserText text={message.content}/>
          <MessageAssets assets={message.assets}/>
          <ReviewCards reviews={message.reviews} t={t}/>
          <Metadata message={message} t={t}/>
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
        {message.reasoning && <ReasoningTrace text={message.reasoning} t={t} />}
        {message.tools && message.tools.length > 0 && <ToolTrace tools={message.tools} t={t} />}
        <ToolPlans tools={message.tools} t={t}/>
        {message.plan && <PlanCard plan={message.plan} t={t}/>}
        {message.content && message.plan?.text !== message.content && (
          <div className="cv-prose">
            <MessageMarkdown text={message.content}/>
          </div>
        )}

        {message.changedFiles?.length ? <ChangedFiles files={message.changedFiles} t={t} /> : null}
        <MessageAssets assets={message.assets}/>
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

        <Metadata message={message} t={t}/>
      </div>
    </div>
  );
}

const JumpContext = React.createContext<(id:string) => void>(() => {});
const BrowseContext = React.createContext<(id:string) => void>(() => {});

function HistoryEvents({events,t}: {events:ChatMessage["before"];t:I18nMessages}) {
  const jump = React.useContext(JumpContext);
  if (!events?.length) return null;
  return <div className="my-2 space-y-1 border-l border-[var(--border-subtle)] pl-3 text-xs">
    {events.map((event,i) => <details key={event.id + i}>
      <summary className="cursor-pointer text-[var(--text-secondary)]">
        {t.historyKinds[event.kind]}{event.kind === "error" && <span className="ml-2 text-red-500">{event.text.split("\n")[0]}</span>}
        {event.createdAt && <span className="ml-2"><Stamp at={event.createdAt} t={t}/></span>}
      </summary>
      <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words">{event.text}</pre>
      {event.anchorId && <button type="button" className="cursor-pointer text-[var(--accent-text)]" onClick={() => jump(event.anchorId!)}>{t.jumpParent}</button>}
    </details>)}
  </div>;
}

function TimelineMessage({message,t}: {message:ChatMessage;t:I18nMessages}) {
  const jump = React.useContext(JumpContext);
  const browse = React.useContext(BrowseContext);
  const visible = message.content || message.tools?.length || message.reasoning || message.plan || message.changedFiles?.length ||
    message.assets?.length || message.reviews?.length || message.error || message.usage;
  return <MessageOrigin.Provider value={message.id}>
    <div id={"timeline-" + message.id} tabIndex={-1} className="outline-none focus-visible:ring-1">
      <HistoryEvents events={message.before} t={t}/>
      {message.lineage && <div className="mb-1 flex flex-wrap gap-2 text-xs text-[var(--text-tertiary)]">
        {message.lineage.subsession && <span>{t.subsession}</span>}
        {message.lineage.reverted && <span>{t.reverted}</span>}
        {message.lineage.branchId && <span title={message.lineage.branchId}>{message.lineage.branchId}</span>}
        {message.lineage.parentId && <button type="button" className="cursor-pointer text-[var(--accent-text)]"
          onClick={() => jump(message.lineage!.parentId!)}>{t.jumpParent}</button>}
      </div>}
      {(visible || !(message.before || message.after)) && <MessageRow message={message} t={t}/>}
      {message.childBranch && <button type="button" className="cursor-pointer text-xs text-[var(--accent-text)]" onClick={() => browse(message.childBranch!)}>{t.openSubsession}</button>}
      <HistoryEvents events={message.after} t={t}/></div>
  </MessageOrigin.Provider>;
}

export function ThreadView({ session, streaming, t, onInspectHandoff }: ThreadViewProps) {
  const bottomRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [session.messages.length, streaming?.text.length, streaming?.reasoning.length, streaming?.tools.length]);

  const handoff = session.handoff;
  const historicalMessages = session.messages.filter((m) => m.historical);
  const liveMessages = session.messages.filter((m) => !m.historical);
  const branches = conversationBranches(historicalMessages);
  const [selection,setSelection] = React.useState<{sessionId:string; id:string} | null>(null);
  const recent = historicalMessages.slice().reverse().find(m => m.lineage?.branchId && !m.lineage.subsession)?.lineage?.branchId;
  const branchId = selection?.sessionId === session.id ? selection.id : recent ?? branches[0]?.id;
  const jump = (id:string) => {
    if (!session.messages.some(m => m.id === id)) return;
    if (!document.getElementById("timeline-" + id)) setSelection({sessionId:session.id,id:""});
    requestAnimationFrame(() => {
      const element = document.getElementById("timeline-" + id);
      element?.focus({preventScroll:true}); element?.scrollIntoView({block:"center"});
    });
  };

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
    <JumpContext.Provider value={jump}>
    <BrowseContext.Provider value={id => setSelection({sessionId:session.id,id})}>
    <div className="flex-1 overflow-y-auto" data-testid="thread-view">
      <div className="mx-auto flex w-full max-w-[740px] flex-col gap-6 px-6 py-6">
        {branches.length > 1 && <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">{t.browseBranch}
          <select aria-label={t.browseBranch} className="max-w-[75%] rounded border bg-[var(--bg-surface)] p-1"
            value={branchId} onChange={e => setSelection({sessionId:session.id,id:e.target.value})}>
            <option value="">{t.allBranches}</option>
            {branches.map(b => <option key={b.id} value={b.id}>{b.subsession ? t.subsession : b.id} · {b.sample}</option>)}
          </select>
        </label>}
        {visibleBranch(historicalMessages,branchId).map((message) => (
          <TimelineMessage key={message.id} message={message} t={t}/>
        ))}

        {handoffStrip}

        {liveMessages.map((message) => (
          <TimelineMessage key={message.id} message={message} t={t}/>
        ))}

        {streaming && (
          <div data-testid="streaming-message" className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-[11.5px] text-[var(--text-secondary)]">
              <AgentGlyph agent={session.agent} className="h-3.5 w-3.5 text-[#5e6ad2] animate-pulse" />
              <span className="font-medium text-[var(--text-primary)]">{agentLabel(session.agent)}</span>
              {(streaming.model ?? session.model) && <span className="font-mono text-[11px] text-[var(--text-tertiary)]">{streaming.model ?? session.model}</span>}
            </div>
            <div className="pl-[22px]">
              {streaming.reasoning && <ReasoningTrace text={streaming.reasoning} t={t}/>}
              {streaming.tools.length > 0 && <ToolTrace tools={streaming.tools} t={t} />}
              <ToolPlans tools={streaming.tools} t={t}/>
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
    </BrowseContext.Provider></JumpContext.Provider>
  );
}
