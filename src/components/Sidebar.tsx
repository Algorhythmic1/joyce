import { useEffect, useRef, useState } from "react";
import { basename, dirname, displayName, isWithin, type Entry } from "../fs";
import { ancestorsOf, findEntry, type Placement } from "../projects";
import type { SectionIcon } from "../sectionIcons";
import { BookIcon, Chevron, NewDocIcon, NewFolderIcon, NewProjectIcon } from "./icons";
import { IconPicker, SectionIconView } from "./IconPicker";
import { SIDEBAR_WIDTH } from "../settings";
import { Resizer } from "./Resizer";

export type CreateKind = "file" | "dir" | "project";

interface Props {
  root: string;
  tree: Entry[];
  openPath: string | null;
  /** Project shown as one continuous document, if any. */
  openProject: string | null;
  renaming: string | null;
  onOpen: (path: string) => void;
  onOpenProject: (path: string) => void;
  onCreate: (kind: CreateKind, dir: string, placement?: Placement) => void;
  onRename: (path: string, newName: string | null) => void;
  onMove: (path: string, destDir: string, placement?: Placement) => void;
  onStartRename: (path: string) => void;
  onTrash: (path: string) => void;
  onSetProject: (path: string, project: boolean) => void;
  onSetIcon: (path: string, icon: SectionIcon | null) => void;
  onPickFolder: () => void;
  width: number;
  onResize: (width: number) => void;
}

type Menu = { x: number; y: number; entry: Entry | null; ordered: boolean };

/** How long to hover a collapsed folder while dragging before it opens. */
const SPRING_OPEN_MS = 650;

/** Where a drag would land: into `dir`, optionally at a spot among its ordered children. */
interface DropTarget {
  dir: string;
  placement?: Placement;
  /** Row showing where it'll go: a line above or below, or highlighted to nest inside. */
  row?: string;
  edge?: "before" | "after" | "into";
}

export interface DragHandlers {
  target: DropTarget | null;
  rowProps: (entry: Entry, parentOrdered: boolean) => React.HTMLAttributes<HTMLDivElement> & { draggable: boolean };
}

