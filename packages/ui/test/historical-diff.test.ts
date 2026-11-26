import {describe,expect,it} from "vitest";
import {diffLines,pairDiffLines} from "../src/client/lib/historical-diff.js";

describe("historical patch display", () => {
  it("pairs replacement lines without moving the next context line or numbering patch headers", () => {
    const lines = diffLines("--- a/file\n+++ b/file\n@@ -7,2 +9,3 @@\n-before\n+after\n+extra\n same");
    expect(lines.slice(0,3).every(line => line.kind === "meta")).toBe(true);
    const pairs = pairDiffLines(lines).slice(3);
    expect(pairs).toEqual([
      {left:{kind:"remove",text:"-before",oldLine:7},right:{kind:"add",text:"+after",newLine:9}},
      {right:{kind:"add",text:"+extra",newLine:10}},
      {left:lines[6],right:{kind:"context",text:" same",oldLine:8,newLine:11}},
    ]);
  });

  it("preserves native patches and does not invent line numbers after a hunk ends", () => {
    const patch = "*** Update File: x\n@@\n-old\n+new\n@@ -0,0 +4 @@\n+known\n\\ No newline at end of file\n+unknown";
    const lines = diffLines(patch);
    expect(lines.map(row => row.text).join("\n")).toBe(patch);
    expect(lines.filter(row => row.newLine !== undefined)).toEqual([{text:"+known",kind:"add",newLine:4}]);
    expect(lines.some(row => row.oldLine !== undefined)).toBe(false);
  });
});
