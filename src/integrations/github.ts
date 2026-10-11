import { invoke } from "@tauri-apps/api/core";
import { basename, dirname, isTauri, slugify, storage } from "../fs";
import { FolderStore, dropKeys, rekey, toRel } from "../folderState";
import {
  assignImageName, buildEntry, entryPath, isLocalImage, localImageChoices, looksLikeCmsConfig, mediaLocation, normalizePath,
  parseConfig, parseEntry, siteImageName, unfillable,
  type Collection, type SiteConfig, type Values,
} from "./sveltia";

/*
 * Publishing documents as entries on sites managed with Sveltia CMS (or
 * Decap/Netlify CMS): sites keep their content in GitHub, and describe their
 * content types in an `admin/config.yml`. Joyce reads that config, so any such
 * site works without set-up beyond naming its repository.
 */

/** A site Joyce can publish to. */
export interface Site {
  id: string;
  name: string;
  /** Repository the content lives in, from the config's `backend.repo`. */
  repo: string;
  branch: string;
  /** Where the CMS config lives (it can be a different repo in principle). */
  configRepo: string;
  configPath: string;
  siteUrl?: string;
}

/** What Joyce remembers about a document's entry on a site, keyed by the document's path. */
export interface Link {
  site: string;
  collection: string;
  values: Values;
  /** Repo-relative path of the entry, once saved. */
  path?: string;
  /** Blob SHA Joyce last wrote; used to notice edits made elsewhere (e.g. in the CMS). */
  sha?: string;
  savedAt?: number;
  commitUrl?: string;
  repo?: string;
  branch?: string;
}

interface GithubState {
  sites: Site[];
  /** Client ID of a GitHub OAuth app with Device Flow enabled, for "Sign in with GitHub". */
  clientId: string;
  links: Record<string, Link>;
}

const FALLBACK: GithubState = { sites: [], clientId: "", links: {} };

// Before sites were read from CMS configs, Joyce had one hard-coded target
// (the Bickerstaff blog). Those settings and post links carry over.
interface OldTarget {
  repo?: string;
  branch?: string;
  author?: string;
  clientId?: string;
}
interface OldLink {
  fields?: Record<string, unknown> & { slug?: string };
  repo?: string;
  branch?: string;
  path?: string;
  sha?: string;
  savedAt?: number;
  commitUrl?: string;
}

function migrate(target: OldTarget | undefined, links: Record<string, OldLink>): GithubState {
  const repo = target?.repo ?? "AlgorhythmicIndustries/bickerstaff-media-site";
  const site: Site = {
    id: slugify(repo),
    name: "Bickerstaff Media",
    repo,
    branch: target?.branch ?? "master",
    configRepo: repo,
    configPath: "", // Found on first use.
  };
  const converted = Object.fromEntries(
    Object.entries(links).map(([path, l]) => {
      const { slug: _slug, ...values } = l.fields ?? {};
      const link: Link = { site: site.id, collection: "blog", values, path: l.path, sha: l.sha, savedAt: l.savedAt, commitUrl: l.commitUrl, repo: l.repo, branch: l.branch };
      return [path, link];
    }),
  );
  return { sites: [site], clientId: target?.clientId ?? "", links: converted };
}

const store = new FolderStore<GithubState>({
  file: "github.json",
  fallback: FALLBACK,
  parse: (raw) => {
    const r = (raw ?? {}) as Partial<GithubState> & { target?: OldTarget };
    if (!r.sites && r.target) return migrate(r.target, (r.links ?? {}) as Record<string, OldLink>);
    return { sites: r.sites ?? [], clientId: r.clientId ?? "", links: r.links ?? {} };
  },
  legacy: () => {
    try {
      const target = localStorage.getItem("joyce:github-target");
      const old = JSON.parse(localStorage.getItem("joyce:github-links") ?? "{}") as Record<string, OldLink>;
      const links = Object.fromEntries(
        Object.entries(old).flatMap(([abs, l]) => {
          const rel = toRel(abs);
          return rel ? [[rel, l] as const] : [];
        }),
      );
      return target || Object.keys(links).length ? migrate(target ? JSON.parse(target) : undefined, links) : null;
    } catch {
      return null;
    }
  },
});