export function Sidebar(props: Props) {
  const { root, tree, openPath, onCreate, onPickFolder } = props;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<Menu | null>(null);
  const [picker, setPicker] = useState<{ entry: Entry; x: number; y: number } | null>(null);

  // Reveal the open document (or project) by expanding the folders and sections around it.
  useEffect(() => {
    const path = openPath ?? props.openProject;
    if (!path) return;
    const around = ancestorsOf(tree, path) ?? [];
    if (!openPath) around.push(path);
    if (around.every((p) => expanded.has(p))) return;
    setExpanded((prev) => new Set([...prev, ...around]));
    // Only when what's open changes (or the tree first loads), so collapsing by hand sticks.
  }, [openPath, props.openProject, tree.length > 0]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  const expand = (path: string) => setExpanded((prev) => new Set(prev).add(path));

  // --- Drag and drop -------------------------------------------------------
  // Into folders anywhere; inside projects, also to a spot between sections.
  const dragging = useRef<string | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const springTimer = useRef<number | undefined>(undefined);

  // Opening a collapsed folder after a short hover lets you drop deeper in the tree.
  const springFor = target && !target.row && target.dir !== root ? target.dir : null;
  useEffect(() => {
    clearTimeout(springTimer.current);
    if (springFor && !expanded.has(springFor)) {
      springTimer.current = window.setTimeout(() => expand(springFor), SPRING_OPEN_MS);
    }
    return () => clearTimeout(springTimer.current);
  }, [springFor, expanded]);

  /** Sections nested under the one being dragged (it can't go inside its own sub-sections). */
  const nestedUnder = (path: string): string[] => {
    const e = findEntry(tree, path);
    const collect = (list: Entry[] = []): string[] => list.flatMap((c) => [c.path, ...collect(c.children ?? [])]);
    return e && !e.isDir ? collect(e.children ?? []) : [];
  };

  const canDrop = (t: DropTarget) => {
    const path = dragging.current;
    if (!path || isWithin(t.dir, path)) return false;
    if (t.row && nestedUnder(path).includes(t.row)) return false;
    if (dirname(path) !== t.dir) return true;
    // Same folder: only a change of place counts, and not relative to the item itself.
    if (!t.placement) return false;
    if (t.placement === "end") return true;
    const p = t.placement;
    const anchor = "before" in p ? p.before : "after" in p ? p.after : p.into;
    return anchor !== basename(path);
  };

  const endDrag = () => {
    dragging.current = null;
    setTarget(null);
  };

  const sameTarget = (a: DropTarget | null, b: DropTarget) => a?.dir === b.dir && a.row === b.row && a.edge === b.edge;

  const dragOver = (e: React.DragEvent, t: DropTarget) => {
    e.stopPropagation();
    if (!canDrop(t)) return setTarget(null);
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!sameTarget(target, t)) setTarget(t);
  };

  const drop = (e: React.DragEvent, t: DropTarget) => {
    e.preventDefault();
    e.stopPropagation();
    const path = dragging.current;
    const ok = canDrop(t);
    endDrag();
    if (!path || !ok) return;
    if (t.dir !== root) expand(t.dir);
    // Open a section that just got a sub-section, so you can see where it went.
    if (t.edge === "into" && t.row) expand(t.row);
    props.onMove(path, t.dir, t.placement);
  };

  /** Works out the drop target from where the pointer is over a row. */
  const targetFor = (e: React.DragEvent, entry: Entry, parentOrdered: boolean): DropTarget => {
    const parent = dirname(entry.path);
    if (!parentOrdered) {
      // Dropping on a document means "into the folder it's in", like Finder's list view.
      return entry.isDir
        ? { dir: entry.path, placement: entry.meta?.project ? "end" : undefined }
        : { dir: parent };
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    // Edges mean "next to"; the middle means "inside": a part, or as a sub-section.
    if (y > 0.25 && y < 0.75) {
      return entry.isDir
        ? { dir: entry.path, placement: "end" }
        : { dir: parent, placement: { into: entry.name }, row: entry.path, edge: "into" };
    }
    const edge = y <= 0.25 ? "before" : "after";
    return {
      dir: parent,
      placement: edge === "before" ? { before: entry.name } : { after: entry.name },
      row: entry.path,
      edge,
    };
  };

  const drag: DragHandlers = {
    target,
    rowProps: (entry, parentOrdered) => ({
      draggable: props.renaming !== entry.path,
      onDragStart: (e) => {
        dragging.current = entry.path;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", entry.name);
        setMenu(null);
      },
      onDragEnd: endDrag,
      onDragOver: (e) => dragOver(e, targetFor(e, entry, parentOrdered)),
      onDrop: (e) => drop(e, targetFor(e, entry, parentOrdered)),
    }),
  };

  // New items go next to whatever is open, which is usually where you're working.
  const targetDir = openPath ? dirname(openPath) : (props.openProject ?? root);

  const openMenu = (e: React.MouseEvent, entry: Entry | null, ordered = false) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry, ordered });
  };

  const menuDir = menu?.entry ? (menu.entry.isDir ? menu.entry.path : dirname(menu.entry.path)) : root;
  // In a project, "new" lands right after the section that was right-clicked.
  const menuPlacement: Placement | undefined =
    menu?.entry && !menu.entry.isDir && menu.ordered ? { after: menu.entry.name } : undefined;
  const menuInProject = !!menu && (menu.ordered || !!(menu.entry?.isDir && menu.entry.meta?.project));
  const act = (fn: () => void) => () => {
    setMenu(null);
    fn();
  };

  const openPicker = (entry: Entry, x: number, y: number) => setPicker({ entry, x, y });

  useEffect(() => {
    if (!picker) return;
    const close = () => setPicker(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [picker]);

  return (
    <aside
      className="sidebar"
      onContextMenu={(e) => openMenu(e, null)}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTarget(null);
      }}
    >
      <div className="sidebar-header" data-tauri-drag-region>
        <button className="folder-name" onClick={onPickFolder} title="Choose a different folder">
          {basename(root)}
        </button>
        <div className="sidebar-actions">
          <button className="icon-button" onClick={() => onCreate("file", targetDir)} title="New document (⌘N)">
            <NewDocIcon />
          </button>
          <button className="icon-button" onClick={() => onCreate("dir", targetDir)} title="New folder (⇧⌘N)">
            <NewFolderIcon />
          </button>
          <button className="icon-button" onClick={() => onCreate("project", root)} title="New project">
            <NewProjectIcon />
          </button>
        </div>
      </div>
      <nav
        className={`tree${target?.dir === root && !target.row ? " drop-root" : ""}`}
        onDragOver={(e) => dragOver(e, { dir: root })}
        onDrop={(e) => drop(e, { dir: root })}
      >
        {tree.length === 0 ? (
          <p className="tree-empty">No documents yet.</p>
        ) : (
          <TreeLevel
            {...props}
            entries={tree}
            depth={0}
            ordered={false}
            expanded={expanded}
            toggle={toggle}
            expand={expand}
            openMenu={openMenu}
            drag={drag}
            openPicker={openPicker}
          />
        )}
      </nav>
      {menu && (
        <ul className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <li onClick={act(() => onCreate("file", menuDir, menuPlacement))}>{menuInProject ? "New Section" : "New Document"}</li>
          <li onClick={act(() => onCreate("dir", menuDir, menuPlacement))}>{menuInProject ? "New Part" : "New Folder"}</li>
          {!menuInProject && <li onClick={act(() => onCreate("project", menuDir))}>New Project</li>}
          {menu.entry && menu.ordered && !menu.entry.isDir && (
            <li onClick={act(() => onCreate("file", dirname(menu.entry!.path), { into: menu.entry!.name }))}>New Sub-section</li>
          )}
          {menu.entry && (
            <>
              <hr />
              {menu.ordered && <li onClick={act(() => openPicker(menu.entry!, menu.x, menu.y))}>Icon…</li>}
              {menu.entry.isDir && !menu.ordered && (
                <li onClick={act(() => props.onSetProject(menu.entry!.path, !menu.entry!.meta?.project))}>
                  {menu.entry.meta?.project ? "Make Into Folder" : "Make Into Project"}
                </li>
              )}
              <li onClick={act(() => props.onStartRename(menu.entry!.path))}>Rename</li>
              <li onClick={act(() => props.onTrash(menu.entry!.path))}>Move to Trash</li>
            </>
          )}
        </ul>
      )}
      <Resizer
        edge="right"
        width={props.width}
        min={SIDEBAR_WIDTH.min}
        max={SIDEBAR_WIDTH.max}
        cssVar="--sidebar-width"
        label="Resize sidebar"
        onResize={(w) => props.onResize(w ?? SIDEBAR_WIDTH.default)}
      />
      {picker && (
        <IconPicker
          icon={picker.entry.icon}
          x={picker.x}
          y={picker.y}
          onPick={(icon) => props.onSetIcon(picker.entry.path, icon)}
          onClose={() => setPicker(null)}
        />
      )}
    </aside>
  );
}

