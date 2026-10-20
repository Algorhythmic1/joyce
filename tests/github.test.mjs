import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "vite";

// Load the actual frontend modules through Vite, with the desktop bridge mocked.
// This exercises discovery, persistence and saves without a token or live writes.
let server, gh, state, cms;
let handleApi;
const disk = new Map(), memory = new Map();
const calls = [];
const fixture = readFileSync(new URL("fixtures/pages.yml", import.meta.url), "utf8");
const legacy = "backend: { name: github, repo: owner/blog, branch: publishing }\ncollections:\n- name: posts\n  folder: posts\n  fields:\n  - { name: title, widget: string }\n  - { name: body, widget: markdown }\n";
const encoded = (content, sha = "config-sha") => ({ status: 200, body: { content: Buffer.from(content).toString("base64"), sha } });
const missing = { status: 404, body: {} };

before(async () => {
  globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  globalThis.window = {
    setTimeout: (...args) => setTimeout(...args), addEventListener: () => {},
    __TAURI_INTERNALS__: { invoke: async (command, args) => {
      if (command === "read_file") {
        if (!disk.has(args.path)) throw new Error("Missing");
        return disk.get(args.path);
      }
      if (command === "write_file") { disk.set(args.path, args.contents); return; }
      if (command === "github_api") { calls.push(args); return handleApi(args); }
      throw new Error(`Unexpected desktop command: ${command}`);
    } },
  };
  server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
  gh = await server.ssrLoadModule("/src/integrations/github.ts");
  state = await server.ssrLoadModule("/src/folderState.ts");
  cms = await server.ssrLoadModule("/src/integrations/sveltia.ts");
  await state.bindFolder("/Writing");
});

after(async () => {
  if (state) await state.bindFolder(null);
  if (server) await server.close();
});

function repoApi(files, tree = []) {
  return ({ path }) => {
    if (path === "/repos/owner/blog") return { status: 200, body: { full_name: "owner/blog", default_branch: "main" } };
    if (path.includes("/git/trees/")) return { status: 200, body: { tree: tree.map(path => ({ path, type: "blob" })) } };
    const name = decodeURIComponent(path.split("/contents/")[1]?.split("?")[0] ?? "");
    return files.has(name) ? encoded(files.get(name)) : missing;
  };
}

test("automatic detection finds root .pages.yml even without a tree entry", async () => {
  handleApi = repoApi(new Map([[".pages.yml", fixture]]));
  const { site, config } = await gh.findSite("https://github.com/owner/blog");
  assert.equal(site.cms, "pages");
  assert.equal(site.configPath, ".pages.yml");
  assert.equal(site.branch, "main");
  assert.equal(site.repo, "owner/blog");
  assert.equal(config.collections[0].folder, "content/posts");
});

test("explicit CMS choice supports both configs in one repo with distinct site IDs", async () => {
  handleApi = repoApi(new Map([[".pages.yml", fixture], ["public/admin/config.yml", legacy]]), ["public/admin/config.yml"]);
  const automatic = await gh.findSite("owner/blog");
  assert.equal(automatic.site.cms, "sveltia");
  assert.equal(automatic.site.branch, "publishing");
  calls.length = 0;
  const pages = await gh.findSite("owner/blog", "pages");
  assert.equal(pages.site.cms, "pages");
  assert.notEqual(pages.site.id, automatic.site.id);
  assert.equal(calls.some(call => call.path.includes("/git/trees/")), false);
  assert.equal((await gh.findSite("owner/blog", "sveltia")).site.cms, "sveltia");
});

