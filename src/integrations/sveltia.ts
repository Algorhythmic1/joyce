import { parse as parseYaml, parseDocument, stringify } from "yaml";

/*
 * Reads a Sveltia CMS (or Decap/Netlify CMS) `config.yml` and turns its folder
 * collections into something Joyce can publish into: which folder and file
 * format, how files are named, and which front matter fields exist. Kept free of
 * app dependencies so it can be tested on its own.
 */

export type FieldKind =
  | "string"
  | "text"
  | "date"
  | "datetime"
  | "boolean"
  | "number"
  | "select"
  | "list"
  | "image"
  | "body"
  | "hidden"
  /** Something Joyce can't edit (relations, objects, galleries…): left as it is. */
  | "other";

export interface Field {
  name: string;
  label: string;
  kind: FieldKind;
  /** The CMS widget name, for explaining "other" fields. */
  widget: string;
  required: boolean;
  default?: unknown;
  hint?: string;
  options?: { label: string; value: string }[];
  multiple?: boolean;
  /** Moment-style output format for dates, e.g. "YYYY-MM-DD". */
  format?: string;
  valueType?: "int" | "float";
}

export interface Collection {
  name: string;
  label: string;
  labelSingular: string;
  folder: string;
  extension: string;
  /** File name template, e.g. "{{slug}}" or "ep-{{fields.episodeNumber}}". */
  slug: string;
  /** Optional sub-path template for nested layouts, e.g. "{{slug}}/index". */
  path?: string;
  /** Field whose value is the entry's title. */
  identifier: string;
  fields: Field[];
  /** Where the entry's images go, if the config says. */
  media?: Media;
  /** Why Joyce can't publish into this collection, if it can't. */
  unsupported?: string;
}

/**
 * A `media_folder` / `public_folder` pair. Both may hold templates ({{slug}},
 * {{filename}}…). A collection's own media folder is relative to its entry's
 * folder unless it starts with "/"; the site-wide one is relative to the repo.
 */
export interface Media {
  /** Where image files are committed. */
  folder: string;
  /** What the Markdown links to an image with: the path prefix before its name. */
  publicFolder: string;
}

export interface SiteConfig {
  repo?: string;
  branch?: string;
  siteUrl?: string;
  collections: Collection[];
}

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function parseField(raw: Raw): Field {
  const name = String(raw.name ?? "");
  const widget = str(raw.widget) ?? "string";
  const base = {
    name,
    label: str(raw.label) ?? name,
    widget,
    required: raw.required !== false,
    default: raw.default,
    hint: str(raw.hint),
  };
  switch (widget) {
    case "string":
      return { ...base, kind: "string" };
    case "text":
      return { ...base, kind: "text" };
    case "markdown":
    case "richtext":
      return { ...base, kind: name === "body" ? "body" : "text" };
    case "boolean":
      return { ...base, kind: "boolean" };
    case "number":
      return { ...base, kind: "number", valueType: raw.value_type === "float" ? "float" : "int" };
    case "hidden":
      return { ...base, kind: "hidden" };
    case "date":
    case "datetime": {
      const format = str(raw.format) ?? str(raw.date_format);
      const dateOnly =
        widget === "date" || raw.time_format === false || (format !== undefined && !/[Hhms]/.test(format.replace(/MM|DD|YYYY|YY|M|D/g, "")));
      return { ...base, kind: dateOnly ? "date" : "datetime", format };
    }
    case "select": {
      const options = (Array.isArray(raw.options) ? raw.options : []).map((o) =>
        typeof o === "object" && o !== null
          ? { label: String((o as Raw).label ?? (o as Raw).value), value: String((o as Raw).value) }
          : { label: String(o), value: String(o) },
      );
      return { ...base, kind: "select", options, multiple: raw.multiple === true };
    }
    case "list":
      // A plain list of strings (like tags). Lists of objects aren't editable here.
      return { ...base, kind: raw.field || raw.fields || raw.types ? "other" : "list" };
    case "image":
      // One image, stored with the collection's other images. A gallery, or a field
      // with its own media folder, stays with the CMS.
      if (raw.multiple === true || str(raw.media_folder) !== undefined) return { ...base, kind: "other" };
      return { ...base, kind: "image" };
    default:
      return { ...base, kind: "other" };
  }
}

