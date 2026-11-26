import * as React from "react";

interface PaneDividerProps {
  side: "left" | "right";
  width: number;
  min: number;
  max: number;
  label: string;
  onResize: (value:number) => void;
  onSave: (value:number) => void;
}

export function PaneDivider({side,width,min,max,label,onResize,onSave}:PaneDividerProps) {
  const drag = React.useRef<{x:number; width:number; value:number} | null>(null);
  const sign = side === "left" ? 1 : -1;
  const clamp = (n:number) => Math.min(max,Math.max(min,n));
  const commit = (value:number) => { onResize(value); onSave(value); };
  return <div role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical"
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} className={'cv-divider '+side}
    onDoubleClick={() => commit(clamp(side === "left" ? 240 : 420))}
    onKeyDown={event => {
      if (!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
      event.preventDefault();
      commit(event.key === "Home" ? min : event.key === "End" ? max : clamp(width + (event.key === "ArrowRight" ? 16 : -16) * sign));
    }}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {x:event.clientX,width,value:width};
    }}
    onPointerMove={event => {
      if (!drag.current) return;
      drag.current.value = clamp(drag.current.width + (event.clientX - drag.current.x) * sign);
      onResize(drag.current.value);
    }}
    onLostPointerCapture={() => {
      if (drag.current) onSave(drag.current.value);
      drag.current = null;
    }}/>;
}
