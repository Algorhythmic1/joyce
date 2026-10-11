import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { Editor } from "./components/Editor";
import { Sidebar, type CreateKind } from "./components/Sidebar";
import { sectionMarks } from "./editor/sections";
import { SYNC_EVENT } from "./editor/setup";
import type { SectionIcon } from "./sectionIcons";
import {
  applyOrder, compileProject, descendantsOf, findEntry, initProject, insertIntoOrder, isOrdered, makeProject, placeInOrder,
  removeFromOrder, renameInOrder, setSectionIcon, takeFromOrder, type Compiled, type Placement,
} from "./projects";
import { Toolbar, type Panel } from "./components/Toolbar";
import { PublishPanel } from "./components/PublishPanel";
import { forgetLinks, moveLinks } from "./integrations/github";
import { DocGoalPanel } from "./components/DocGoalPanel";
import { countChars, forgetDocGoals, goalState, moveDocGoals, useDocGoal } from "./docGoals";
import { SettingsPanel } from "./components/SettingsPanel";
import { ProgressPanel } from "./components/ProgressPanel";
import { startReminders } from "./reminders";
import { bindFolder, reloadFolderState, toRel } from "./folderState";
import { SyncPanel, statusText } from "./components/SyncPanel";
import { onRemoteChanges, useSync } from "./sync";
import { goalFor, periodTotal, recordWriting, useDays, useGoals, type Period } from "./stats";
import { ASSETS_DIR, allPaths, basename, dirname, displayName, isWithin, join, slugify, storage, uniquePath, type Entry } from "./fs";
import { fontStack, loadSettings, saveSettings, type Settings } from "./settings";

const ROOT_KEY = "joyce:root";
const LAST_KEY = "joyce:last-file";
const SAVE_DELAY = 400;
const TEXT_EXT = /\.(md|markdown|txt)$/i;

// Image Markdown and link URLs aren't words anyone wrote.
const countWords = (text: string) =>
  text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\]\([^)]*\)/g, "]")
    .match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu)?.length ?? 0;

/** Relative references to images in a document's assets folder. */
const IMAGE_REF = new RegExp(`!\\[[^\\]]*\\]\\(\\s*<?(${ASSETS_DIR}/[^)\\s>]+)>?`, "g");

const fileToBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

const safeDecode = (s: string) => {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
};

let imageCounter = 0;

