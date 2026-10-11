import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { SectionIcon } from "./sectionIcons";
import { open } from "@tauri-apps/plugin-dialog";

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  children?: Entry[] | null;
  /** A folder's `.joyce.json`, if any (see projects.ts). */
  meta?: FolderMeta | null;
  /** Icon chosen for a section or part (from its project's outline). */
  icon?: SectionIcon;
}

export interface FolderMeta {
  /** This folder is a project: its sections compile into one piece of writing. */
  project?: boolean;
  /** Outline of children in their chosen order: names, or `{ name, icon?, children? }`. */
  order?: unknown[];
}

export const MANIFEST = ".joyce.json";

export interface Storage {
  pickFolder(): Promise<string | null>;
  listTree(root: string): Promise<Entry[]>;
  read(path: string): Promise<string>;
  write(path: string, contents: string): Promise<void>;
  createFile(path: string): Promise<void>;
  createDir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  trash(path: string): Promise<void>;
  /** Saves image bytes (base64) at `path`, creating folders as needed. Never overwrites. */
  writeImage(path: string, base64: string): Promise<void>;
  /** A URL the webview can display the image at `path` with. */
  imageUrl(path: string): string;
  /** Lets images inside `dir` be displayed. */
  allowImages(dir: string): Promise<void>;
}

/** Pasted images are kept in this folder beside their document. */
export const ASSETS_DIR = "assets";

export const isTauri = "__TAURI_INTERNALS__" in window;

export const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
export const join = (dir: string, name: string) => `${dir.replace(/\/$/, "")}/${name}`;
/** URL-safe name, e.g. "I'm a DPRK soldier" → "i-m-a-dprk-soldier" (the CMS's slug shape). */
export const slugify = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const isWithin = (path: string, ancestor: string) => path === ancestor || path.startsWith(ancestor + "/");
export const displayName = (name: string) => name.replace(/\.(md|markdown|txt)$/i, "");

const tauriStorage: Storage = {
  async pickFolder() {
    const picked = await open({ directory: true, multiple: false, title: "Choose a folder for your writing" });
    return typeof picked === "string" ? picked : null;
  },
  listTree: (root) => invoke("list_tree", { root }),
  read: (path) => invoke("read_file", { path }),
  write: (path, contents) => invoke("write_file", { path, contents }),
  createFile: (path) => invoke("create_file", { path }),
  createDir: (path) => invoke("create_dir", { path }),
  rename: (from, to) => invoke("rename_path", { from, to }),
  trash: (path) => invoke("trash_path", { path }),
  writeImage: (path, base64) => invoke("write_image", { path, base64 }),
  imageUrl: (path) => convertFileSrc(path),
  allowImages: (dir) => invoke("allow_images_from", { dir }),
};

// In a plain browser (e.g. `npm run dev`) we fake a folder in localStorage so the
// UI can be developed and previewed without the native shell.
const DEMO_KEY = "joyce:demo-fs";
const DEMO_ROOT = "/Writing";

type DemoFs = { files: Record<string, string>; dirs: string[] };

function loadDemo(): DemoFs {
  const raw = localStorage.getItem(DEMO_KEY);
  if (raw) return JSON.parse(raw);
  return {
    dirs: [DEMO_ROOT, `${DEMO_ROOT}/Drafts`],
    files: {
      [`${DEMO_ROOT}/Welcome.md`]:
        "# Welcome to Joyce\n\nA quiet place to write. Everything you type is saved as a plain **Markdown** file in a folder you choose, so your words are never locked inside an app.\n\n## A few things to try\n\n- Select text and press *⌘B* or *⌘I*\n- Press ⌘1, ⌘2 or ⌘3 for headings\n- Press ⌘\\ to hide the sidebar\n- Click **Aa** to change the typeface\n\n> The toolbar fades away while you type. Move the mouse to bring it back.\n",
      [`${DEMO_ROOT}/Drafts/Chapter One.md`]: "# Chapter One\n\nStately, plump Buck Mulligan came from the stairhead…\n",
    },
  };
}

const demoStorage: Storage = (() => {
  let state = loadDemo();
  // Images are only kept for the session; localStorage is too small for them.
  const images = new Map<string, string>();
  const save = () => localStorage.setItem(DEMO_KEY, JSON.stringify(state));
  const exists = (p: string) => p in state.files || state.dirs.includes(p);
  const build = (dir: string): Entry[] => {
    const childDirs = state.dirs.filter((d) => dirname(d) === dir && d !== dir && basename(d) !== ASSETS_DIR);
    const childFiles = Object.keys(state.files).filter((f) => dirname(f) === dir && !basename(f).startsWith("."));
    const meta = (d: string) => {
      try {
        return JSON.parse(state.files[join(d, MANIFEST)] ?? "null");
      } catch {
        return null;
      }
    };
    const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    return [
      ...childDirs.map((d) => ({ name: basename(d), path: d, isDir: true, children: build(d), meta: meta(d) })).sort(byName),
      ...childFiles.map((f) => ({ name: basename(f), path: f, isDir: false })).sort(byName),
    ];
  };
  const fail = (msg: string) => Promise.reject(msg);
  return {
    pickFolder: async () => DEMO_ROOT,
    listTree: async (root) => build(root),
    read: async (path) => state.files[path] ?? fail("No such file"),
    write: async (path, contents) => {
      state.files[path] = contents;
      save();
    },
    createFile: async (path) => {
      if (exists(path)) return fail("Already exists");
      state.files[path] = "";
      save();
    },
    createDir: async (path) => {
      if (exists(path)) return fail("Already exists");
      state.dirs.push(path);
      save();
    },
    rename: async (from, to) => {
      if (exists(to) || images.has(to)) return fail("Something with that name already exists");
      const move = (p: string) => (p === from || p.startsWith(from + "/") ? to + p.slice(from.length) : p);
      for (const [p, url] of [...images]) {
        if (move(p) !== p) {
          images.delete(p);
          images.set(move(p), url);
        }
      }
      state = {
        dirs: state.dirs.map(move),
        files: Object.fromEntries(Object.entries(state.files).map(([p, c]) => [move(p), c])),
      };
      save();
    },
    writeImage: async (path, base64) => {
      if (images.has(path)) return fail("Already exists");
      const ext = path.split(".").pop()?.toLowerCase();
      const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext === "svg" ? "svg+xml" : ext}`;
      images.set(path, `data:${mime};base64,${base64}`);
    },
    imageUrl: (path) => images.get(path) ?? "",
    allowImages: async () => {},
    trash: async (path) => {
      const inside = (p: string) => p === path || p.startsWith(path + "/");
      state = {
        dirs: state.dirs.filter((d) => !inside(d)),
        files: Object.fromEntries(Object.entries(state.files).filter(([p]) => !inside(p))),
      };
      save();
    },
  };
})();

export const storage: Storage = isTauri ? tauriStorage : demoStorage;

/** Returns a path in `dir` named `base.ext`, or `base 2.ext`, `base 3.ext`… if taken. */
export function uniquePath(dir: string, base: string, ext: string, taken: Set<string>): string {
  for (let i = 1; ; i++) {
    const p = join(dir, `${base}${i > 1 ? ` ${i}` : ""}${ext}`);
    if (!taken.has(p)) return p;
  }
}

export function allPaths(entries: Entry[], out = new Set<string>()): Set<string> {
  for (const e of entries) {
    out.add(e.path);
    if (e.children) allPaths(e.children, out);
  }
  return out;
}
