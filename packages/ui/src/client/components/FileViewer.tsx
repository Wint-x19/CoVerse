import * as React from "react";
import Markdown, {defaultUrlTransform} from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FilePreview, FileScope, UiSession } from "../../shared/types.js";
import { api } from "@/lib/api";
import { fileReference, fileTokens, linkFilePaths, locateQuote, type FileReference } from "@/lib/file-references";
import {reviewSegments} from "@/lib/review-directives";
import type { I18nMessages } from "@/lib/i18n";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import type {RecordedAsset} from "@coverse/core";
import {AssetPreview, imageMime} from "./AssetPreview";

type Target = FileReference & {scope?: FileScope; asset?: RecordedAsset; messageId?: string; documentUri?:string};
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
      <FileLink target={{path:part.file, ...(part.start ? {line:part.start} : {})}}>
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
  React.useEffect(() => {
    let active = true;
    api.previewFile(sessionId, target.path, target.scope ?? "project")
      .then(file => { if (active) setResult(file); })
      .catch(error => { if (active) setResult(String(error.message ?? error)); });
    return () => { active = false; };
  }, [sessionId, target.path, target.scope]);
  if (result === null) return <p>{t.loading}</p>;
  if (typeof result === "string") return <p role="alert">{result}</p>;
  if (result.kind === "media") return <AssetPreview url={result.url} type={result.mediaType} label={result.path} t={t}/>;
  if (result.kind === "directory") return <ul>{result.entries.map(entry => <li key={entry}>
    <button type="button" className="cursor-pointer hover:underline" onClick={() =>
      open({path: result.path + "/" + entry})}>{entry}</button></li>)}</ul>;
  if (target.documentUri && /\.md$/i.test(target.path) && !target.line && !target.quote)
    return <div className="cv-prose"><MessageMarkdown text={result.content}/></div>;
  return <HistoricalText text={result.content} target={target} t={t}/>;
}

function HistoricalText({text,target,t}: {text:string;target:Target;t:I18nMessages}) {
  const selected = React.useRef<HTMLDivElement>(null);
  const lines = text.split(/\r\n|\n|\r/);
  const located = target.quote ? locateQuote(text, target.quote, target.line) : target.line;
  React.useEffect(() => { selected.current?.scrollIntoView({block:"center"}); }, [text,located]);
  const line = located ?? 1;
  // Keep very large text previews selectable without mounting a DOM element for each line.
  const index = Math.min(line - 1, lines.length - 1);
  return <div className="font-mono text-xs whitespace-pre">
    {line > lines.length && <p role="status">{t.missingLine(line, lines.length)}</p>}
    {target.quote && located === undefined && <aside className="my-2 whitespace-pre-wrap border-l pl-2">
      <p role="status">{t.quoteMissing}</p><pre>{target.quote}</pre>
    </aside>}
    {index > 0 && <pre>{lines.slice(0, index).join("\n") + "\n"}</pre>}
    <div ref={selected} data-file-line={index + 1} className={located ? "bg-[var(--bg-hover)]" : undefined}>
      {located && <span className="mr-2 select-none text-[var(--accent-text)]">{index + 1}</span>}{lines[index] || " "}
    </div>
    {index + 1 < lines.length && <pre>{lines.slice(index + 1).join("\n")}</pre>}
  </div>;
}

export function FileViewer({session, children, t}: {session:UiSession | null; children: React.ReactNode; t: I18nMessages}) {
  const sessionId = session?.id;
  const [selection, setSelection] = React.useState<{id: string; target: Target} | null>(null);
  const open = (request: Target) => {
    if (!session) return;
    let target = request;
    if (!request.scope && !request.asset) {
      let uri = request.path;
      const parent = selection?.id === session.id ? selection.target : undefined;
      const documentUri = parent?.asset?.sourceUri ?? parent?.documentUri;
      if (documentUri) {
        try { uri = new URL(request.path,documentUri).href; } catch { /* Plain project paths also appear in archives. */ }
      }
      const origin = request.messageId ?? parent?.messageId;
      const index = session.messages.findIndex(message => message.id === origin);
      const messages = index < 0 ? session.messages.slice().reverse() :
        [...session.messages.slice(0,index+1).reverse(),...session.messages.slice(index+1)];
      const asset = messages.flatMap(m => m.assets ?? []).find(a => a.sourceUri && (a.sourceUri === uri || a.sourceUri === request.path));
      if (asset && (asset.location === "text" || asset.location === "embedded" || asset.location === "remote"))
        target = {...request,path:asset.label ?? uri,asset};
      else if (asset) target = {...request,path:asset.value,scope:asset.location === "attachment" ? "attachment" : "project",...(asset.sourceUri ? {documentUri:asset.sourceUri} : {})};
      else if (documentUri && session.handoff?.files.some(f => f.path === "source/" + request.path))
        target = {...request,scope:"attachment"};
      else target = {...request,path:uri};
      if (origin) target.messageId = origin;
    }
    setSelection({id:session.id,target});
  };
  const target = selection?.id === sessionId ? selection?.target : undefined;
  return <FileContext.Provider value={open}>{children}
    {sessionId && target && <Dialog open onOpenChange={visible => { if (!visible) setSelection(null); }}>
      <DialogContent aria-describedby={undefined} className="max-w-[min(90vw,960px)]">
        <DialogTitle className="mr-8 mb-3 break-all">{target.path}{target.line ? " · L" + target.line : ""}</DialogTitle>
        <div className="max-h-[70vh] overflow-auto">
          {target.asset ? target.asset.location === "text" ? target.asset.mediaType === "text/markdown" && !target.quote && !target.line
            ? <div className="cv-prose"><MessageMarkdown text={target.asset.value}/></div>
            : <HistoricalText text={target.asset.value} target={target} t={t}/>
            : <AssetPreview url={target.asset.value} type={target.asset.mediaType} label={target.path} t={t}/>
            : <Preview key={JSON.stringify([sessionId, target])} sessionId={sessionId} target={target} open={open} t={t}/>}
        </div>
      </DialogContent>
    </Dialog>}
  </FileContext.Provider>;
}
