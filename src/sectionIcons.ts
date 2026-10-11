/**
 * Symbols and colors writers can give sections, so the shape of a long piece is
 * visible at a glance in the sidebar (scenes, characters, places, threads…).
 * Shape and color are chosen separately, so identity never rests on color alone.
 */

export interface SectionIcon {
  symbol: SymbolId;
  color: ColorId;
}

/** 16×16 filled glyphs. `evenodd` marks shapes with holes. */
export const SYMBOLS = {
  circle: { label: "Circle", d: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z" },
  square: { label: "Square", d: "M5 3h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" },
  triangle: { label: "Triangle", d: "M8 2.2 14.2 13.3H1.8z" },
  diamond: { label: "Diamond", d: "M8 1.8 14.2 8 8 14.2 1.8 8z" },
  star: { label: "Star", d: "M8 1.3l2 4.2 4.6.6-3.4 3.2.9 4.6L8 11.6l-4.1 2.3.9-4.6L1.4 6.1 6 5.5z" },
  heart: { label: "Heart", d: "M8 14S1.8 10.2 1.8 5.8A3.3 3.3 0 0 1 8 4.2a3.3 3.3 0 0 1 6.2 1.6C14.2 10.2 8 14 8 14z" },
  bookmark: { label: "Bookmark", d: "M4 1.8h8a.8.8 0 0 1 .8.8v11.9L8 11.2l-4.8 3.3V2.6a.8.8 0 0 1 .8-.8z" },
  flag: { label: "Flag", d: "M3 1.5h1.5v13H3z M4.5 2.2h8l-2 3 2 3h-8z" },
  bolt: { label: "Lightning", d: "M9.3 1 3 9.2h4.3L6.6 15 13 6.7H8.7z" },
  leaf: { label: "Leaf", d: "M14 2C6 2 2.3 5.8 2.3 10.4c0 1.1.2 2.2.7 3.2 1.4-4.3 4-6.6 7-7.6-2.6 1.6-4.6 4-5.9 7.7C11.3 14.4 14 9.1 14 2z" },
  moon: { label: "Moon", d: "M10.6 1.9a6.3 6.3 0 1 0 3.6 9.3A5.3 5.3 0 0 1 10.6 1.9z" },
  drop: { label: "Drop", d: "M8 1.3S3.3 6.9 3.3 10.1a4.7 4.7 0 0 0 9.4 0C12.7 6.9 8 1.3 8 1.3z" },
  flame: { label: "Flame", d: "M8.6 1c.6 3 3.6 4.6 3.6 8.2a4.2 4.2 0 0 1-8.4 0c0-1.9 1-3.1 2.1-4 0 1.4.6 2.4 1.7 2.7C7 5.6 7.5 3.1 8.6 1z" },
  eye: {
    label: "Eye",
    d: "M8 3.3C3.8 3.3 1.2 8 1.2 8s2.6 4.7 6.8 4.7S14.8 8 14.8 8 12.2 3.3 8 3.3zm0 2.4a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6z",
    evenodd: true,
  },
  person: { label: "Character", d: "M8 1.8a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4zM2.8 14.2c0-3 2.3-5.2 5.2-5.2s5.2 2.2 5.2 5.2z" },
  pin: {
    label: "Place",
    d: "M8 1.3a4.7 4.7 0 0 0-4.7 4.7c0 3.6 4.7 8.8 4.7 8.8s4.7-5.2 4.7-8.8A4.7 4.7 0 0 0 8 1.3zm0 3.1a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2z",
    evenodd: true,
  },
  bulb: { label: "Idea", d: "M8 1.3a4.6 4.6 0 0 0-2.7 8.3c.5.4.8 1 .8 1.6v.6h3.8v-.6c0-.6.3-1.2.8-1.6A4.6 4.6 0 0 0 8 1.3zM6.1 12.8h3.8v.6a1.1 1.1 0 0 1-1.1 1.1H7.2a1.1 1.1 0 0 1-1.1-1.1z" },
  clock: {
    label: "Time",
    d: "M8 1.4a6.6 6.6 0 1 0 0 13.2A6.6 6.6 0 0 0 8 1.4zm-.75 2.8h1.5v3.4l2.4 1.5-.8 1.3-3.1-2z",
    evenodd: true,
  },
} as const;

export type SymbolId = keyof typeof SYMBOLS;

/**
 * A validated categorical palette (distinguishable for common color blindness),
 * plus gray. Each has light and dark steps; see `--icon-*` in styles.css.
 */
export const COLORS = {
  blue: "Blue",
  orange: "Orange",
  aqua: "Aqua",
  yellow: "Yellow",
  magenta: "Magenta",
  green: "Green",
  violet: "Violet",
  red: "Red",
  gray: "Gray",
} as const;

export type ColorId = keyof typeof COLORS;

export const colorVar = (c: ColorId) => `var(--icon-${c})`;

export const isSectionIcon = (v: unknown): v is SectionIcon =>
  !!v &&
  typeof v === "object" &&
  (v as SectionIcon).symbol in SYMBOLS &&
  (v as SectionIcon).color in COLORS;

/** For places outside React (e.g. editor widgets). */
export function iconElement(icon: SectionIcon, size = 14): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  const sym = SYMBOLS[icon.symbol];
  path.setAttribute("d", sym.d);
  path.setAttribute("fill", colorVar(icon.color));
  if ("evenodd" in sym) path.setAttribute("fill-rule", "evenodd");
  path.setAttribute("stroke", "var(--icon-edge)");
  path.setAttribute("stroke-width", "0.7");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}
