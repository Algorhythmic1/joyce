import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorExtensions } from "../editor/setup";

interface Props {
  initial: string;
  onChange: (doc: string, typed: boolean) => void;
  onReady: (view: EditorView | null) => void;
  autoFocus: boolean;
}

/** Mount with a `key` per document: each file gets a fresh view and undo history. */
export function Editor({ initial, onChange, onReady, autoFocus }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: editorExtensions((doc, typed) => onChangeRef.current(doc, typed)),
      }),
    });
    if (autoFocus) view.focus();
    onReady(view);
    return () => {
      onReady(null);
      view.destroy();
    };
  }, []);

  return <div className="editor" ref={host} />;
}
