export type Theme = "auto" | "light" | "cream" | "sepia" | "dark";

export interface Settings {
  font: string;
  fontSize: number;
  lineHeight: number;
  /** Width of the writing column, in characters. */
  measure: number;
  theme: Theme;
  sidebar: boolean;
  /** Sidebar width in pixels. */
  sidebarWidth: number;
}

export const SIDEBAR_WIDTH = { min: 180, default: 248, max: 520 };
export const clampSidebarWidth = (w: number) =>
  Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, w)));

// All of these ship with macOS, so there's nothing to download or license.
export const FONTS: { name: string; stack: string }[] = [
  { name: "New York", stack: 'ui-serif, "New York", Georgia, serif' },
  { name: "Iowan Old Style", stack: '"Iowan Old Style", "Palatino Linotype", serif' },
  { name: "Charter", stack: 'Charter, "Bitstream Charter", Georgia, serif' },
  { name: "Palatino", stack: 'Palatino, "Palatino Linotype", serif' },
  { name: "Baskerville", stack: 'Baskerville, "Baskerville Old Face", serif' },
  { name: "Georgia", stack: "Georgia, serif" },
  { name: "San Francisco", stack: 'system-ui, -apple-system, "Helvetica Neue", sans-serif' },
  { name: "Avenir Next", stack: '"Avenir Next", Avenir, sans-serif' },
  { name: "Helvetica Neue", stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { name: "SF Mono", stack: 'ui-monospace, "SF Mono", Menlo, monospace' },
  { name: "Menlo", stack: "Menlo, Monaco, monospace" },
  { name: "Courier", stack: '"Courier New", Courier, monospace' },
];

/** Resolves a font name to a CSS stack; unknown names are treated as an installed font. */
export const fontStack = (name: string) =>
  FONTS.find((f) => f.name === name)?.stack ?? `"${name.replace(/"/g, "")}", ui-serif, serif`;

export const DEFAULT_SETTINGS: Settings = {
  font: "New York",
  fontSize: 19,
  lineHeight: 1.7,
  measure: 66,
  theme: "auto",
  sidebar: true,
  sidebarWidth: SIDEBAR_WIDTH.default,
};

const KEY = "joyce:settings";

export function loadSettings(): Settings {
  try {
    const s = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
    return { ...s, sidebarWidth: clampSidebarWidth(Number(s.sidebarWidth) || SIDEBAR_WIDTH.default) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export const saveSettings = (s: Settings) => localStorage.setItem(KEY, JSON.stringify(s));
