import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePagesConfig, looksLikePagesConfig } from "../src/integrations/pages.ts";
import { parseConfig, defaultValues, entryName, entryPath, buildEntry, parseEntry, unfillable, valuesFrom, missingRequired, mediaLocation } from "../src/integrations/sveltia.ts";

const fixture = readFileSync(new URL("fixtures/pages.yml", import.meta.url), "utf8");
const now = new Date(2026, 9, 11, 14, 35, 7);
const collection = (extra = "", fields = "    - { name: title, type: string }\n    - { name: body, type: rich-text }") => parsePagesConfig(
  `content:\n- name: posts\n  type: collection\n  path: content/posts\n${extra}  fields:\n${fields}\n`,
).collections[0];

test("Pages config maps fields into the existing entry form with optional fields by default", () => {
  const c = parsePagesConfig(fixture).collections[0];
  assert.equal(c.unsupported, undefined);
  assert.equal(c.identifier, "title");
  assert.equal(c.folder, "content/posts");
  assert.deepEqual(c.fields.map(f => [f.name, f.kind, f.required]), [
    ["title", "string", true], ["date", "date", false], ["draft", "boolean", false],
    ["tags", "list", false], ["category", "select", false], ["excerpt", "text", false],
    ["cover", "image", false], ["body", "body", false],
  ]);
  assert.equal(c.fields.find(f => f.name === "excerpt").label, "Description");
  assert.deepEqual(c.fields.find(f => f.name === "category").options, [
    { value: "news", label: "News" }, { value: "essays", label: "Essays" },
  ]);
  const values = defaultValues(c, "Café & conversation", now);
  assert.equal(values.date, "2026-10-11");
  assert.equal(values.draft, true);
  assert.equal(entryPath(c, entryName(c, values, now)), "content/posts/2026-10-11-cafe-conversation.md");
  assert.deepEqual(unfillable(c), []);
  assert.deepEqual(missingRequired(c, { ...values, title: "" }), ["title"]);
});

test("media sources decide where pasted and chosen images go, linked the way Pages links them", () => {
  const where = (c, field) => mediaLocation(c, "content/posts/hello.md", {}, field && c.fields.find(f => f.name === field));
  // A folder name is linked as "/name".
  const short = collection("", "    - { name: cover, type: image }\n    - { name: body, type: rich-text }");
  assert.equal(short.media, undefined);
  const named = parsePagesConfig("media: public/media/\ncontent:\n- { name: posts, type: collection, path: content/posts, fields: [{ name: body, type: rich-text }] }\n").collections[0];
  assert.deepEqual(where(named), { folder: "public/media", prefix: "/public/media/" });
  // The fixture's single source: committed under public/images, linked as /images.
  const fixed = parsePagesConfig(fixture).collections[0];
  assert.deepEqual(where(fixed), { folder: "public/images", prefix: "/images/" });
  assert.deepEqual(where(fixed, "cover"), { folder: "public/images", prefix: "/images/" });

  const sources = `media:
- { name: images, input: /static/images/, output: / }
- { name: heroes, input: static/heroes, output: /heroes }
content:
- name: posts
  type: collection
  path: content/posts
  fields:
  - { name: hero, type: image, options: { media: heroes } }
  - { name: thumb, type: image, options: { path: static/images/thumbs } }
  - { name: outside, type: image, options: { path: elsewhere } }
  - { name: gallery, type: image, options: { multiple: { max: 6 } } }
  - { name: off, type: image, options: { media: false } }
  - { name: lost, type: image, options: { media: nowhere } }
  - { name: body, type: rich-text, options: { media: heroes } }
`;
  const c = parsePagesConfig(sources).collections[0];
  assert.deepEqual(c.fields.map(f => [f.name, f.kind]), [
    ["hero", "image"], ["thumb", "image"], ["outside", "image"], ["gallery", "other"], ["off", "other"], ["lost", "other"], ["body", "body"],
  ]);
  // The body's own media source takes pasted images; each image field uses its own.
  assert.deepEqual(where(c), { folder: "static/heroes", prefix: "/heroes/" });
  assert.deepEqual(where(c, "hero"), { folder: "static/heroes", prefix: "/heroes/" });
  // A path inside the source keeps its place under the output; output "/" links from the root.
  assert.deepEqual(where(c, "thumb"), { folder: "static/images/thumbs", prefix: "/thumbs/" });
  // A path outside the source can't be linked, so the source's own folder is used.
  assert.deepEqual(where(c, "outside"), { folder: "static/images", prefix: "/" });
});

