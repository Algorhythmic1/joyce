import { Compartment, Facet, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

export interface ImageContext {
  /** Folder of the open document; relative image paths resolve against it. */
  dir: string;
  /** Turns an absolute path into a URL the webview can display. */
  url: (absPath: string) => string;
  /** Saves a pasted or dropped image and returns the path to put in the Markdown. */
  save: (file: File) => Promise<string | null>;
}

const imageContext = Facet.define<ImageContext, ImageContext | null>({
  combine: (values) => values[values.length - 1] ?? null,
});

/** Reconfigured when the document is renamed or moved, so relative paths keep resolving. */
export const imageCompartment = new Compartment();
export const imageContextExtension = (ctx: ImageContext) => imageContext.of(ctx);

/** A line holding just an image: `![alt](src)` or `![alt](src "title")`. */
const IMAGE_LINE = /^\s*!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)\s*$/;

function resolve(src: string, ctx: ImageContext) {
  if (/^(https?:|data:)/i.test(src)) return src;
  let path = src;
  try {
    path = decodeURI(src);
  } catch {
    // Not percent-encoded; use as written.
  }
  return ctx.url(path.startsWith("/") ? path : `${ctx.dir.replace(/\/$/, "")}/${path.replace(/^\.\//, "")}`);
}

class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
    readonly src: string,
  ) {
    super();
  }

  eq(other: ImageWidget) {
    return other.url === this.url && other.alt === this.alt;
  }

  get estimatedHeight() {
    return 240;
  }

  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-image";
    const img = document.createElement("img");
    img.src = this.url;
    img.alt = this.alt;
    img.draggable = false;
    img.onerror = () => {
      wrap.classList.add("missing");
      wrap.textContent = `Image not found: ${this.src}`;
    };
    wrap.appendChild(img);
    return wrap;
  }

  // Let clicks through so the editor places the cursor (revealing the Markdown).
  ignoreEvent() {
    return false;
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const ctx = state.facet(imageContext);
  if (!ctx) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  const { doc, selection } = state;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (!line.text.includes("![")) continue;
    const m = line.text.match(IMAGE_LINE);
    if (!m) continue;
    const widget = new ImageWidget(resolve(m[2], ctx), m[1], m[2]);
    const editing = selection.ranges.some((r) => r.from <= line.to && r.to >= line.from);
    // While the cursor is on the line, show its Markdown with the image beneath;
    // otherwise the image stands in for the line.
    ranges.push(
      editing
        ? Decoration.widget({ widget, block: true, side: 1 }).range(line.to)
        : Decoration.replace({ widget, block: true }).range(line.from, line.to),
    );
  }
  return Decoration.set(ranges);
}

const imageField = StateField.define<DecorationSet>({
  create: buildDecorations,
  update(deco, tr) {
    const reconfigured = tr.startState.facet(imageContext) !== tr.state.facet(imageContext);
    return tr.docChanged || tr.selection || reconfigured ? buildDecorations(tr.state) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Inserts each image on a line of its own, keeping text above and below intact. */
async function insertImages(view: EditorView, files: File[], pos: number) {
  const ctx = view.state.facet(imageContext);
  if (!ctx) return;
  for (const file of files) {
    let src: string | null;
    try {
      src = await ctx.save(file);
    } catch (e) {
      console.error(e);
      continue;
    }
    if (!src) continue;
    const line = view.state.doc.lineAt(pos);
    // Splitting a paragraph shouldn't leave stray spaces at the break.
    const offset = pos - line.from;
    const from = line.from + line.text.slice(0, offset).trimEnd().length;
    const to = line.to - line.text.slice(offset).trimStart().length;
    const atStart = from === line.from;
    const atEnd = to === line.to;
    const prevBlank = line.number === 1 || view.state.doc.line(line.number - 1).text.trim() === "";
    const before = !atStart ? "\n\n" : line.text.trim() === "" && !prevBlank ? "\n" : "";
    const after = atEnd ? "\n" : "\n\n";
    const insert = `${before}![](${src})${after}`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      scrollIntoView: true,
      userEvent: "input.paste",
    });
    pos = view.state.selection.main.head;
  }
  view.focus();
}

const imagesOf = (list: FileList | undefined | null) =>
  [...(list ?? [])].filter((f) => f.type.startsWith("image/"));

const pasteAndDrop = EditorView.domEventHandlers({
  paste(event, view) {
    if (view.state.readOnly) return false;
    const files = imagesOf(event.clipboardData?.files);
    if (!files.length) return false;
    event.preventDefault();
    insertImages(view, files, view.state.selection.main.head);
    return true;
  },
  drop(event, view) {
    if (view.state.readOnly) return false;
    const files = imagesOf(event.dataTransfer?.files);
    if (!files.length) return false;
    event.preventDefault();
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
    // Drop between lines, not in the middle of a word.
    const line = view.state.doc.lineAt(pos);
    insertImages(view, files, pos - line.from < line.length / 2 ? line.from : line.to);
    return true;
  },
});

const imageTheme = EditorView.baseTheme({
  ".cm-image": {
    padding: "0.6em 0",
    cursor: "pointer",
  },
  ".cm-image img": {
    display: "block",
    maxWidth: "100%",
    maxHeight: "70vh",
    margin: "0 auto",
    borderRadius: "6px",
  },
  ".cm-image.missing": {
    fontFamily: "var(--ui-font, system-ui)",
    fontSize: "0.75em",
    color: "var(--muted)",
    border: "1px dashed var(--border)",
    borderRadius: "6px",
    padding: "1em",
    textAlign: "center",
  },
});

export const images = (ctx: ImageContext): Extension => [
  imageCompartment.of(imageContext.of(ctx)),
  imageField,
  pasteAndDrop,
  imageTheme,
];
