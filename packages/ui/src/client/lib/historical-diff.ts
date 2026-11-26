export interface DiffLine {
  kind: "meta" | "context" | "add" | "remove";
  text: string;
  oldLine?: number;
  newLine?: number;
}

/** Native patch dialects can omit coordinates. Only number rows inside a declared unified hunk. */
export function diffLines(patch: string): DiffLine[] {
  let oldLine = 0, newLine = 0, oldLeft = 0, newLeft = 0;
  return patch.replace(/\r\n/g, "\n").split("\n").map(text => {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
      oldLeft = Number(hunk[2] ?? 1); newLeft = Number(hunk[4] ?? 1);
    } else if (text.startsWith("+") && newLeft > 0) {
      newLeft--; return {kind:"add", text, newLine:newLine++};
    } else if (text.startsWith("-") && oldLeft > 0) {
      oldLeft--; return {kind:"remove", text, oldLine:oldLine++};
    } else if (text.startsWith(" ") && oldLeft > 0 && newLeft > 0) {
      oldLeft--; newLeft--; return {kind:"context", text, oldLine:oldLine++, newLine:newLine++};
    }
    return {kind:"meta", text};
  });
}

export function pairDiffLines(lines: DiffLine[]) {
  const pairs: {left?: DiffLine; right?: DiffLine; meta?: DiffLine}[] = [];
  for (let i = 0; i < lines.length;) {
    const row = lines[i]!;
    if (row.kind === "meta") { pairs.push({meta:row}); i++; continue; }
    if (row.kind === "context") { pairs.push({left:row, right:row}); i++; continue; }
    const deleted: DiffLine[] = [], added: DiffLine[] = [];
    while (lines[i]?.kind === "remove") deleted.push(lines[i++]!);
    while (lines[i]?.kind === "add") added.push(lines[i++]!);
    for (let j = 0; j < Math.max(deleted.length, added.length); j++) {
      pairs.push({...deleted[j] && {left:deleted[j]}, ...added[j] && {right:added[j]}});
    }
  }
  return pairs;
}
