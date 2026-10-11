import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { basename } from "../fs";
import { COLORS, SYMBOLS, colorVar, type ColorId, type SymbolId } from "../sectionIcons";
import { canvasSession } from "../canvas/sessions";
import { cardBounds, connect, curve, deleteCards, endpoint, MIN_CARD, newCard, screenToWorld, SIDES, viewportBounds, worldToScreen, zoomAt,
  type Board, type Camera, type Card, type Point, type Side } from "../canvas/model";
import { CanvasGrid } from "./CanvasGrid";
import { CanvasMinimap } from "./CanvasMinimap";
import { CanvasConnections } from "./CanvasConnections";
import { SectionIconView } from "./IconPicker";
import "../canvas/canvas.css";

type Gesture = { id: number; start: Point; camera: Camera; moved: boolean; before: Board; kind: "pan" | "move" | "resize" | "connect";
  card?: string; ids?: Set<string>; side?: Side; next?: Board };
type Recovery = { name: string; board: Board };
const cameraKey = (root: string) => `joyce:canvas-camera:${root}`;
const editable = (target: EventTarget | null) => target instanceof Element && !!target.closest("input, textarea, select, [contenteditable=true]");
const MoveGlyph = () => <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v16M2 10h16M7 5l3-3 3 3M7 15l3 3 3-3M5 7l-3 3 3 3M15 7l3 3-3 3" /></svg>;
const EditGlyph = () => <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 13-1 4 4-1L17 6l-3-3zM12 5l3 3" /></svg>;
const CopyGlyph = () => <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M12 3H5a2 2 0 0 0-2 2v7"/></svg>;
const ConnectGlyph = () => <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10h13M12 6l4 4-4 4M3 5v10"/></svg>;
const TrashGlyph = () => <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M7 5V3h6v2M5 5l1 12h8l1-12M8 8v6M12 8v6"/></svg>;

