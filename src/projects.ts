import { MANIFEST, dirname, join, storage, type Entry, type FolderMeta } from "./fs";
import { isSectionIcon, type SectionIcon } from "./sectionIcons";

/*
 * A project is a folder whose documents ("sections") are kept in a chosen order
 * and can be compiled back into one continuous piece of writing.
 *
 * The order lives in the folder's `.joyce.json` as an outline: each item is a
 * file or folder name, or `{ name, icon?, children? }` when it has an icon or
 * sub-sections. Sub-sections are files in the same folder; nesting is purely in
 * the outline, so restructuring never moves files around. Folders inside a
 * project are parts, with outlines of their own, compiled in place.
 */

export interface OutlineNode {
  name: string;
  icon?: SectionIcon;
  children: OutlineNode[];
}

type OrderItem = string | { name: string; icon?: SectionIcon; children?: OrderItem[] };

export type Placement = { before: string } | { after: string } | { into: string } | "end";

export function findEntry(entries: Entry[], path: string): Entry | undefined {
  for (const e of entries) {
    if (e.path === path) return e;
    const found = e.children && findEntry(e.children, path);
    if (found) return found;
  }
}

/** Paths from the top of the tree down to (not including) `path`: folders and parent sections. */
export function ancestorsOf(entries: Entry[], path: string, trail: string[] = []): string[] | undefined {
  for (const e of entries) {
    if (e.path === path) return trail;
    const found = e.children && ancestorsOf(e.children, path, [...trail, e.path]);
    if (found) return found;
  }
}

/** The project containing `path` (or `path` itself, if it's a project), if any. */
export function projectOf(tree: Entry[], root: string, path: string): Entry | undefined {
  for (let p = path; p.length > root.length; p = dirname(p)) {
    const e = findEntry(tree, p);
    if (e?.isDir && e.meta?.project) return e;
  }
}

/** Whether a folder's children are in a chosen order: projects and folders inside them. */
export const isOrdered = (tree: Entry[], root: string, dir: string) => !!projectOf(tree, root, dir);

// --- Outlines -----------------------------------------------------------------

/** Reads an outline from a manifest, tolerating anything malformed or repeated. */
function parseOutline(raw: unknown): OutlineNode[] {
  const seen = new Set<string>();
  const parse = (items: unknown): OutlineNode[] => {
    if (!Array.isArray(items)) return [];
    const nodes: OutlineNode[] = [];
    for (const item of items) {
      const name = typeof item === "string" ? item : (item as { name?: unknown })?.name;
      if (typeof name !== "string" || seen.has(name)) continue;
      seen.add(name);
      const obj = typeof item === "object" ? (item as { icon?: unknown; children?: unknown }) : {};
      nodes.push({
        name,
        icon: isSectionIcon(obj.icon) ? obj.icon : undefined,
        children: parse(obj.children),
      });
    }
    return nodes;
  };
  return parse(raw);
}

function serialize(nodes: OutlineNode[]): OrderItem[] {
  return nodes.map((n) =>
    !n.icon && !n.children.length
      ? n.name
      : { name: n.name, ...(n.icon && { icon: n.icon }), ...(n.children.length && { children: serialize(n.children) }) },
  );
}

