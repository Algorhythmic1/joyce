import { useRef, useState } from "react";
import { ABOUT_TOLERANCE, goalState, setDocGoal, type DocGoal } from "../docGoals";

interface Props {
  path: string;
  goal: DocGoal | undefined;
  words: number;
  chars: number;
}

const MODES: { id: DocGoal["mode"]; label: string }[] = [
  { id: "atLeast", label: "At least" },
  { id: "about", label: "About" },
  { id: "atMost", label: "At most" },
];

const fmt = (n: number) => n.toLocaleString();

export function DocGoalPanel({ path, goal, words, chars }: Props) {
  const [mode, setMode] = useState<DocGoal["mode"]>(goal?.mode ?? "atLeast");
  const [unit, setUnit] = useState<DocGoal["unit"]>(goal?.unit ?? "words");
  const [target, setTarget] = useState(goal ? String(goal.target) : "");
  // The latest values, so quick successive changes build on each other rather than
  // on whatever was rendered last.
  const draft = useRef({ mode, unit, target });

  // Changes apply as you make them; there's no separate save step.
  const apply = (patch: Partial<{ mode: DocGoal["mode"]; unit: DocGoal["unit"]; target: string }>) => {
    const next = (draft.current = { ...draft.current, ...patch });
    setMode(next.mode);
    setUnit(next.unit);
    setTarget(next.target);
    const n = Math.round(Number(next.target));
    setDocGoal(path, n > 0 ? { mode: next.mode, unit: next.unit, target: n } : null);
  };

  const count = goal?.unit === "chars" ? chars : words;
  const state = goal && goalState(goal, count);
  const units = (n: number) => `${fmt(n)} ${goal?.unit === "chars" ? (n === 1 ? "character" : "characters") : n === 1 ? "word" : "words"}`;

  return (
    <div className="panel doc-goal-panel" onMouseDown={(e) => e.stopPropagation()}>
      <h3>Document goal</h3>
      <div className="segmented three">
        {MODES.map((m) => (
          <button key={m.id} className={mode === m.id ? "selected" : ""} onClick={() => apply({ mode: m.id })}>
            {m.label}
          </button>
        ))}
      </div>
      <div className="doc-goal-row">
        <input
          type="number"
          min={0}
          step={unit === "words" ? 50 : 100}
          placeholder="Off"
          value={target}
          autoFocus
          onChange={(e) => apply({ target: e.currentTarget.value })}
        />
        <div className="segmented two">
          <button className={unit === "words" ? "selected" : ""} onClick={() => apply({ unit: "words" })}>Words</button>
          <button className={unit === "chars" ? "selected" : ""} onClick={() => apply({ unit: "chars" })}>Characters</button>
        </div>
      </div>
      <p className="hint">
        {!goal
          ? "Set a length for this document. Useful when a piece has a word or character limit."
          : state === "over"
            ? `${units(count - goal.target)} over ${goal.mode === "about" ? "the target" : "the limit"}.`
            : state === "met"
              ? goal.mode === "atMost"
                ? `Within the limit, ${units(goal.target - count)} to spare.`
                : "Goal reached."
              : goal.mode === "atMost"
                ? `Room for ${units(goal.target - count)} more.`
                : `${units(goal.target - count)} to go.`}
        {goal?.mode === "about" && ` “About” allows ${ABOUT_TOLERANCE * 100}% either way.`}
      </p>
      {goal && (
        <button className="link-button" onClick={() => apply({ target: "" })}>
          Remove goal
        </button>
      )}
    </div>
  );
}