export default function CanvasWorkspace({ root, maximized, onToggleMaximized, onClose }: {
  root: string; maximized: boolean; onToggleMaximized: () => void; onClose: () => void;
}) {
  const session = useMemo(() => canvasSession(root), [root]);
  const snapshot = useSyncExternalStore(session.subscribe, session.get);
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const sizeRef = useRef(size);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 });
  const cameraRef = useRef(camera); cameraRef.current = camera;
  const [draft, setDraft] = useState<Board | null>(null);
  const board = draft ?? snapshot.board;
  const boardRef = useRef(board); boardRef.current = board;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [edgeSelection, setEdgeSelection] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [editing, setEditing] = useState<string | null>(null);
  const editingBefore = useRef<Board | null>(null);
  const [appearance, setAppearance] = useState(false);
  const [connecting, setConnecting] = useState<{ card: string; side: Side; pointer?: Point; target?: string } | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const [busy, setBusy] = useState(false);
  const [space, setSpace] = useState(false);
  const spaceRef = useRef(false);
  const [help, setHelp] = useState(false);
  const [recoveries, setRecoveries] = useState(false);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const cameraReady = useRef(false);
  const cameraFrame = useRef(0);
  const pendingCamera = useRef<Camera | null>(null);
  const touches = useRef(new Map<number, Point>());
  const pinch = useRef<{ camera: Camera; anchor: Point; distance: number } | null>(null);

  // Coalesce high-frequency pan/zoom input into one scene update per frame.
  const moveCamera = useCallback((next: Camera) => {
    if (![next.x, next.y, next.zoom].every(Number.isFinite)) return;
    cameraRef.current = next;
    pendingCamera.current = next;
    if (!cameraFrame.current) cameraFrame.current = requestAnimationFrame(() => {
      cameraFrame.current = 0;
      if (pendingCamera.current) setCamera(pendingCamera.current);
    });
  }, []);
  useEffect(() => {
    void session.reload();
    const onFocus = () => { void session.reload(); };
    window.addEventListener("focus", onFocus);
    const observer = new ResizeObserver(() => {
      if (!host.current) return;
      const next = { width: host.current.clientWidth, height: host.current.clientHeight };
      // Keep the same world point at the center when docking or maximizing.
      if (cameraReady.current) moveCamera({ ...cameraRef.current,
        x: cameraRef.current.x + (next.width - sizeRef.current.width) / 2,
        y: cameraRef.current.y + (next.height - sizeRef.current.height) / 2 });
      sizeRef.current = next;
      setSize(next);
    });
    observer.observe(host.current!);
    return () => {
      observer.disconnect(); window.removeEventListener("focus", onFocus);
      clearTimeout(hoverTimer.current); cancelAnimationFrame(cameraFrame.current);
      // Editing and pointer gestures must release their remote-reload hold on unmount.
      if (editingBefore.current) { session.record(editingBefore.current); session.release(); }
      if (gesture.current) session.release();
      void session.flush().catch(() => {});
      if (cameraReady.current && session.get().board) {
        localStorage.setItem(cameraKey(root), JSON.stringify({ ...cameraRef.current, viewport: sizeRef.current, boardId: session.get().board!.id }));
      }
    };
  }, [session, root, moveCamera]);
  useEffect(() => {
    if (maximized && !host.current?.contains(document.activeElement)) host.current?.focus({ preventScroll: true });
  }, [maximized]);
  useEffect(() => {
    if (cameraReady.current || !snapshot.board || size.width <= 1) return;
    cameraReady.current = true;
    let initial: Camera = { x: size.width / 2, y: size.height / 2, zoom: 1 };
    try {
      const saved = JSON.parse(localStorage.getItem(cameraKey(root)) ?? "null");
      if (saved?.boardId === snapshot.board.id && [saved.x, saved.y, saved.zoom].every((n: unknown) => typeof n === "number" && Number.isFinite(n)) && saved.zoom >= 0.02 && saved.zoom <= 3) {
        initial = { x: saved.x, y: saved.y, zoom: saved.zoom };
        if ([saved.viewport?.width, saved.viewport?.height].every((n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 1)) {
          initial.x += (size.width - saved.viewport.width) / 2;
          initial.y += (size.height - saved.viewport.height) / 2;
        }
      }
    } catch { /* The board is independent of a damaged local camera preference. */ }
    moveCamera(initial);
  }, [snapshot.board, size.width, size.height, root, moveCamera]);
  useEffect(() => {
    if (!cameraReady.current || !snapshot.board) return;
    const timer = setTimeout(() => localStorage.setItem(cameraKey(root), JSON.stringify({ ...camera, viewport: sizeRef.current, boardId: snapshot.board!.id })), 250);
    return () => clearTimeout(timer);
  }, [camera, root, snapshot.board?.id]);

  const finishEditing = useCallback(() => {
    if (editingBefore.current) { session.record(editingBefore.current); editingBefore.current = null; session.release(); }
    setEditing(null);
  }, [session]);
  const selectConnection = useCallback((id: string) => {
    finishEditing(); setEdgeSelection(id); setSelected(new Set()); setHovered(null);
  }, [finishEditing]);
  const isPanning = useCallback(() => spaceRef.current, []);
  const beginEditing = (card: Card) => {
    if (editing === card.id) { textArea.current?.focus(); return; }
    finishEditing();
    editingBefore.current = session.get().board;
    session.hold();
    setEditing(card.id); setSelected(new Set([card.id])); setHovered(card.id); setAppearance(false); setConnecting(null);
  };
  useEffect(() => { if (editing) textArea.current?.focus(); }, [editing]);

  const patchCard = (id: string, patch: Partial<Card>, record = true) => {
    const current = session.get().board;
    if (current) session.change({ ...current, cards: current.cards.map(c => c.id === id ? { ...c, ...patch } : c) }, record);
  };
  const addCard = (point?: Point) => {
    finishEditing();
    const current = session.get().board;
    if (!current) return;
    const center = point ?? screenToWorld({ x: size.width / 2, y: size.height / 2 }, cameraRef.current);
    const card = newCard({ x: center.x - 140, y: center.y - 80 });
    session.change({ ...current, cards: [...current.cards, card] });
    beginEditing(card);
  };
  const removeSelection = () => {
    finishEditing();
    const current = session.get().board;
    if (!current) return;
    session.change(edgeSelection ? { ...current, connections: current.connections.filter(e => e.id !== edgeSelection) } : deleteCards(current, selected));
    setSelected(new Set()); setEdgeSelection(null); setHovered(null); setConnecting(null); setAppearance(false);
  };
  const duplicate = (card: Card) => {
    finishEditing();
    const current = session.get().board;
    if (!current) return;
    const copy = { ...card, id: crypto.randomUUID(), x: card.x + 28, y: card.y + 28 };
    session.change({ ...current, cards: [...current.cards, copy] });
    setSelected(new Set([copy.id])); setHovered(copy.id); setAppearance(false);
  };
  const finishConnection = (to: string, toSide: Side = "left") => {
    if (!connecting || !session.get().board) return;
    session.change(connect(session.get().board!, connecting.card, to, connecting.side, toSide));
    setConnecting(null); setSelected(new Set([to]));
  };
  const fit = () => {
    const bounds = cardBounds(boardRef.current?.cards ?? []);
    if (!bounds) { moveCamera({ x: size.width / 2, y: size.height / 2, zoom: 1 }); return; }
    const z = Math.max(0.02, Math.min(1.5, (size.width - 120) / bounds.width, (size.height - 160) / bounds.height));
    moveCamera({ x: size.width / 2 - (bounds.x + bounds.width / 2) * z,
      y: size.height / 2 - (bounds.y + bounds.height / 2) * z, zoom: z });
  };
  const pointerPoint = (e: { clientX: number; clientY: number }) => {
    const rect = host.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const beginGesture = (e: ReactPointerEvent, kind: Gesture["kind"], card?: Card, side?: Side) => {
    if (!board || gesture.current || (e.button !== 0 && e.button !== 1)) return;
    e.preventDefault(); e.stopPropagation();
    finishEditing(); setAppearance(false);
    let ids = selected;
    if (card && kind === "move") {
      ids = e.shiftKey ? new Set(selected) : selected.has(card.id) ? selected : new Set([card.id]);
      if (e.shiftKey && ids.has(card.id)) ids.delete(card.id); else ids.add(card.id);
      setSelected(ids); setEdgeSelection(null);
    }
    if (card && kind === "resize") { ids = new Set([card.id]); setSelected(ids); }
    if (kind === "connect" && card) setConnecting({ card: card.id, side: side ?? "right", pointer: screenToWorld(pointerPoint(e), cameraRef.current) });
    gesture.current = { id: e.pointerId, start: pointerPoint(e), camera: cameraRef.current, moved: false,
      before: session.get().board!, kind, card: card?.id, side, ids };
    session.hold(); setBusy(true); host.current!.setPointerCapture(e.pointerId);
  };
  const cancelGesture = useCallback(() => {
    if (pinch.current) { moveCamera(pinch.current.camera); pinch.current = null; touches.current.clear(); setBusy(false); }
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    if (g.kind === "pan") moveCamera(g.camera);
    setDraft(null); setConnecting(null); setBusy(false); session.release();
    if (host.current?.hasPointerCapture(g.id)) host.current.releasePointerCapture(g.id);
  }, [moveCamera, session]);
  const pointerMove = (e: ReactPointerEvent) => {
    const point = pointerPoint(e), g = gesture.current;
    if (e.pointerType === "touch" && touches.current.has(e.pointerId)) touches.current.set(e.pointerId, point);
    if (pinch.current && touches.current.size === 2) {
      const [a, b] = [...touches.current.values()], p = pinch.current;
      const zoom = Math.max(0.02, Math.min(3, p.camera.zoom * Math.hypot(b.x - a.x, b.y - a.y) / p.distance));
      const world = screenToWorld(p.anchor, p.camera);
      moveCamera({ x: (a.x + b.x) / 2 - world.x * zoom, y: (a.y + b.y) / 2 - world.y * zoom, zoom });
      return;
    }
    if (!g || g.id !== e.pointerId) {
      if (connecting) {
        const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-card-id]");
        setConnecting({ ...connecting, pointer: screenToWorld(point, cameraRef.current), target: target?.dataset.cardId });
      }
      return;
    }
    const dx = point.x - g.start.x, dy = point.y - g.start.y;
    if (Math.hypot(dx, dy) < 3 && !g.moved) return;
    g.moved = true;
    if (g.kind === "pan") { moveCamera({ ...g.camera, x: g.camera.x + dx, y: g.camera.y + dy }); return; }
    if (g.kind === "connect") {
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-card-id]");
      setConnecting({ card: g.card!, side: g.side ?? "right", pointer: screenToWorld(point, cameraRef.current), target: target?.dataset.cardId });
      return;
    }
    const next = { ...g.before, cards: g.before.cards.map(c => {
      if (g.kind === "move" && g.ids?.has(c.id)) return { ...c, x: c.x + dx / g.camera.zoom, y: c.y + dy / g.camera.zoom };
      if (g.kind === "resize" && c.id === g.card) return { ...c, width: Math.max(MIN_CARD.width, c.width + dx / g.camera.zoom), height: Math.max(MIN_CARD.height, c.height + dy / g.camera.zoom) };
      return c;
    }) };
    g.next = next; setDraft(next);
  };
  const pointerUp = (e: ReactPointerEvent) => {
    touches.current.delete(e.pointerId);
    if (pinch.current) {
      pinch.current = null; setBusy(false);
      if (host.current?.hasPointerCapture(e.pointerId)) host.current.releasePointerCapture(e.pointerId);
      return;
    }
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    if (g.next && g.moved) session.change(g.next);
    if (g.kind === "connect") {
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-card-id]");
      const port = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-side]");
      if (target?.dataset.cardId) session.change(connect(session.get().board!, g.card!, target.dataset.cardId, g.side, (port?.dataset.side as Side | undefined) ?? "left"));
      setConnecting(null);
    }
    if (g.kind === "pan" && !g.moved) { setSelected(new Set()); setEdgeSelection(null); setHovered(null); setConnecting(null); }
    setDraft(null); setBusy(false); session.release();
    if (host.current?.hasPointerCapture(g.id)) host.current.releasePointerCapture(g.id);
    if (!g.moved && g.card) host.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(g.card)}"]`)?.focus({ preventScroll: true });
  };

  useEffect(() => {
    const element = host.current!;
    let safariGesture: { camera: Camera; anchor: Point } | null = null;
    // WebKit reports trackpad pinch with gesture events rather than Ctrl+wheel.
    const gestureStart = (event: Event) => {
      event.preventDefault(); cancelGesture();
      const e = event as Event & { clientX?: number; clientY?: number };
      const rect = element.getBoundingClientRect();
      safariGesture = { camera: cameraRef.current, anchor: { x: e.clientX === undefined ? rect.width / 2 : e.clientX - rect.left,
        y: e.clientY === undefined ? rect.height / 2 : e.clientY - rect.top } };
    };
    const gestureChange = (event: Event) => {
      event.preventDefault();
      const scale = (event as Event & { scale?: number }).scale;
      if (safariGesture && typeof scale === "number" && scale > 0) moveCamera(zoomAt(safariGesture.camera, safariGesture.anchor, safariGesture.camera.zoom * scale));
    };
    const gestureEnd = () => { safariGesture = null; };
    const wheel = (e: WheelEvent) => {
      if ((e.target as Element).closest(".canvas-hud, .canvas-minimap, .canvas-popover, .canvas-card-editor, .canvas-card-copy")) {
        if (!e.ctrlKey && !e.metaKey) return;
      }
      e.preventDefault();
      const rect = element.getBoundingClientRect();
      const current = cameraRef.current;
      const multiplier = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? element.clientHeight : 1;
      if (e.ctrlKey || e.metaKey) moveCamera(zoomAt(current, { x: e.clientX - rect.left, y: e.clientY - rect.top }, current.zoom * Math.exp(-e.deltaY * multiplier * 0.008)));
      else moveCamera({ ...current, x: current.x - (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * multiplier,
        y: current.y - (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * multiplier });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("gesturestart", gestureStart, { passive: false });
    element.addEventListener("gesturechange", gestureChange, { passive: false });
    element.addEventListener("gestureend", gestureEnd);
    const blur = () => { spaceRef.current = false; setSpace(false); cancelGesture(); };
    window.addEventListener("blur", blur);
    return () => {
      element.removeEventListener("wheel", wheel); window.removeEventListener("blur", blur);
      element.removeEventListener("gesturestart", gestureStart); element.removeEventListener("gesturechange", gestureChange); element.removeEventListener("gestureend", gestureEnd);
    };
  }, [moveCamera, cancelGesture]);
  // Capture Space even before a click gives the canvas focus, without intercepting text input.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !editable(e.target) && e.target instanceof Element && (host.current?.contains(e.target) || e.target === document.body) && !e.target.closest("button")) {
        e.preventDefault(); spaceRef.current = true; setSpace(true);
      }
    };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") { spaceRef.current = false; setSpace(false); } };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  const activeId = appearance || editing ? editing ?? [...selected][0] : hovered ?? (selected.size === 1 ? [...selected][0] : undefined);
  const active = board?.cards.find(c => c.id === activeId);
  const activeScreen = active && worldToScreen(active, camera);
  const toolbarWidth = Math.min(358, size.width - 24);
  const toolbarBelow = !!activeScreen && activeScreen.y < 62;
  const toolbarPosition = activeScreen && active ? {
    left: Math.max(12, Math.min(size.width - toolbarWidth - 12, activeScreen.x)),
    top: Math.max(58, Math.min(size.height - 56, toolbarBelow ? activeScreen.y + active.height * camera.zoom + 12 : activeScreen.y - 56)),
    width: toolbarWidth,
  } : undefined;
  const holdHover = (id: string) => { clearTimeout(hoverTimer.current); setHovered(id); };
  const leaveHover = () => { clearTimeout(hoverTimer.current); hoverTimer.current = setTimeout(() => { if (!gesture.current) setHovered(null); }, 180); };
  const cardsById = useMemo(() => new Map(board?.cards.map(c => [c.id, c])), [board]);
  const selectedEdge = board?.connections.find(e => e.id === edgeSelection);
  const viewport = viewportBounds(camera, size);

  return <div className={`canvas-workspace${space ? " canvas-space" : ""}${busy ? " canvas-busy" : ""}`} ref={host}
    tabIndex={0} role="region" aria-label="Idea canvas" data-canvas-zoom={camera.zoom}
    onPointerDownCapture={e => {
      if (e.pointerType !== "touch" || (e.target as Element).closest(".canvas-hud, .canvas-popover, .canvas-minimap")) return;
      touches.current.set(e.pointerId, pointerPoint(e));
      if (touches.current.size === 2) {
        cancelGesture(); e.preventDefault(); e.stopPropagation(); finishEditing();
        const [a, b] = [...touches.current.values()];
        pinch.current = { camera: cameraRef.current, anchor: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)) };
        setBusy(true);
        for (const id of touches.current.keys()) host.current!.setPointerCapture(id);
      }
    }}
    onPointerDown={e => {
      if ((e.target as Element).closest(".canvas-hud, .canvas-popover, .canvas-minimap, .canvas-card-toolbar")) return;
      if (spaceRef.current || e.button === 1 || !(e.target as Element).closest("[data-card-id], .canvas-edge-hit")) beginGesture(e, "pan");
    }} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancelGesture}
    onLostPointerCapture={() => { if (gesture.current) cancelGesture(); }}
    onDoubleClick={e => {
      if (spaceRef.current || e.button !== 0) return;
      // Drag capture can retarget clicks to the host. Route by the visible surface
      // beneath the pointer so a card double-click never creates another card.
      const target = document.elementFromPoint(e.clientX, e.clientY) ?? e.target as Element;
      if (editable(target) || target.closest("button, .canvas-hud, .canvas-popover, .canvas-minimap, .canvas-card-toolbar, .canvas-edge-hit")) return;
      const id = target.closest<HTMLElement>("[data-card-id]")?.dataset.cardId;
      const card = id ? cardsById.get(id) : undefined;
      e.preventDefault();
      e.stopPropagation();
      if (card) beginEditing(card);
      else addCard(screenToWorld(pointerPoint(e), cameraRef.current));
    }}
    onKeyDown={e => {
      if (e.key === "Escape") {
        e.stopPropagation(); cancelGesture(); finishEditing(); setAppearance(false); setHelp(false); setRecoveries(false); setRecovery(null); setConnecting(null); host.current?.focus(); return;
      }
      if (gesture.current) { e.preventDefault(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") { e.preventDefault(); e.stopPropagation(); addCard(); return; }
      if (editable(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) session.redo(); else session.undo(); }
      else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); session.redo(); }
      else if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); setSelected(new Set(board?.cards.map(c => c.id))); }
      else if ((e.key === "Delete" || e.key === "Backspace") && !(e.target as Element).closest("button")) { e.preventDefault(); removeSelection(); }
      else if (e.key === "Enter" && connecting && selected.size === 1 && !(e.target as Element).closest("button")) { e.preventDefault(); finishConnection([...selected][0]); }
      else if (e.key === "Enter" && selected.size === 1 && !(e.target as Element).closest("button")) {
        const card = board?.cards.find(c => selected.has(c.id)); if (card) { e.preventDefault(); beginEditing(card); }
      } else if (!mod && !(e.target as Element).closest("button") && e.key.toLowerCase() === "n") { e.preventDefault(); addCard(); }
      else if (!mod && !(e.target as Element).closest("button") && e.key.toLowerCase() === "c" && selected.size === 1) setConnecting({ card: [...selected][0], side: "right" });
      else if (!mod && !(e.target as Element).closest("button") && e.key.toLowerCase() === "f") fit();
      else if (!mod && !(e.target as Element).closest("button") && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        e.preventDefault();
        const step = e.shiftKey ? 40 : 8, dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0,
          dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        if (selected.size && board) session.change({ ...board, cards: board.cards.map(c => selected.has(c.id) ? { ...c, x: c.x + dx, y: c.y + dy } : c) });
        else moveCamera({ ...camera, x: camera.x - dx * 4, y: camera.y - dy * 4 });
      }
    }}>
    <CanvasGrid camera={camera} host={host} />
    <div className="canvas-hud canvas-heading" onPointerDown={e => e.stopPropagation()}>
      <div className="canvas-heading-title"><span className="canvas-eyebrow">SPACE TO THINK</span><h1>Canvas <span>/ {basename(root)}</span></h1></div>
      <div className="canvas-heading-actions">
        <button className="canvas-add" aria-label="Add card" title="Add card" disabled={!board} onClick={() => addCard()}><span aria-hidden="true">＋</span><span className="canvas-add-label">Add card</span></button>
        <button className="canvas-layout-button" aria-label={maximized ? "Return canvas to sidebar" : "Maximize canvas"}
          title={maximized ? "Return to sidebar" : "Maximize canvas"} aria-pressed={maximized} onClick={onToggleMaximized}>
          <svg viewBox="0 0 20 20" aria-hidden="true">{maximized
            ? <><rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M12 4v12M9 10H5m2-2-2 2 2 2"/></>
            : <path d="M7 3H3v4M13 3h4v4M3 13v4h4M17 13v4h-4"/>}</svg>
        </button>
        <button className="canvas-layout-button" aria-label="Close canvas" title="Close canvas" onClick={() => { finishEditing(); onClose(); }}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>
        </button>
      </div>
    </div>
    {!board && <div className="canvas-empty" role="status"><p>{snapshot.error ?? "Opening your canvas…"}</p>{snapshot.error && <button onClick={() => { void session.reload(); }}>Try again</button>}</div>}
    {board && !board.cards.length && <div className="canvas-empty"><span className="canvas-empty-mark" aria-hidden="true">✧</span><h2>A little room for your ideas.</h2><p>Double-click anywhere to leave a thought.<br/>Connect the pieces as they come together.</p><button className="canvas-add" onClick={() => addCard()}>Create your first card <span aria-hidden="true">＋</span></button></div>}
    {board && <>
      <svg className="canvas-connections" aria-label="Card connections">
        <defs><marker id="canvas-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1 9 5 1 9" fill="none" stroke="var(--ui-text)" strokeWidth="1.4" /></marker></defs>
        <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.zoom})`}>
          <CanvasConnections board={board} selection={edgeSelection} onSelect={selectConnection} isPanning={isPanning}/>
          {connecting && cardsById.get(connecting.card) && <path className="canvas-edge canvas-edge-preview" vectorEffect="non-scaling-stroke"
            d={curve(endpoint(cardsById.get(connecting.card)!, connecting.side), connecting.pointer ?? endpoint(cardsById.get(connecting.card)!, connecting.side), connecting.side, "left")} />}
        </g>
      </svg>
      <div className="canvas-card-layer" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}>
        {board.cards.filter(c => editing === c.id || selected.size === 1 && selected.has(c.id) || hovered === c.id || gesture.current?.kind === "move" && gesture.current.ids?.has(c.id) ||
          c.x + c.width >= viewport.x - 360 / camera.zoom && c.x <= viewport.x + viewport.width + 360 / camera.zoom &&
          c.y + c.height >= viewport.y - 360 / camera.zoom && c.y <= viewport.y + viewport.height + 360 / camera.zoom).map(card => <article
          key={card.id} data-card-id={card.id} tabIndex={0} aria-label={card.title || card.body.slice(0, 60) || "Empty idea card"}
          className={`canvas-card${selected.has(card.id) ? " selected" : ""}${editing === card.id ? " editing" : ""}${connecting?.target === card.id && connecting.card !== card.id ? " connect-target" : ""}`}
          style={{ left: card.x, top: card.y, width: card.width, height: card.height, fontSize: card.textSize,
            "--card-color": card.icon ? colorVar(card.icon.color) : "var(--accent)", zIndex: selected.has(card.id) ? 2 : 1 } as React.CSSProperties}
          onPointerEnter={() => holdHover(card.id)} onPointerLeave={leaveHover}
          onFocus={e => { holdHover(card.id); if (e.currentTarget.matches(":focus-visible")) setSelected(new Set([card.id])); }}
          onPointerDown={e => {
            if (spaceRef.current || e.button === 1) return;
            if (editing === card.id || (e.target as Element).closest("button, input, textarea")) { e.stopPropagation(); return; }
            if (connecting && !gesture.current) { e.stopPropagation(); finishConnection(card.id); return; }
            beginGesture(e, "move", card);
          }}>
          {card.icon && <div className="canvas-card-symbol"><SectionIconView icon={card.icon} size={18} /></div>}
          {editing === card.id ? <div className="canvas-card-editor" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) finishEditing(); }}>
            <input aria-label="Card title" placeholder="Title (optional)" value={card.title} onChange={e => patchCard(card.id, { title: e.target.value }, false)} />
            <textarea ref={textArea} aria-label="Card idea" placeholder="Write a thought…" value={card.body} spellCheck onChange={e => patchCard(card.id, { body: e.target.value }, false)} />
          </div> : <div className="canvas-card-copy">{card.title && <h2>{card.title}</h2>}<p>{card.body || (!card.title ? <span className="canvas-card-placeholder">A thought begins here…</span> : "")}</p></div>}
          <button className="canvas-resize" title="Drag to resize" aria-label="Resize card" onPointerDown={e => { if (!spaceRef.current && e.button !== 1) beginGesture(e, "resize", card); }}
            onKeyDown={e => {
              const delta = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[e.key];
              if (delta) { e.preventDefault(); e.stopPropagation(); patchCard(card.id, { width: Math.max(MIN_CARD.width, card.width + delta[0]), height: Math.max(MIN_CARD.height, card.height + delta[1]) }); }
            }}><i/><i/><i/></button>
          {SIDES.map(side => <button key={side} className={`canvas-port canvas-port-${side}`} data-side={side} aria-label={`Connect from ${side} of card`}
            onPointerDown={e => { if (!spaceRef.current && e.button !== 1) beginGesture(e, "connect", card, side); }} onClick={e => { if (e.detail === 0) setConnecting({ card: card.id, side }); }} />)}
        </article>)}
      </div>
      {active && toolbarPosition && !busy && <div className="canvas-card-toolbar canvas-hud" style={toolbarPosition} role="toolbar" aria-label="Card actions"
        onPointerEnter={() => holdHover(active.id)} onPointerLeave={leaveHover} onPointerDown={e => e.stopPropagation()}>
        <button aria-label="Move card" title="Drag to move" className="canvas-move-handle" onPointerDown={e => beginGesture(e, "move", active)}><MoveGlyph/></button>
        <button aria-label="Edit card" title="Edit card" onClick={() => beginEditing(active)}><EditGlyph/></button>
        <button aria-label="Card appearance" title="Icon & color" aria-expanded={appearance} onClick={() => { setSelected(new Set([active.id])); setAppearance(!appearance); }}>
          {active.icon ? <SectionIconView icon={active.icon} size={17}/> : <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2s-5 6-5 10a5 5 0 0 0 10 0c0-4-5-10-5-10z"/></svg>}
        </button>
        <span className="canvas-tool-divider"/>
        {([14, 17, 21] as const).map((s, i) => <button key={s} aria-label={`${["Small", "Medium", "Large"][i]} card text`} aria-pressed={active.textSize === s} title={`${["Small", "Medium", "Large"][i]} text`}
          style={{ fontSize: 12 + i * 3 }} onClick={() => patchCard(active.id, { textSize: s })}>A</button>)}
        <span className="canvas-tool-divider"/>
        <button aria-label="Duplicate card" title="Duplicate card" onClick={() => duplicate(active)}><CopyGlyph/></button>
        <button aria-label="Connect card" title="Connect card (C)" aria-pressed={connecting?.card === active.id} onClick={() => { finishEditing(); setConnecting({ card: active.id, side: "right" }); }}><ConnectGlyph/></button>
        <button aria-label="Delete card" title="Delete card" onClick={() => { finishEditing(); session.change(deleteCards(session.get().board!, new Set([active.id]))); setSelected(new Set()); setHovered(null); setAppearance(false); }}><TrashGlyph/></button>
      </div>}
      {active && appearance && toolbarPosition && <div className="canvas-popover canvas-appearance" style={{ left: toolbarPosition.left, top: Math.min(size.height - 250, toolbarPosition.top + 48) }} onPointerDown={e => e.stopPropagation()}>
        <div className="canvas-popover-heading"><span>Icon & color</span><button aria-label="Close appearance" onClick={() => setAppearance(false)}>×</button></div>
        <div className="icon-grid">{(Object.keys(SYMBOLS) as SymbolId[]).map(symbol => <button key={symbol} title={SYMBOLS[symbol].label} aria-label={`${SYMBOLS[symbol].label} icon`} aria-pressed={active.icon?.symbol === symbol}
          onClick={() => patchCard(active.id, { icon: { symbol, color: active.icon?.color ?? "aqua" } })}><SectionIconView icon={{ symbol, color: active.icon?.color ?? "aqua" }} size={17}/></button>)}</div>
        <div className="color-row">{(Object.keys(COLORS) as ColorId[]).map(color => <button key={color} className="swatch" aria-label={`${COLORS[color]} card`} aria-pressed={active.icon?.color === color}
          style={{ background: colorVar(color) }} onClick={() => patchCard(active.id, { icon: { symbol: active.icon?.symbol ?? "bulb", color } })}/>)}</div>
        <div className="canvas-appearance-footer"><button onClick={() => patchCard(active.id, { icon: undefined })}>Remove icon</button><button onClick={() => {
          const text = host.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(active.id)}"] .canvas-card-copy`);
          patchCard(active.id, { height: Math.max(MIN_CARD.height, (text?.scrollHeight ?? active.height - 48) + (active.icon ? 82 : 48)) });
        }}>Fit to content</button></div>
      </div>}
      {selectedEdge && <div className="canvas-hud canvas-edge-toolbar" role="toolbar" aria-label="Connection actions">
        <span>Connection</span><button aria-pressed={selectedEdge.arrow} onClick={() => session.change({ ...board, connections: board.connections.map(e => e.id === selectedEdge.id ? { ...e, arrow: !e.arrow } : e) })}>Arrow {selectedEdge.arrow ? "on" : "off"}</button>
        <button aria-label="Delete connection" onClick={removeSelection}><TrashGlyph/></button>
      </div>}
      {connecting && <div className="canvas-hud canvas-connection-hint" role="status">Choose another card to connect <button onClick={() => setConnecting(null)}>Cancel</button></div>}
      <CanvasMinimap board={board} camera={camera} size={size} selected={selected} busy={busy} onCamera={moveCamera}/>
    </>}
    <div className="canvas-hud canvas-navigation" onPointerDown={e => e.stopPropagation()}>
      <button aria-label="Zoom out" title="Zoom out" onClick={() => moveCamera(zoomAt(camera, { x: size.width / 2, y: size.height / 2 }, camera.zoom / 1.2))}>−</button>
      <button className="canvas-zoom-value" aria-label="Reset zoom to 100%" title="Reset to 100%" onClick={() => moveCamera(zoomAt(camera, { x: size.width / 2, y: size.height / 2 }, 1))}>{Math.round(camera.zoom * 100)}%</button>
      <button aria-label="Zoom in" title="Zoom in" onClick={() => moveCamera(zoomAt(camera, { x: size.width / 2, y: size.height / 2 }, camera.zoom * 1.2))}>＋</button>
      <span className="canvas-tool-divider"/><button onClick={fit} title="Fit cards (F)" aria-label="Fit cards">Fit</button>
      <span className="canvas-tool-divider"/><button aria-label="Undo canvas action" disabled={!session.canUndo || busy} onClick={() => { finishEditing(); session.undo(); }}>↶</button>
      <button aria-label="Redo canvas action" disabled={!session.canRedo || busy} onClick={() => session.redo()}>↷</button>
      <span className="canvas-tool-divider"/><button aria-label="Canvas shortcuts" aria-expanded={help} onClick={() => { setHelp(!help); setRecoveries(false); }}>?</button>
    </div>
    <div className="canvas-hud canvas-save-status" role="status">
      <span className={`canvas-save-dot ${snapshot.status}`}/>{snapshot.status === "error" ? "Canvas needs attention" : snapshot.status === "dirty" || snapshot.status === "saving" ? "Saving…" : snapshot.status === "loading" ? "Loading…" : "Saved locally"}
      {(snapshot.recovered.length > 0 || snapshot.error && !board) && <button onClick={() => { setRecoveries(!recoveries); setHelp(false); }}>Recovered versions{snapshot.recovered.length ? ` (${snapshot.recovered.length})` : ""}</button>}
    </div>
    {snapshot.error && <div className="canvas-hud canvas-error" role="alert"><span>{snapshot.error}</span><button onClick={() => { void session.retry().catch(() => {}); }}>Retry</button></div>}
    {notice && <div className="canvas-hud canvas-error" role="alert">{notice}<button onClick={() => setNotice(null)}>Dismiss</button></div>}
    {help && <div className="canvas-popover canvas-help"><div className="canvas-popover-heading"><span>A few ways to find your flow</span><button aria-label="Close shortcuts" onClick={() => setHelp(false)}>×</button></div>
      <dl><dt>New card</dt><dd>Double-click · N</dd><dt>Move around</dt><dd>Drag background · Space-drag</dd><dt>Zoom</dt><dd>Pinch · ⌘ / Ctrl + scroll</dd><dt>Edit a card</dt><dd>Double-click · Enter</dd><dt>Select several</dt><dd>Shift-click</dd><dt>Connect</dt><dd>Drag a side dot · C, select a card, Enter</dd><dt>Resize</dt><dd>Drag corner dots · focus them + arrows</dd><dt>Fit cards</dt><dd>F</dd><dt>Move selection</dt><dd>Arrows · Shift for larger steps</dd><dt>Undo / redo</dt><dd>⌘ / Ctrl Z · Shift Z</dd><dt>Finish / cancel</dt><dd>Escape</dd></dl></div>}
    {recoveries && <div className="canvas-popover canvas-recoveries"><div className="canvas-popover-heading"><span>Recovered versions</span><button aria-label="Close recovered versions" onClick={() => { setRecoveries(false); setRecovery(null); }}>×</button></div>
      <p>Conflicting ideas are kept here. Preview a version before restoring it; your current board is backed up automatically.</p>
      {!snapshot.recovered.length && <p>No recovered versions found.</p>}
      {snapshot.recovered.map(name => <button className="canvas-recovery-item" key={name} onClick={() => { finishEditing(); void session.readRecovery(name).then(b => setRecovery({ name, board: b })).catch(e => setNotice(String(e))); }} aria-pressed={recovery?.name === name}>{name.replace(/^canvas \(|\)\.json$/g, "")}</button>)}
      {recovery && <div className="canvas-recovery-preview"><strong>{recovery.board.cards.length} cards · {recovery.board.connections.length} connections</strong>
        <div>{recovery.board.cards.map(c => <article key={c.id}><strong>{c.title}</strong><p>{c.body || "Empty card"}</p></article>)}</div>
        <button className="canvas-add" onClick={() => { void session.restore(recovery.name).then(() => { setRecovery(null); setRecoveries(false); setSelected(new Set()); setHovered(null); fit(); }).catch(e => setNotice(String(e))); }}>Restore this version</button>
      </div>}
    </div>}
  </div>;
}
