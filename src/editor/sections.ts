import type { Extension, Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { CompiledSection } from "../projects";
import { iconElement } from "../sectionIcons";

/** A quiet label where each section of a compiled project begins; click it to edit that section. */
class SectionMark extends WidgetType {
  constructor(
    readonly section: CompiledSection,
    readonly first: boolean,
    readonly onOpen: (path: string) => void,
  ) {
    super();
  }

  eq(other: SectionMark) {
    const a = other.section;
    const b = this.section;
    return (
      a.path === b.path && a.start === b.start && other.first === this.first &&
      a.icon?.symbol === b.icon?.symbol && a.icon?.color === b.icon?.color
    );
  }

  toDOM() {
    const mark = document.createElement("div");
    mark.className = `cm-section-mark${this.section.isPart ? " part" : ""}${this.first ? " first" : ""}`;
    mark.style.paddingLeft = `${this.section.depth * 1.2}em`;
    const label = document.createElement("button");
    label.type = "button";
    label.textContent = this.section.name;
    label.title = this.section.isPart ? "Part" : `Edit “${this.section.name}”`;
    if (!this.section.isPart) label.onclick = () => this.onOpen(this.section.path);
    if (this.section.icon) label.prepend(iconElement(this.section.icon, 12));
    mark.appendChild(label);
    return mark;
  }

  ignoreEvent() {
    return true;
  }
}

export function sectionMarks(sections: CompiledSection[], onOpen: (path: string) => void): Extension {
  const ranges: Range<Decoration>[] = sections.map((s, i) =>
    Decoration.widget({ widget: new SectionMark(s, i === 0, onOpen), block: true, side: -1 }).range(s.start),
  );
  return [
    EditorView.decorations.of(Decoration.set(ranges, true)),
    EditorView.baseTheme({
      ".cm-section-mark": {
        display: "flex",
        alignItems: "center",
        gap: "0.8em",
        margin: "2.4em 0 1.2em",
        fontFamily: "var(--ui-font, system-ui)",
        fontSize: "11px",
        letterSpacing: "0.04em",
        color: "var(--muted)",
      },
      ".cm-section-mark.first": { marginTop: "0" },
      ".cm-section-mark::after": { content: '""', flex: "1", borderTop: "1px solid var(--border)" },
      ".cm-section-mark button": {
        all: "unset",
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        cursor: "pointer",
        padding: "2px 6px",
        marginLeft: "-6px",
        borderRadius: "4px",
      },
      ".cm-section-mark button:hover": { background: "var(--hover)", color: "var(--accent)" },
      ".cm-section-mark.part button": { cursor: "default", textTransform: "uppercase", fontWeight: "600" },
      ".cm-section-mark.part button:hover": { background: "none", color: "var(--muted)" },
    }),
  ];
}
