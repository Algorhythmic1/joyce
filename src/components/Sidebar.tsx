import { useEffect, useRef, useState } from "react";
import { basename, dirname, displayName, isWithin, type Entry } from "../fs";
import { Chevron, NewDocIcon, NewFolderIcon } from "./icons";

interface Props {
  root: string;
  tree: Entry[];
  openPath: string | null;
  renaming: string | null;
  onOpen: (path: string) => void;
  onCreate: (kind: "file" | "dir", dir: string) => void;
  onRename: (path: string, newName: string | null) => void;
  onMove: (path: string, destDir: string) => void;
  onStartRename: (path: string) => void;
  onTrash: (path: string) => void;
  onPickFolder: () => void;
}

type Menu = { x: number; y: number; entry: Entry | null };

/** How long to hover a collapsed folder while dragging before it opens. */
const SPRING_OPEN_MS = 650;

export interface DragHandlers {
  dropTarget: string | null;
  rowProps: (entry: Entry) => React.HTMLAttributes<HTMLDivElement> & { draggable: boolean };
}

export function Sidebar(props: Props) {
  const { root, tree, openPath, onCreate, onPickFolder } = props;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<Menu | null>(null);

  // Reveal the open document by expanding its ancestor folders.
  useEffect(() => {
    if (!openPath) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (let d = dirname(openPath); d.length > root.length; d = dirname(d)) next.add(d);
      return next;
    });
  }, [openPath, root]);

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

  // --- Drag and drop: move files and folders into folders ------------------
  const dragging = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const springTimer = useRef<number | undefined>(undefined);

  // Opening a collapsed folder after a short hover lets you drop deeper in the tree.
  useEffect(() => {
    clearTimeout(springTimer.current);
    if (dropTarget && dropTarget !== root && !expanded.has(dropTarget)) {
      springTimer.current = window.setTimeout(
        () => setExpanded((prev) => new Set(prev).add(dropTarget)),
        SPRING_OPEN_MS,
      );
    }
    return () => clearTimeout(springTimer.current);
  }, [dropTarget, root, expanded]);

  // Dropping where the item already is, or a folder into itself, isn't a move.
  const canDrop = (dir: string) => {
    const path = dragging.current;
    return !!path && dirname(path) !== dir && !isWithin(dir, path);
  };

  const endDrag = () => {
    dragging.current = null;
    setDropTarget(null);
  };

  const dragOver = (e: React.DragEvent, dir: string) => {
    e.stopPropagation();
    if (!canDrop(dir)) return setDropTarget(null);
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(dir);
  };

  const drop = (e: React.DragEvent, dir: string) => {
    e.preventDefault();
    e.stopPropagation();
    const path = dragging.current;
    const ok = canDrop(dir);
    endDrag();
    if (!path || !ok) return;
    if (dir !== root) setExpanded((prev) => new Set(prev).add(dir));
    props.onMove(path, dir);
  };

  const drag: DragHandlers = {
    dropTarget,
    rowProps: (entry) => {
      // Dropping on a document means "into the folder it's in", like Finder's list view.
      const dir = entry.isDir ? entry.path : dirname(entry.path);
      return {
        draggable: props.renaming !== entry.path,
        onDragStart: (e) => {
          dragging.current = entry.path;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", entry.name);
          setMenu(null);
        },
        onDragEnd: endDrag,
        onDragOver: (e) => dragOver(e, dir),
        onDrop: (e) => drop(e, dir),
      };
    },
  };

  // New items go next to whatever is open, which is usually where you're working.
  const targetDir = openPath ? dirname(openPath) : root;

  const openMenu = (e: React.MouseEvent, entry: Entry | null) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  };

  const menuDir = menu?.entry ? (menu.entry.isDir ? menu.entry.path : dirname(menu.entry.path)) : root;

  return (
    <aside
      className="sidebar"
      onContextMenu={(e) => openMenu(e, null)}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
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
        </div>
      </div>
      <nav
        className={`tree${dropTarget === root ? " drop-root" : ""}`}
        onDragOver={(e) => dragOver(e, root)}
        onDrop={(e) => drop(e, root)}
      >
        {tree.length === 0 ? (
          <p className="tree-empty">No documents yet.</p>
        ) : (
          <TreeLevel {...props} entries={tree} depth={0} expanded={expanded} toggle={toggle} openMenu={openMenu} drag={drag} />
        )}
      </nav>
      {menu && (
        <ul className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <li onClick={() => (setMenu(null), onCreate("file", menuDir))}>New Document</li>
          <li onClick={() => (setMenu(null), onCreate("dir", menuDir))}>New Folder</li>
          {menu.entry && (
            <>
              <hr />
              <li onClick={() => (setMenu(null), props.onStartRename(menu.entry!.path))}>Rename</li>
              <li onClick={() => (setMenu(null), props.onTrash(menu.entry!.path))}>Move to Trash</li>
            </>
          )}
        </ul>
      )}
    </aside>
  );
}

interface LevelProps extends Props {
  entries: Entry[];
  depth: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
  openMenu: (e: React.MouseEvent, entry: Entry) => void;
  drag: DragHandlers;
}

function TreeLevel(props: LevelProps) {
  const { entries, depth, expanded, toggle, openMenu, openPath, renaming, onOpen, onRename, onStartRename, drag } = props;
  return (
    <ul role="group">
      {entries.map((entry) => {
        const isOpen = expanded.has(entry.path);
        return (
          <li key={entry.path}>
            <div
              {...drag.rowProps(entry)}
              className={`tree-row${entry.path === openPath ? " selected" : ""}${
                entry.isDir && drag.dropTarget === entry.path ? " drop-target" : ""
              }`}
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => (entry.isDir ? toggle(entry.path) : onOpen(entry.path))}
              onDoubleClick={() => onStartRename(entry.path)}
              onContextMenu={(e) => openMenu(e, entry)}
            >
              <span className="tree-chevron">{entry.isDir && <Chevron open={isOpen} />}</span>
              {renaming === entry.path ? (
                <RenameInput entry={entry} onDone={(name) => onRename(entry.path, name)} />
              ) : (
                <span className={`tree-label${entry.isDir ? " is-dir" : ""}`}>
                  {entry.isDir ? entry.name : displayName(entry.name)}
                </span>
              )}
            </div>
            {entry.isDir && isOpen && entry.children && entry.children.length > 0 && (
              <TreeLevel {...props} entries={entry.children} depth={depth + 1} />
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