/** Every file and folder directly in `dir`, including sections shown nested under others. */
function physicalChildren(dir: Entry): Entry[] {
  const out: Entry[] = [];
  const visit = (list: Entry[]) => {
    for (const e of list) {
      out.push(e);
      if (!e.isDir && e.children) visit(e.children);
    }
  };
  visit(dir.children ?? []);
  return out;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

/**
 * The folder's outline, matched to what's actually on disk: entries for missing
 * files are dropped (their sub-sections move up into their place), anything not
 * listed (e.g. added in Finder) goes at the end, and folders can't have sub-sections.
 */
function reconcile(raw: unknown, present: Entry[]): OutlineNode[] {
  const kinds = new Map(present.map((e) => [e.name, e.isDir]));
  const listed = new Set<string>();
  const clean = (nodes: OutlineNode[]): OutlineNode[] =>
    nodes.flatMap((n) => {
      const children = clean(n.children);
      if (!kinds.has(n.name)) return children;
      listed.add(n.name);
      return kinds.get(n.name) ? [{ ...n, children: [] }, ...children] : [{ ...n, children }];
    });
  const nodes = clean(parseOutline(raw));
  const extra = [...kinds.keys()].filter((n) => !listed.has(n)).sort(byName);
  return [...nodes, ...extra.map((name) => ({ name, children: [] }))];
}

const outlineOf = (dir: Entry) => reconcile(dir.meta?.order, physicalChildren(dir));

/**
 * Arranges each ordered folder by its outline throughout the tree: sections nest
 * under their parents and carry their icons. Other folders keep folders-first A–Z.
 */
export function applyOrder(entries: Entry[], ordered = false, meta?: FolderMeta | null): Entry[] {
  const arrange = (e: Entry): Entry =>
    e.isDir && e.children ? { ...e, children: applyOrder(e.children, ordered || !!e.meta?.project, e.meta) } : e;
  if (!ordered) return entries.map(arrange);
  const named = new Map(entries.map((e) => [e.name, e]));
  const build = (n: OutlineNode): Entry => {
    const e = arrange(named.get(n.name)!);
    if (e.isDir) return { ...e, icon: n.icon };
    return { ...e, icon: n.icon, children: n.children.length ? n.children.map(build) : undefined };
  };
  return reconcile(meta?.order, entries).map(build);
}

async function writeMeta(dir: { path: string; meta?: FolderMeta | null }, meta: FolderMeta) {
  await storage.write(join(dir.path, MANIFEST), JSON.stringify({ ...dir.meta, ...meta }, null, 2) + "\n");
}

const saveOutline = (dir: Entry, nodes: OutlineNode[]) => writeMeta(dir, { order: serialize(nodes) });

function find(nodes: OutlineNode[], name: string): { node: OutlineNode; list: OutlineNode[]; index: number } | undefined {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node.name === name) return { node, list: nodes, index };
    const found = find(node.children, name);
    if (found) return found;
  }
}

/** Removes and returns a node with its whole subtree. */
function take(nodes: OutlineNode[], name: string): OutlineNode | undefined {
  const found = find(nodes, name);
  if (found) found.list.splice(found.index, 1);
  return found?.node;
}

function insert(nodes: OutlineNode[], node: OutlineNode, placement: Placement) {
  if (placement !== "end") {
    const anchor = "before" in placement ? placement.before : "after" in placement ? placement.after : placement.into;
    const found = find(nodes, anchor);
    if (found) {
      if ("into" in placement) found.node.children.push(node);
      else found.list.splice("before" in placement ? found.index : found.index + 1, 0, node);
      return;
    }
  }
  nodes.push(node);
}

const subtree = (node: OutlineNode): string[] => node.children.flatMap((c) => [c.name, ...subtree(c)]);

/** Names of everything nested under `name`, deepest last. */
export const descendantsOf = (dir: Entry, name: string) => {
  const found = find(outlineOf(dir), name);
  return found ? subtree(found.node) : [];
};

/** Marks a new folder as a project whose outline starts with `sections`. */
export const initProject = (path: string, sections: string[]) => writeMeta({ path }, { project: true, order: sections });

export const makeProject = (dir: Entry, project: boolean) =>
  writeMeta(dir, { project, order: serialize(outlineOf(dir)) });

/**
 * Puts `name` (with its sub-sections) at `placement` in an ordered folder. A
 * section can't be placed inside its own sub-sections; that's a no-op.
 */
export async function placeInOrder(dir: Entry, name: string, placement: Placement) {
  const nodes = outlineOf(dir);
  const existing = find(nodes, name)?.node;
  if (existing && placement !== "end") {
    const anchor = "before" in placement ? placement.before : "after" in placement ? placement.after : placement.into;
    if (anchor === name || subtree(existing).includes(anchor)) return;
  }
  const node = take(nodes, name) ?? { name, children: [] };
  insert(nodes, node, placement);
  await saveOutline(dir, nodes);
}

