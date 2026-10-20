import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignImageName, buildEntry, defaultValues, editable, localImageChoices, mediaLocation, missingRequired,
  parseConfig, siteImageName, unfillable, valuesFrom,
} from "../src/integrations/sveltia.ts";

// The shape of the Bickerstaff collections: a hero (or cover) is one image, stored
// with the collection's other images. Audio uploads and galleries stay with the CMS.
const configText = `
backend: { name: github, repo: example/site, branch: master }
media_folder: public/uploads
public_folder: /uploads
collections:
  - name: blog
    label: Blog
    folder: src/content/blog
    extension: mdx
    format: frontmatter
    media_folder: ../../assets/blog
    public_folder: ../../assets/blog
    fields:
      - { name: title, label: Title, widget: string }
      - { name: heroImage, label: Hero image, widget: image, required: false }
      - { name: heroImageAlt, label: Hero image alt text, widget: string, required: false }
      - { name: draft, label: Draft, widget: boolean, default: false }
      - { name: body, label: Body, widget: markdown }
  - name: podcast
    label: Podcast
    folder: src/content/podcast
    extension: mdx
    media_folder: /src/assets/podcast
    public_folder: ../../assets/podcast
    fields:
      - { name: title, label: Title, widget: string }
      - { name: audioKey, label: Audio, widget: r2-audio }
      - { name: coverImage, label: Episode cover image, widget: image, required: false }
      - { name: gallery, label: Gallery, widget: image, multiple: true, required: false }
      - { name: banner, label: Banner, widget: image, media_folder: /src/assets/banners, required: false }
      - { name: body, label: Show notes, widget: markdown }
`;

const config = parseConfig(configText);
const blog = config.collections.find((c) => c.name === "blog");
const podcast = config.collections.find((c) => c.name === "podcast");

test("a hero image is a field Joyce can set, and goes where the collection's images go", () => {
  assert.equal(blog.fields.find((f) => f.name === "heroImage").kind, "image");
  assert.equal(editable(blog.fields.find((f) => f.name === "heroImage")), true);
  assert.deepEqual(unfillable(blog).map((f) => f.name), []);
  const where = mediaLocation(blog, "src/content/blog/shore.mdx", { title: "Shore" });
  assert.deepEqual(where, { folder: "src/assets/blog", prefix: "../../assets/blog/" });
});

test("a cover image works the same way; galleries, private folders and other uploads do not", () => {
  const kind = (name) => podcast.fields.find((f) => f.name === name).kind;
  assert.equal(kind("coverImage"), "image");
  assert.equal(kind("gallery"), "other");
  assert.equal(kind("banner"), "other");
  assert.equal(kind("audioKey"), "other");
  assert.deepEqual(unfillable(podcast).map((f) => f.name), ["audioKey"]);
  assert.deepEqual(missingRequired(podcast, { ...defaultValues(podcast, "Ep"), coverImage: "" }).includes("Audio"), false);
  assert.equal(missingRequired(blog, { title: "Shore", heroImage: "" }).includes("Hero image"), false);
});

test("a required image must be chosen, and is no longer a reason to send the user to the CMS", () => {
  const text = configText.replace("heroImage, label: Hero image, widget: image, required: false", "heroImage, label: Hero image, widget: image");
  const required = parseConfig(text).collections[0];
  assert.deepEqual(missingRequired(required, { title: "Shore", heroImage: "" }), ["Hero image"]);
  assert.deepEqual(missingRequired(required, { title: "Shore", heroImage: { local: "assets/shore.png" } }), []);
  assert.deepEqual(unfillable(required).map((f) => f.name), []);
});

test("the entry keeps a site path, drops a cleared hero, and does not write a local file into front matter", () => {
  const values = { ...defaultValues(blog, "Shore"), heroImage: "../../assets/blog/shore.png", heroImageAlt: "The shore" };
  const built = buildEntry(blog, values, "The water.");
  assert.match(built, /^heroImage: \.\.\/\.\.\/assets\/blog\/shore\.png$/m);
  assert.match(built, /^heroImageAlt: The shore$/m);
  assert.doesNotMatch(buildEntry(blog, { ...values, heroImage: "" }, "The water."), /^heroImage:/m);
  assert.doesNotMatch(buildEntry(blog, { ...values, heroImage: { local: "assets/shore.png" } }, "The water."), /^heroImage:/m);

  const again = valuesFrom(blog, { heroImage: "../../assets/blog/shore.png", title: "Shore" });
  assert.equal(again.heroImage, "../../assets/blog/shore.png");
});

test("an existing hero is replaced when the user chooses one, and kept when they don't edit it", () => {
  const existing = "---\nheroImage: ../../assets/blog/old.png\ntitle: Shore\n---\n\nBody.\n";
  const replaced = buildEntry(blog, { title: "Shore", heroImage: "../../assets/blog/new.png" }, "Body.", existing);
  assert.match(replaced, /heroImage: \.\.\/\.\.\/assets\/blog\/new\.png/);
  assert.doesNotMatch(replaced, /old\.png/);
  const kept = buildEntry(blog, valuesFrom(blog, { heroImage: "../../assets/blog/old.png", title: "Shore" }), "Body.", existing);
  assert.match(kept, /heroImage: \.\.\/\.\.\/assets\/blog\/old\.png/);
  const cleared = buildEntry(blog, { title: "Shore", heroImage: "" }, "Body.", existing);
  assert.doesNotMatch(cleared, /^heroImage:/m);
});

test("chosen images are the local files, and site paths are not uploaded again", () => {
  const values = { heroImage: { local: "assets/shore.png" }, heroImageAlt: "The shore", title: "Shore" };
  assert.deepEqual(localImageChoices(blog, values), [{ field: "heroImage", local: "assets/shore.png" }]);
  assert.deepEqual(localImageChoices(blog, { ...values, heroImage: "../../assets/blog/shore.png" }), []);
  assert.deepEqual(localImageChoices(podcast, { coverImage: { local: "assets/cover.png" }, audioKey: "episodes/1.mp3" }), [
    { field: "coverImage", local: "assets/cover.png" },
  ]);
});

test("image names are URL-safe, and a different file with the same name is numbered", () => {
  assert.equal(siteImageName("My Photo.PNG"), "my-photo.png");
  assert.equal(siteImageName("shore.png"), "shore.png");
  const existing = new Map([["shore.png", "aaa"]]);
  assert.deepEqual(assignImageName("shore.png", "aaa", existing), { name: "shore.png", upload: false });
  assert.deepEqual(assignImageName("shore.png", "bbb", existing), { name: "shore-2.png", upload: true });
  existing.set("shore-2.png", "ccc");
  assert.deepEqual(assignImageName("shore.png", "bbb", existing), { name: "shore-3.png", upload: true });
  existing.set("shore-2.png", "bbb");
  assert.deepEqual(assignImageName("shore.png", "bbb", existing), { name: "shore-2.png", upload: false });
});
