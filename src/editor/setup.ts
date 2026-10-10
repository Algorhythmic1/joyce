import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { EditorView, drawSelection, keymap, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";
import { formattingKeymap } from "./commands";

// Markdown stays visible but recedes: markup characters are muted while the
// text they affect is styled in place.
const prose = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.6em", fontWeight: "700", lineHeight: "1.3" },
  { tag: t.heading2, fontSize: "1.3em", fontWeight: "700", lineHeight: "1.35" },
  { tag: t.heading3, fontSize: "1.12em", fontWeight: "700" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--muted)" },
  { tag: t.processingInstruction, color: "var(--muted)", fontWeight: "400" },
  { tag: t.contentSeparator, color: "var(--muted)" },
  { tag: t.quote, color: "var(--quote)", fontStyle: "italic" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--muted)", textDecoration: "underline" },
  { tag: t.monospace, fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: "0.88em" },
]);

const surface = EditorView.theme({
  "&": { height: "100%", background: "transparent", color: "var(--text)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font)",
    fontSize: "var(--font-size)",
    lineHeight: "var(--line-height)",
    overflowX: "hidden",
  },
  ".cm-content": {
    maxWidth: "var(--measure)",
    width: "100%",
    margin: "0 auto",
    padding: "min(18vh, 140px) 2rem 45vh",
    caretColor: "var(--accent)",
    fontVariantLigatures: "common-ligatures",
    hyphens: "auto",
  },
  ".cm-line": { padding: "0" },
  ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
    { background: "var(--selection) !important" },
});

/**
 * Whether a change came from the writer's own typing or deleting. Pastes, drops,
 * undo/redo and programmatic edits don't count toward writing stats: a paste isn't
 * writing, and undoing one shouldn't count against you either.
 */
const isWriting = (u: ViewUpdate) =>
  u.transactions.some((tr) => tr.docChanged) &&
  u.transactions.every(
    (tr) =>
      !tr.docChanged ||
      ((tr.isUserEvent("input") || tr.isUserEvent("delete")) &&
        !tr.isUserEvent("input.paste") &&
        !tr.isUserEvent("input.drop")),
  );

export function editorExtensions(onChange: (doc: string, typed: boolean) => void): Extension[] {
  return [
    history(),
    drawSelection(),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "on", autocapitalize: "sentences" }),
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(prose),
    surface,
    keymap.of([...formattingKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange(u.state.doc.toString(), isWriting(u));
    }),
  ];
}
