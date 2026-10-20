import { isWithin, join, storage } from "../fs";
import { CanvasSession, isCanvasFile } from "./persistence.ts";

/*
 * Each project keeps its own board in `<project>/.joyce/canvas.json`, so it
 * moves, syncs and backs up with the project. Writing outside any project uses
 * the writing folder's own `.joyce/canvas.json`.
 */
const sessions = new Map<string, CanvasSession>();
export function canvasSession(folder: string) {
  let session = sessions.get(folder);
  if (!session) { session = new CanvasSession(folder, storage); sessions.set(folder, session); }
  return session;
}
export const flushCanvases = () => Promise.all([...sessions.values()].map(s => s.flush()));

/** Saves and then forgets every board inside `path`, before it's moved or trashed. */
export async function releaseCanvases(path: string) {
  const within = [...sessions].filter(([folder]) => isWithin(folder, path));
  await Promise.all(within.map(([, s]) => s.flush()));
  for (const [folder] of within) sessions.delete(folder);
}

/** Reloads the boards whose files changed; `paths` are relative to `root`. */
export function reloadCanvas(root: string, paths?: string[]) {
  const folders = new Set<string>();
  for (const p of paths ?? []) {
    const m = p.match(/^(?:(.+)\/)?\.joyce\/([^/]+)$/);
    if (m && isCanvasFile(m[2])) folders.add(m[1] ? join(root, m[1]) : root);
  }
  for (const [folder, session] of sessions) {
    if (paths ? folders.has(folder) : isWithin(folder, root)) void session.reload();
  }
}
window.addEventListener("blur", () => { void flushCanvases().catch(() => {}); });
window.addEventListener("beforeunload", () => { void flushCanvases().catch(() => {}); });
