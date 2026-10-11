import { memo, useRef, useState } from "react";
import { endpoint, mapBounds, mapTransform, screenToWorld, viewportBounds, worldToScreen, type Camera, type Board } from "../canvas/model";

const MapShapes = memo(function MapShapes({ board, selected }: { board: Board; selected: Set<string> }) {
  const cards = new Map(board.cards.map(c => [c.id, c]));
  return <>
    {board.connections.map(e => {
      const a = cards.get(e.from), b = cards.get(e.to);
      if (!a || !b) return null;
      const from = endpoint(a, e.fromSide), to = endpoint(b, e.toSide);
      return <line key={e.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className="canvas-map-edge" vectorEffect="non-scaling-stroke"/>;
    })}
    {board.cards.map(c => <rect key={c.id} x={c.x} y={c.y} width={c.width} height={c.height} rx={12}
      className={`canvas-map-card${selected.has(c.id) ? " selected" : ""}`} vectorEffect="non-scaling-stroke"/>)}
  </>;
});

export function CanvasMinimap({ board, camera, size, selected, busy, onCamera }: {
  board: Board; camera: Camera; size: { width: number; height: number }; selected: Set<string>; busy: boolean; onCamera: (c: Camera) => void;
}) {
  const viewport = viewportBounds(camera, size);
  const [, redraw] = useState(0);
  const drag = useRef<{ id: number; start: { x: number; y: number }; camera: Camera; transform: Camera } | null>(null);
  const frozen = useRef(mapBounds(board.cards, viewport));
  if (!busy && !drag.current) frozen.current = mapBounds(board.cards, viewport);
  const transform = mapTransform(frozen.current);
  const p = worldToScreen(viewport, transform);
  return <div className="canvas-minimap">
    <span className="canvas-minimap-label">Overview</span>
    <svg viewBox="0 0 180 116" role="img" aria-label="Canvas overview. Click to navigate or drag the viewport." tabIndex={0}
      onKeyDown={e => {
        const delta = { ArrowLeft: [-80, 0], ArrowRight: [80, 0], ArrowUp: [0, -80], ArrowDown: [0, 80] }[e.key];
        if (delta) { e.preventDefault(); e.stopPropagation(); onCamera({ ...camera, x: camera.x - delta[0], y: camera.y - delta[1] }); }
      }}
      onPointerDown={e => {
        if (e.button !== 0) return;
        e.stopPropagation(); e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
        const rect = e.currentTarget.getBoundingClientRect();
        const start = { x: (e.clientX - rect.left) * 180 / rect.width, y: (e.clientY - rect.top) * 116 / rect.height };
        let next = camera;
        if (!(e.target as Element).classList.contains("canvas-map-viewport")) {
          const world = screenToWorld(start, transform);
          next = { ...camera, x: size.width / 2 - world.x * camera.zoom, y: size.height / 2 - world.y * camera.zoom };
          onCamera(next);
        }
        drag.current = { id: e.pointerId, start, camera: next, transform };
      }}
      onPointerMove={e => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = (e.clientX - rect.left) * 180 / rect.width, y = (e.clientY - rect.top) * 116 / rect.height;
        onCamera({ ...d.camera, x: d.camera.x - (x - d.start.x) / d.transform.zoom * d.camera.zoom,
          y: d.camera.y - (y - d.start.y) / d.transform.zoom * d.camera.zoom });
      }}
      onPointerUp={() => { drag.current = null; redraw(v => v + 1); }} onPointerCancel={() => { if (drag.current) onCamera(drag.current.camera); drag.current = null; redraw(v => v + 1); }}
      onLostPointerCapture={() => { drag.current = null; redraw(v => v + 1); }}>
      <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.zoom})`} pointerEvents="none">
        <MapShapes board={board} selected={selected}/>
      </g>
      <rect x={p.x} y={p.y} width={viewport.width * transform.zoom} height={viewport.height * transform.zoom} rx="3" className="canvas-map-viewport" />
    </svg>
  </div>;
}
