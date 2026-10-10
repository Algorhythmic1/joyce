import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { Editor } from "./components/Editor";
import { Sidebar } from "./components/Sidebar";
import { Toolbar, type Panel } from "./components/Toolbar";
import { PublishPanel } from "./components/PublishPanel";
import { forgetLinks, moveLinks } from "./integrations/github";
import { SettingsPanel } from "./components/SettingsPanel";
import { ProgressPanel } from "./components/ProgressPanel";
import { startReminders } from "./reminders";
import { goalFor, periodTotal, recordWriting, useDays, useGoals, type Period } from "./stats";
import { allPaths, basename, dirname, displayName, isWithin, join, storage, uniquePath, type Entry } from "./fs";
import { fontStack, loadSettings, saveSettings, type Settings } from "./settings";

const ROOT_KEY = "joyce:root";
const LAST_KEY = "joyce:last-file";
const SAVE_DELAY = 400;
const TEXT_EXT = /\.(md|markdown|txt)$/i;

const countWords = (text: string) => text.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu)?.length ?? 0;

function findEntry(entries: Entry[], path: string): Entry | undefined {
  for (const e of entries) {
    if (e.path === path) return e;
    const found = e.children && findEntry(e.children, path);
    if (found) return found;
  }
}

export default function App() {
  const [settings, setSettings] = useState(loadSettings);
  const [root, setRoot] = useState(() => localStorage.getItem(ROOT_KEY));
  const [tree, setTree] = useState<Entry[]>([]);
  // `id` identifies an editor session; it survives renames so the view isn't rebuilt.
  const [doc, setDoc] = useState<{ id: number; path: string; text: string } | null>(null);
  const nextId = useRef(0);
  const [words, setWords] = useState(0);
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

  const onChange = (text: string, typed: boolean) => {
    if (!doc) return;
    const count = countWords(text);
    if (typed) recordWriting(count - lastCount.current);
    lastCount.current = count;
    setWords(count);
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
      setTree(await storage.listTree(root));
    } catch (e) {
      report(e);
    }
  }, [root, report]);

  const openFile = useCallback(
    async (path: string) => {
      await flush();
      try {
        const text = await storage.read(path);
        setDoc({ id: ++nextId.current, path, text });
        lastCount.current = countWords(text);
        setWords(lastCount.current);
        localStorage.setItem(LAST_KEY, path);
      } catch (e) {
        report(e);
      }
    },
    [flush, report],
  );

  useEffect(() => {
    if (!root) return;
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

  const create = async (kind: "file" | "dir", dir: string) => {
    const taken = allPaths(tree);
    const path = kind === "file" ? uniquePath(dir, "Untitled", ".md", taken) : uniquePath(dir, "New Folder", "", taken);
    try {
      await (kind === "file" ? storage.createFile(path) : storage.createDir(path));
      setRenaming(path);
      await refresh();
      if (kind === "file") await openFile(path);
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
    await relocate(path, to);
  };

  /** Renames or moves a file or folder, keeping everything that points at it in step. */
  const relocate = async (path: string, to: string) => {
    try {
      await flush();
      await storage.rename(path, to);
      moveLinks(path, to);
      if (doc && isWithin(doc.path, path)) {
        const moved = to + doc.path.slice(path.length);
        setDoc({ ...doc, path: moved });
        localStorage.setItem(LAST_KEY, moved);
      }
      await refresh();
    } catch (e) {
      report(e);
    }
  };

  const move = async (path: string, destDir: string) => {
    const to = join(destDir, basename(path));
    if (to === path || isWithin(destDir, path)) return;
    if (allPaths(tree).has(to)) {
      return report(`“${displayName(basename(path))}” is already in “${basename(destDir)}”.`);
    }
    await relocate(path, to);
  };

  const trash = async (path: string) => {
    try {
      await flush();
      await storage.trash(path);
      forgetLinks(path);
      if (doc && isWithin(doc.path, path)) {
        setDoc(null);
        localStorage.removeItem(LAST_KEY);
      }
      await refresh();
    } catch (e) {
      report(e);
    }
  };

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
        const dir = doc ? dirname(doc.path) : root;
        createRef.current(e.shiftKey ? "dir" : "file", dir);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [root, doc]);

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
          renaming={renaming}
          onOpen={openFile}
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
          hasDoc={!!doc}
        />
        {panel === "type" && <SettingsPanel settings={settings} onChange={updateSettings} />}
        {panel === "progress" && <ProgressPanel />}
        {panel === "publish" && doc && (
          <PublishPanel localPath={doc.path} getText={() => view?.state.doc.toString() ?? doc.text} />
        )}
        {doc ? (
          <Editor key={doc.id} initial={doc.text} onChange={onChange} onReady={setView} autoFocus={!renaming} />
        ) : (
          <div className="empty">
            <p>Select a document, or press ⌘N to start a new one.</p>
          </div>
        )}
        {doc && (
          <footer className="statusbar">
            {words.toLocaleString()} {words === 1 ? "word" : "words"}
            <span className="statusbar-sep">·</span>
            {goals.daily ? `${today.toLocaleString()} / ${goals.daily.toLocaleString()} today` : `${today.toLocaleString()} today`}
          </footer>
        )}
        {toast && <div className="toast" onClick={() => setToast(null)}>{toast}</div>}
      </main>
    </div>
  );
}
