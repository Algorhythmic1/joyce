import { newBoard, parseBoard, type Board } from "./model.ts";

export interface CanvasStorage {
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  listFiles(path: string): Promise<string[]>;
}
export type CanvasSnapshot = { board: Board | null; status: "loading" | "saved" | "dirty" | "saving" | "error"; error: string | null; recovered: string[] };
export const CANVAS_FILE = "canvas.json";
export const isCanvasFile = (name: string) => /^canvas(?: \(.+\))?\.json$/.test(name);
const serialize = (board: Board) => JSON.stringify(board, null, 2) + "\n";

/** One lazy session per folder. Disk operations are serialized; failed writes remain dirty. */
export class CanvasSession {
  private snapshot: CanvasSnapshot = { board: null, status: "loading", error: null, recovered: [] };
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private revision = 0;
  private diskText: string | null = null;
  private holds = 0;
  private reloadPending = false;
  private history: Board[] = [];
  private future: Board[] = [];
  readonly path: string;
  readonly dir: string;
  readonly root: string;
  private storage: CanvasStorage;

  constructor(root: string, storage: CanvasStorage) {
    this.root = root;
    this.storage = storage;
    this.dir = `${root.replace(/\/$/, "")}/.joyce`;
    this.path = `${this.dir}/${CANVAS_FILE}`;
  }
  get = () => this.snapshot;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private emit(patch: Partial<CanvasSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach(fn => fn());
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }
  get canUndo() { return this.history.length > 0; }
  get canRedo() { return this.future.length > 0; }
  retry() { return this.dirty ? this.flush() : this.reload(); }
  hold() { this.holds++; }
  release() {
    this.holds = Math.max(0, this.holds - 1);
    if (!this.holds && this.reloadPending) { this.reloadPending = false; void this.reload(); }
  }
  record(before: Board) {
    if (before === this.snapshot.board) return;
    this.history.push(before);
    if (this.history.length > 100) this.history.shift();
    this.future = [];
    this.emit({});
  }
  change(board: Board, record = true) {
    const before = this.snapshot.board;
    if (!before || before === board) return;
    this.dirty = true;
    this.revision++;
    this.emit({ board, status: "dirty", error: null });
    if (record) this.record(before);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, 450);
  }
  undo() {
    const before = this.history.pop();
    if (!before || !this.snapshot.board) return;
    this.future.push(this.snapshot.board);
    this.change(before, false);
  }
  redo() {
    const next = this.future.pop();
    if (!next || !this.snapshot.board) return;
    this.history.push(this.snapshot.board);
    this.change(next, false);
  }
  async reload() {
    if (this.holds) { this.reloadPending = true; return; }
    return this.enqueue(async () => {
      try {
        const files = await this.storage.listFiles(this.dir);
        const recovered = files.filter(n => n !== CANVAS_FILE && isCanvasFile(n)).sort();
        this.emit({ recovered });
        if (!files.includes(CANVAS_FILE)) {
          // A remote deletion never discards unsaved local ideas.
          if (!this.snapshot.board) this.emit({ board: newBoard(), status: "saved", error: null, recovered });
          else this.emit({ recovered });
          return;
        }
        const text = await this.storage.read(this.path);
        const board = parseBoard(JSON.parse(text));
        // A gesture may have started while disk IO was in flight.
        if (this.holds) { this.reloadPending = true; this.emit({ recovered }); return; }
        if (this.dirty && text !== this.diskText) {
          const name = `canvas (from another computer ${crypto.randomUUID()}).json`;
          await this.storage.write(`${this.dir}/${name}`, text);
          this.diskText = text;
          this.emit({ recovered: [...recovered, name] });
          return;
        }
        if (!this.dirty && text !== this.diskText) {
          this.history = []; this.future = [];
          this.diskText = text;
          this.emit({ board, status: "saved", error: null, recovered });
        } else this.emit({ recovered, ...(!this.dirty ? { status: "saved" as const, error: null } : {}) });
      } catch (e) { this.emit({ status: "error", error: String(e) }); }
    });
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    return this.enqueue(async () => {
      if (!this.dirty || !this.snapshot.board) return;
      const rev = this.revision, text = serialize(this.snapshot.board);
      this.emit({ status: "saving" });
      try {
        // Sync may have replaced the file before its UI event was delivered.
        // Check at the last possible moment, and preserve that version too.
        if ((await this.storage.listFiles(this.dir)).includes(CANVAS_FILE)) {
          const disk = await this.storage.read(this.path);
          if (disk !== this.diskText && disk !== text) {
            parseBoard(JSON.parse(disk));
            const name = `canvas (from another computer ${crypto.randomUUID()}).json`;
            await this.storage.write(`${this.dir}/${name}`, disk);
            this.emit({ recovered: [...this.snapshot.recovered, name] });
          }
        }
        await this.storage.write(this.path, text);
        this.diskText = text;
        if (rev === this.revision) this.dirty = false;
        this.emit({ status: this.dirty ? "dirty" : "saved", error: null });
      } catch (e) {
        this.emit({ status: "error", error: `Couldn’t save your canvas: ${String(e)}` });
        throw e;
      }
    });
  }
  async readRecovery(name: string): Promise<Board> {
    if (!isCanvasFile(name) || name.includes("/") || name.includes("\\")) throw new Error("Invalid recovery file");
    return parseBoard(JSON.parse(await this.storage.read(`${this.dir}/${name}`)));
  }
  async restore(name: string) {
    const recovered = await this.readRecovery(name);
    // Keep even a damaged/future main file before an explicit restoration.
    if ((await this.storage.listFiles(this.dir)).includes(CANVAS_FILE)) {
      const original = await this.storage.read(this.path);
      await this.enqueue(() => this.storage.write(`${this.dir}/canvas (before restore ${crypto.randomUUID()}).json`, original));
      this.diskText = original;
    }
    if (this.snapshot.board) {
      const backup = `canvas (before restore ${crypto.randomUUID()}).json`;
      await this.enqueue(() => this.storage.write(`${this.dir}/${backup}`, serialize(this.snapshot.board!)));
      this.change({ ...recovered, id: this.snapshot.board.id });
    } else {
      this.dirty = true; this.revision++;
      this.emit({ board: recovered, status: "dirty", error: null });
    }
    await this.flush();
    await this.reload();
  }
}
