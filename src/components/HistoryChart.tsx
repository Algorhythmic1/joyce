import { useState } from "react";
import type { Bucket, Period } from "../stats";

interface Props {
  buckets: Bucket[];
  period: Period;
  goal: number | null;
}

const WIDTH = 312;
const PLOT_H = 112;
const AXIS_H = 18;
const TOP = 16;

const fmtDate: Record<Period, Intl.DateTimeFormatOptions> = {
  day: { month: "short", day: "numeric" },
  week: { month: "short", day: "numeric" },
  month: { month: "short" },
};

export const bucketLabel = (b: Bucket, period: Period) =>
  (period === "week" ? "Week of " : "") +
  b.start.toLocaleDateString(undefined, period === "month" ? { month: "long", year: "numeric" } : fmtDate[period]);

const compact = (n: number) => (n >= 1000 ? `${+(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n));

/** Rounds up to 1, 2 or 5 × 10ⁿ so ticks land on clean numbers. */
function niceMax(v: number) {
  if (v <= 0) return 100;
  const pow = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find((m) => m * pow >= v) ?? 10) * pow;
}

/** Bar per period; the goal is a hairline across the plot. */
export function HistoryChart({ buckets, period, goal }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(goal ?? 0, ...buckets.map((b) => b.words)));
  const y = (v: number) => TOP + PLOT_H - (v / max) * PLOT_H;
  const slot = WIDTH / buckets.length;
  const barW = Math.min(24, slot - 2);
  const r = Math.min(4, barW / 2);
  const ticks = [0, max / 2, max];
  const labelled = new Set([0, Math.floor((buckets.length - 1) / 2), buckets.length - 1]);
  const active = hover === null ? null : buckets[hover];

  return (
    <div className="chart">
      <svg width={WIDTH} height={TOP + PLOT_H + AXIS_H} role="img" aria-label={`Words written per ${period}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="chart-grid" x1={0} x2={WIDTH} y1={y(t)} y2={y(t)} />
            {t > 0 && (
              <text className="chart-tick" x={0} y={y(t) - 3}>
                {compact(t)}
              </text>
            )}
          </g>
        ))}
        {buckets.map((b, i) => {
          const x = i * slot + (slot - barW) / 2;
          const h = (b.words / max) * PLOT_H;
          const top = y(b.words);
          const base = TOP + PLOT_H;
          // Rounded data end, square at the baseline.
          const d =
            h <= 0
              ? ""
              : h < r
                ? `M${x},${base}V${top}H${x + barW}V${base}Z`
                : `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + barW - r}Q${x + barW},${top} ${x + barW},${top + r}V${base}Z`;
          return (
            <g key={b.start.getTime()}>
              {d && <path className={`chart-bar${hover === i ? " hovered" : ""}`} d={d} />}
              {labelled.has(i) && (
                <text
                  className="chart-tick"
                  x={i === 0 ? 0 : i === buckets.length - 1 ? WIDTH : i * slot + slot / 2}
                  y={base + 13}
                  textAnchor={i === 0 ? "start" : i === buckets.length - 1 ? "end" : "middle"}
                >
                  {i === buckets.length - 1 ? (period === "day" ? "Today" : `This ${period}`) : b.start.toLocaleDateString(undefined, fmtDate[period])}
                </text>
              )}
              {/* The hit target is the whole column, not just the painted bar. */}
              <rect
                className="chart-hit"
                x={i * slot}
                y={TOP}
                width={slot}
                height={PLOT_H}
                tabIndex={0}
                aria-label={`${bucketLabel(b, period)}: ${b.words.toLocaleString()} words`}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
            </g>
          );
        })}
        {goal ? (
          <g className="chart-goal">
            <line x1={0} x2={WIDTH} y1={y(goal)} y2={y(goal)} />
            <text x={WIDTH} y={y(goal) - 4} textAnchor="end">
              Goal {compact(goal)}
            </text>
          </g>
        ) : null}
      </svg>
      {active && hover !== null && (
        <div
          className="chart-tooltip"
          style={{
            left: Math.min(Math.max(hover * slot + slot / 2, 50), WIDTH - 50),
            top: Math.max(y(active.words) - 8, 0),
          }}
        >
          <strong>{active.words.toLocaleString()}</strong>
          <span>{bucketLabel(active, period)}</span>
        </div>
      )}
    </div>
  );
}
