import { EditorSelection, type ChangeSpec } from "@codemirror/state";
import type { EditorView, KeyBinding } from "@codemirror/view";

type Command = (view: EditorView) => boolean;

/** Wraps the selection in `mark` (e.g. `**`), or unwraps it if it's already wrapped. */
export const toggleInline =
  (mark: string): Command =>
  (view) => {
    const { state } = view;
    const n = mark.length;
    view.dispatch(
      state.changeByRange((range) => {
        const before = state.sliceDoc(range.from - n, range.from);
        const after = state.sliceDoc(range.to, range.to + n);
        if (before === mark && after === mark) {
          return {
            changes: [
              { from: range.from - n, to: range.from },
              { from: range.to, to: range.to + n },
            ],
            range: EditorSelection.range(range.from - n, range.to - n),
          };
        }
        const text = state.sliceDoc(range.from, range.to);
        if (text.length >= 2 * n && text.startsWith(mark) && text.endsWith(mark)) {
          return {
            changes: { from: range.from, to: range.to, insert: text.slice(n, -n) },
            range: EditorSelection.range(range.from, range.to - 2 * n),
          };
        }
        return {
          changes: [
            { from: range.from, insert: mark },
            { from: range.to, insert: mark },
          ],
          range: EditorSelection.range(range.from + n, range.to + n),
        };
      }),
    );
    view.focus();
    return true;
  };

const BLOCK_PREFIX = /^(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/;

/** Applies `prefixFor(i)` to every selected line, or removes it if all lines already have it. */
const toggleLinePrefix =
  (matches: RegExp, prefixFor: (i: number) => string): Command =>
  (view) => {
    const { state } = view;
    const lines = new Map<number, ReturnType<typeof state.doc.line>>();
    for (const r of state.selection.ranges) {
      for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
        lines.set(n, state.doc.line(n));
      }
    }
    const sorted = [...lines.values()].sort((a, b) => a.number - b.number);
    const allHave = sorted.every((l) => matches.test(l.text));
    const changes: ChangeSpec[] = sorted.map((line, i) => {
      const existing = line.text.match(BLOCK_PREFIX)?.[0] ?? "";
      return { from: line.from, to: line.from + existing.length, insert: allHave ? "" : prefixFor(i) };
    });
    view.dispatch({ changes, scrollIntoView: true });
    view.focus();
    return true;
  };

// Level 0 means "plain paragraph": strip whatever block prefix the line has.
export const setHeading = (level: number): Command =>
  level === 0
    ? toggleLinePrefix(/^(?!)/, () => "")
    : toggleLinePrefix(new RegExp(`^#{${level}}\\s`), () => "#".repeat(level) + " ");

export const toggleQuote = toggleLinePrefix(/^>/, () => "> ");
export const toggleBullets = toggleLinePrefix(/^[-*+]\s/, () => "- ");
export const toggleNumbers = toggleLinePrefix(/^\d+[.)]\s/, (i) => `${i + 1}. `);

export const insertLink: Command = (view) => {
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to);
      const insert = `[${text}](url)`;
      // Select the placeholder URL if there was text, otherwise put the cursor inside the brackets.
      const cursor = text
        ? EditorSelection.range(range.from + text.length + 3, range.from + text.length + 6)
        : EditorSelection.cursor(range.from + 1);
      return { changes: { from: range.from, to: range.to, insert }, range: cursor };
    }),
  );
  view.focus();
  return true;
};

export const formattingKeymap: KeyBinding[] = [
  { key: "Mod-b", run: toggleInline("**") },
  { key: "Mod-i", run: toggleInline("*") },
  { key: "Mod-Shift-x", run: toggleInline("~~") },
  { key: "Mod-e", run: toggleInline("`") },
  { key: "Mod-k", run: insertLink },
  { key: "Mod-0", run: setHeading(0) },
  { key: "Mod-1", run: setHeading(1) },
  { key: "Mod-2", run: setHeading(2) },
  { key: "Mod-3", run: setHeading(3) },
  { key: "Mod-Shift-8", run: toggleBullets },
  { key: "Mod-Shift-7", run: toggleNumbers },
  { key: "Mod-Shift-9", run: toggleQuote },
];
