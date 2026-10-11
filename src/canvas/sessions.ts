import { storage } from "../fs";
import { CanvasSession, isCanvasFile } from "./persistence.ts";

const sessions = new Map<string, CanvasSession>();
export function canvasSession(root: string) {
  let session = sessions.get(root);
  if (!session) { session = new CanvasSession(root, storage); sessions.set(root, session); }
  return session;
}
export const flushCanvases = () => Promise.all([...sessions.values()].map(s => s.flush()));
export function reloadCanvas(root: string, paths?: string[]) {
  if (!paths || paths.some(p => p.startsWith(".joyce/") && isCanvasFile(p.slice(7)))) void sessions.get(root)?.reload();
}
window.addEventListener("blur", () => { void flushCanvases().catch(() => {}); });
window.addEventListener("beforeunload", () => { void flushCanvases().catch(() => {}); });
