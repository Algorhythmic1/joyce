import { FONTS, type Settings, type Theme } from "../settings";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

const THEMES: { id: Theme; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "light", label: "Light" },
  { id: "cream", label: "Cream" },
  { id: "sepia", label: "Sepia" },
  { id: "dark", label: "Dark" },
];

export function SettingsPanel({ settings, onChange }: Props) {
  const isCustom = !FONTS.some((f) => f.name === settings.font);
  return (
    <div className="panel settings-panel" onMouseDown={(e) => e.stopPropagation()}>
      <section>
        <h3>Typeface</h3>
        <div className="font-list">
          {FONTS.map((f) => (
            <button
              key={f.name}
              className={settings.font === f.name ? "selected" : ""}
              style={{ fontFamily: f.stack }}
              onClick={() => onChange({ font: f.name })}
            >
              {f.name}
            </button>
          ))}
        </div>
        <input
          className={`custom-font${isCustom ? " selected" : ""}`}
          placeholder="Any installed font…"
          defaultValue={isCustom ? settings.font : ""}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          onBlur={(e) => e.currentTarget.value.trim() && onChange({ font: e.currentTarget.value.trim() })}
        />
      </section>

      <Slider label="Size" value={settings.fontSize} min={13} max={30} step={1}
        format={(v) => `${v}px`} onChange={(fontSize) => onChange({ fontSize })} />
      <Slider label="Line spacing" value={settings.lineHeight} min={1.3} max={2.4} step={0.05}
        format={(v) => v.toFixed(2)} onChange={(lineHeight) => onChange({ lineHeight })} />
      <Slider label="Line width" value={settings.measure} min={40} max={100} step={2}
        format={(v) => `${v} ch`} onChange={(measure) => onChange({ measure })} />

      <section>
        <h3>Theme</h3>
        <div className="segmented">
          {THEMES.map((t) => (
            <button key={t.id} className={settings.theme === t.id ? "selected" : ""} onClick={() => onChange({ theme: t.id })}>
              {t.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function Slider(props: {
  label: string; value: number; min: number; max: number; step: number;
  format: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <section>
      <h3>
        {props.label}
        <span>{props.format(props.value)}</span>
      </h3>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value}
        onChange={(e) => props.onChange(Number(e.currentTarget.value))} />
    </section>
  );
}
