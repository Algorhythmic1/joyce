import { useSyncExternalStore } from "react";
import { isWithin } from "./fs";

/** A length goal for one document, e.g. "at most 800 words" for a column with a limit. */
export interface DocGoal {
  mode: "atLeast" | "atMost" | "about";
  target: number;
  unit: "words" | "chars";
}

/** "About" counts as met within this fraction of the target either way. */
export const ABOUT_TOLERANCE = 0.1;

const KEY = "joyce:doc-goals";

function load(): Record<string, DocGoal> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

let goals = load();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

function save(next: Record<string, DocGoal>) {
  goals = next;
  localStorage.setItem(KEY, JSON.stringify(goals));
  listeners.forEach((l) => l());
}

export const useDocGoal = (path: string | null) =>
  useSyncExternalStore(subscribe, () => (path ? goals[path] : undefined));

export function setDocGoal(path: string, goal: DocGoal | null) {
  const next = { ...goals };
  if (goal) next[path] = goal;
  else delete next[path];
  save(next);
}

/** Keeps goals attached when a document, or a folder of documents, is renamed or moved. */
export function moveDocGoals(from: string, to: string) {
  save(Object.fromEntries(Object.entries(goals).map(([p, g]) => [isWithin(p, from) ? to + p.slice(from.length) : p, g])));
}

export function forgetDocGoals(path: string) {
  save(Object.fromEntries(Object.entries(goals).filter(([p]) => !isWithin(p, path))));
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