function parseCollection(raw: Raw, siteMedia?: Media): Collection | null {
  if (!raw.name) return null;
  const name = String(raw.name);
  const label = str(raw.label) ?? name;
  const fields = (Array.isArray(raw.fields) ? (raw.fields as Raw[]) : []).filter((f) => f && f.name).map(parseField);
  const format = str(raw.format) ?? "frontmatter";
  const extension = (str(raw.extension) ?? "md").replace(/^\./, "");
  const c: Collection = {
    name,
    label,
    labelSingular: str(raw.label_singular) ?? label,
    folder: String(raw.folder ?? "").replace(/^\/+|\/+$/g, ""),
    extension,
    slug: str(raw.slug) ?? "{{slug}}",
    path: str(raw.path),
    identifier: str(raw.identifier_field) ?? "title",
    fields,
    media: collectionMedia(raw, siteMedia),
  };
  if (!raw.folder) c.unsupported = "It's a set of fixed files, not a folder of entries.";
  else if (!["md", "mdx", "markdown"].includes(extension)) c.unsupported = `Its entries are .${extension} files, not Markdown.`;
  else if (!["frontmatter", "yaml-frontmatter"].includes(format)) c.unsupported = `Its entries use ${format}, which Joyce doesn't write yet.`;
  else if (raw.create === false) c.unsupported = "The site doesn't allow new entries in it.";
  return c;
}

function siteMedia(raw: Raw): Media | undefined {
  const folder = str(raw.media_folder);
  if (folder === undefined) return undefined;
  // Site-wide folders are from the repo root, written with or without a leading "/".
  const rooted = `/${folder.replace(/^\/+/, "")}`;
  return { folder: rooted, publicFolder: str(raw.public_folder) ?? rooted };
}

function collectionMedia(raw: Raw, site?: Media): Media | undefined {
  const folder = str(raw.media_folder);
  if (folder === undefined) return site;
  // {{media_folder}} and {{public_folder}} mean the site-wide ones.
  const inherit = (t: string) =>
    t.replace(/\{\{\s*media_folder\s*\}\}/g, site?.folder.slice(1) ?? "").replace(/\{\{\s*public_folder\s*\}\}/g, site?.publicFolder ?? "");
  return { folder: inherit(folder), publicFolder: inherit(str(raw.public_folder) ?? folder) };
}

export function parseConfig(text: string): SiteConfig {
  const raw = (parseYaml(text) ?? {}) as Raw;
  const backend = (raw.backend ?? {}) as Raw;
  const media = siteMedia(raw);
  return {
    repo: str(backend.repo),
    branch: str(backend.branch),
    siteUrl: str(raw.site_url) ?? str(raw.display_url),
    collections: (Array.isArray(raw.collections) ? (raw.collections as Raw[]) : [])
      .map((c) => parseCollection(c, media))
      .filter((c): c is Collection => !!c),
  };
}

/** Whether a YAML file looks like a CMS config (rather than any other config.yml). */
export function looksLikeCmsConfig(text: string): boolean {
  try {
    const raw = parseYaml(text) as Raw;
    return !!raw && Array.isArray(raw.collections) && typeof raw.backend === "object";
  } catch {
    return false;
  }
}

// --- Values ----------------------------------------------------------------------

/** Form values, keyed by field name. Dates are kept as "YYYY-MM-DD" / "YYYY-MM-DDTHH:mm". */
export type Values = Record<string, unknown>;

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ymdhm = (d: Date) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export const slugify = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Fields the publish form shows (others are kept as they are, or get their defaults). */
export const editable = (f: Field) => !["body", "hidden", "other"].includes(f.kind);

