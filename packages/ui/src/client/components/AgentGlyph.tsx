import { cn } from "@/lib/utils";

interface AgentGlyphProps {
  agent: string;
  className?: string;
}

/** Minimal monochrome geometric marks — no rainbow badges or loud gradients. */
export function AgentGlyph({ agent, className }: AgentGlyphProps) {
  if (agent === "claude-code") {
    return (
      <svg viewBox="0 0 16 16" fill="none" className={cn("h-3.5 w-3.5 shrink-0", className)} aria-hidden="true">
        <path
          d="M8 2v12M2.8 5l10.4 6M13.2 5L2.8 11"
          stroke="currentColor"
          strokeWidth="1.45"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (agent === "antigravity") {
    return (
      <svg viewBox="0 0 16 16" fill="none" className={cn("h-3.5 w-3.5 shrink-0", className)} aria-hidden="true">
        <path
          d="M8 2.2 13 13H3L8 2.2Z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <circle cx="8" cy="9.6" r="1.15" fill="currentColor" />
      </svg>
    );
  }
  if (agent === "codex") {
    return (
      <svg viewBox="0 0 16 16" fill="none" className={cn("h-3.5 w-3.5 shrink-0", className)} aria-hidden="true">
        <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="M5.7 6.2 7.8 8 5.7 9.8M8.8 9.8h1.9" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" className={cn("h-3.5 w-3.5 shrink-0", className)} aria-hidden="true">
      <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 18 18" fill="none" className={cn("h-4 w-4 shrink-0", className)} aria-hidden="true">
      <circle cx="6.5" cy="9" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="11.5" cy="9" r="4.5" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.55" />
    </svg>
  );
}
