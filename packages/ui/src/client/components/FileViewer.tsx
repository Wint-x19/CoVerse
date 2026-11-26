import * as React from "react";
import Markdown, {defaultUrlTransform} from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FilePreview, FileScope, UiSession, ChatMessage } from "../../shared/types.js";
import { api } from "@/lib/api";
import { fileReference, fileTokens, linkFilePaths, locateQuote, type FileReference } from "@/lib/file-references";
import {reviewSegments} from "@/lib/review-directives";
import type { I18nMessages } from "@/lib/i18n";
import { FileText, Folder, GitCompareArrows, PanelRightClose, X } from "lucide-react";
import {DiffPreview} from "./DiffPreview";
import type {RecordedFileChange} from "@coverse/core";
import type {RecordedAsset} from "@coverse/core";
import {AssetPreview, imageMime, ReadingPage} from "./AssetPreview";

type Target = FileReference & {scope?: FileScope; asset?: RecordedAsset; messageId?: string; documentUri?:string; change?: RecordedFileChange; side?: string; occurrence?:string};
const RestorePosition = React.createContext(false);
const FileContext = React.createContext<(target: Target) => void>(() => {});
export const MessageOrigin = React.createContext<string | undefined>(undefined);

export function FileLink({target, children}: {target: Target; children: React.ReactNode}) {
  const open = React.useContext(FileContext);
  const origin = React.useContext(MessageOrigin);
  return <button type="button" className="cursor-pointer break-all text-left text-[var(--accent-text)] hover:underline"
    title={target.path} onClick={() => open(origin ? {...target,messageId:origin} : target)}>{children}</button>;
}

export function MessageAssets({assets}: {assets?: readonly RecordedAsset[] | undefined}) {
  return assets?.map((asset,i) => {
    const local = asset.location === "project" || asset.location === "attachment";
    const label = asset.label || (local || asset.location === "remote" ? asset.value : asset.mediaType);
    const thumb = asset.location === "embedded" && imageMime(asset.mediaType) && asset.value.startsWith("data:" + asset.mediaType + ";base64,");
    return <div className="my-2" key={i}><FileLink target={local ?
      {path:asset.value,scope:asset.location === "attachment" ? "attachment" : "project",...(asset.sourceUri ? {documentUri:asset.sourceUri} : {})} : {path:label,asset}}>
      {thumb && <img loading="lazy" alt={label} src={asset.value} className="mb-1 max-h-44 max-w-full rounded object-contain"/>}
      {label}
    </FileLink>{asset.description && <p className="text-xs text-[var(--text-secondary)]">{asset.description}</p>}</div>;
  });
}

export function MessageMarkdown({text}: {text: string}) {
  return <>{reviewSegments(text).map((part, index) => "text" in part
    ? <Markdown key={index} remarkPlugins={[remarkGfm]} rehypePlugins={[linkFilePaths]}
    urlTransform={(url, key) => (key === "href" || key === "src") && fileReference(url) ? url : defaultUrlTransform(url)}
    components={{a: ({href, children}) => {
      const target = href && fileReference(href, true);
      if (target) return <FileLink target={target}>{children}</FileLink>;
      return /^https?:\/\//i.test(href ?? "")
        ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>;
    }, img: ({src,alt}) => {
      if (typeof src !== "string") return <span>{alt}</span>;
      const ref = fileReference(src,true);
      if (ref) return <FileLink target={ref}>{alt || ref.path}</FileLink>;
      return /^https?:\/\//i.test(src) ? <img src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer"/> : <span>{alt}</span>;
    }}}>{part.text}</Markdown>
    : <section key={index} className="my-2 rounded-md border border-[var(--border-subtle)] p-3">
      <strong>{part.title}</strong><p>{part.body}</p>
      <FileLink target={{path:part.file, ...(part.start ? {line:part.start} : {}),...(part.end ? {endLine:part.end} : {})}}>
        {part.file}{part.start ? ":" + part.start : ""}{part.end && part.end !== part.start ? "–" + part.end : ""}
      </FileLink>
    </section>)}</>;
}