/** A file on this computer chosen for an image field, relative to the document. */
export interface LocalImage {
  local: string;
}

export const isLocalImage = (v: unknown): v is LocalImage =>
  !!v && typeof v === "object" && typeof (v as LocalImage).local === "string" && (v as LocalImage).local !== "";

/** Image fields the user has chosen a file for (not a path already on the site). */
export function localImageChoices(c: Collection, values: Values): { field: string; local: string }[] {
  const out: { field: string; local: string }[] = [];
  for (const f of c.fields) {
    const value = values[f.name];
    if (f.kind === "image" && isLocalImage(value)) out.push({ field: f.name, local: value.local });
  }
  return out;
}

/** A file's name as the site will have it: URL-safe, so the link needs no escaping. */
export function siteImageName(localName: string) {
  const dot = localName.lastIndexOf(".");
  const ext = dot > 0 ? localName.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  const base = slugify(dot > 0 ? localName.slice(0, dot) : localName) || "image";
  return ext ? `${base}.${ext}` : base;
}

/**
 * Name to use in the media folder. Identical bytes keep the name already there;
 * a different file with that name gets `photo-2.png`, then `photo-3.png`.
 */
export function assignImageName(wanted: string, sha: string, existing: Map<string, string>): { name: string; upload: boolean } {
  let name = wanted;
  for (let i = 2; existing.has(name) && existing.get(name) !== sha; i++) name = wanted.replace(/(\.[^.]*)?$/, `-${i}$1`);
  return { name, upload: existing.get(name) !== sha };
}

/** The collection's draft switch, if it has one (a boolean field named "draft"). */
export const draftField = (c: Collection) => c.fields.find((f) => f.name === "draft" && f.kind === "boolean");

/** Starting values for a new entry. Joyce saves drafts unless told otherwise. */
export function defaultValues(c: Collection, title: string, now = new Date()): Values {
  const v: Values = {};
  for (const f of c.fields) {
    if (!editable(f)) continue;
    const d = f.default;
    switch (f.kind) {
      case "date":
        v[f.name] = typeof d === "string" && d !== "{{now}}" ? d.slice(0, 10) : f.required ? ymd(now) : "";
        break;
      case "datetime":
        v[f.name] = typeof d === "string" && d !== "{{now}}" ? d.slice(0, 16) : f.required ? ymdhm(now) : "";
        break;
      case "boolean":
        v[f.name] = f.name === "draft" ? true : d === true;
        break;
      case "list":
        v[f.name] = Array.isArray(d) ? d.map(String) : [];
        break;
      case "select":
        v[f.name] = f.multiple ? (Array.isArray(d) ? d.map(String) : []) : d !== undefined ? String(d) : "";
        break;
      case "number":
        v[f.name] = typeof d === "number" ? String(d) : "";
        break;
      default:
        v[f.name] = d !== undefined ? String(d) : "";
    }
  }
  if (c.fields.some((f) => f.name === c.identifier)) v[c.identifier] = title;
  return v;
}

/** Values for editing an existing entry, from its front matter. */
export function valuesFrom(c: Collection, data: Raw): Values {
  const v = defaultValues(c, "");
  for (const f of c.fields) {
    if (!editable(f) || !(f.name in data)) continue;
    const x = data[f.name];
    switch (f.kind) {
      case "date":
        v[f.name] = x instanceof Date ? ymd(x) : String(x ?? "").slice(0, 10);
        break;
      case "datetime":
        v[f.name] = x instanceof Date ? ymdhm(x) : String(x ?? "").slice(0, 16);
        break;
      case "boolean":
        v[f.name] = x === true;
        break;
      case "list":
        // The CMS writes lists, but hand-written front matter sometimes has one string.
        v[f.name] = Array.isArray(x) ? x.map(String) : x ? [String(x)] : [];
        break;
      case "select":
        v[f.name] = f.multiple ? (Array.isArray(x) ? x.map(String) : []) : String(x ?? "");
        break;
      default:
        v[f.name] = x === null || x === undefined ? "" : String(x);
    }
  }
  return v;
}

