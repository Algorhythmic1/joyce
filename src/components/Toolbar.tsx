import type { EditorView } from "@codemirror/view";
import {
  insertLink, setHeading, toggleBullets, toggleInline, toggleNumbers, toggleQuote,
} from "../editor/commands";
import { BulletsIcon, CodeIcon, LinkIcon, NumbersIcon, ProgressRing, PublishIcon, QuoteIcon, SidebarIcon } from "./icons";

interface Props {
  view: EditorView | null;
  onToggleSidebar: () => void;
  panel: Panel | null;
  onTogglePanel: (panel: Panel) => void;
  /** Whether a document is open, which saving to GitHub needs. */
  hasDoc: boolean;
  /** Fraction of today's goal written, or null without a daily goal. */
  todayProgress: number | null;
}

type Tool = { label: React.ReactNode; title: string; run: (v: EditorView) => boolean };

const GROUPS: Tool[][] = [
  [
    { label: <b>B</b>, title: "Bold (⌘B)", run: toggleInline("**") },
    { label: <i style={{ fontFamily: "ui-serif, Georgia, serif" }}>I</i>, title: "Italic (⌘I)", run: toggleInline("*") },
    { label: <s>S</s>, title: "Strikethrough (⇧⌘X)", run: toggleInline("~~") },
  ],
  [
    { label: "H1", title: "Heading 1 (⌘1)", run: setHeading(1) },
    { label: "H2", title: "Heading 2 (⌘2)", run: setHeading(2) },
    { label: "H3", title: "Heading 3 (⌘3)", run: setHeading(3) },
  ],
  [
    { label: <QuoteIcon />, title: "Quote (⇧⌘9)", run: toggleQuote },
    { label: <BulletsIcon />, title: "Bulleted list (⇧⌘8)", run: toggleBullets },
    { label: <NumbersIcon />, title: "Numbered list (⇧⌘7)", run: toggleNumbers },
  ],
  [
    { label: <LinkIcon />, title: "Link (⌘K)", run: insertLink },
    { label: <CodeIcon />, title: "Code (⌘E)", run: toggleInline("`") },
  ],
];

export type Panel = "type" | "progress" | "publish";

export function Toolbar({ view, onToggleSidebar, panel, onTogglePanel, todayProgress, hasDoc }: Props) {
  return (
    <header className="toolbar" data-tauri-drag-region>
      <button className="icon-button sidebar-toggle" onClick={onToggleSidebar} title="Toggle sidebar (⌘\)">
        <SidebarIcon />
      </button>
      <div className="format-tools" data-tauri-drag-region>
        {GROUPS.map((group, i) => (
          <div className="tool-group" key={i}>
            {group.map((tool) => (
              <button
                key={tool.title}
                className="icon-button"
                title={tool.title}
                disabled={!view}
                // Keep focus (and the selection) in the editor.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => view && tool.run(view)}
              >
                {tool.label}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="panel-buttons">
        {hasDoc && (
          <button
            className={`icon-button${panel === "publish" ? " active" : ""}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => onTogglePanel("publish")}
            title="Save to GitHub"
          >
            <PublishIcon />
          </button>
        )}
        <button
          className={`icon-button${panel === "progress" ? " active" : ""}`}
          // Don't let the panel's click-outside handler see this, or it would close and reopen.
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => onTogglePanel("progress")}
          title={todayProgress === null ? "Progress & goals" : `Progress & goals: ${Math.round(todayProgress * 100)}% of today's goal`}
        >
          <ProgressRing value={todayProgress} />
        </button>
        <button
          className={`icon-button type-button${panel === "type" ? " active" : ""}`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => onTogglePanel("type")}
          title="Typography & theme"
        >
          Aa
        </button>
      </div>
    </header>
  );
}
