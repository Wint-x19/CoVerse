import { FileUp } from "lucide-react";

interface DropOverlayProps {
  visible: boolean;
}

export function DropOverlay({ visible }: DropOverlayProps) {
  if (!visible) return null;

  return (
    <div
      data-testid="drop-overlay"
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-[2px] p-6"
    >
      <div className="flex h-full w-full items-center justify-center rounded-2xl border border-dashed border-[#5e6ad2]/70 bg-[#5e6ad2]/[0.05]">
        <div className="flex items-center gap-2.5 rounded-xl border border-white/[0.12] bg-[#101114] px-4 py-2.5 text-[13.5px] font-medium text-[#f7f8f8] shadow-[0_16px_48px_rgba(0,0,0,0.6)]">
          <FileUp className="h-4 w-4 text-[#828fff]" />
          <span>Drop session files</span>
        </div>
      </div>
    </div>
  );
}