export const available = isTauri;

export const getSites = () => store.get().sites;
export const subscribeSites = store.subscribe;
export const getClientId = () => store.get().clientId;
export const setClientId = (clientId: string) => store.set({ ...store.get(), clientId });

function updateSite(site: Site) {
  const sites = store.get().sites;
  store.set({ ...store.get(), sites: sites.some((s) => s.id === site.id) ? sites.map((s) => (s.id === site.id ? site : s)) : [...sites, site] });
}

export function removeSite(id: string) {
  store.set({ ...store.get(), sites: store.get().sites.filter((s) => s.id !== id) });
}

const links = () => store.get().links;
const saveLinks = (next: Record<string, Link>) => store.set({ ...store.get(), links: next });

export const getLink = (localPath: string): Link | undefined => {
  const rel = toRel(localPath);
  return rel ? links()[rel] : undefined;
};

export function setLink(localPath: string, link: Link) {
  const rel = toRel(localPath);
  if (rel) saveLinks({ ...links(), [rel]: link });
}

/** Keeps links attached when a document, or a folder containing documents, is renamed. */
export function moveLinks(from: string, to: string) {
  const [a, b] = [toRel(from), toRel(to)];
  if (a && b) saveLinks(rekey(links(), a, b));
}

export function forgetLinks(path: string) {
  const rel = toRel(path);
  if (rel) saveLinks(dropKeys(links(), rel));
}

// --- Converting a document into an entry -----------------------------------------

