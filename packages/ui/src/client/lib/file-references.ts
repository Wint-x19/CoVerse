export interface FileReference {
  path: string;
  line?: number;
}

export function fileReference(value: string, encoded = false): FileReference | undefined {
  if (!value || value.startsWith("#") || /^(?:\/\/|\\\\)/.test(value)) return;
  const location = /(?:#L(\d+)(?:C\d+)?(?:-L?\d+)?|:(\d+)(?::\d+)?)$/i.exec(value);
  let path = location ? value.slice(0, location.index) : value;
  if (/^[a-z][\w+.-]*:/i.test(path) && !/^(?:[a-z]:[\\/]|file:\/\/)/i.test(path)) return;
  if (encoded && !path.startsWith("file:")) {
    try { path = decodeURIComponent(path); } catch { return; }
  }
  if (!path || /[\u0000-\u001f]/.test(path)) return;
  const line = Number(location?.[1] ?? location?.[2]);
  return Number.isSafeInteger(line) && line > 0 ? {path, line} : {path};
}

// Match paths in prose without turning ordinary words, version numbers or URLs into file links.
const token = /(?:https?:\/\/\S+)|(?:[\p{L}\p{N}_.@~:/\\-]+(?:#L\d+(?:-L?\d+)?)?)/giu;
export function fileTokens(text: string): Array<{text: string; reference?: FileReference}> {
  const parts: Array<{text: string; reference?: FileReference}> = [];
  let offset = 0;
  for (const match of text.matchAll(token)) {
    const label = match[0].replace(/[.,:]+$/, "");
    const reference = fileReference(label);
    if (!reference || !(/[\\/]/.test(reference.path) || /\.(?:[a-z][\w-]{0,12})$/i.test(reference.path) ||
        /^(?:README|LICENSE|Dockerfile|Makefile|AGENTS)$/i.test(reference.path))) continue;
    if (match.index > offset) parts.push({text: text.slice(offset, match.index)});
    parts.push({text: label, reference});
    offset = match.index + label.length;
  }
  if (offset < text.length) parts.push({text: text.slice(offset)});
  return parts;
}

type HtmlNode = {type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HtmlNode[]};
export function linkFilePaths() {
  function visit(node: HtmlNode) {
    if (!node.children || ["pre", "a"].includes(node.tagName ?? "")) return;
    const literal = node.children.length === 1 ? node.children[0]?.value : undefined;
    if (node.tagName === "code" && literal && !/\n/.test(literal) &&
        /^(?:[a-z]:[\\/]|\.{0,2}\/|[\w.-]+[\\/])[^<>{}="|]*$/i.test(literal) && fileReference(literal)) {
      node.children = [{type: "element", tagName: "a", properties: {href: literal}, children: node.children}];
      return;
    }
    node.children = node.children.flatMap(child => {
      if (child.type !== "text") { visit(child); return [child]; }
      return fileTokens(child.value ?? "").map(({text, reference}): HtmlNode => reference
        ? {type: "element", tagName: "a", properties: {href: text}, children: [{type: "text", value: text}]}
        : {type: "text", value: text});
    });
  }
  return visit;
}
