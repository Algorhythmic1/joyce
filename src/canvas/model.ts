import { COLORS, SYMBOLS, type SectionIcon } from "../sectionIcons.ts";
import { websiteUrl } from "./websites.ts";

export type Point = { x: number; y: number };
export type Camera = Point & { zoom: number };
export type Side = "top" | "right" | "bottom" | "left";
export type Card = Point & {
  id: string;
  title: string;
  body: string;
  width: number;
  height: number;
  textSize: 14 | 17 | 21;
  icon?: SectionIcon;
  kind?: "idea" | "website";
  url?: string;
};
export type Connection = { id: string; from: string; to: string; fromSide: Side; toSide: Side; arrow: boolean };
export type Board = { version: 1; id: string; cards: Card[]; connections: Connection[] };
export type Bounds = Point & { width: number; height: number };
export const SIDES: Side[] = ["top", "right", "bottom", "left"];
export const MIN_CARD = { width: 180, height: 100 };
export const newBoard = (): Board => ({ version: 1, id: crypto.randomUUID(), cards: [], connections: [] });
export const newCard = (p: Point): Card => ({ ...p, id: crypto.randomUUID(), title: "", body: "", width: 280, height: 160, textSize: 17 });
export const newWebsiteCard = (p: Point, url: string, title = ""): Card => ({ ...newCard(p), kind: "website", url: websiteUrl(url), title });
export const screenToWorld = (p: Point, c: Camera): Point => ({ x: (p.x - c.x) / c.zoom, y: (p.y - c.y) / c.zoom });
export const worldToScreen = (p: Point, c: Camera): Point => ({ x: p.x * c.zoom + c.x, y: p.y * c.zoom + c.y });
export const zoomAt = (c: Camera, p: Point, zoom: number): Camera => {
  const world = screenToWorld(p, c);
  const z = Math.max(0.02, Math.min(3, zoom));
  return { x: p.x - world.x * z, y: p.y - world.y * z, zoom: z };
};
export function endpoint(card: Card, side: Side): Point {
  return { x: card.x + (side === "left" ? 0 : side === "right" ? card.width : card.width / 2),
    y: card.y + (side === "top" ? 0 : side === "bottom" ? card.height : card.height / 2) };
}
export function curve(from: Point, to: Point, fromSide: Side, toSide: Side): string {
  const distance = Math.max(48, Math.min(240, Math.hypot(to.x - from.x, to.y - from.y) * 0.45));
  const control = (p: Point, s: Side) => ({ x: p.x + (s === "right" ? distance : s === "left" ? -distance : 0),
    y: p.y + (s === "bottom" ? distance : s === "top" ? -distance : 0) });
  const a = control(from, fromSide), b = control(to, toSide);
  return `M ${from.x} ${from.y} C ${a.x} ${a.y} ${b.x} ${b.y} ${to.x} ${to.y}`;
}
export function cardBounds(cards: Card[]): Bounds | null {
  if (!cards.length) return null;
  const x = Math.min(...cards.map(c => c.x)), y = Math.min(...cards.map(c => c.y));
  return { x, y, width: Math.max(...cards.map(c => c.x + c.width)) - x, height: Math.max(...cards.map(c => c.y + c.height)) - y };
}
export const viewportBounds = (c: Camera, size: { width: number; height: number }): Bounds => ({ ...screenToWorld({ x: 0, y: 0 }, c), width: size.width / c.zoom, height: size.height / c.zoom });
export function mapBounds(cards: Card[], viewport: Bounds): Bounds {
  const content = cardBounds(cards) ?? viewport;
  const x = Math.min(content.x, viewport.x), y = Math.min(content.y, viewport.y);
  const w = Math.max(content.x + content.width, viewport.x + viewport.width) - x;
  const h = Math.max(content.y + content.height, viewport.y + viewport.height) - y;
  const pad = Math.max(80, Math.max(w, h) * 0.1);
  return { x: x - pad, y: y - pad, width: w + pad * 2, height: h + pad * 2 };
}
export function mapTransform(bounds: Bounds, width = 180, height = 116): Camera {
  const zoom = Math.min(width / bounds.width, height / bounds.height);
  return { zoom, x: (width - bounds.width * zoom) / 2 - bounds.x * zoom, y: (height - bounds.height * zoom) / 2 - bounds.y * zoom };
}
export function connect(board: Board, from: string, to: string, fromSide: Side = "right", toSide: Side = "left"): Board {
  if (from === to || !board.cards.some(c => c.id === from) || !board.cards.some(c => c.id === to) ||
    board.connections.some(e => e.from === from && e.to === to || e.from === to && e.to === from)) return board;
  return { ...board, connections: [...board.connections, { id: crypto.randomUUID(), from, to, fromSide, toSide, arrow: false }] };
}
export function deleteCards(board: Board, ids: Set<string>): Board {
  return { ...board, cards: board.cards.filter(c => !ids.has(c.id)), connections: board.connections.filter(e => !ids.has(e.from) && !ids.has(e.to)) };
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e12;
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;

/** Fail closed: malformed or future data is never silently replaced by an empty board. */
export function parseBoard(raw: unknown): Board {
  if (!object(raw) || raw.version !== 1) throw new Error("This canvas is damaged or uses a newer version of Joyce. Its file has been kept unchanged.");
  if (!id(raw.id) || !Array.isArray(raw.cards) || !Array.isArray(raw.connections)) throw new Error("Canvas data is incomplete. Its file has been kept unchanged.");
  const ids = new Set<string>();
  for (const c of raw.cards) {
    if (!object(c) || !id(c.id) || ids.has(c.id) || typeof c.title !== "string" || typeof c.body !== "string" ||
      !finite(c.x) || !finite(c.y) || !finite(c.width) || !finite(c.height) || c.width < MIN_CARD.width || c.height < MIN_CARD.height ||
      ![14, 17, 21].includes(c.textSize as number)) throw new Error("A canvas card is invalid. Its file has been kept unchanged.");
    if (c.icon !== undefined && (!object(c.icon) || typeof c.icon.symbol !== "string" || typeof c.icon.color !== "string" ||
      !Object.hasOwn(SYMBOLS, c.icon.symbol) || !Object.hasOwn(COLORS, c.icon.color))) throw new Error("A canvas icon is invalid. Its file has been kept unchanged.");
    if (c.kind !== undefined && c.kind !== "idea" && c.kind !== "website") throw new Error("A canvas card type is unsupported. Its file has been kept unchanged.");
    if (c.kind === "website") {
      if (typeof c.url !== "string" || websiteUrl(c.url) !== c.url) throw new Error("A website card address is invalid. Its file has been kept unchanged.");
    } else if (c.url !== undefined) throw new Error("A canvas card address is invalid. Its file has been kept unchanged.");
    ids.add(c.id);
  }
  const edges = new Set<string>(), pairs = new Set<string>();
  for (const e of raw.connections) {
    if (!object(e) || !id(e.id) || edges.has(e.id) || !id(e.from) || !id(e.to) || !ids.has(e.from) || !ids.has(e.to) || e.from === e.to ||
      !SIDES.includes(e.fromSide as Side) || !SIDES.includes(e.toSide as Side) || typeof e.arrow !== "boolean") throw new Error("A canvas connection is invalid. Its file has been kept unchanged.");
    const pair = JSON.stringify([e.from, e.to].sort());
    if (pairs.has(pair)) throw new Error("A canvas connection is repeated. Its file has been kept unchanged.");
    edges.add(e.id); pairs.add(pair);
  }
  return raw as unknown as Board;
}
