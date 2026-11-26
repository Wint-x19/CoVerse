import * as React from "react";
import type { RecordedFileChange } from "@coverse/core";
import type { I18nMessages } from "@/lib/i18n";
import { diffLines, pairDiffLines, type DiffLine } from "@/lib/historical-diff";
import type { FileReference } from "@/lib/file-references";

export function DiffPreview({change, target, t}: {change:RecordedFileChange; target:FileReference & {side?:string}; t:I18nMessages}) {
  const [split, setSplit] = React.useState(false);
  const [wrap, setWrap] = React.useState(false);
  const root = React.useRef<HTMLDivElement>(null);
  const lines = React.useMemo(() => (change.patches ?? []).flatMap(diffLines), [change]);
  const side = target.side === "original" ? "oldLine" : "newLine";
  const selections = React.useMemo(() => {
    const selected = new Set<DiffLine>();
    if (!target.line && !target.quote) return selected;
    const cited = target.quote?.replace(/\r\n?/g,"\n").trimEnd().split("\n");
    const candidates = lines.filter(row => row[side] !== undefined && (!cited || row.text.slice(1).includes(cited[0]!)));
    const exact = candidates.filter(row => row[side] === target.line);
    const first = exact.length === 1 ? exact[0] : cited && candidates.length === 1 ? candidates[0] : undefined;
    if (!first) return selected;
    const start = lines.indexOf(first);
    const count = cited?.length ?? Math.max(1, (target.endLine ?? target.line ?? 1) - (target.line ?? 1) + 1);
    for (let i=start, n=0; i<lines.length && n<count; i++) {
      const row = lines[i]!;
      if (row.kind === "meta") break;
      if (row[side] === undefined) continue;
      if (row[side] !== first[side]! + n || (cited && !row.text.slice(1).includes(cited[n]!))) return new Set<DiffLine>();
      selected.add(row); n++;
    }
    return selected.size === count ? selected : new Set<DiffLine>();
  },[lines,side,target]);
  const pageSize = 500;
  const anchor = Math.max(0,lines.findIndex(row => selections.has(row)));
  const [offset,setOffset] = React.useState(Math.floor(anchor/pageSize)*pageSize);
  React.useLayoutEffect(() => { setOffset(Math.floor(anchor/pageSize)*pageSize); },[anchor,target]);
  const visible = lines.slice(offset,offset+pageSize);
  React.useEffect(() => { root.current?.querySelector("[data-selected]")?.scrollIntoView({block:"center"}); }, [selections,split,offset]);
  function cell(row?: DiffLine, half?: "oldLine" | "newLine") {
    if (!row) return <div className="diff-cell"/>;
    return <div className={'diff-cell diff-' + row.kind} data-selected={selections.has(row) && (!half || half === side) ? true : undefined}>
      {row.kind !== "meta" && <span className="diff-numbers">{half ? row[half] : [row.oldLine ?? "·",row.newLine ?? "·"].join("  ")}</span>}
      <code>{row.text || " "}</code>
    </div>;
  }
  return <div ref={root} className={'cv-diff' + (wrap ? " wrap" : "")}>
    <div className="cv-diff-options"><button type="button" aria-pressed={split} onClick={() => setSplit(!split)}>{split ? t.unified : t.splitDiff}</button>
      <button type="button" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>{t.wrap}</button></div>
    {!lines.length && <p>{change.patches ? t.noChanges : t.diffUnavailable}</p>}
    {lines.length > 0 && lines.every(row => row.kind === "meta") && <p>{t.unknownLines}</p>}
    {(target.line || target.quote) && !selections.size && <aside>{t.quoteMissing} <code>{target.quote}</code></aside>}
    {split ? pairDiffLines(visible).map((pair,i) => <div className="diff-pair" key={i}>{pair.meta ? cell(pair.meta) : <>{cell(pair.left,"oldLine")}{cell(pair.right,"newLine")}</>}</div>)
      : visible.map((row,i) => <React.Fragment key={i}>{cell(row)}</React.Fragment>)}
    {lines.length > pageSize && <nav className="cv-diff-options">
      <button disabled={offset === 0} onClick={() => setOffset(offset-pageSize)}>{t.previousPage}</button>
      <span>{Math.floor(offset/pageSize)+1} / {Math.ceil(lines.length/pageSize)}</span>
      <button disabled={offset+pageSize >= lines.length} onClick={() => setOffset(offset+pageSize)}>{t.nextPage}</button>
    </nav>}
  </div>;
}