/** Formats a form date with the field's moment-style format (the common tokens). */
function formatDate(f: Field, value: string): string {
  if (!f.format) return f.kind === "date" ? value.slice(0, 10) : new Date(value).toISOString();
  const d = new Date(f.kind === "date" ? `${value.slice(0, 10)}T00:00` : value);
  const tokens: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(-2),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    HH: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
  };
  return f.format.replace(/YYYY|YY|MM|DD|HH|mm|ss/g, (t) => tokens[t]);
}

/** The value written to front matter, or undefined to leave the field out. */
function output(f: Field, value: unknown): unknown {
  const empty = value === undefined || value === "" || (Array.isArray(value) && !value.length && !f.required);
  switch (f.kind) {
    case "boolean":
      return value === true;
    case "list":
      return Array.isArray(value) ? value : [];
    case "select":
      return f.multiple ? (Array.isArray(value) ? value : []) : empty ? undefined : String(value);
    case "number": {
      if (empty) return undefined;
      const n = Number(value);
      return Number.isNaN(n) ? undefined : f.valueType === "float" ? n : Math.round(n);
    }
    case "image":
      // A chosen local file is turned into a site path before this runs.
      return typeof value === "string" && value ? value : undefined;
    case "date":
    case "datetime":
      return empty ? undefined : formatDate(f, String(value));
    default:
      return empty ? undefined : String(value);
  }
}

/**
 * Required fields Joyce can't fill in (an audio upload, an image…) that have no
 * default and no value in the existing entry. An entry missing them may fail the
 * site's build, so Joyce won't create one; it can still update an entry made in
 * the CMS, whose values it keeps.
 */
export function unfillable(c: Collection, existing?: Raw): Field[] {
  return c.fields.filter(
    (f) => (f.kind === "other" || f.kind === "hidden") && f.required && f.default === undefined && !(existing && f.name in existing),
  );
}

/** Required fields that are still empty, by label. */
export function missingRequired(c: Collection, values: Values): string[] {
  return c.fields
    .filter((f) => editable(f) && f.required && f.kind !== "boolean")
    .filter((f) => {
      const v = values[f.name];
      return v === undefined || v === "" || (Array.isArray(v) && !v.length && f.kind !== "list");
    })
    .map((f) => f.label);
}

// --- Files --------------------------------------------------------------------------

/**
 * Expands a CMS file-name template: {{slug}}, {{fields.x}} or {{x}}, {{year}},
 * {{month}}, {{day}}, {{hour}}, {{minute}}, {{second}}, {{uuid}}, {{uuid_short}}.
 * Filters (`| lower`…) are ignored; values are made URL-safe.
 */
export function expandTemplate(template: string, c: Collection, values: Values, now = new Date()): string {
  return template.replace(/\{\{\s*([^}|]+?)\s*(?:\|[^}]*)?\}\}/g, (_, key: string) => {
    const k = key.trim();
    const dateParts: Record<string, string> = {
      year: String(now.getFullYear()),
      month: pad(now.getMonth() + 1),
      day: pad(now.getDate()),
      hour: pad(now.getHours()),
      minute: pad(now.getMinutes()),
      second: pad(now.getSeconds()),
    };
    if (k in dateParts) return dateParts[k];
    if (k === "slug") return slugify(String(values[c.identifier] ?? ""));
    if (k === "uuid") return crypto.randomUUID();
    if (k === "uuid_short") return crypto.randomUUID().slice(0, 8);
    const field = k.replace(/^fields\./, "");
    return slugify(String(values[field] ?? ""));
  });
}