export function UrlText({text}: {text:string}) {
  return <>{text.split(/(https?:\/\/[^\s<>"\]]+)/gi).map((part,i) => {
    if (!/^https?:\/\//i.test(part)) return part;
    const href = part.replace(/[.,;:!?，。；！）]+$/u,"");
    return <React.Fragment key={i}><a href={href} target="_blank" rel="noreferrer" className="text-[var(--accent-text)] hover:underline">{href}</a>{part.slice(href.length)}</React.Fragment>;
  })}</>;
}

export function UserText({text}: {text: string}) {
  // Keep prompts verbatim, including instructions that happen to look like HTML or Markdown.
  const parts = text.split(/(\[[^\]\n]+\]\((?:<[^>\n]+>|[^)\s]+)\))/g);
  return <>{parts.map((part, index) => {
    const link = /^\[[^\]\n]+\]\((?:<([^>\n]+)>|([^)\s]+))\)$/.exec(part);
    const target = link && fileReference(link[1] ?? link[2]!, true);
    if (target) return <FileLink key={index} target={target}>{part}</FileLink>;
    const href = link?.[1] ?? link?.[2];
    if (href && /^https?:\/\//i.test(href)) return <a key={index} href={href} target="_blank" rel="noreferrer" className="text-[var(--accent-text)] hover:underline">{part}</a>;
    return <React.Fragment key={index}>{fileTokens(part).map((item, i) => item.reference
      ? <FileLink key={i} target={item.reference}>{item.text}</FileLink> : <UrlText key={i} text={item.text}/>)}</React.Fragment>;
  })}</>;
}

function Preview({sessionId, target, open, t}: {
  sessionId: string; target: Target; open: (target: Target) => void; t: I18nMessages;
}) {
  const [result, setResult] = React.useState<FilePreview | string | null>(null);
  const [pickedPath,setPickedPath] = React.useState("");
  React.useEffect(() => {
    let active = true;
    api.previewFile(sessionId, target.path, target.scope ?? "project")
      .then(file => { if (active) setResult(file); })
      .catch(error => { if (active) setResult(String(error.message ?? error)); });
    return () => { active = false; };
  }, [sessionId, target.path, target.scope]);
  if (result === null) return <p>{t.loading}</p>;
  if (typeof result === "string") return <div className="space-y-3"><p role="alert">{result}</p>
    <div className="flex gap-3 text-xs text-[var(--accent-text)]">
      <button type="button" onClick={async () => {
        try { const chosen = await api.locateFile(sessionId); if (chosen) {setPickedPath(chosen.path);setResult(chosen);} }
        catch (error) {setResult(error instanceof Error ? error.message : String(error));}
      }}>{t.locateFile}</button>
      <button type="button" onClick={async () => {
        try { await api.revealFile(sessionId,target.path,target.scope ?? "project"); }
        catch (error) {setResult(error instanceof Error ? error.message : String(error));}
      }}>{t.revealFile}</button>
    </div></div>;
  if (result.kind === "media") return <AssetPreview url={result.url} type={result.mediaType} label={result.path} t={t}/>;
  if (result.kind === "directory") return <ul>{result.entries.map(entry => <li key={entry}>
    <button type="button" className="cursor-pointer hover:underline" onClick={() =>
      open({path: result.path + "/" + entry,scope:target.scope ?? "project"})}>{entry}</button></li>)}</ul>;
  if (/\.md$/i.test(target.path) && !target.line && !target.quote)
    return <div className="cv-prose"><MessageMarkdown text={result.content}/></div>;
  return <>{pickedPath && <p className="mb-2 break-all text-xs text-[var(--text-secondary)]">{pickedPath}</p>}
    <HistoricalText text={result.content} target={target} t={t}/></>;
}

function HistoricalText({text,target,t}: {text:string;target:Target;t:I18nMessages}) {
  const selected = React.useRef<HTMLDivElement>(null);
  const restoring = React.useContext(RestorePosition);
  const lines = text.split(/\r\n|\n|\r/);
  const located = target.quote ? locateQuote(text, target.quote, target.line) : target.line;
  React.useEffect(() => { if (located && !restoring) selected.current?.scrollIntoView({block:"center"}); }, [text,located,target,restoring]);
  const line = located ?? 1;
  // Keep very large text previews selectable without mounting a DOM element for each line.
  const index = Math.min(line - 1, lines.length - 1);
  const count = target.quote && located ? target.quote.trimEnd().split(/\r\n|\n|\r/).length :
    Math.max(1,(target.endLine ?? line) - line + 1);
  const end = Math.min(lines.length,index + count);
  function renderLines(start:number,stop:number) {
    if (lines.length > 4000) return <pre>{lines.slice(start,stop).join("\n") || " "}</pre>;
    return lines.slice(start,stop).map((value,i) =>
      <span className="cv-source-line" data-number={start+i+1} key={start+i}>{value || " "}{i+start+1 < stop ? "\n" : ""}</span>);
  }
  return <div className="font-mono text-xs whitespace-pre">
    {line > lines.length && <p role="status">{t.missingLine(line, lines.length)}</p>}
    {target.quote && located === undefined && <aside className="my-2 whitespace-pre-wrap border-l pl-2">
      <p role="status">{t.quoteMissing}</p><pre>{target.quote}</pre>
    </aside>}
    {index > 0 && renderLines(0,index)}
    <div ref={selected} data-file-line={index + 1} className={located ? "bg-[var(--bg-hover)]" : undefined}>
      {renderLines(index,end)}
    </div>
    {end < lines.length && renderLines(end,lines.length)}
  </div>;
}

