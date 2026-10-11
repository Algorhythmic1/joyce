import { FolderStore, dropKeys, rekey, toRel, useStore } from "./folderState";

/** A length goal for one document, e.g. "at most 800 words" for a column with a limit. */
export interface DocGoal {
  mode: "atLeast" | "atMost" | "about";
  target: number;
  unit: "words" | "chars";
}

/** "About" counts as met within this fraction of the target either way. */
export const ABOUT_TOLERANCE = 0.1;

// Kept in the writing folder (see folderState.ts), keyed by path relative to it.
const LEGACY_KEY = "joyce:doc-goals";

const store = new FolderStore<Record<string, DocGoal>>({
  file: "doc-goals.json",
  fallback: {},
  parse: (raw) => (raw && typeof raw === "object" ? (raw as Record<string, DocGoal>) : {}),
  // Earlier versions kept goals per computer, keyed by absolute path.
  legacy: () => {
    try {
      const old = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? "{}") as Record<string, DocGoal>;
      const moved = Object.entries(old).flatMap(([abs, g]) => {
        const rel = toRel(abs);
        return rel ? [[rel, g] as const] : [];
      });
      return moved.length ? Object.fromEntries(moved) : null;
    } catch {
      return null;
    }
  },
});

export const useDocGoal = (path: string | null) => {
  const all = useStore(store);
  const rel = path && toRel(path);
  return rel ? all[rel] : undefined;
};

export function setDocGoal(path: string, goal: DocGoal | null) {
  const rel = toRel(path);
  if (!rel) return;
  const next = { ...store.get() };
  if (goal) next[rel] = goal;
  else delete next[rel];
  store.set(next);
}

/** Keeps goals attached when a document, or a folder of documents, is renamed or moved. */
export function moveDocGoals(from: string, to: string) {
  const [a, b] = [toRel(from), toRel(to)];
  if (a && b) store.set(rekey(store.get(), a, b));
}

export function forgetDocGoals(path: string) {
  const rel = toRel(path);
  if (rel) store.set(dropKeys(store.get(), rel));
}

export type GoalState = "under" | "met" | "over";

/**
 * Where a count stands against a goal. "over" only applies to limits: going past an
 * "at least" goal is still just met.
 */
export function goalState(goal: DocGoal, count: number): GoalState {
  const { mode, target } = goal;
  if (mode === "atLeast") return count >= target ? "met" : "under";
  if (mode === "atMost") return count > target ? "over" : count >= target * (1 - ABOUT_TOLERANCE) ? "met" : "under";
  const slack = target * ABOUT_TOLERANCE;
  return count > target + slack ? "over" : count >= target - slack ? "met" : "under";
}

/**
 * Characters as a reader sees them: Markdown syntax (heading marks, emphasis,
 * link URLs, list bullets) and line breaks don't count.
 */
export function countChars(text: string): number {
  const plain = text
    .replace(/^ {0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|\*|_|`)/g, "")
    .replace(/\r?\n/g, "");
  return [...plain].length;
}