/** Removes `name` and its subtree from a folder's outline, returning it for placing elsewhere. */
export async function takeFromOrder(dir: Entry, name: string): Promise<OutlineNode | undefined> {
  const nodes = outlineOf(dir);
  const node = take(nodes, name);
  if (node) await saveOutline(dir, nodes);
  return node;
}

/** Removes `name` from the outline; its sub-sections move up into its place. */
export async function removeFromOrder(dir: Entry, name: string) {
  const nodes = outlineOf(dir);
  const found = find(nodes, name);
  if (!found) return;
  found.list.splice(found.index, 1, ...found.node.children);
  await saveOutline(dir, nodes);
}

/** Adds a node (and its subtree) taken from another folder's outline. */
export async function insertIntoOrder(dir: Entry, node: OutlineNode, placement: Placement) {
  const nodes = outlineOf(dir);
  insert(nodes, node, placement);
  await saveOutline(dir, nodes);
}

export async function renameInOrder(dir: Entry, from: string, to: string) {
  const nodes = outlineOf(dir);
  const found = find(nodes, from);
  if (!found) return;
  found.node.name = to;
  await saveOutline(dir, nodes);
}

export async function setSectionIcon(dir: Entry, name: string, icon: SectionIcon | null) {
  const nodes = outlineOf(dir);
  const found = find(nodes, name);
  if (!found) return;
  found.node.icon = icon ?? undefined;
  await saveOutline(dir, nodes);
}

// --- Compiling --------------------------------------------------------------

export interface CompiledSection {
  path: string;
  /** Section name for display (file name without extension, or the part's folder name). */
  name: string;
  /** Character offset where this section starts in the compiled text. */
  start: number;
  /** Nesting: 0 at the top of the project, 1 for a sub-section or inside a part, and so on. */
  depth: number;
  isPart: boolean;
  icon?: SectionIcon;
}

export interface Compiled {
  text: string;
  sections: CompiledSection[];
}

const displayName = (name: string) => name.replace(/\.(md|markdown|txt)$/i, "");

/**
 * Relative image paths in a section are relative to the section's folder. In the
 * compiled text everything is relative to the project folder, so sections inside
 * parts get their folder prepended.
 */
function rebaseImages(text: string, prefix: string) {
  if (!prefix) return text;
  // Folder names can contain spaces, which aren't allowed bare in a Markdown link.
  const encoded = prefix.split("/").map(encodeURIComponent).join("/");
  return text.replace(
    /(!\[[^\]]*\]\(\s*<?)(?![a-z][a-z0-9+.-]*:|\/|#)([^)\s>]+)/gi,
    (_, open: string, src: string) => `${open}${encoded}/${src.replace(/^\.\//, "")}`,
  );
}

/**
 * Stitches a project's sections into one continuous document: each section, then
 * its sub-sections, then the next, with a blank line between. Expects a project
 * entry from a tree arranged by `applyOrder`. Reads from disk, so save edits first.
 */
export async function compileProject(project: Entry): Promise<Compiled> {
  const sections: CompiledSection[] = [];
  const pieces: string[] = [];
  let length = 0;
  const nextStart = () => length + (pieces.length ? 2 : 0);

  const walk = async (entries: Entry[], depth: number) => {
    for (const e of entries) {
      if (e.isDir) {
        // Parts mark a boundary but contribute no text of their own.
        sections.push({ path: e.path, name: e.name, start: nextStart(), depth, isPart: true, icon: e.icon });
        await walk(e.children ?? [], depth + 1);
        continue;
      }
      const rel = dirname(e.path).slice(project.path.length).replace(/^\//, "");
      const text = rebaseImages((await storage.read(e.path)).replace(/\s+$/, ""), rel);
      sections.push({ path: e.path, name: displayName(e.name), start: nextStart(), depth, isPart: false, icon: e.icon });
      const sep = pieces.length ? "\n\n" : "";
      pieces.push(sep + text);
      length += sep.length + text.length;
      if (e.children) await walk(e.children, depth + 1);
    }
  };
  await walk(project.children ?? [], 0);
  // A part with nothing after it would point past the end.
  for (const s of sections) s.start = Math.min(s.start, length);
  return { text: pieces.join("") + (pieces.length ? "\n" : ""), sections };
}
