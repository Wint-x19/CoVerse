import * as React from "react";
import Markdown, {defaultUrlTransform} from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FilePreview, FileScope } from "../../shared/types.js";
import { api } from "@/lib/api";
import { fileReference, fileTokens, linkFilePaths, type FileReference } from "@/lib/file-references";
import type { I18nMessages } from "@/lib/i18n";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

type Target = FileReference & {scope?: FileScope};
const FileContext = React.createContext<(target: Target) => void>(() => {});

export function FileLink({target, children}: {target: Target; children: React.ReactNode}) {
  const open = React.useContext(FileContext);
  return <button type="button" className="cursor-pointer break-all text-left text-[var(--accent-text)] hover:underline"
    title={target.path} onClick={() => open(target)}>{children}</button>;
}

export function MessageMarkdown({text}: {text: string}) {
  return <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[linkFilePaths]}
    urlTransform={(url, key) => key === "href" && fileReference(url) ? url : defaultUrlTransform(url)}
    components={{a: ({href, children}) => {
      const target = href && fileReference(href, true);
      if (target) return <FileLink target={target}>{children}</FileLink>;
      return /^https?:\/\//i.test(href ?? "")
        ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>;
    }}}>{text}</Markdown>;
}

export function UserText({text}: {text: string}) {
  // Keep prompts verbatim, including instructions that happen to look like HTML or Markdown.
  const parts = text.split(/(\[[^\]\n]+\]\((?:<[^>\n]+>|[^)\s]+)\))/g);
  return <>{parts.map((part, index) => {
    const link = /^\[[^\]\n]+\]\((?:<([^>\n]+)>|([^)\s]+))\)$/.exec(part);
    const target = link && fileReference(link[1] ?? link[2]!, true);
    if (target) return <FileLink key={index} target={target}>{part}</FileLink>;
    return <React.Fragment key={index}>{fileTokens(part).map((item, i) => item.reference
      ? <FileLink key={i} target={item.reference}>{item.text}</FileLink> : item.text)}</React.Fragment>;
  })}</>;
}

function Preview({sessionId, target, open, t}: {
  sessionId: string; target: Target; open: (target: Target) => void; t: I18nMessages;
}) {
  const [result, setResult] = React.useState<FilePreview | string | null>(null);
  const selected = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    let active = true;
    api.previewFile(sessionId, target.path, target.scope ?? "project")
      .then(file => { if (active) setResult(file); })
      .catch(error => { if (active) setResult(String(error.message ?? error)); });
    return () => { active = false; };
  }, [sessionId, target.path, target.scope]);
  React.useEffect(() => { selected.current?.scrollIntoView({block: "center"}); }, [result, target.line]);
  if (result === null) return <p>{t.loading}</p>;
  if (typeof result === "string") return <p role="alert">{result}</p>;
  if (result.kind === "directory") return <ul>{result.entries.map(entry => <li key={entry}>
    <button type="button" className="cursor-pointer hover:underline" onClick={() =>
      open({path: result.path + "/" + entry})}>{entry}</button></li>)}</ul>;
  const lines = result.content.split(/\r\n|\n|\r/);
  const line = target.line ?? 1;
  // Keep very large text previews selectable without mounting a DOM element for each line.
  const index = Math.min(line - 1, lines.length - 1);
  return <div className="font-mono text-xs whitespace-pre">
    {line > lines.length && <p role="status">{t.missingLine(line, lines.length)}</p>}
    {index > 0 && <pre>{lines.slice(0, index).join("\n") + "\n"}</pre>}
    <div ref={selected} data-file-line={index + 1} className={target.line ? "bg-[var(--bg-hover)]" : undefined}>
      {target.line && <span className="mr-2 select-none text-[var(--accent-text)]">{index + 1}</span>}{lines[index] || " "}
    </div>
    {index + 1 < lines.length && <pre>{lines.slice(index + 1).join("\n")}</pre>}
  </div>;
}

export function FileViewer({sessionId, children, t}: {sessionId?: string | undefined; children: React.ReactNode; t: I18nMessages}) {
  const [selection, setSelection] = React.useState<{id: string; target: Target} | null>(null);
  const open = (target: Target) => { if (sessionId) setSelection({id: sessionId, target}); };
  const target = selection?.id === sessionId ? selection?.target : undefined;
  return <FileContext.Provider value={open}>{children}
    {sessionId && target && <Dialog open onOpenChange={visible => { if (!visible) setSelection(null); }}>
      <DialogContent aria-describedby={undefined} className="max-w-[min(90vw,960px)]">
        <DialogTitle className="mr-8 mb-3 break-all">{target.path}{target.line ? " · L" + target.line : ""}</DialogTitle>
        <div className="max-h-[70vh] overflow-auto">
          <Preview key={JSON.stringify([sessionId, target])} sessionId={sessionId} target={target} open={open} t={t}/>
        </div>
      </DialogContent>
    </Dialog>}
  </FileContext.Provider>;
}