/** A leading `# Heading` is the entry's title; the site renders the title itself. */
export function splitTitle(text: string): { title: string | null; body: string } {
  const m = text.match(/^\s*#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/);
  if (!m) return { title: null, body: text };
  return { title: m[1].trim(), body: text.slice(m[0].length).replace(/^\s*\n/, "") };
}

/** Markdown images: alt text, then the link (bare or in <angle brackets>), then an optional title. */
const IMAGE = /(!\[[^\]]*\]\(\s*)(<[^>]*>|[^)\s]+)((?:\s+(?:"[^"]*"|'[^']*'))?\s*\))/g;

/**
 * Images the document links to on this computer (pasted ones, in its assets
 * folder), as written in the Markdown. Web addresses and site paths ("/uploads/…")
 * aren't local; nor are links already pointing into the site's media folder.
 */
export function localImages(body: string, sitePrefix = ""): string[] {
  const refs = [...body.matchAll(IMAGE)].map((m) => m[2]);
  return [
    ...new Set(
      refs.filter((ref) => {
        const target = ref.replace(/^<|>$/g, "");
        return !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(target) && !(sitePrefix && target.startsWith(sitePrefix));
      }),
    ),
  ];
}

const decodeRef = (ref: string) => {
  const target = ref.replace(/^<|>$/g, "");
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
};

/** Absolute path of an image linked from a document, or null if the link climbs out of the drive. */
export function resolveDocImage(docPath: string, ref: string): string | null {
  const docDir = dirname(docPath);
  const root = docDir.match(/^(?:[A-Za-z]:)?\//)?.[0] ?? "";
  const file = normalizePath(`${docDir.slice(root.length)}/${decodeRef(ref)}`);
  return file === null ? null : root + file;
}

/** How many images a save would upload: pasted ones, plus image fields the user has chosen. */
export function imagesToUpload(body: string, collection: Collection, values: Values, sitePrefix = ""): number {
  const keys = new Set(localImages(body, sitePrefix).map(decodeRef));
  for (const choice of localImageChoices(collection, values)) keys.add(choice.local);
  return keys.size;
}

// --- GitHub API -----------------------------------------------------------------

interface ApiResponse {
  status: number;
  body: any;
}

const api = (method: "GET" | "PUT" | "POST" | "PATCH", path: string, body?: unknown) =>
  invoke<ApiResponse>("github_api", { method, path, body: body ?? null });

const apiError = (res: ApiResponse, what: string) =>
  new Error(`${what} failed (HTTP ${res.status})${res.body?.message ? `: ${res.body.message}` : ""}`);

export const signedIn = () => invoke<boolean>("github_signed_in");
export const signOut = () => invoke<void>("github_sign_out");
export const ghCliAvailable = () => invoke<boolean>("github_gh_cli_available");
export const importGhCli = () => invoke<void>("github_import_gh_cli");
export const openInBrowser = (url: string) => invoke<void>("github_open", { url });

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export const startDeviceFlow = (clientId: string) => invoke<DeviceCode>("github_device_start", { clientId });

/** Polls until the user approves the code on github.com. Resolves once the token is stored. */
export async function waitForDeviceFlow(clientId: string, code: DeviceCode, signal: AbortSignal) {
  let interval = code.interval;
  const deadline = Date.now() + code.expiresIn * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    if (signal.aborted) throw new Error("cancelled");
    const status = await invoke<string>("github_device_poll", { clientId, deviceCode: code.deviceCode });
    if (status === "done") return;
    if (status === "slow_down") interval += 5;
  }
  throw new Error("The code expired. Start sign-in again.");
}

export interface Account {
  login: string;
  canPush: boolean;
}

export async function account(repo: string): Promise<Account> {
  const [user, r] = await Promise.all([api("GET", "/user"), api("GET", `/repos/${repo}`)]);
  if (user.status !== 200) throw apiError(user, "Checking your GitHub account");
  if (r.status === 404) throw new Error(`Can't find ${repo}, or your account can't see it.`);
  if (r.status !== 200) throw apiError(r, "Checking the repository");
  return { login: user.body.login, canPush: !!r.body.permissions?.push };
}

export const signedInLogin = async () => {
  const user = await api("GET", "/user");
  if (user.status !== 200) throw apiError(user, "Checking your GitHub account");
  return user.body.login as string;
};

const contentsPath = (repo: string, path: string) => `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;

function fromBase64(b64: string) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

const fromBase64Bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** The SHA Git (and GitHub) give a file with these bytes, to tell whether it's already there. */
async function blobSha(bytes: Uint8Array) {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header);
  all.set(bytes, header.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", all));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Names and SHAs of the files in a repo folder (empty if there's no such folder). */
async function listFolder(repo: string, branch: string, folder: string): Promise<Map<string, string>> {
  const res = await api("GET", `${contentsPath(repo, folder)}?ref=${encodeURIComponent(branch)}`);
  if (res.status === 404) return new Map();
  if (res.status !== 200) throw apiError(res, "Reading the site's images");
  const items = Array.isArray(res.body) ? (res.body as { name: string; sha: string; type: string }[]) : [];
  return new Map(items.filter((i) => i.type === "file").map((i) => [i.name, i.sha]));
}

/** The branch moved on between reading it and committing; the save can simply be redone. */
class BranchMoved extends Error {}

type CommitFile = { path: string } & ({ text: string } | { base64: string });

/**
 * Commits several files at once (an entry and its images), so the site builds
 * once and never sees the entry without its images.
 */
async function commitFiles(repo: string, branch: string, message: string, files: CommitFile[]) {
  const ref = `/repos/${repo}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
  const head = await api("GET", ref.replace("/git/refs/", "/git/ref/"));
  if (head.status !== 200) throw apiError(head, "Reading the site's branch");
  const parent: string = head.body.object.sha;
  const parentCommit = await api("GET", `/repos/${repo}/git/commits/${parent}`);
  if (parentCommit.status !== 200) throw apiError(parentCommit, "Reading the site's latest commit");

  const tree = [];
  for (const f of files) {
    if ("text" in f) {
      tree.push({ path: f.path, mode: "100644", type: "blob", content: f.text });
      continue;
    }
    const blob = await api("POST", `/repos/${repo}/git/blobs`, { content: f.base64, encoding: "base64" });
    if (blob.status !== 201) throw apiError(blob, `Uploading ${basename(f.path)}`);
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.body.sha });
  }
  const newTree = await api("POST", `/repos/${repo}/git/trees`, { base_tree: parentCommit.body.tree.sha, tree });
  if (newTree.status !== 201) throw apiError(newTree, "Saving to GitHub");
  const commit = await api("POST", `/repos/${repo}/git/commits`, { message, tree: newTree.body.sha, parents: [parent] });
  if (commit.status !== 201) throw apiError(commit, "Saving to GitHub");
  const moved = await api("PATCH", ref, { sha: commit.body.sha, force: false });
  if (moved.status === 422 || moved.status === 409) throw new BranchMoved();
  if (moved.status !== 200) throw apiError(moved, "Saving to GitHub");
  return { url: commit.body.html_url as string };
}

