import { memo, useMemo } from "react";
import { curve, endpoint, type Board } from "../canvas/model";

/** The graph's geometry is independent of camera movement. */
export const CanvasConnections = memo(function CanvasConnections({ board, selection, onSelect, isPanning }: {
  board: Board; selection: string | null; onSelect: (id: string) => void; isPanning: () => boolean;
}) {
  const cards = useMemo(() => new Map(board.cards.map(c => [c.id, c])), [board]);
  return <>{board.connections.map(edge => {
    const a = cards.get(edge.from), b = cards.get(edge.to);
    if (!a || !b) return null;
    const path = curve(endpoint(a, edge.fromSide), endpoint(b, edge.toSide), edge.fromSide, edge.toSide);
    return <g key={edge.id} className={selection === edge.id ? "selected" : ""}>
      <path d={path} className="canvas-edge" vectorEffect="non-scaling-stroke" markerEnd={edge.arrow ? "url(#canvas-arrow)" : undefined}/>
      <path d={path} className="canvas-edge-hit" vectorEffect="non-scaling-stroke" role="button" tabIndex={0}
        aria-label={`Connection from ${a.title || a.body.slice(0, 30) || "card"} to ${b.title || b.body.slice(0, 30) || "card"}`}
        onFocus={() => onSelect(edge.id)}
        onPointerDown={e => { if (isPanning() || e.button === 1) return; e.stopPropagation(); onSelect(edge.id); }}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onSelect(edge.id); } }}/>
    </g>;
  })}</>;
});