type FileTab = {key:string; target:Target};
type TabState = {tabs:FileTab[]; active:string};
const EMPTY_TABS:TabState = {tabs:[],active:""};
const WorkspaceContext = React.createContext<{
  state:TabState;
  activate:(key:string) => void;
  closeTab:(key:string) => void;
  open:(target:Target, parent?:Target) => void;
  pages:Map<string,number>;
  scroll:Map<string,number>;
} | null>(null);

function tabKey(target:Target) {
  const source = target.change ? "diff" : target.asset?.location ?? target.scope ?? "project";
  const version = target.change || target.asset || target.scope === "attachment" ? target.messageId : "";
  return JSON.stringify([source,target.path.replaceAll("\\\\","/"),version,target.occurrence,target.asset?.sourceUri]);
}

export function FileViewer({session, children, onOpen, messages}: {
  session:UiSession | null; children:React.ReactNode; onOpen:() => void; messages:ChatMessage[];
}) {
  const [bySession,setBySession] = React.useState<Record<string,TabState>>({});
  const pages = React.useRef(new Map<string,number>()).current;
  const scroll = React.useRef(new Map<string,number>()).current;
  const id = session?.id ?? "";
  const state = bySession[id] ?? EMPTY_TABS;
  const update = (change:(previous:TabState) => TabState) =>
    setBySession(previous => ({...previous,[id]:change(previous[id] ?? EMPTY_TABS)}));
  const open = (request:Target, parent?:Target) => {
    if (!session) return;
    let target = request;
    if (request.side && request.side !== "file") {
      const origin = messages.findIndex(message => message.id === request.messageId);
      const candidates = messages.slice(0,origin+1).reverse();
      for (const message of candidates) {
        const changes = message.changedFiles?.length ? message.changedFiles : message.tools?.flatMap(tool => tool.changedFiles ?? []) ?? [];
        const matches = changes.filter(change => change.path === request.path);
        if (!matches.length) continue;
        if (matches.length === 1 && matches[0]?.patches?.length) target = {...request,change:matches[0],messageId:message.id};
        break;
      }
    }
    if (!request.scope && !request.asset && !target.change) {
      let uri = request.path;
      const documentUri = parent?.asset?.sourceUri ?? parent?.documentUri;
      if (documentUri) {
        try { uri = new URL(request.path,documentUri).href; } catch { /* Plain project paths also appear in archives. */ }
      }
      const origin = request.messageId ?? parent?.messageId;
      const index = messages.findIndex(message => message.id === origin);
      const ordered = index < 0 ? messages.slice().reverse() :
        [...messages.slice(0,index+1).reverse(),...messages.slice(index+1)];
      const asset = ordered.flatMap(m => [...m.assets ?? [],...m.tools?.flatMap(tool => tool.results?.flatMap(result => result.assets ?? []) ?? []) ?? []]).find(a => a.sourceUri && (a.sourceUri === uri || a.sourceUri === request.path));
      if (asset && (asset.location === "text" || asset.location === "embedded" || asset.location === "remote"))
        target = {...request,path:asset.label ?? uri,asset};
      else if (asset) target = {...request,path:asset.value,scope:asset.location === "attachment" ? "attachment" : "project",...(asset.sourceUri ? {documentUri:asset.sourceUri} : {})};
      else if (documentUri && session.handoff?.files.some(f => f.path === "source/" + request.path))
        target = {...request,scope:"attachment"};
      else if (parent && !parent.asset && !documentUri && !/^(?:[\\/]|[a-z][\w+.-]*:)/i.test(request.path)) {
        const directory = parent.path.replaceAll("\\","/").split("/").slice(0,-1);
        for (const part of request.path.replaceAll("\\","/").split("/")) {
          if (part === "." || !part) continue;
          if (part === ".." && directory.length && directory.at(-1) !== "..") directory.pop();
          else directory.push(part);
        }
        target = {...request,path:directory.join("/"),scope:parent.scope ?? "project"};
      } else target = {...request,path:uri};
      if (origin) target.messageId = origin;
    }
    const key = tabKey(target);
    if (target.line || target.quote) scroll.delete(id + key);
    update(previous => ({
      active:key,
      tabs:previous.tabs.some(tab => tab.key === key) ? previous.tabs.map(tab => tab.key === key ? {key,target} : tab) : [...previous.tabs,{key,target}],
    }));
    onOpen();
  };
  const activate = (key:string) => update(previous => ({...previous,active:key}));
  const closeTab = (key:string) => update(previous => {
    pages.delete(id + key);
    const tabs = previous.tabs.filter(tab => tab.key !== key);
    scroll.delete(id + key);
    return {tabs,active:key === previous.active ? tabs.at(-1)?.key ?? "" : previous.active};
  });
  return <WorkspaceContext.Provider value={{state,activate,closeTab,open,scroll,pages}}>
    <FileContext.Provider value={open}>{children}</FileContext.Provider>
  </WorkspaceContext.Provider>;
}

