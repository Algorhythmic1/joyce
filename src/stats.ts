import { useSyncExternalStore } from "react";
import { join, storage } from "./fs";
import { FolderStore, STATE_DIR, currentRoot, deviceId, onFolderLoad, useStore } from "./folderState";

/** Net words written and active writing time for one local calendar day. */
export interface DayStats {
  words: number;
  seconds: number;
}

export type Period = "day" | "week" | "month";

export interface Goals {
  daily: number | null;
  weekly: number | null;
  monthly: number | null;
  /** 0 = weeks start on Sunday, 1 = Monday. */
  weekStart: 0 | 1;
  reminder: {
    enabled: boolean;
    /** "HH:MM", local time. */
    time: string;
    /** Days of the week it fires on, 0 = Sunday. */
    days: number[];
    onlyIfBehind: boolean;
  };
}

export const DEFAULT_GOALS: Goals = {
  daily: null,
  weekly: null,
  monthly: null,
  weekStart: 1,
  reminder: { enabled: false, time: "09:00", days: [1, 2, 3, 4, 5], onlyIfBehind: true },
};

const STATS_KEY = "joyce:stats";
const GOALS_KEY = "joyce:goals";
/** Pauses longer than this between edits don't count as writing time. */
const IDLE_GAP_MS = 60_000;

// --- Dates ------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export function startOf(period: Period, d: Date, weekStart: 0 | 1): Date {
  if (period === "day") return startOfDay(d);
  if (period === "month") return new Date(d.getFullYear(), d.getMonth(), 1);
  return addDays(startOfDay(d), -((d.getDay() - weekStart + 7) % 7));
}

function nextStart(period: Period, d: Date): Date {
  if (period === "day") return addDays(d, 1);
  if (period === "week") return addDays(d, 7);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}

function prevStart(period: Period, d: Date): Date {
  if (period === "day") return addDays(d, -1);
  if (period === "week") return addDays(d, -7);
  return new Date(d.getFullYear(), d.getMonth() - 1, 1);
}

// --- Store ------------------------------------------------------------------
// Stats and goals live in the writing folder's `.joyce/` (see folderState.ts).
// Each computer writes only its own stats file; totals add them all up, so two
// machines never edit the same file.

/** Data from before stats moved into the writing folder; adopted once, by the first folder opened. */
function legacy<T>(key: string, fallback: T): T | null {
  const migrated = `joyce:migrated:${key}`;
  if (localStorage.getItem(migrated)) return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  localStorage.setItem(migrated, "1");
  try {
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return null;
  }
}

const parseDays = (raw: unknown): Record<string, DayStats> => {
  const out: Record<string, DayStats> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      const d = v as Partial<DayStats>;
      if (/^\d{4}-\d{2}-\d{2}$/.test(k)) out[k] = { words: Number(d?.words) || 0, seconds: Number(d?.seconds) || 0 };
    }
  }
  return out;
};

const mine = new FolderStore<Record<string, DayStats>>({
  file: () => `stats/${deviceId}.json`,
  fallback: {},
  parse: parseDays,
  legacy: () => legacy(STATS_KEY, {}),
});

const goalsStore = new FolderStore<Goals>({
  file: "goals.json",
  fallback: DEFAULT_GOALS,
  parse: (raw) => ({ ...DEFAULT_GOALS, ...(raw as Partial<Goals>) }),
  legacy: () => legacy(GOALS_KEY, DEFAULT_GOALS),
});

/** Stats written by other computers, read-only here. */
let others: Record<string, DayStats>[] = [];

onFolderLoad(async () => {
  const dir = currentRoot();
  if (!dir) return void (others = []);
  const statsDir = join(join(dir, STATE_DIR), "stats");
  const files = (await storage.listFiles(statsDir).catch(() => [])).filter(
    (f) => f.endsWith(".json") && f !== `${deviceId}.json`,
  );
  others = await Promise.all(
    files.map((f) => storage.read(join(statsDir, f)).then((t) => parseDays(JSON.parse(t)), () => ({}))),
  );
  recomputeDays();
});

let days: Record<string, DayStats> = {};
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

function recomputeDays() {
  const merged: Record<string, DayStats> = {};
  for (const source of [mine.get(), ...others]) {
    for (const [k, d] of Object.entries(source)) {
      const m = (merged[k] ??= { words: 0, seconds: 0 });
      m.words += d.words;
      m.seconds += d.seconds;
    }
  }
  days = merged;
  listeners.forEach((l) => l());
}
mine.subscribe(recomputeDays);

