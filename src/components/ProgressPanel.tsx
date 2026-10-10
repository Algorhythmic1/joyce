import { useState } from "react";
import {
  allTime, goalFor, history, periodTotal, streak, updateGoals, useDays, useGoals,
  type Goals, type Period,
} from "../stats";
import { ensureNotificationPermission } from "../reminders";
import { HistoryChart, bucketLabel } from "./HistoryChart";

const PERIODS: { id: Period; label: string; current: string; count: number }[] = [
  { id: "day", label: "Days", current: "Today", count: 30 },
  { id: "week", label: "Weeks", current: "This week", count: 12 },
  { id: "month", label: "Months", current: "This month", count: 12 },
];

const fmt = (n: number) => n.toLocaleString();

function duration(seconds: number) {
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function ProgressPanel() {
  const [tab, setTab] = useState<"progress" | "goals">("progress");
  return (
    <div className="panel progress-panel" onMouseDown={(e) => e.stopPropagation()}>
      <div className="segmented tabs">
        <button className={tab === "progress" ? "selected" : ""} onClick={() => setTab("progress")}>Progress</button>
        <button className={tab === "goals" ? "selected" : ""} onClick={() => setTab("goals")}>Goals & Reminders</button>
      </div>
      {tab === "progress" ? <Progress onEditGoals={() => setTab("goals")} /> : <GoalsForm />}
    </div>
  );
}

function Progress({ onEditGoals }: { onEditGoals: () => void }) {
  const days = useDays();
  const goals = useGoals();
  const [range, setRange] = useState<Period>("day");
  const [asTable, setAsTable] = useState(false);
  const today = periodTotal(days, goals, "day");
  const week = periodTotal(days, goals, "week");
  const meta = PERIODS.find((p) => p.id === range)!;
  const buckets = history(days, goals, range, meta.count);
  const hasGoals = goals.daily || goals.weekly || goals.monthly;

  return (
    <>
      <section className="meters">
        {PERIODS.map((p) => (
          <Meter key={p.id} label={p.current} value={periodTotal(days, goals, p.id).words} goal={goalFor(goals, p.id)} />
        ))}
        {!hasGoals && (
          <button className="link-button" onClick={onEditGoals}>Set a daily, weekly or monthly goal →</button>
        )}
      </section>

      <section className="stat-row">
        <Stat label="Streak" value={`${streak(days, goals)}`} unit={streak(days, goals) === 1 ? "day" : "days"} />
        <Stat label="Time today" value={duration(today.seconds)} />
        <Stat label="This week" value={duration(week.seconds)} />
        <Stat label="All time" value={fmt(allTime(days))} unit="words" />
      </section>

      <section>
        <h3>
          Words written
          <button className="link-button" onClick={() => setAsTable((t) => !t)}>{asTable ? "Chart" : "Table"}</button>
        </h3>
        <div className="segmented small">
          {PERIODS.map((p) => (
            <button key={p.id} className={range === p.id ? "selected" : ""} onClick={() => setRange(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        {asTable ? (
          <table className="history-table">
            <tbody>
              {[...buckets].reverse().map((b) => (
                <tr key={b.start.getTime()}>
                  <td>{bucketLabel(b, range)}</td>
                  <td>{fmt(b.words)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <HistoryChart buckets={buckets} period={range} goal={goalFor(goals, range)} />
        )}
      </section>
    </>
  );
}

function Meter({ label, value, goal }: { label: string; value: number; goal: number | null }) {
  const pct = goal ? Math.min(1, value / goal) : 0;
  return (
    <div className="meter">
      <div className="meter-label">
        <span>{label}</span>
        <span>
          <strong>{fmt(value)}</strong>
          {goal ? <span className="muted"> / {fmt(goal)}</span> : <span className="muted"> words</span>}
          {goal && value >= goal ? <span className="meter-done" aria-label="Goal reached"> ✓</span> : null}
        </span>
      </div>
      {goal ? (
        <div className="meter-track" role="progressbar" aria-valuenow={value} aria-valuemax={goal} aria-label={`${label} goal`}>
          <div className="meter-fill" style={{ width: `${pct * 100}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        {value}
        {unit && <span className="muted"> {unit}</span>}
      </div>
    </div>
  );
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function GoalsForm() {
  const goals = useGoals();
  const { reminder } = goals;
  const [permissionDenied, setPermissionDenied] = useState(false);
  const setReminder = (patch: Partial<Goals["reminder"]>) => updateGoals({ reminder: { ...reminder, ...patch } });
  // Show weekdays in the order the week starts.
  const dayOrder = goals.weekStart === 1 ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];

  const toggleReminder = async (enabled: boolean) => {
    if (enabled) {
      const granted = await ensureNotificationPermission();
      setPermissionDenied(!granted);
      if (!granted) return;
    }
    setReminder({ enabled });
  };

  return (
    <>
      <section className="goal-inputs">
        <h3>Word goals</h3>
        {(["daily", "weekly", "monthly"] as const).map((key) => (
          <label key={key} className="goal-input">
            <span>{key[0].toUpperCase() + key.slice(1)}</span>
            <input
              type="number"
              min={0}
              step={50}
              placeholder="Off"
              value={goals[key] ?? ""}
              onChange={(e) => {
                const n = Math.round(Number(e.currentTarget.value));
                updateGoals({ [key]: e.currentTarget.value && n > 0 ? n : null });
              }}
            />
            <span className="muted">words</span>
          </label>
        ))}
      </section>

      <section>
        <h3>Week starts on</h3>
        <div className="segmented small two">
          {([1, 0] as const).map((d) => (
            <button key={d} className={goals.weekStart === d ? "selected" : ""} onClick={() => updateGoals({ weekStart: d })}>
              {WEEKDAY_NAMES[d]}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3>Reminder</h3>
        <label className="check">
          <input type="checkbox" checked={reminder.enabled} onChange={(e) => toggleReminder(e.currentTarget.checked)} />
          Remind me to write at
          <input
            type="time"
            value={reminder.time}
            disabled={!reminder.enabled}
            onChange={(e) => e.currentTarget.value && setReminder({ time: e.currentTarget.value })}
          />
        </label>
        <div className={`weekdays${reminder.enabled ? "" : " disabled"}`}>
          {dayOrder.map((d) => (
            <button
              key={d}
              title={WEEKDAY_NAMES[d]}
              aria-pressed={reminder.days.includes(d)}
              className={reminder.days.includes(d) ? "selected" : ""}
              disabled={!reminder.enabled}
              onClick={() =>
                setReminder({
                  days: reminder.days.includes(d) ? reminder.days.filter((x) => x !== d) : [...reminder.days, d],
                })
              }
            >
              {WEEKDAYS[d]}
            </button>
          ))}
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={reminder.onlyIfBehind}
            disabled={!reminder.enabled}
            onChange={(e) => setReminder({ onlyIfBehind: e.currentTarget.checked })}
          />
          Only if I'm behind on a goal
        </label>
        <p className="hint">
          {permissionDenied
            ? "Notifications are turned off for Joyce. Allow them in System Settings → Notifications."
            : "Reminders appear while Joyce is open, even in the background."}
        </p>
      </section>
    </>
  );
}