function ProjectDirectory({sessionId, path, t}: {sessionId:string; path:string; t:I18nMessages}) {
  const [entries, setEntries] = React.useState<string[]>([]);
  const [error,setError] = React.useState("");
  const [loading,setLoading] = React.useState(true);
  React.useEffect(() => {
    let current = true;
    api.previewFile(sessionId,path,"project").then(preview => {
      if (current && preview.kind === "directory") setEntries(preview.entries);
    }).catch(cause => { if (current) setError(String(cause.message ?? cause)); })
      .finally(() => { if (current) setLoading(false); });
    return () => {current=false;};
  },[sessionId,path]);
  if (error) return <p role="alert">{error}</p>;
  if (loading) return <p role="status">{t.loading}</p>;
  return <ul className="cv-tree">{entries.map(entry => {
    const child = path === "." ? entry : path + "/" + entry;
    return <li key={entry}>{entry.endsWith("/") ? <DirectoryNode sessionId={sessionId} path={child.slice(0,-1)} name={entry} t={t}/> :
      <FileLink target={{path:child,scope:"project"}}><FileText size={14}/>{entry}</FileLink>}</li>;
  })}</ul>;
}
function DirectoryNode({name,...props}: {name:string;sessionId:string;path:string;t:I18nMessages}) {
  const [expanded,setExpanded] = React.useState(false);
  return <><button className="cv-tree-row" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
    <Folder size={14}/>{name}</button>{expanded && <ProjectDirectory {...props}/>}</>;
}

function conversationFiles(messages:ChatMessage[]) {
  return messages.flatMap((message,index) => {
    const targets:Target[] = [];
    const add = (target:Target) => targets.push({...target,messageId:message.id});
    const changes = message.changedFiles?.length ? message.changedFiles.map(change => ({change})) :
      message.tools?.flatMap((tool,i) => (tool.changedFiles ?? []).map(change => ({change,occurrence:tool.id ?? String(i)}))) ?? [];
    for (const entry of changes) add({path:entry.change.path,...entry});
    for (const asset of [...message.assets ?? [],...message.tools?.flatMap(tool => tool.results?.flatMap(result => result.assets ?? []) ?? []) ?? []]) {
      if (asset.location === "attachment" || asset.location === "project") add({path:asset.value,scope:asset.location,...asset.sourceUri && {documentUri:asset.sourceUri}});
      else add({path:asset.label ?? asset.sourceUri ?? asset.mediaType,asset});
    }
    const refs = new Map<string,FileReference>();
    const text = message.content.replace(/!?\[[^\]\n]*\]\((?:<([^>\n]+)>|([^)\s]+))\)/g, (_,a:string,b:string) => {
      const ref = fileReference(a ?? b,true);
      if (ref) refs.set(ref.path,ref);
      return " ";
    });
    for (const token of fileTokens(text)) if (token.reference) refs.set(token.reference.path,token.reference);
    for (const review of message.reviews ?? []) refs.set(review.path,{path:review.path});
    for (const ref of refs.values()) if (!targets.some(target => target.path === ref.path)) add(ref);
    return targets.length ? [{id:message.id,number:index+1,targets}] : [];
  });
}

