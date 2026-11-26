import * as React from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
import type { LossItem } from "@coverse/core";
import type { BundleDetailResponse, UiSession } from "../../shared/types.js";
import type { I18nMessages } from "@/lib/i18n";
import { api } from "@/lib/api";
import { agentLabel, cn, formatBytes } from "@/lib/utils";
import { Button } from "./ui/button";
import { FileLink } from "./FileViewer";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

interface InspectorDrawerProps {
  open: boolean;
  session: UiSession | null;
  t: I18nMessages;
  onClose: () => void;
  onSessionUpdated: (session: UiSession) => void;
}

function formatCommand(command:string, args:string[]) {
  const windows = api.platform === "win32";
  function quote(value:string) {
    if (/^[a-zA-Z0-9_.:/@-]+$/.test(value)) return value;
    return "'" + value.replaceAll("'",windows ? "''" : "'\\''") + "'";
  }
  return (windows && quote(command) !== command ? "& " : "") + [command,...args].map(quote).join(" ");
}

function CopyButton({value,t}: {value:string; t:I18nMessages}) {
  const [status,setStatus] = React.useState<"idle" | "done" | "error">("idle");
  React.useEffect(() => {setStatus("idle");},[value]);
  return <button type="button" className="cv-action inline-flex items-center gap-1" onClick={async () => {
    try {await navigator.clipboard.writeText(value);setStatus("done");} catch {setStatus("error");}
  }}>{status === "done" ? <Check size={13}/> : <Copy size={13}/>} {status === "error" ? t.copyFailed : t.copy}</button>;
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

export function InspectorDrawer({ open, session, t, onClose, onSessionUpdated }: InspectorDrawerProps) {
  const [tab,setTab] = React.useState("ledger");
  const [detail,setDetail] = React.useState<BundleDetailResponse | null>(null);
  const [error,setError] = React.useState("");
  const [native,setNative] = React.useState("");
  const [syncing,setSyncing] = React.useState(false);
  const handoff = session?.handoff;
  const heading = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => { if (open) heading.current?.focus({preventScroll:true}); },[open]);
  React.useEffect(() => {
    if (!open || !session || !handoff) return;
    let active = true;
    setError(""); setNative(""); setDetail(null);
    api.getBundle(handoff.bundleId).then(result => {if(active) setDetail(result);})
      .catch(cause => {if(active) setError(String(cause.message ?? cause));});
    api.nativeResume(session.id).then(result => {if(active && result) setNative(formatCommand(result.command,result.args));})
      .catch(cause => {if(active) setError(String(cause.message ?? cause));});
    return () => {active=false;};
  },[open,session?.id,session?.targetSessionId,handoff?.bundleId]);
  if (!open || !session || !handoff) return null;
  const bundleCommand = formatCommand("coverse",["run","--agent",handoff.to,"--bundle",handoff.bundlePath,"--cwd",session.cwd,"--prompt","..."]);
  const desktop = session.agent === "antigravity";
  const pending = desktop && !handoff.desktopSessionId || session.bundlePending && !handoff.desktopFirst;
  async function sync() {
    setError("");setSyncing(true);
    try {onSessionUpdated(await api.materializeSession(session!.id));}
    catch (cause) {setError(cause instanceof Error ? cause.message : String(cause));}
    finally {setSyncing(false);}
  }
  return <section aria-label={t.detailsTitle} data-testid="inspector-drawer" className="cv-details">
    <div className="cv-details-inner">
      <header className="flex items-center justify-between gap-3"><h2 tabIndex={-1} ref={heading}>{t.detailsTitle}</h2>
        <button className="cv-action" onClick={onClose}>{t.stay} →</button></header>
      <section className="cv-resume">
        <h3>{t.continueIn(agentLabel(session.agent))}</h3>
        <p>{t.resumeHere} <code>{session.cwd}</code><CopyButton value={session.cwd} t={t}/></p>
        <div><strong>{t.nativeCli}</strong>{native ? <p><code data-testid="native-command">{native}</code><CopyButton value={native} t={t}/></p> :
          <p>{t.cliPending}</p>}</div>
        {desktop && <div><strong>{t.desktopCopy}</strong><p>{handoff.desktopSessionId ? t.desktopReady : handoff.desktopError?.code === "DESKTOP_OPEN" ? t.closeDesktop : t.desktopPending}</p>
          {handoff.desktopSessionId && <p>{session.title} · <code>{handoff.desktopSessionId}</code></p>}</div>}
        {pending && <Button variant="secondary" size="sm" disabled={syncing} onClick={() => void sync()} data-testid="inspector-sync-btn">
          <RefreshCw size={13} className={syncing ? "animate-spin" : ""}/>{syncing ? t.syncing : desktop && (handoff.desktopFirst || !session.bundlePending) ? t.desktopSync : t.syncNow}</Button>}
        {handoff.materializationError && <p role="alert">{handoff.materializationError.message}</p>}
        {handoff.desktopError && handoff.desktopError.code !== "DESKTOP_OPEN" && <p role="alert">{handoff.desktopError.message}</p>}
      </section>
      {error && <p role="alert">{error}</p>}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>{(["ledger","context","files"] as const).map(key =>
          <TabsTrigger key={key} value={key} data-testid={"inspector-tab-"+key}>{t[key]}</TabsTrigger>)}</TabsList>
        <TabsContent value="ledger" data-testid="inspector-ledger" className="space-y-4 py-4">
          {(["dropped","downgraded","approximated"] as const).map(kind =>
            <LedgerSection key={kind} title={t[kind]} tone={kind} items={handoff.ledger[kind]}/>)}
          {handoff.diagnostics.map((d,i) => <p key={i}>{d.code} · {d.message}</p>)}
        </TabsContent>
        <TabsContent value="context"><div className="my-3 flex justify-between">{t.turns(handoff.statistics.turns)} · {formatBytes(handoff.statistics.utf8Bytes)}
          {detail && <CopyButton value={detail.context} t={t}/>}</div><pre className="whitespace-pre-wrap break-words">{detail?.context ?? (error || t.loading)}</pre></TabsContent>
        <TabsContent value="files"><p className="my-2 break-all"><code>{handoff.bundlePath}</code><CopyButton value={handoff.bundlePath} t={t}/></p><ul>{handoff.files.map(file => <li key={file.path} className="cv-change-row">
          <FileLink target={{path:file.path,scope:"bundle"}}>{file.path}</FileLink><span>{formatBytes(file.bytes)}</span></li>)}</ul><details className="cv-options"><summary>CoVerse CLI</summary><code className="break-all">{bundleCommand}</code><CopyButton value={bundleCommand} t={t}/></details></TabsContent>
      </Tabs>
    </div>
  </section>;
}
