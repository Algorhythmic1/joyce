import { useEffect, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorExtensions } from "../editor/setup";
import { imageCompartment, imageContextExtension } from "../editor/images";
import { storage } from "../fs";

interface Props {
  initial: string;
  onChange: (doc: string, typed: boolean, fromSync: boolean) => void;
  onReady: (view: EditorView | null) => void;
  autoFocus: boolean;
  /** Folder of the document, for resolving relative image paths. */
  dir: string;
  saveImage: (file: File) => Promise<string | null>;
  readOnly?: boolean;
  extra?: Extension;
}

/** Mount with a `key` per document: each file gets a fresh view and undo history. */
export function Editor({ initial, onChange, onReady, autoFocus, dir, saveImage, readOnly, extra }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const saveImageRef = useRef(saveImage);
  saveImageRef.current = saveImage;
  const viewRef = useRef<EditorView | null>(null);
  const imageContext = (d: string) => ({ dir: d, url: storage.imageUrl, save: (f: File) => saveImageRef.current(f) });

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: editorExtensions((doc, typed, fromSync) => onChangeRef.current(doc, typed, fromSync), imageContext(dir), { readOnly, extra }),
      }),
    });
    viewRef.current = view;
    if (autoFocus) view.focus();
    onReady(view);
    return () => {
      onReady(null);
      view.destroy();
    };
  }, []);

  // A rename or move keeps the same editor; point relative image paths at the new folder.
  const firstDir = useRef(dir);
  useEffect(() => {
    if (dir === firstDir.current) return;
    firstDir.current = dir;
    viewRef.current?.dispatch({ effects: imageCompartment.reconfigure(imageContextExtension(imageContext(dir))) });
  }, [dir]);

  return <div className="editor" ref={host} />;
}
