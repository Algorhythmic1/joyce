import { parse as parseYaml } from "yaml";
import type { Collection, Field, SiteConfig } from "./sveltia";

/* Pages CMS describes repo content in .pages.yml. Normalize its schema into
 * the same collections used by Joyce's entry form and GitHub publisher. */
type Raw = Record<string, unknown>;
const object = (v: unknown): Raw => v && typeof v === "object" && !Array.isArray(v) ? v as Raw : {};
const str = (v: unknown) => typeof v === "string" ? v : undefined;
const records = (v: unknown): Raw[] => Array.isArray(v) ? v.map(object) : [];

function resolveField(raw: Raw, components: Raw, seen = new Set<string>()): Raw {
  const name = str(raw.component);
  if (!name) return raw;
  if (seen.has(name)) throw new Error(`Pages CMS component “${name}” has a circular reference.`);
  if (!components[name]) throw new Error(`Pages CMS component “${name}” is missing.`);
  const base = resolveField(object(components[name]), components, new Set([...seen, name]));
  return { ...base, ...raw, type: base.type, options: { ...object(base.options), ...object(raw.options) } };
}

function parseField(raw: Raw): Field {
  const name = String(raw.name);
  const type = str(raw.type) ?? "unknown";
  const options = object(raw.options);
  const f: Field = {
    name,
    label: str(raw.label) ?? name,
    widget: type,
    kind: "other",
    required: raw.required === true,
    default: raw.default,
    hint: str(raw.description),
  };
  // Repeated strings are tags; other repeated types must retain their shape.
  if (raw.list === true || (raw.list && typeof raw.list === "object")) {
    f.kind = type === "string" || type === "text" ? "list" : "other";
  } else {
    switch (type) {
      case "string": case "text": case "boolean":
        f.kind = type;
        break;
      case "rich-text":
        f.kind = options.format === "html" ? "other" : "text";
        break;
      case "number":
        f.kind = "number";
        f.valueType = "float";
        break;
      case "date":
        f.kind = options.time === true ? "datetime" : "date";
        f.format = str(options.format);
        f.formatStyle = "date-fns";
        f.default = raw.default ?? "{{now}}";
        break;
      case "select":
        if (Array.isArray(options.values)) {
          f.kind = "select";
          f.options = options.values.map((value) => {
            const option = object(value);
            const v = typeof value === "object" ? String(option.name ?? option.value ?? "") : String(value);
            return { value: v, label: str(option.label) ?? v };
          });
          f.multiple = options.multiple === true;
        }
        break;
    }
  }
  // Hidden/readonly fields retain remote data or defaults, even scalar fields.
  if (raw.hidden === true || raw.readonly === true) {
    f.kind = "other";
    f.default = raw.default;
  }
  else if (name === "body" && ["string", "text", "rich-text", "code"].includes(type) && !raw.list && options.format !== "html") {
    f.kind = "body";
  }
  return f;
}

function parseCollection(raw: Raw, components: Raw): Collection | null {
  if (!str(raw.name)) return null;
  const fields = records(raw.fields).filter((f) => str(f.name)).map((f) => resolveField(f, components));
  const filename = str(raw.filename) ?? str(object(raw.filename).template) ?? "{year}-{month}-{day}-{primary}.md";
  const extension = filename.match(/\.([a-z0-9]+)$/i)?.[1] ?? "";
  const template = extension ? filename.slice(0, -(extension.length + 1)) : filename;
  const identifier = str(object(raw.view).primary) ?? (fields.some((f) => f.name === "title") ? "title" : str(fields[0]?.name) ?? "title");
  const c: Collection = {
    name: String(raw.name),
    label: str(raw.label) ?? String(raw.name),
    labelSingular: str(raw.label) ?? String(raw.name),
    folder: (str(raw.path) ?? "").replace(/^\/+|\/+$/g, "").replace(/^\.\//, ""),
    extension,
    // Pages uses single braces; {primary} and {slug} both refer to view.primary.
    slug: template.replace(/\{([^{}]+)\}/g, (_, token: string) => `{{${token === "primary" ? "slug" : token}}}`),
    identifier,
    fields: fields.map(parseField),
  };
  const format = str(raw.format) ?? "yaml-frontmatter";
  const delimiters = raw.delimiters;
  if (raw.type !== "collection") c.unsupported = "It's a fixed file, not a folder of entries.";
  else if (!c.folder || c.folder.split("/").some((p) => p === ".." || p === ".")) c.unsupported = "It doesn't have a valid repository folder.";
  else if (!["md", "mdx", "markdown"].includes(extension)) c.unsupported = `Its entries are ${extension ? `.${extension}` : "extensionless"} files, not Markdown.`;
  else if (format !== "yaml-frontmatter") c.unsupported = `Its entries use ${format}, which Joyce doesn't write yet.`;
  else if (delimiters !== undefined && delimiters !== "---" && !(Array.isArray(delimiters) && delimiters.length === 2 && delimiters.every((d) => d === "---"))) {
    c.unsupported = "Its entries use custom front matter delimiters, which Joyce doesn't write yet.";
  } else if (object(raw.operations).create === false) c.unsupported = "The site doesn't allow new entries in it.";
  else if (!c.fields.some((f) => f.kind === "body")) c.unsupported = "It doesn't have an editable Markdown body field.";
  else if (/[{}]/.test(template.replace(/\{[^{}]+\}/g, "")) || template.split("/").some((p) => p === ".." || p === ".") || template.startsWith("/")) {
    c.unsupported = "Its filename template isn't a valid relative path.";
  } else if (raw.subfolders === false && template.includes("/")) c.unsupported = "Its filename template uses folders, but subfolders are disabled.";
  else {
    const tokens = [...template.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
    const reserved = ["primary", "slug", "year", "month", "day", "hour", "minute", "second"];
    const unknown = tokens.find((t) => !reserved.includes(t) && !fields.some((f) => f.name === t.replace(/^fields\./, "")));
    if (unknown) c.unsupported = `Its filename template refers to an unknown field: ${unknown}.`;
  }
  return c;
}

export function looksLikePagesConfig(text: string): boolean {
  try {
    return Array.isArray(object(parseYaml(text)).content);
  } catch {
    return false;
  }
}

export function parsePagesConfig(text: string): SiteConfig {
  const raw = object(parseYaml(text));
  if (!Array.isArray(raw.content)) throw new Error("The Pages CMS config must define a content list.");
  const components = object(raw.components);
  const flatten = (entries: unknown): Raw[] => records(entries).flatMap((entry) =>
    entry.type === "group" ? flatten(entry.items) : [entry],
  );
  return {
    collections: flatten(raw.content).map((entry) => parseCollection(entry, components)).filter((c): c is Collection => c !== null),
  };
}
