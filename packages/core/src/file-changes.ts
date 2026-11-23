import { parsePatch, structuredPatch, type StructuredPatchHunk } from "diff";
import type { RecordedFileChange } from "./types.js";

export function fileChangeFromHunks(path: string, hunks: readonly StructuredPatchHunk[]): RecordedFileChange {
  let added = 0, removed = 0;
  const patches = hunks.map(hunk => {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added++;
      if (line.startsWith("-")) removed++;
    }
    const oldStart = hunk.oldLines ? hunk.oldStart : Math.max(0, hunk.oldStart - 1);
    const newStart = hunk.newLines ? hunk.newStart : Math.max(0, hunk.newStart - 1);
    return ["@@ -" + oldStart + "," + hunk.oldLines + " +" + newStart + "," + hunk.newLines + " @@",
      ...hunk.lines].join("\n");
  });
  return {path, added, removed, patches};
}

export function compareFileVersions(path: string, before: string, after: string): RecordedFileChange {
  const diff = structuredPatch(path, path, before, after, undefined, undefined, {maxEditLength: 2048});
  if (diff) return fileChangeFromHunks(path, diff.hunks);
  // Preserve both complete versions even when a minimal line diff is expensive.
  const lines = (s: string) => s ? (s.endsWith("\n") ? s.slice(0,-1) : s).split("\n") : [];
  const old = lines(before), next = lines(after);
  const body = (s: string, entries: string[], prefix: string) => [
    ...entries.map(line => prefix + line), ...(s && !s.endsWith("\n") ? ["\\ No newline at end of file"] : []),
  ];
  return fileChangeFromHunks(path, [{oldStart: old.length ? 1 : 0, oldLines: old.length,
    newStart: next.length ? 1 : 0, newLines: next.length, lines: [...body(before,old,"-"), ...body(after,next,"+")]}]);
}

export function fromUnifiedDiff(path:string, patch:string): RecordedFileChange {
  try {
    const hunks = parsePatch(patch).flatMap(file => file.hunks);
    if (hunks.length) return {...fileChangeFromHunks(path,hunks),patches:[patch]};
  } catch { /* Some tool outputs use a native patch dialect. Keep those lines readable. */ }
  return {path,added:null,removed:null,patches:[patch]};
}