async function getFile(repo: string, branch: string, path: string): Promise<{ sha: string; content: string } | null> {
  const res = await api("GET", `${contentsPath(repo, path)}?ref=${encodeURIComponent(branch)}`);
  if (res.status === 404) return null;
  if (res.status !== 200) throw apiError(res, "Reading from GitHub");
  return { sha: res.body.sha, content: fromBase64(res.body.content) };
}

// --- Finding and reading a site's CMS config ---------------------------------------

/** Accepts `owner/name`, a github.com URL, or a git remote. */
export function parseRepo(input: string): string | null {
  const s = input.trim().replace(/\.git$/, "");
  const m = s.match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/.*)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Finds a repository's CMS config. Sveltia and Decap configs are usually at
 * `admin/config.yml` under the folder the site serves (`public/`, `static/`…),
 * but can be anywhere, so look through the whole tree.
 */
export async function findSite(input: string): Promise<{ site: Site; config: SiteConfig }> {
  const named = parseRepo(input);
  if (!named) throw new Error("Enter a GitHub repository, like owner/name or its github.com address.");
  const r = await api("GET", `/repos/${named}`);
  if (r.status === 404) throw new Error(`Can't find ${named}, or your GitHub account can't see it.`);
  if (r.status !== 200) throw apiError(r, "Looking up the repository");
  const repo: string = r.body.full_name; // Follows renames.
  const branch: string = r.body.default_branch;

  const tree = await api("GET", `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  if (tree.status !== 200) throw apiError(tree, "Reading the repository's files");
  const candidates = (tree.body.tree as { path: string; type: string }[])
    .filter((t) => t.type === "blob" && /(^|\/)config\.ya?ml$/.test(t.path) && /(^|\/)(admin|cms)(\/|$)/i.test(t.path))
    .filter((t) => !/(^|\/)node_modules\//.test(t.path))
    .map((t) => t.path)
    .sort((a, b) => a.split("/").length - b.split("/").length);

  for (const path of candidates.slice(0, 8)) {
    const file = await getFile(repo, branch, path);
    if (!file || !looksLikeCmsConfig(file.content)) continue;
    const config = parseConfig(file.content);
    const contentRepo = config.repo ?? repo;
    const site: Site = {
      id: slugify(contentRepo),
      name: siteName(config, contentRepo),
      repo: contentRepo,
      branch: config.branch ?? branch,
      configRepo: repo,
      configPath: path,
      siteUrl: config.siteUrl,
    };
    return { site, config };
  }
  throw new Error(`No Sveltia or Decap CMS config (admin/config.yml) found in ${repo}.`);
}

function siteName(config: SiteConfig, repo: string) {
  if (config.siteUrl) {
    try {
      return new URL(config.siteUrl).hostname.replace(/^www\./, "");
    } catch {
      // Not a URL; fall back to the repository name.
    }
  }
  return repo.split("/")[1];
}

export async function addSite(input: string): Promise<Site> {
  const { site, config } = await findSite(input);
  configCache.set(site.id, config);
  updateSite(site);
  return site;
}

const configCache = new Map<string, SiteConfig>();

/** A site's current config (fetched fresh, so changes to the site's CMS show up). */
export async function loadSiteConfig(site: Site): Promise<SiteConfig> {
  if (!site.configPath) {
    // Carried over from before configs were read; find it now.
    const found = await findSite(site.configRepo || site.repo);
    updateSite({ ...found.site, id: site.id, name: site.name === "Bickerstaff Media" ? found.site.name : site.name });
    configCache.set(site.id, found.config);
    return found.config;
  }
  try {
    const file = await getFile(site.configRepo, site.branch, site.configPath);
    if (!file) throw new Error(`The CMS config at ${site.configPath} is gone.`);
    const config = parseConfig(file.content);
    configCache.set(site.id, config);
    return config;
  } catch (e) {
    // Offline or briefly unavailable: the last config read still describes the site.
    const cached = configCache.get(site.id);
    if (cached) return cached;
    throw e;
  }
}

// --- Saving ------------------------------------------------------------------------

/** Thrown when saving would clobber something; the user can retry with `overwrite`. */
export class SaveConflict extends Error {
  constructor(public kind: "exists" | "changed", message: string) {
    super(message);
  }
}

export interface SaveRequest {
  site: Site;
  collection: Collection;
  values: Values;
  /** File name within the collection (from its slug template), for new entries. */
  name: string;
  /** The entry's title, for the commit message. */
  title: string;
}

export async function saveEntry(localPath: string, text: string, req: SaveRequest, opts: { overwrite?: boolean } = {}): Promise<Link> {
  try {
    return await trySave(localPath, text, req, opts.overwrite ?? false);
  } catch (e) {
    // Someone else committed meanwhile. Start over, so their change to this entry (if any) is noticed.
    if (!(e instanceof BranchMoved)) throw e;
    try {
      return await trySave(localPath, text, req, opts.overwrite ?? false);
    } catch (again) {
      if (again instanceof BranchMoved) throw new SaveConflict("changed", "The site changed on GitHub while saving. Try again.");
      throw again;
    }
  }
}

async function trySave(localPath: string, text: string, req: SaveRequest, overwrite: boolean): Promise<Link> {
  const { site, collection, values } = req;
  let { body } = collection.fields.some((f) => f.name === collection.identifier) ? splitTitle(text) : { body: text };

  const stored = getLink(localPath);
  // A link to another site, collection or branch doesn't apply here.
  const link =
    stored && stored.site === site.id && stored.collection === collection.name && stored.branch === site.branch ? stored : undefined;
  const path = link?.path ?? entryPath(collection, req.name);
  const remote = await getFile(site.repo, site.branch, path);
  const missing = unfillable(collection, remote ? parseEntry(remote.content).data : undefined);
  if (missing.length) {
    throw new Error(
      `${collection.label} entries need ${missing.map((f) => f.label).join(", ")}, which Joyce can't set. ` +
        "Create the entry in the CMS first, then Joyce can update its text.",
    );
  }

  const images = await placeImages(site, collection, path, values, localPath, body);
  body = images.body;
  const savedValues = images.values;
  const content = buildEntry(collection, savedValues, body, remote?.content);

  const base: Link = { site: site.id, collection: collection.name, values: savedValues, repo: site.repo, branch: site.branch, path };
  // Nothing to commit, and nothing to conflict with.
  if (remote && content === remote.content && !images.uploads.length) {
    const unchanged = { ...link, ...base, sha: remote.sha, savedAt: Date.now() };
    setLink(localPath, unchanged);
    return unchanged;
  }

  if (remote && !overwrite) {
    if (!link?.sha) {
      throw new SaveConflict("exists", `An entry named “${path.split("/").pop()}” already exists. Change the file name, or overwrite it.`);
    }
    if (remote.sha !== link.sha) {
      throw new SaveConflict("changed", "This entry was changed on GitHub (maybe in the CMS) since Joyce last saved it.");
    }
  }

  const draft = values.draft === true ? " draft" : "";
  const n = images.uploads.length;
  const withImages = n ? ` with ${n === 1 ? "an image" : `${n} images`}` : "";
  const commit = await commitFiles(
    site.repo,
    site.branch,
    `${remote ? "Update" : "Create"} ${collection.labelSingular.toLowerCase()}${draft} “${req.title}”${withImages} (from Joyce)`,
    [...images.uploads, { path, text: content }],
  );

  const saved: Link = { ...base, sha: await blobSha(new TextEncoder().encode(content)), savedAt: Date.now(), commitUrl: commit.url };
  setLink(localPath, saved);
  return saved;
}

