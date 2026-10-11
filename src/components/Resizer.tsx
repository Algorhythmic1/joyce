import { useEffect, useRef, useState } from "react";

interface Props {
  /** Which edge of its pane the handle sits on. Dragging away from the pane makes it wider. */
  edge: "left" | "right";
  /** Current width, or null when the pane is at its natural (responsive) width. */
  width: number | null;
  min: number;
  max: number;
  /** CSS variable on `.app` that sizes the pane, updated live while dragging. */
  cssVar: string;
  label: string;
  /** Saves a new width; null goes back to the default. */
  onResize: (width: number | null) => void;
}

const clamp = (w: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, w)));

/**
 * A pane's edge: drag to resize, double-click to reset, or focus it and use the
 * arrow keys (Shift for bigger steps). The width is saved when you let go.
 */
export function Resizer({ edge, width, min, max, cssVar, label, onResize }: Props) {
  const handle = useRef<HTMLDivElement>(null);
  const [visibleWidth, setVisibleWidth] = useState(width ?? min);
  const drag = useRef<{ startX: number; startWidth: number; last: number } | null>(null);
  const sign = edge === "right" ? 1 : -1;

  // Resize live by setting the CSS variable directly; save once at the end.
  const preview = (w: number | null) => {
    const app = handle.current?.closest<HTMLElement>(".app");
    if (w === null) app?.style.removeProperty(cssVar);
    else app?.style.setProperty(cssVar, `${w}px`);
  };
  // Window size can constrain a saved width; always start from what's on screen.
  const current = (el: HTMLElement) => Math.round(el.parentElement?.getBoundingClientRect().width ?? min);

  useEffect(() => {
    const pane = handle.current?.parentElement;
    if (!pane) return;
    const observer = new ResizeObserver(() => setVisibleWidth(Math.round(pane.getBoundingClientRect().width)));
    observer.observe(pane);
    return () => {
      observer.disconnect();
      if (drag.current) {
        drag.current = null;
        document.body.classList.remove("resizing");
        const app = pane.closest<HTMLElement>(".app");
        if (width === null) app?.style.removeProperty(cssVar);
        else app?.style.setProperty(cssVar, `${width}px`);
      }
    };
  }, [cssVar, width]);

  const cancel = () => {
    if (!drag.current) return;
    drag.current = null;
    handle.current?.classList.remove("dragging");
    document.body.classList.remove("resizing");
    preview(width);
  };

  return (
    <div
      ref={handle}
      className={`pane-resizer ${edge}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={Math.min(min, visibleWidth)}
      aria-valuemax={max}
      aria-valuenow={visibleWidth}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        try {
          // Keeps the drag going even when the pointer outruns the handle.
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Not essential; the drag still works while over the handle.
        }
        const start = current(e.currentTarget);
        drag.current = { startX: e.clientX, startWidth: start, last: start };
        e.currentTarget.classList.add("dragging");
        document.body.classList.add("resizing");
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.last = clamp(d.startWidth + sign * (e.clientX - d.startX), min, max);
        preview(d.last);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        e.currentTarget.classList.remove("dragging");
        document.body.classList.remove("resizing");
        if (d && d.last !== d.startWidth) onResize(d.last);
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onDoubleClick={() => onResize(null)}
      onKeyDown={(e) => {
        const step = (e.shiftKey ? 48 : 16) * sign;
        if (e.key === "ArrowLeft") onResize(clamp(current(e.currentTarget) - step, min, max));
        else if (e.key === "ArrowRight") onResize(clamp(current(e.currentTarget) + step, min, max));
        else return;
        e.preventDefault();
      }}
    />
  );
}