export default function App() {
  const [settings, setSettings] = useState(loadSettings);
  const [root, setRoot] = useState(() => localStorage.getItem(ROOT_KEY));
  const [tree, setTree] = useState<Entry[]>([]);
  // `id` identifies an editor session; it survives renames so the view isn't rebuilt.
  const [doc, setDoc] = useState<{ id: number; path: string; text: string } | null>(null);
  const nextId = useRef(0);
  // A project shown as one continuous, read-only document. Exclusive with `doc`.
  const [project, setProject] = useState<{ path: string; compiled: Compiled; version: number } | null>(null);
  const [words, setWords] = useState(0);
  const [chars, setChars] = useState(0);
  const [view, setView] = useState<EditorView | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [typing, setTyping] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const report = useCallback((e: unknown) => setToast(String(e)), []);

  // --- Saving ---------------------------------------------------------------
  const pending = useRef<{ path: string; text: string } | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  const flush = useCallback(async () => {
    clearTimeout(saveTimer.current);
    const p = pending.current;
    pending.current = null;
    if (p) await storage.write(p.path, p.text).catch(report);
  }, [report]);

  // Word count of the open document as of the last change, for measuring each edit.
  const lastCount = useRef(0);

  const onChange = (text: string, typed: boolean, fromSync = false) => {
    if (!doc) return;
    const count = countWords(text);
    if (typed) recordWriting(count - lastCount.current);
    lastCount.current = count;
    setWords(count);
    setChars(countChars(text));
    // Another computer's edit is already on disk; nothing to save.
    if (fromSync) return;
    pending.current = { path: doc.path, text };
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flush, SAVE_DELAY);
  };

  useEffect(() => {
    const onHide = () => void flush();
    window.addEventListener("blur", onHide);
    window.addEventListener("beforeunload", onHide);
    return () => {
      window.removeEventListener("blur", onHide);
      window.removeEventListener("beforeunload", onHide);
    };
  }, [flush]);

  // --- Files ----------------------------------------------------------------
  const refresh = useCallback(async () => {
    if (!root) return;
    try {
      setTree(applyOrder(await storage.listTree(root)));
    } catch (e) {
      report(e);
    }
  }, [root, report]);

  const openFile = useCallback(
    async (path: string) => {
      await flush();
      try {
        const text = await storage.read(path);
        setProject(null);
        setDoc({ id: ++nextId.current, path, text });
        lastCount.current = countWords(text);
        setWords(lastCount.current);
        setChars(countChars(text));
        localStorage.setItem(LAST_KEY, path);
      } catch (e) {
        report(e);
      }
    },
    [flush, report],
  );

  useEffect(() => {
    if (!root) return;
    storage.allowImages(root).catch(report);
    // Goals, stats and other app data that live in the writing folder.
    bindFolder(root).catch(report);
    refresh();
    const last = localStorage.getItem(LAST_KEY);
    if (last && isWithin(last, root)) openFile(last);
    // Pick up changes made outside the app whenever we come back to it.
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [root, refresh, openFile]);

  const pickFolder = async () => {
    const picked = await storage.pickFolder().catch(report);
    if (!picked) return;
    await flush();
    setDoc(null);
    localStorage.setItem(ROOT_KEY, picked);
    setRoot(picked);
  };

  const create = async (kind: CreateKind, dir: string, placement?: Placement) => {
    if (!root) return;
    const taken = allPaths(tree);
    const ordered = isOrdered(tree, root, dir);
    const folderName = kind === "project" ? "Untitled Project" : ordered ? "New Part" : "New Folder";
    const path = kind === "file" ? uniquePath(dir, "Untitled", ".md", taken) : uniquePath(dir, folderName, "", taken);
    const firstSection = join(path, "Untitled.md");
    try {
      await (kind === "file" ? storage.createFile(path) : storage.createDir(path));
      if (kind === "project") {
        // A project starts with one section, ready to write in.
        await storage.createFile(firstSection);
        await initProject(path, [basename(firstSection)]);
      }
      const dirEntry = findEntry(tree, dir);
      if (ordered && dirEntry) {
        // New sections go after the one being edited, if it's in the same place.
        const where = placement ?? (doc && dirname(doc.path) === dir ? { after: basename(doc.path) } : "end");
        await placeInOrder(dirEntry, basename(path), where);
      }
      setRenaming(path);
      await refresh();
      if (kind === "file") await openFile(path);
      if (kind === "project") await openFile(firstSection);
    } catch (e) {
      report(e);
    }
  };

  const rename = async (path: string, name: string | null) => {
    setRenaming(null);
    view?.focus();
    const entry = findEntry(tree, path);
    name = name?.trim() ?? "";
    if (!entry || !name) return;
    if (name.includes("/")) return report("Names can't contain “/”.");
    const ext = entry.isDir ? "" : (entry.name.match(TEXT_EXT)?.[0] ?? ".md");
    const to = join(dirname(path), entry.isDir || TEXT_EXT.test(name) ? name : name + ext);
    if (to === path) return;
    const parent = findEntry(tree, dirname(path));
    await relocate(path, to, async () => {
      if (parent) await renameInOrder(parent, basename(path), basename(to));
    });
  };

  /** Renames or moves a file or folder, keeping everything that points at it in step. */
  /** Moves one file or folder on disk and updates everything keyed by its path. */
  const renameOnDisk = async (path: string, to: string) => {
    await storage.rename(path, to);
    moveLinks(path, to);
    moveDocGoals(path, to);
    if (doc && isWithin(doc.path, path)) {
      const moved = to + doc.path.slice(path.length);
      setDoc((d) => (d && d.path === doc.path ? { ...d, path: moved } : d));
      localStorage.setItem(LAST_KEY, moved);
    }
    if (project && isWithin(project.path, path)) {
      const moved = to + project.path.slice(path.length);
      setProject((p) => (p && p.path === project.path ? { ...p, path: moved } : p));
    }
  };

  const relocate = async (path: string, to: string, beforeRefresh?: () => Promise<void>): Promise<boolean> => {
    try {
      await flush();
      await renameOnDisk(path, to);
      // Order bookkeeping happens before the sidebar redraws, so nothing jumps around.
      await beforeRefresh?.();
      await refresh();
      return true;
    } catch (e) {
      report(e);
      return false;
    }
  };

  /**
   * A document's pasted images live in the assets folder beside it, so when the
   * document changes folders its images go with it and the links keep working.
   */
  const carryImages = async (from: string, to: string) => {
    const fromDir = dirname(from);
    const toDir = dirname(to);
    if (fromDir === toDir) return;
    const text = await storage.read(to);
    let updated = text;
    for (const ref of new Set([...text.matchAll(IMAGE_REF)].map((m) => m[1]))) {
      const name = safeDecode(ref.slice(ASSETS_DIR.length + 1));
      const src = join(join(fromDir, ASSETS_DIR), name);
      // On a name clash in the destination, number the copy and update the link.
      for (let i = 1; i <= 50; i++) {
        const destName = i === 1 ? name : name.replace(/(\.[^.]+)?$/, `-${i}$1`);
        try {
          await storage.rename(src, join(join(toDir, ASSETS_DIR), destName));
          if (destName !== name) updated = updated.split(`(${ref})`).join(`(${ASSETS_DIR}/${encodeURI(destName)})`);
          break;
        } catch (e) {
          // Anything but a clash (usually: the image is already gone) means leave it be.
          if (!String(e).includes("already exists")) break;
        }
      }
    }
    if (updated !== text) {
      await storage.write(to, updated);
      if (doc?.path === from) await openFile(to);
    }
  };

  const saveImage = async (file: File): Promise<string | null> => {
    if (!doc) return null;
    const ext = (file.type.split("/")[1] ?? "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
    const base = slugify(displayName(basename(doc.path))) || "image";
    const name = `${base}-${Date.now().toString(36)}${(imageCounter++ % 36).toString(36)}.${ext}`;
    try {
      await storage.writeImage(join(join(dirname(doc.path), ASSETS_DIR), name), await fileToBase64(file));
      return `${ASSETS_DIR}/${name}`;
    } catch (e) {
      report(e);
      return null;
    }
  };

  const move = async (path: string, destDir: string, placement?: Placement) => {
    if (!root) return;
    const name = basename(path);
    const srcDir = dirname(path);
    const srcEntry = findEntry(tree, srcDir);
    const destEntry = findEntry(tree, destDir);
    const destOrdered = isOrdered(tree, root, destDir);

    // Restructuring within a project only changes its outline, not any files.
    if (srcDir === destDir) {
      if (!destOrdered || !destEntry || !placement) return;
      try {
        await placeInOrder(destEntry, name, placement);
        await refresh();
      } catch (e) {
        report(e);
      }
      return;
    }

    if (isWithin(destDir, path)) return;
    // A section travels with its sub-sections.
    const srcOrdered = !!srcEntry && isOrdered(tree, root, srcDir);
    const family = [name, ...(srcOrdered ? descendantsOf(srcEntry!, name) : [])];
    const taken = allPaths(tree);
    const clash = family.find((n) => taken.has(join(destDir, n)));
    if (clash) return report(`“${displayName(clash)}” is already in “${basename(destDir)}”.`);

    try {
      await flush();
      const node = srcOrdered ? await takeFromOrder(srcEntry!, name) : undefined;
      for (const n of family) await renameOnDisk(join(srcDir, n), join(destDir, n));
      if (destEntry && destOrdered) await insertIntoOrder(destEntry, node ?? { name, children: [] }, placement ?? "end");
      await refresh();
      for (const n of family) {
        if (!findEntry(tree, join(srcDir, n))?.isDir) await carryImages(join(srcDir, n), join(destDir, n)).catch(report);
      }
    } catch (e) {
      report(e);
      await refresh();
    }
  };

  const setIcon = async (path: string, icon: SectionIcon | null) => {
    const parent = findEntry(tree, dirname(path));
    if (!parent) return;
    try {
      await setSectionIcon(parent, basename(path), icon);
      await refresh();
    } catch (e) {
      report(e);
    }
  };

  const setProjectFlag = async (path: string, flag: boolean) => {
    const entry = findEntry(tree, path);
    if (!entry) return;
    try {
      await makeProject(entry, flag);
      if (!flag && project?.path === path) setProject(null);
      await refresh();
    } catch (e) {
      report(e);
    }
  };

  // --- Projects as one document ----------------------------------------------
  const projectVersion = useRef(0);

  const openProject = useCallback(
    async (path: string) => {
      const entry = findEntry(tree, path);
      if (!entry) return;
      await flush();
      try {
        const compiled = await compileProject(entry);
        setDoc(null);
        setProject({ path, compiled, version: ++projectVersion.current });
      } catch (e) {
        report(e);
      }
    },
    [tree, flush, report],
  );

  // Keep the continuous view current as sections are added, reordered or edited elsewhere.
  const projectPath = project?.path;
  useEffect(() => {
    if (projectPath) openProject(projectPath);
    // Only the tree changing should trigger this; openProject changes with it.
  }, [tree]);

  const trash = async (path: string) => {
    try {
      await flush();
      await storage.trash(path);
      forgetLinks(path);
      forgetDocGoals(path);
      if (doc && isWithin(doc.path, path)) {
        setDoc(null);
        localStorage.removeItem(LAST_KEY);
      }
      if (project && isWithin(project.path, path)) setProject(null);
      const parent = findEntry(tree, dirname(path));
      if (parent) await removeFromOrder(parent, basename(path));
      await refresh();
    } catch (e) {
      report(e);
    }
  };

  // --- Sync -------------------------------------------------------------------
  const sync = useSync();
  // Latest values for the long-lived listener below.
  const latest = useRef({ doc, view, tree, refresh, flush });
  latest.current = { doc, view, tree, refresh, flush };

  useEffect(
    () =>
      onRemoteChanges(async (paths) => {
        const { doc, view, tree, refresh, flush } = latest.current;
        await refresh();
        if (paths.some((p) => p.startsWith(".joyce/"))) await reloadFolderState();
        const rel = doc && toRel(doc.path);
        if (!doc || !rel || !paths.includes(rel)) return;
        const text = await storage.read(doc.path).catch(() => null);
        if (text === null) return;
        if (pending.current?.path === doc.path) {
          // Typing here hasn't been saved yet, and a change arrived from elsewhere:
          // keep theirs beside this document, then save ours as the newest.
          const ext = basename(doc.path).match(TEXT_EXT)?.[0] ?? ".md";
          const copy = uniquePath(dirname(doc.path), `${displayName(basename(doc.path))} (from another computer)`, ext, allPaths(tree));
          await storage.write(copy, text);
          await flush();
          await refresh();
          return;
        }
        if (!view || view.state.doc.toString() === text) return;
        // Show the other computer's version in place, keeping the cursor about where it was.
        const head = Math.min(view.state.selection.main.head, text.length);
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: head },
          userEvent: SYNC_EVENT,
        });
      }),
    [],
  );

  // --- Settings & chrome ----------------------------------------------------
  const updateSettings = (patch: Partial<Settings>) =>
    setSettings((s) => {
      const next = { ...s, ...patch };
      saveSettings(next);
      return next;
    });

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    if (!panel) return;
    const close = () => setPanel(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [panel]);

  const createRef = useRef(create);
  createRef.current = create;
  const toggleSidebar = () => updateSettings({ sidebar: !settings.sidebar });
  const toggleSidebarRef = useRef(toggleSidebar);
  toggleSidebarRef.current = toggleSidebar;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanel(null);
      if (!e.metaKey && !e.ctrlKey) return;
      const key = e.key.toLowerCase();
      if (key === "\\") toggleSidebarRef.current();
      else if (key === "n" && root) {
        const dir = doc ? dirname(doc.path) : (project?.path ?? root);
        createRef.current(e.shiftKey ? "dir" : "file", dir);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [root, doc, project]);

  // Fade the chrome out while typing; any mouse movement brings it back.
  useEffect(() => {
    const show = () => setTyping(false);
    window.addEventListener("mousemove", show);
    return () => window.removeEventListener("mousemove", show);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // --- Goals ----------------------------------------------------------------
  const days = useDays();
  const goals = useGoals();
  const today = periodTotal(days, goals, "day").words;

  const docGoal = useDocGoal(doc?.path ?? null);
  const docCount = docGoal?.unit === "chars" ? chars : words;
  const docState = docGoal ? goalState(docGoal, docCount) : null;
  const unitLabel = docGoal?.unit === "chars" ? "characters" : words === 1 ? "word" : "words";

  // Celebrate reaching a document's goal while writing it (not on open, and not for
  // limits, where getting close isn't an achievement).
  const lastDocState = useRef<{ id: number; state: string | null } | null>(null);
  useEffect(() => {
    const prev = lastDocState.current;
    lastDocState.current = doc ? { id: doc.id, state: docState } : null;
    if (!doc || !docGoal || docGoal.mode === "atMost" || prev?.id !== doc.id) return;
    if (prev.state === "under" && docState === "met") {
      setToast(`Document goal reached: ${docGoal.target.toLocaleString()} ${docGoal.unit === "chars" ? "characters" : "words"}.`);
    }
  }, [doc, docGoal, docState]);

  useEffect(() => startReminders(), []);

  // Congratulate once when a goal is crossed while writing (not when a goal is
  // lowered, or on launch). The longest period crossed wins.
  const lastTotals = useRef<Record<Period, number> | null>(null);
  useEffect(() => {
    const periods: Period[] = ["month", "week", "day"];
    const totals = Object.fromEntries(periods.map((p) => [p, periodTotal(days, goals, p).words])) as Record<Period, number>;
    const prev = lastTotals.current;
    lastTotals.current = totals;
    if (!prev) return;
    const crossed = periods.find((p) => {
      const goal = goalFor(goals, p);
      return goal && prev[p] < goal && totals[p] >= goal && totals[p] > prev[p];
    });
    if (crossed) {
      const name = { day: "Daily", week: "Weekly", month: "Monthly" }[crossed];
      setToast(`${name} goal reached: ${goalFor(goals, crossed)!.toLocaleString()} words.`);
    }
  }, [days, goals]);

  const cssVars = {
    "--font": fontStack(settings.font),
    "--font-size": `${settings.fontSize}px`,
    "--line-height": settings.lineHeight,
    "--measure": `calc(${settings.measure}ch + 4rem)`,
    "--sidebar-width": `${settings.sidebarWidth}px`,
  } as React.CSSProperties;

  if (!root) {
    return (
      <div className="welcome" data-tauri-drag-region>
        <h1>Joyce</h1>
        <p>Your writing lives as plain Markdown files in a folder of your choosing.</p>
        <button className="primary" onClick={pickFolder}>Choose a Folder</button>
      </div>
    );
  }

  return (
    <div className={`app${settings.sidebar ? "" : " no-sidebar"}${typing && doc ? " typing" : ""}`} style={cssVars}>
      {settings.sidebar && (
        <Sidebar
          root={root}
          tree={tree}
          openPath={doc?.path ?? null}
          openProject={project?.path ?? null}
          renaming={renaming}
          onOpen={openFile}
          onOpenProject={openProject}
          onSetProject={setProjectFlag}
          onSetIcon={setIcon}
          width={settings.sidebarWidth}
          onResize={(sidebarWidth) => updateSettings({ sidebarWidth })}
          onCreate={create}
          onRename={rename}
          onMove={move}
          onStartRename={setRenaming}
          onTrash={trash}
          onPickFolder={pickFolder}
        />
      )}
      <main
        className="main"
        onKeyDown={(e) =>
          !e.metaKey && !e.ctrlKey && e.key.length === 1 && (e.target as Element).closest(".cm-editor") && setTyping(true)
        }
      >
        <Toolbar
          view={view}
          onToggleSidebar={toggleSidebar}
          panel={panel}
          onTogglePanel={(p) => setPanel((open) => (open === p ? null : p))}
          todayProgress={goals.daily ? today / goals.daily : null}
          syncState={sync.info?.enabled ? (sync.info.status?.state ?? "syncing") : null}
          syncTitle={sync.info?.enabled ? `Sync: ${statusText(sync.info.status)}` : "Sync"}
          hasDoc={!!doc}
        />
        {panel === "type" && <SettingsPanel settings={settings} onChange={updateSettings} />}
        {panel === "progress" && <ProgressPanel />}
        {panel === "sync" && <SyncPanel info={sync.info} reload={sync.reload} root={root} />}
        {panel === "docGoal" && doc && <DocGoalPanel key={doc.path} path={doc.path} goal={docGoal} words={words} chars={chars} />}
        {panel === "publish" && doc && (
          <PublishPanel localPath={doc.path} getText={() => view?.state.doc.toString() ?? doc.text} />
        )}
        {doc ? (
          <Editor
            key={doc.id}
            initial={doc.text}
            onChange={onChange}
            onReady={setView}
            autoFocus={!renaming}
            dir={dirname(doc.path)}
            saveImage={saveImage}
          />
        ) : project ? (
          <Editor
            key={`project-${project.version}`}
            initial={project.compiled.text}
            onChange={() => {}}
            // Formatting buttons stay off: this view is for reading the whole thing through.
            onReady={() => {}}
            autoFocus={false}
            readOnly
            dir={project.path}
            saveImage={async () => null}
            extra={sectionMarks(project.compiled.sections, openFile)}
          />
        ) : (
          <div className="empty">
            <p>Select a document, or press ⌘N to start a new one.</p>
          </div>
        )}
        {project && (
          <footer className="statusbar">
            <span>
              {basename(project.path)} · {project.compiled.sections.filter((s) => !s.isPart).length} sections ·{" "}
              {countWords(project.compiled.text).toLocaleString()} words
            </span>
          </footer>
        )}
        {doc && (
          // Going over a limit keeps the count visible even while the rest of the chrome fades.
          <footer className={`statusbar${docState === "over" ? " alert" : ""}`}>
            <button
              className={`statusbar-count${docState ? ` ${docState}` : ""}${panel === "docGoal" ? " active" : ""}`}
              title={docGoal ? "Document goal" : "Set a goal for this document"}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setPanel((open) => (open === "docGoal" ? null : "docGoal"))}
            >
              {docGoal
                ? `${docCount.toLocaleString()} / ${docGoal.target.toLocaleString()} ${unitLabel}`
                : `${words.toLocaleString()} ${unitLabel}`}
              {docGoal && (
                <span className="mini-meter" aria-hidden="true">
                  <span style={{ width: `${Math.min(1, docCount / docGoal.target) * 100}%` }} />
                </span>
              )}
              {docState === "met" && docGoal?.mode !== "atMost" && <span className="statusbar-check"> ✓</span>}
            </button>
            <span className="statusbar-sep">·</span>
            <span>
              {goals.daily ? `${today.toLocaleString()} / ${goals.daily.toLocaleString()} today` : `${today.toLocaleString()} today`}
            </span>
          </footer>
        )}
        {toast && <div className="toast" onClick={() => setToast(null)}>{toast}</div>}
      </main>
    </div>
  );
}
