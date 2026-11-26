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
  const listeners = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => listeners.current?.abort(),[]);
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
      event.preventDefault();
      const divider = event.currentTarget;
      divider.focus({preventScroll:true});
      const origin = event.clientX, pointer = event.pointerId;
      let current = width;
      listeners.current?.abort();
      const controller = new AbortController();
      listeners.current = controller;
      const options = {capture:true,signal:controller.signal};
      const resize = (move:PointerEvent) => {
        if (move.pointerId !== pointer) return;
        current = clamp(width + (move.clientX - origin) * sign);
        onResize(current);
      };
      const finish = () => {
        controller.abort();
        onSave(current);
      };
      window.addEventListener("pointermove",resize,options);
      window.addEventListener("pointerup",up => {if (up.pointerId === pointer) {resize(up);finish();}},options);
      window.addEventListener("pointercancel",cancel => {if (cancel.pointerId === pointer) finish();},options);
      window.addEventListener("blur",finish,options);
      if (divider.hasPointerCapture(pointer)) return;
      try {divider.setPointerCapture(pointer);} catch { /* Window listeners still track desktop mouse input. */ }
    }}/>;
}
