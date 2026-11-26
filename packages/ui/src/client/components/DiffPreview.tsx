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
    const first = candidates.find(row => row[side] === target.line) ?? (cited && candidates.length === 1 ? candidates[0] : undefined);
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
  const [limit, setLimit] = React.useState(500);
  const firstSelected = lines.findIndex(row => selections.has(row));
  const visible = lines.slice(0,Math.max(limit, firstSelected + selections.size + 1));
  React.useEffect(() => { root.current?.querySelector("[data-selected]")?.scrollIntoView({block:"center"}); }, [selections,split]);
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
    {visible.length < lines.length && <button type="button" className="cv-action" onClick={() => setLimit(visible.length + 500)}>+ {Math.min(500,lines.length-visible.length)} ↓</button>}
  </div>;
}