test("Pages filenames include their extension and honor primary, aliases, field and time tokens", () => {
  const c = collection(`  view: { primary: headline }\n  filename:\n    template: "{primary}/{slug}-{fields.section}-{section}-{hour}{minute}{second}.mdx"\n    field: create\n`,
    "    - { name: headline, type: string }\n    - { name: section, type: string }\n    - { name: body, type: rich-text }");
  assert.equal(c.unsupported, undefined);
  assert.equal(c.identifier, "headline");
  assert.equal(entryPath(c, entryName(c, { headline: "A title", section: "World News" }, now)),
    "content/posts/a-title/a-title-world-news-world-news-143507.mdx");
  assert.equal(collection().slug, "{{year}}-{{month}}-{{day}}-{{slug}}");
  const first = collection("", "    - { name: heading, type: string }\n    - { name: body, type: text }");
  assert.equal(first.identifier, "heading");
});

test("new entries serialize typed values and a Markdown body in field order", () => {
  const c = parsePagesConfig(fixture).collections[0];
  const values = { ...defaultValues(c, "Hello", now), tags: ["one", "two"], category: "news", excerpt: "A summary" };
  const content = buildEntry(c, values, "Markdown **body**.");
  const parsed = parseEntry(content);
  assert.deepEqual(parsed.data, {
    title: "Hello", date: "2026-10-11", draft: true, tags: ["one", "two"], category: "news", excerpt: "A summary",
  });
  assert.match(parsed.body, /^\nMarkdown \*\*body\*\*\.\n$/);
  assert.deepEqual(Object.keys(parsed.data), ["title", "date", "draft", "tags", "category", "excerpt"]);
});

test("image, object, hidden, readonly and unknown metadata survive an update when there's no media to upload to", () => {
  const c = collection("", `    - { name: title, type: string }\n    - { name: cover, type: image, required: true }\n    - { name: seo, type: object }\n    - { name: locked, type: string, readonly: true }\n    - { name: private, type: string, hidden: true, default: secret }\n    - { name: body, type: rich-text }`);
  assert.deepEqual(unfillable(c).map(f => f.name), ["cover"]);
  const old = "---\ntitle: Old\ncover: /images/photo.png\nseo:\n  description: Keep this\nlocked: Fixed\nprivate: Original\nextra: Keep me\n---\n\nOld body\n";
  assert.deepEqual(unfillable(c, parseEntry(old).data), []);
  const updated = parseEntry(buildEntry(c, { title: "New", locked: "Ignore", private: "Ignore" }, "New body", old));
  assert.deepEqual(updated.data, { title: "New", cover: "/images/photo.png", seo: { description: "Keep this" }, locked: "Fixed", private: "Original", extra: "Keep me" });
});

test("Pages date-fns formatting round-trips into form dates and preserves literal tokens", () => {
  const c = collection("", `    - { name: title, type: string }\n    - name: date\n      type: date\n      options: { format: 'dd/MM/yyyy' }\n    - name: scheduled\n      type: date\n      default: ''\n      options: { time: true, format: "yyyy-MM-dd'T'HH:mm" }\n    - { name: body, type: rich-text }`);
  assert.equal(defaultValues(c, "Post", now).scheduled, "");
  const parsed = parseEntry(buildEntry(c, { title: "Post", date: "2026-10-11", scheduled: "2026-10-12T14:35" }, "Body"));
  assert.equal(parsed.data.date, "11/10/2026");
  assert.equal(parsed.data.scheduled, "2026-10-12T14:35");
  const values = valuesFrom(c, parsed.data);
  assert.equal(values.date, "2026-10-11");
  assert.equal(values.scheduled, "2026-10-12T14:35");
});