test("discovery reports missing and invalid Pages configs clearly", async () => {
  handleApi = repoApi(new Map());
  await assert.rejects(gh.findSite("owner/blog", "pages"), /No Pages CMS config/);
  handleApi = repoApi(new Map([[".pages.yml", "content: ["]]));
  await assert.rejects(gh.findSite("owner/blog", "pages"), /Can't read .pages.yml/);
});

test("Pages parser is reused on reload, including stored sites without a CMS marker", async () => {
  const files = new Map([[".pages.yml", fixture]]);
  handleApi = repoApi(files);
  const site = await gh.addSite("owner/blog", "pages");
  assert.equal(gh.getSites().find(s => s.id === site.id).cms, "pages");
  files.set(".pages.yml", fixture.replace("content/posts", "articles"));
  assert.equal((await gh.loadSiteConfig({ ...site, cms: undefined })).collections[0].folder, "articles");
  // A corrupt or deleted config must not silently fall back to a valid cached schema.
  files.set(".pages.yml", "content: {}");
  await assert.rejects(gh.loadSiteConfig(site), /valid Pages CMS config/);
  files.delete(".pages.yml");
  await assert.rejects(gh.loadSiteConfig(site), /config.*gone/);
});

test("Pages saves create and update entries, skip identical content and refuse external edits", async () => {
  const files = new Map([[".pages.yml", fixture]]);
  handleApi = repoApi(files);
  const { site, config } = await gh.findSite("owner/blog", "pages");
  const collection = config.collections[0];
  const values = cms.defaultValues(collection, "Hello Pages", new Date(2026, 9, 11));
  const name = cms.entryName(collection, values, new Date(2026, 9, 11));
  const req = { site, collection, values, name, title: "Hello Pages" };
  let remote, writes = 0;
  handleApi = ({ method, path, body }) => {
    assert.equal(path.split("?")[0], "/repos/owner/blog/contents/content/posts/2026-10-11-hello-pages.md");
    if (method === "GET") return remote ? encoded(remote.content, remote.sha) : missing;
    assert.equal(method, "PUT");
    assert.equal(body.branch, "main");
    if (remote) assert.equal(body.sha, remote.sha);
    remote = { content: Buffer.from(body.content, "base64").toString("utf8"), sha: `saved-${++writes}` };
    return { status: 201, body: { content: { sha: remote.sha }, commit: { html_url: "https://github.com/owner/blog/commit/123" } } };
  };
  const first = await gh.saveEntry("/Writing/Post.md", "# Hello Pages\n\n**Markdown** body.", req);
  assert.equal(first.path, "content/posts/2026-10-11-hello-pages.md");
  assert.equal(cms.parseEntry(remote.content).data.title, "Hello Pages");
  assert.ok(!cms.parseEntry(remote.content).body.includes("# Hello Pages"));
  await gh.saveEntry("/Writing/Post.md", "# Hello Pages\n\n**Markdown** body.", req);
  assert.equal(writes, 1);
  await gh.saveEntry("/Writing/Post.md", "# Hello Pages\n\nUpdated body.", req);
  assert.equal(writes, 2);
  remote = { content: remote.content.replace("Updated body.", "CMS edit."), sha: "external-edit" };
  await assert.rejects(gh.saveEntry("/Writing/Post.md", "# Hello Pages\n\nLocal edit.", req), error => error instanceof gh.SaveConflict && error.kind === "changed");
  assert.equal(writes, 2);
  await assert.rejects(gh.saveEntry("/Writing/Another.md", "# Hello Pages\n\nOther body.", req), error => error instanceof gh.SaveConflict && error.kind === "exists");
  assert.equal(writes, 2);
  await gh.saveEntry("/Writing/Post.md", "# Hello Pages\n\nApproved edit.", req, { overwrite: true });
  assert.equal(writes, 3);
  assert.equal(gh.getLink("/Writing/Post.md").sha, "saved-3");
});

test("unsupported collections, invalid new paths, required images and pasted images block writes", async () => {
  handleApi = repoApi(new Map([[".pages.yml", fixture]]));
  const { site, config } = await gh.findSite("owner/blog", "pages");
  const collection = config.collections[0], values = cms.defaultValues(collection, "Post");
  const req = { site, collection, values, name: "post", title: "Post" };
  const save = (changes = {}, body = "Body") => gh.saveEntry("/Writing/Blocked.md", body, { ...req, ...changes });
  calls.length = 0;
  await assert.rejects(save({ collection: { ...collection, unsupported: "Unsupported format" } }), /Unsupported format/);
  await assert.rejects(save({ name: "../elsewhere" }), /collection's folder/);
  await assert.rejects(save({}, "![Pasted](assets/pic.png)"), /can't upload/);
  assert.equal(calls.length, 0);
  const withRequiredImage = { ...collection, fields: collection.fields.map(f => f.name === "cover" ? { ...f, required: true } : f) };
  await assert.rejects(save({ collection: withRequiredImage }), /need cover/);
  assert.equal(calls.every(call => call.method === "GET"), true);
});

test("Pages collections without a separate title field keep the document's heading", async () => {
  const bodyConfig = "content:\n- name: pages\n  type: collection\n  path: docs\n  filename: article.md\n  fields:\n  - { name: body, type: rich-text }\n";
  handleApi = repoApi(new Map([[".pages.yml", bodyConfig]]));
  const { site, config } = await gh.findSite("owner/blog", "pages");
  const collection = config.collections[0];
  let content;
  handleApi = ({ method, body }) => {
    if (method === "GET") return missing;
    content = Buffer.from(body.content, "base64").toString("utf8");
    return { status: 201, body: { content: { sha: "body-post" }, commit: { html_url: "https://github.com/owner/blog/commit/body" } } };
  };
  await gh.saveEntry("/Writing/BodyOnly.md", "# Keep this heading\n\nBody", { site, collection, values: {}, name: "article", title: "Keep this heading" });
  assert.match(cms.parseEntry(content).body, /# Keep this heading/);
  assert.deepEqual(cms.parseEntry(content).data, {});
});
