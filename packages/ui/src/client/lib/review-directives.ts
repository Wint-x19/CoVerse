export type ReviewSegment = {text: string} | {file: string; title: string; body: string; start?: number; end?: number};

function directive(line: string): Exclude<ReviewSegment, {text:string}> | undefined {
  const body = /^ {0,3}::code-comment\{(.*)\}[ \t]*$/.exec(line)?.[1];
  if (!body) return;
  const attributes = new Map<string,string>();
  const entry = /\s*([\w-]+)=(?:"((?:\\.|[^"\\])*)"|(\d+))/gy;
  let position = 0;
  while (position < body.trimEnd().length) {
    entry.lastIndex = position;
    const m = entry.exec(body);
    if (!m || attributes.has(m[1]!)) return;
    attributes.set(m[1]!, (m[2] ?? m[3]!).replace(/\\(["\\])/g, "$1"));
    position = entry.lastIndex;
  }
  const file = attributes.get("file"), title = attributes.get("title"), comment = attributes.get("body");
  if (!file || !title || !comment) return;
  const start = Number(attributes.get("start")), end = Number(attributes.get("end"));
  return {file,title,body:comment, ...(Number.isSafeInteger(start) && start > 0 ? {start} : {}),
    ...(Number.isSafeInteger(end) && end >= start ? {end} : {})};
}

/** This Markdown extension is display-only. Literal directives inside code remain copyable. */
export function reviewSegments(markdown: string): ReviewSegment[] {
  if (!markdown.includes("::code-comment{")) return [{text:markdown}];
  const result: ReviewSegment[] = [];
  let start = 0, fence = "";
  for (const row of markdown.matchAll(/^([^\r\n]*)(?:\r\n|\n|\r|$)/gm)) {
    const line = row[1]!, marker = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1]!;
      else if (marker[1]!.startsWith(fence) && !marker[2]!.trim()) fence = "";
      continue;
    }
    const comment = !fence && directive(line);
    if (!comment) continue;
    if (row.index > start) result.push({text:markdown.slice(start, row.index)});
    result.push(comment);
    start = row.index + row[0].length;
  }
  if (start < markdown.length) result.push({text:markdown.slice(start)});
  return result;
}