/**
 * Finds images to upload — pasted into the document, or chosen for an image
 * field such as a hero — and points both the Markdown and those fields at the
 * site's media folder, the way the CMS links images it uploads. Images already
 * on the site with the same bytes aren't sent again; a different file with the
 * same name gets a numbered name instead. One file chosen twice is uploaded once.
 */
async function placeImages(site: Site, collection: Collection, entry: string, values: Values, localPath: string, body: string) {
  const uploads: CommitFile[] = [];
  const where = mediaLocation(collection, entry, values);
  const refs = localImages(body, where?.prefix);
  const choices = localImageChoices(collection, values);
  if (!refs.length && !choices.length) return { body, values, uploads };
  if (!where) {
    throw new Error(
      `${site.name}'s CMS config doesn't say where ${collection.label.toLowerCase()} images go (its media_folder), ` +
        "so Joyce can't upload the images in this. Remove them, or use images hosted online.",
    );
  }

  const existing = await listFolder(site.repo, site.branch, where.folder);
  // The same file on disk (a pasted image also chosen as the hero) goes up once.
  const byFile = new Map<string, string>();
  const place = async (ref: string) => {
    const abs = resolveDocImage(localPath, ref);
    const cached = abs ? byFile.get(abs) : undefined;
    if (cached) return cached;
    let base64: string;
    try {
      if (!abs) throw new Error();
      base64 = await storage.readImage(abs);
    } catch {
      throw new Error(`Can't find the image “${decodeRef(ref)}” on this computer, so it can't be uploaded. Paste it again, or remove it.`);
    }
    const sha = await blobSha(fromBase64Bytes(base64));
    const assigned = assignImageName(siteImageName(basename(decodeRef(ref))), sha, existing);
    if (assigned.upload) {
      uploads.push({ path: where.folder ? `${where.folder}/${assigned.name}` : assigned.name, base64 });
      existing.set(assigned.name, sha);
    }
    const pub = `${where.prefix}${assigned.name}`;
    if (abs) byFile.set(abs, pub);
    return pub;
  };

  const placed = new Map<string, string>();
  for (const ref of refs) placed.set(ref, await place(ref));
  const next = { ...values };
  for (const choice of choices) next[choice.field] = await place(choice.local);
  return {
    body: body.replace(IMAGE, (m, open: string, ref: string, close: string) => (placed.has(ref) ? `${open}${placed.get(ref)}${close}` : m)),
    values: next,
    uploads,
  };
}

/** Relative paths of image files chosen for this document's fields (a hero, a cover). */
export function linkedImageRefs(localPath: string): string[] {
  const link = getLink(localPath);
  if (!link) return [];
  return Object.values(link.values).flatMap((v) => (isLocalImage(v) ? [v.local] : []));
}

/** Points a chosen image at a new relative path after its file was renamed to avoid a clash. */
export function retargetLocalImage(localPath: string, from: string, to: string) {
  const link = getLink(localPath);
  if (!link || from === to) return;
  let changed = false;
  const values: Values = { ...link.values };
  for (const [key, value] of Object.entries(values)) {
    if (isLocalImage(value) && value.local === from) {
      values[key] = { local: to };
      changed = true;
    }
  }
  if (changed) setLink(localPath, { ...link, values });
}

/** The entry's current front matter on GitHub, for editing an entry saved before. */
export async function remoteEntry(link: Link, site: Site) {
  if (!link.path) return null;
  const file = await getFile(site.repo, site.branch, link.path);
  return file ? parseEntry(file.content) : null;
}

export const fileUrl = (link: Link) => `https://github.com/${link.repo}/blob/${link.branch}/${link.path}`;