let lastEdit = 0;

/** Records a change in word count caused by the writer's own typing. */
export function recordWriting(wordDelta: number) {
  const now = Date.now();
  const key = dayKey(new Date(now));
  const all = mine.get();
  const today = all[key] ?? { words: 0, seconds: 0 };
  const gap = now - lastEdit;
  lastEdit = now;
  // Writes happen on every keystroke; batch them to disk.
  mine.set(
    {
      ...all,
      [key]: {
        words: today.words + wordDelta,
        seconds: today.seconds + (gap < IDLE_GAP_MS ? gap / 1000 : 0),
      },
    },
    { saveAfterMs: 5000 },
  );
}

export const msSinceLastEdit = () => Date.now() - lastEdit;

export function updateGoals(patch: Partial<Goals>) {
  goalsStore.set({ ...goalsStore.get(), ...patch });
}

export const useDays = () => useSyncExternalStore(subscribe, () => days);
export const useGoals = () => useStore(goalsStore);
export const getDays = () => days;
export const getGoals = () => goalsStore.get();

// --- Derived numbers --------------------------------------------------------

/** Words in [from, to). A day's net can be negative after heavy editing; it counts as zero. */
function wordsBetween(all: Record<string, DayStats>, from: Date, to: Date) {
  let total = 0;
  for (let d = from; d < to; d = addDays(d, 1)) total += Math.max(0, all[dayKey(d)]?.words ?? 0);
  return total;
}

function secondsBetween(all: Record<string, DayStats>, from: Date, to: Date) {
  let total = 0;
  for (let d = from; d < to; d = addDays(d, 1)) total += all[dayKey(d)]?.seconds ?? 0;
  return total;
}

export const goalFor = (g: Goals, period: Period) =>
  period === "day" ? g.daily : period === "week" ? g.weekly : g.monthly;

export function periodTotal(all: Record<string, DayStats>, g: Goals, period: Period, now = new Date()) {
  const from = startOf(period, now, g.weekStart);
  return { words: wordsBetween(all, from, nextStart(period, from)), seconds: secondsBetween(all, from, nextStart(period, from)) };
}

export interface Bucket {
  start: Date;
  words: number;
}

/** The last `count` periods, oldest first, ending with the current one. */
export function history(all: Record<string, DayStats>, g: Goals, period: Period, count: number, now = new Date()): Bucket[] {
  const buckets: Bucket[] = [];
  let start = startOf(period, now, g.weekStart);
  for (let i = 0; i < count; i++) {
    buckets.unshift({ start, words: wordsBetween(all, start, nextStart(period, start)) });
    start = prevStart(period, start);
  }
  return buckets;
}

/**
 * Consecutive days the daily goal was met (or, without a daily goal, days with any
 * writing). Today only extends the streak; not having written yet doesn't break it.
 */
export function streak(all: Record<string, DayStats>, g: Goals, now = new Date()) {
  const met = (d: Date) => (all[dayKey(d)]?.words ?? 0) >= (g.daily ?? 1);
  let d = startOfDay(now);
  if (!met(d)) d = addDays(d, -1);
  let n = 0;
  while (met(d)) {
    n++;
    d = addDays(d, -1);
  }
  return n;
}

export function allTime(all: Record<string, DayStats>) {
  return Object.values(all).reduce((sum, d) => sum + Math.max(0, d.words), 0);
}

/**
 * How far behind an even pace each goal is right now. A weekly goal of 3,500 on the
 * third day of the week expects 1,500 by the end of today.
 */
export function behindPace(all: Record<string, DayStats>, g: Goals, now = new Date()) {
  const result: { period: Period; short: number; goal: number }[] = [];
  for (const period of ["day", "week", "month"] as Period[]) {
    const goal = goalFor(g, period);
    if (!goal) continue;
    const from = startOf(period, now, g.weekStart);
    const to = nextStart(period, from);
    const totalDays = Math.round((to.getTime() - from.getTime()) / 86_400_000);
    const elapsedDays = Math.round((startOfDay(now).getTime() - from.getTime()) / 86_400_000) + 1;
    const expected = Math.round((goal * elapsedDays) / totalDays);
    const short = expected - wordsBetween(all, from, to);
    if (short > 0) result.push({ period, short, goal });
  }
  return result;
}