export function FilePanel({session,messages,t,onClose,returnToDetails}: {
  session:UiSession; messages:ChatMessage[]; t:I18nMessages; onClose:() => void; returnToDetails?:() => void;
}) {
  const {state,activate,closeTab,open,scroll,pages} = React.useContext(WorkspaceContext)!;
  const [project,setProject] = React.useState(false);
  const tab = state.tabs.find(item => item.key === state.active);
  const groups = React.useMemo(() => conversationFiles(messages),[messages]);
  const target = tab?.target;
  const pane = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const el = pane.current;
    if (!el || !tab) return;
    const key = session.id + tab.key;
    el.focus({preventScroll:true});
    const saved = scroll.get(key) ?? 0;
    if (!saved) return;
    const restore = () => { el.scrollTop = saved; if (el.scrollTop >= saved-1) observer.disconnect(); };
    const observer = new ResizeObserver(restore);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    restore();
    return () => observer.disconnect();
  },[session.id,tab,scroll]);
  return <aside data-testid="file-panel" aria-label={t.filePanel} className="cv-file-panel">
    <header><strong>{t.filePanel}</strong><button type="button" data-testid="close-file-panel" aria-label={t.dismiss} onClick={onClose}><PanelRightClose size={16}/></button></header>
    {returnToDetails && <button type="button" className="cv-action" onClick={returnToDetails}>← {t.returnDetails}</button>}
    <div className="cv-file-tabs">
      <button type="button" aria-pressed={!tab} onClick={() => activate("")}><Folder size={14}/>{t.files}</button>
      {state.tabs.map(item => <div key={item.key} data-active={item.key === state.active}>
        <button type="button" title={item.target.path} aria-pressed={item.key === state.active} onClick={() => activate(item.key)}>
          {item.target.change ? <GitCompareArrows size={13}/> : <FileText size={13}/>}
          <span>{item.target.path.split(/[\\/]/).at(-1) || item.target.path}</span>
          {item.target.change && <small>#{messages.findIndex(m => m.id === item.target.messageId)+1 || "…"}</small>}
        </button><button type="button" aria-label={t.dismiss + " " + item.target.path} onClick={() => closeTab(item.key)}><X size={12}/></button>
      </div>)}
    </div>
    {tab && target ? <>
      <div className="cv-file-heading"><span>{target.change ? t.historyDiff : target.asset || (target.scope && target.scope !== "project") ? t.archived : t.currentFile}</span>
        <code>{target.path}{target.line ? " · L" + target.line : ""}</code>
        {target.change && <button type="button" className="cv-action" onClick={() => open({path:target.path,scope:"project"})}>{t.openDisk}</button>}</div>
      <div key={tab.key} tabIndex={-1} aria-label={target.path} className="cv-file-body" ref={pane} onScroll={event => scroll.set(session.id + tab.key,event.currentTarget.scrollTop)}>
        <RestorePosition.Provider value={(scroll.get(session.id+tab.key) ?? 0)>0}><ReadingPage.Provider value={{page:pages.get(session.id + tab.key) ?? 1,remember:page => pages.set(session.id + tab.key,page)}}>
        <FileContext.Provider value={request => open(request,target)}><div>
        {target.change ? <DiffPreview change={target.change} target={target} t={t}/> :
          target.asset ? target.asset.location === "text" ? target.asset.mediaType === "text/markdown" && !target.quote && !target.line
            ? <div className="cv-prose"><MessageMarkdown text={target.asset.value}/></div>
            : <HistoricalText text={target.asset.value} target={target} t={t}/>
            : <AssetPreview url={target.asset.value} type={target.asset.mediaType} label={target.path} t={t}/>
          : <Preview sessionId={session.id} target={target} open={request => open(request,target)} t={t}/>}
        </div></FileContext.Provider></ReadingPage.Provider></RestorePosition.Provider>
      </div>
    </> : <>
      <div className="cv-file-switch"><button aria-pressed={!project} onClick={() => setProject(false)}>{t.sessionFiles}</button>
        <button aria-pressed={project} onClick={() => setProject(true)}>{t.projectFiles}</button></div>
      <div className="cv-file-body">{project ? <ProjectDirectory sessionId={session.id} path="." t={t}/> :
        groups.length ? groups.map(group => <section className="cv-tree" key={group.id}><h4>{t.turnLabel} {group.number}</h4>
          {group.targets.map((item,i) => <FileLink key={i} target={item}>{item.change ? <GitCompareArrows size={14}/> : <FileText size={14}/>} {item.path}</FileLink>)}
        </section>) : <p>{t.noFiles}</p>}</div>
    </>}
  </aside>;
}