test("string lists are editable while repeated objects and dates retain their structure", () => {
  const c = collection("", `    - { name: tags, type: string, list: { min: 1 } }\n    - { name: objects, type: object, list: true }\n    - { name: dates, type: date, list: true }\n    - { name: rating, type: number }\n    - { name: body, type: rich-text }`);
  assert.deepEqual(c.fields.map(f => f.kind), ["list", "other", "other", "number", "body"]);
  const data = parseEntry(buildEntry(c, { tags: ["hi"], rating: "4.5" }, "Body", "---\nobjects: [{x: 1}]\ndates: [2026-10-11]\n---\nOld")).data;
  assert.equal(data.rating, 4.5);
  assert.deepEqual(data.objects, [{ x: 1 }]);
  assert.deepEqual(data.dates, ["2026-10-11"]);
});

test("nested content groups and chained field components are resolved", () => {
  const config = parsePagesConfig(`components:\n  heading: { type: string, required: true }\n  title: { component: heading, label: Title }\ncontent:\n- type: group\n  name: docs\n  items:\n  - type: group\n    name: nested\n    items:\n    - name: pages\n      type: collection\n      path: docs\n      fields:\n      - { name: title, component: title, label: Heading }\n      - { name: body, type: rich-text }\n`);
  assert.equal(config.collections.length, 1);
  assert.equal(config.collections[0].fields[0].required, true);
  assert.equal(config.collections[0].fields[0].label, "Heading");
});

test("unsupported file formats, body shapes, paths and disabled creation are explained", () => {
  for (const [extra, fields, reason] of [
    ["  type: file\n", undefined, /fixed file/],
    ["  filename: '{primary}.json'\n", undefined, /not Markdown/],
    ["  format: toml-frontmatter\n", undefined, /toml-frontmatter/],
    ["  delimiters: +++\n", undefined, /custom front matter/],
    ["  operations: { create: false }\n", undefined, /new entries/],
    ["", "    - { name: title, type: string }", /body field/],
    ["", "    - { name: body, type: rich-text, options: { format: html } }", /body field/],
    ["  filename: '../{primary}.md'\n", undefined, /relative path/],
    ["  filename: '{unknown}.md'\n", undefined, /unknown field/],
    ["  filename: '{primary}/index.md'\n  subfolders: false\n", undefined, /subfolders/],
  ]) {
    // Replace instead of repeating a YAML key when testing a single file.
    const c = extra.includes("type: file") ? parsePagesConfig("content:\n- name: site\n  type: file\n  path: index.md\n").collections[0] : collection(extra, fields);
    assert.match(c.unsupported, reason);
  }
});

test("malformed configs and missing or circular components fail clearly", () => {
  for (const input of ["hello", "[]", "content: {}", "content: ["]) assert.equal(looksLikePagesConfig(input), false);
  assert.equal(looksLikePagesConfig(fixture), true);
  assert.throws(() => parsePagesConfig("content: {}"), /content list/);
  assert.throws(() => collection("", "    - { name: title, component: missing }"), /missing/);
  assert.throws(() => parsePagesConfig("components:\n  a: { component: b }\n  b: { component: a }\ncontent:\n- name: posts\n  type: collection\n  path: posts\n  fields:\n  - {name: title, component: a}\n"), /circular/);
});

test("Sveltia filenames, required defaults and Moment date formats still work", () => {
  const c = parseConfig("backend: { name: github, repo: owner/site }\ncollections:\n- name: posts\n  folder: posts\n  slug: '{{year}}-{{slug}}'\n  fields:\n  - { name: title, widget: string }\n  - { name: date, widget: date, format: 'YYYY/MM/DD' }\n  - { name: body, widget: markdown }\n").collections[0];
  assert.ok(c.fields[0].required);
  const values = defaultValues(c, "Legacy site", now);
  assert.equal(entryPath(c, entryName(c, values, now)), "posts/2026-legacy-site.md");
  assert.equal(parseEntry(buildEntry(c, values, "Body")).data.date, "2026/10/11");
});

test("a date or list primary field retains its type instead of taking the document heading", () => {
  const c = collection("", "    - { name: date, type: date }\n    - { name: body, type: rich-text }");
  assert.equal(c.identifier, "date");
  assert.equal(defaultValues(c, "Heading", now).date, "2026-10-11");
  const tags = collection("", "    - { name: tags, type: string, list: true }\n    - { name: body, type: rich-text }");
  assert.deepEqual(defaultValues(tags, "Heading", now).tags, []);
});
