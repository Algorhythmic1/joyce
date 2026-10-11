import { useSyncExternalStore } from "react";
import { isWithin, join, storage } from "./fs";

/*
 * App data that belongs with the writing rather than with one computer (goals,
 * stats, document goals, GitHub links) lives as small JSON files in a hidden
 * `.joyce/` folder inside the writing folder. That way it moves, backs up and
 * syncs along with the documents. Paths inside these files are relative to the
 * writing folder, since it can live at a different place on each machine.
 */

export const STATE_DIR = ".joyce";

let root: string | null = null;

/** Identifies this computer, e.g. in per-device stats files. Stays on this machine. */
export const deviceId: string = (() => {
  let id = localStorage.getItem("joyce:device-id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("joyce:device-id", id);
  }
  return id;
})();

export const currentRoot = () => root;

/** A path inside the writing folder, relative to it, with `/` separators. */
export const toRel = (abs: string) => (root && isWithin(abs, root) && abs !== root ? abs.slice(root.length + 1) : null);
export const toAbs = (rel: string) => (root ? join(root, rel) : rel);

/** Moves keys of a path-keyed record when a file or folder is renamed or moved. */
export function rekey<V>(record: Record<string, V>, from: string, to: string): Record<string, V> {
  return Object.fromEntries(
    Object.entries(record).map(([k, v]) => [k === from || k.startsWith(from + "/") ? to + k.slice(from.length) : k, v]),
  );
}

export function dropKeys<V>(record: Record<string, V>, path: string): Record<string, V> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== path && !k.startsWith(path + "/")));
}

type Loader = () => Promise<void>;
const loaders = new Set<Loader>();
const flushers = new Set<() => Promise<void>>();

interface StoreOptions<T> {
  /** File name inside `.joyce/`. */
  file: string | (() => string);
  fallback: T;
  /** Turns whatever is in the file into a valid value. */
  parse?: (raw: unknown) => T;
  /** Data from before this lived in the folder (called once, when the file doesn't exist yet). */
  legacy?: () => T | null;
}

/** A JSON value kept in `.joyce/<file>`, loaded when a writing folder opens and saved shortly after changes. */
export class FolderStore<T> {
  private value: T;
  private listeners = new Set<() => void>();
  private timer: number | undefined;
  private dirty = false;

  constructor(private opts: StoreOptions<T>) {
    this.value = opts.fallback;
    loaders.add(() => this.load());
    flushers.add(() => this.flush());
  }

  private get path() {
    const file = typeof this.opts.file === "function" ? this.opts.file() : this.opts.file;
    return root ? join(join(root, STATE_DIR), file) : null;
  }

  get = () => this.value;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };

  private emit() {
    this.listeners.forEach((l) => l());
  }

  set(value: T, { saveAfterMs = 600 } = {}) {
    this.value = value;
    this.emit();
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), saveAfterMs);
  }

  async flush() {
    clearTimeout(this.timer);
    const path = this.path;
    if (!this.dirty || !path) return;
    this.dirty = false;
    await storage.write(path, JSON.stringify(this.value, null, 2) + "\n").catch((e) => {
      this.dirty = true;
      console.error(e);
    });
  }

  private loading: Promise<void> = Promise.resolve();

  /** Loads take turns, so two overlapping loads can't undo each other. */
  load() {
    this.loading = this.loading.then(() => this.loadNow());
    return this.loading;
  }

  private async loadNow() {
    const path = this.path;
    if (!path || this.dirty) return;
    let raw: unknown;
    let found = true;
    try {
      raw = JSON.parse(await storage.read(path));
    } catch {
      found = false;
    }
    // Unsaved changes (including a migration in progress) win over what's on disk.
    if (this.dirty) return;
    if (found) {
      this.value = this.opts.parse ? this.opts.parse(raw) : (raw as T);
    } else {
      const legacy = this.opts.legacy?.();
      if (legacy) return this.set(legacy, { saveAfterMs: 0 });
      this.value = this.opts.fallback;
    }
    this.emit();
  }
}

export const useStore = <T,>(store: FolderStore<T>) => useSyncExternalStore(store.subscribe, store.get);

/** Extra loading work beyond single files (e.g. reading every device's stats). */
export function onFolderLoad(fn: Loader) {
  loaders.add(fn);
}

/** Switches to a writing folder: saves anything pending for the old one, then loads the new one's state. */
export async function bindFolder(newRoot: string | null) {
  await flushFolderState();
  root = newRoot;
  await reloadFolderState();
}

/** Re-reads state from disk, e.g. after another computer's changes arrived. */
export async function reloadFolderState() {
  await Promise.all([...loaders].map((l) => l()));
}

export async function flushFolderState() {
  await Promise.all([...flushers].map((f) => f()));
}

window.addEventListener("beforeunload", () => void flushFolderState());
