import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { UploadedFilePayload } from "../../shared/types.js";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function agentLabel(id: string): string {
  switch (id) {
    case "claude-code":
      return "Claude Code";
    case "antigravity":
      return "Antigravity";
    case "codex":
      return "Codex";
    default:
      return id;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function shortPath(value: string, maxSegments = 2): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= maxSegments) return normalized;
  return `…/${parts.slice(-maxSegments).join("/")}`;
}

export function relativeTime(iso: string): string {
  const deltaSec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (deltaSec < 60) return "now";
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h`;
  return `${Math.floor(deltaSec / 86400)}d`;
}

export async function filesToPayloads(fileList: FileList | File[]): Promise<UploadedFilePayload[]> {
  const items = Array.from(fileList);
  return Promise.all(
    items.map(async (file) => {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const relative = file.webkitRelativePath && file.webkitRelativePath.trim() ? file.webkitRelativePath : file.name;
      return { path: relative, contentBase64: btoa(binary) };
    }),
  );
}
