import { FileUp } from "lucide-react";

interface DropOverlayProps {
  visible: boolean;
  label: string;
}

export function DropOverlay({ visible, label }: DropOverlayProps) {
  if (!visible) return null;

  return (
    <div
      data-testid="drop-overlay"
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-[var(--backdrop)] backdrop-blur-[2px] p-6"
    >
      <div className="flex h-full w-full items-center justify-center rounded-2xl border border-dashed border-[#5e6ad2]/70 bg-[#5e6ad2]/[0.06]">
        <div className="flex items-center gap-2.5 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] px-4 py-2.5 text-[13.5px] font-medium text-[var(--text-primary)] shadow-[var(--shadow-modal)]">
          <FileUp className="h-4 w-4 text-[var(--accent-text)]" />
          <span>{label}</span>
        </div>
      </div>
    </div>
  );
}