interface LevelProps extends Props {
  entries: Entry[];
  depth: number;
  /** Whether these entries are in a chosen order (inside a project). */
  ordered: boolean;
  expanded: Set<string>;
  toggle: (path: string) => void;
  expand: (path: string) => void;
  openMenu: (e: React.MouseEvent, entry: Entry, ordered: boolean) => void;
  drag: DragHandlers;
  openPicker: (entry: Entry, x: number, y: number) => void;
}

function TreeLevel(props: LevelProps) {
  const { entries, depth, ordered, expanded, toggle, expand, openMenu, openPath, renaming, drag } = props;
  return (
    <ul role="group">
      {entries.map((entry) => {
        const isOpen = expanded.has(entry.path);
        const isProject = entry.isDir && !!entry.meta?.project;
        const hasChildren = !!entry.children?.length;
        const expandable = entry.isDir || hasChildren;
        const t = drag.target;
        const selected = entry.path === openPath || (isProject && entry.path === props.openProject);
        const classes = [
          "tree-row",
          selected && "selected",
          isProject && "is-project",
          ((entry.isDir && t && !t.row && t.dir === entry.path) || (t?.row === entry.path && t.edge === "into")) &&
            "drop-target",
          t?.row === entry.path && t.edge !== "into" && `drop-${t.edge}`,
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <li key={entry.path}>
            <div
              {...drag.rowProps(entry, ordered)}
              className={classes}
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => {
                if (isProject) {
                  // A project's name opens it as one continuous document.
                  expand(entry.path);
                  props.onOpenProject(entry.path);
                } else if (entry.isDir) toggle(entry.path);
                else props.onOpen(entry.path);
              }}
              onDoubleClick={() => props.onStartRename(entry.path)}
              onContextMenu={(e) => openMenu(e, entry, ordered)}
            >
              <span
                className="tree-chevron"
                onClick={(e) => {
                  if (!expandable) return;
                  e.stopPropagation();
                  toggle(entry.path);
                }}
              >
                {expandable && <Chevron open={isOpen} />}
              </span>
              {isProject ? (
                <span className="tree-icon">
                  <BookIcon />
                </span>
              ) : (
                ordered && (
                  // Every row in a project has an icon slot, so names line up; click it to choose.
                  <button
                    className={`tree-icon section-icon${entry.icon ? "" : " empty"}`}
                    title="Choose an icon"
                    draggable={false}
                    onClick={(e) => {
                      e.stopPropagation();
                      const r = e.currentTarget.getBoundingClientRect();
                      props.openPicker(entry, r.left, r.bottom + 4);
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    {entry.icon ? <SectionIconView icon={entry.icon} /> : <span className="icon-dot" />}
                  </button>
                )
              )}
              {renaming === entry.path ? (
                <RenameInput entry={entry} onDone={(name) => props.onRename(entry.path, name)} />
              ) : (
                <span
                  className={`tree-label${entry.isDir ? " is-dir" : ""}`}
                  // The full name, for when it's cut off.
                  title={entry.isDir ? entry.name : displayName(entry.name)}
                >
                  {entry.isDir ? entry.name : displayName(entry.name)}
                </span>
              )}
            </div>
            {expandable && isOpen && hasChildren && (
              <TreeLevel {...props} entries={entry.children!} depth={depth + 1} ordered={ordered || isProject} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function RenameInput({ entry, onDone }: { entry: Entry; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="rename-input"
      defaultValue={entry.isDir ? entry.name : displayName(entry.name)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== "Escape") return;
        // Focus moves to the editor on finish; don't let this keystroke land there too.
        e.preventDefault();
        finish(e.key === "Enter" ? e.currentTarget.value : null);
      }}
    />
  );
}