/** Repo path for a new entry: folder / (path or slug template) . extension */
export const entryPath = (c: Collection, name: string) => `${c.folder ? `${c.folder}/` : ""}${name}.${c.extension}`;
export const entryName = (c: Collection, values: Values, now = new Date()) =>
  expandTemplate(c.path ?? c.slug, c, values, now).replace(/^\/+|\/+$/g, "");

/** Resolves "." and ".." in a slash-separated path. Null if it climbs out of the root. */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") out.push(part);
    else if (!out.length) return null;
    else out.pop();
  }
  return out.join("/");
}

/**
 * Where an entry's images go: the repo folder to commit them to, and the prefix
 * the Markdown links to them with (e.g. "../../assets/blog/" or "/uploads/").
 * Null if the site's config doesn't say, or says somewhere outside the repo.
 */
export function mediaLocation(c: Collection, entryRepoPath: string, values: Values): { folder: string; prefix: string } | null {
  if (!c.media) return null;
  const file = entryRepoPath.slice(entryRepoPath.lastIndexOf("/") + 1);
  const entryDir = entryRepoPath.slice(0, Math.max(0, entryRepoPath.lastIndexOf("/")));
  const inCollection = c.folder && entryDir.startsWith(c.folder) ? entryDir.slice(c.folder.length).replace(/^\//, "") : "";
  const filename = file.replace(/\.[^.]*$/, "");
  const vars: Record<string, string> = {
    filename,
    extension: c.extension,
    dirname: inCollection,
    // A nested entry (".../{{slug}}/index") is named by its folder.
    slug: c.path && inCollection ? inCollection.split("/").pop()! : filename,
  };
  const expand = (t: string) =>
    t.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k: string) => vars[k] ?? expandTemplate(m, c, values));
  const folder = expand(c.media.folder);
  const repoFolder = normalizePath(folder.startsWith("/") ? folder : `${entryDir}/${folder}`);
  if (repoFolder === null) return null;
  const pub = expand(c.media.publicFolder);
  return { folder: repoFolder, prefix: pub === "" ? "" : `${pub.replace(/\/+$/, "")}/` };
}

/**
 * MDX treats `<` and `{` as JSX. Prose can contain both ("x < y", "{sic}"), so
 * escape them everywhere except inside code, where they're already literal.
 */
export function escapeMdx(body: string): string {
  let inFence = false;
  return body
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, i) => (i % 2 ? part : part.replace(/(?<!\\)([<{}])/g, "\\$1")))
        .join("");
    })
    .join("\n");
}

export function parseEntry(content: string): { data: Raw; body: string } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: content };
  const data = (parseDocument(m[1]).toJS() ?? {}) as Raw;
  return { data, body: content.slice(m[0].length) };
}

/**
 * Builds the entry file: front matter in the collection's field order, then the
 * body. Updating an existing entry keeps every key Joyce doesn't edit (relations,
 * galleries, fields the CMS added) exactly as it was.
 */
export function buildEntry(c: Collection, values: Values, body: string, existing?: string): string {
  const prior = existing ? parseEntry(existing).data : {};
  const data: Raw = {};
  for (const f of c.fields) {
    if (f.kind === "body") continue;
    if (editable(f)) {
      const out = output(f, values[f.name]);
      if (out !== undefined) data[f.name] = out;
    } else if (f.name in prior) {
      data[f.name] = prior[f.name];
    } else if (f.default !== undefined && f.default !== "{{now}}") {
      data[f.name] = f.default;
    }
  }
  // Anything in the old file the config doesn't mention stays, after the known fields.
  for (const [k, v] of Object.entries(prior)) if (!(k in data) && !c.fields.some((f) => f.name === k)) data[k] = v;
  let text = body.trim();
  if (c.extension === "mdx") text = escapeMdx(text);
  return `---\n${stringify(data, { lineWidth: 0 })}---\n\n${text}\n`;
}
