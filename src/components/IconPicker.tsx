import { useState } from "react";
import { COLORS, SYMBOLS, colorVar, type ColorId, type SectionIcon, type SymbolId } from "../sectionIcons";

export function SectionIconView({ icon, size = 14 }: { icon: SectionIcon; size?: number }) {
  const sym = SYMBOLS[icon.symbol];
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-label={`${COLORS[icon.color]} ${sym.label}`}>
      <path
        d={sym.d}
        fill={colorVar(icon.color)}
        fillRule={"evenodd" in sym ? "evenodd" : undefined}
        stroke="var(--icon-edge)"
        strokeWidth="0.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface Props {
  icon?: SectionIcon;
  x: number;
  y: number;
  onPick: (icon: SectionIcon | null) => void;
  onClose: () => void;
}

/** Pick a symbol and a color; each change applies right away. */
export function IconPicker({ icon, x, y, onPick, onClose }: Props) {
  const [color, setColor] = useState<ColorId>(icon?.color ?? "blue");
  const [symbol, setSymbol] = useState<SymbolId | undefined>(icon?.symbol);

  const choose = (next: { symbol?: SymbolId; color?: ColorId }) => {
    const s = next.symbol ?? symbol ?? "circle";
    const c = next.color ?? color;
    setSymbol(s);
    setColor(c);
    onPick({ symbol: s, color: c });
  };

  // Keep the popover on screen near where it was opened.
  const left = Math.min(x, window.innerWidth - 236);
  const top = Math.min(y, window.innerHeight - 230);

  return (
    <div className="icon-picker" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="icon-grid">
        {(Object.keys(SYMBOLS) as SymbolId[]).map((id) => (
          <button
            key={id}
            title={SYMBOLS[id].label}
            className={symbol === id ? "selected" : ""}
            onClick={() => choose({ symbol: id })}
          >
            <SectionIconView icon={{ symbol: id, color }} size={16} />
          </button>
        ))}
      </div>
      <div className="color-row">
        {(Object.keys(COLORS) as ColorId[]).map((id) => (
          <button
            key={id}
            title={COLORS[id]}
            aria-label={COLORS[id]}
            aria-pressed={color === id}
            className={`swatch${color === id ? " selected" : ""}`}
            style={{ background: colorVar(id) }}
            onClick={() => choose({ color: id })}
          />
        ))}
      </div>
      <div className="icon-picker-footer">
        {icon && (
          <button
            className="link-button"
            onClick={() => {
              onPick(null);
              onClose();
            }}
          >
            Remove icon
          </button>
        )}
        <button className="link-button" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
