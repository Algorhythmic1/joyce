import { invoke } from "@tauri-apps/api/core";
import { isTauri, slugify } from "../fs";
import { FolderStore, dropKeys, rekey, toRel } from "../folderState";
import {
  buildEntry, entryPath, parseEntry, titleField, unfillable, type Collection, type SiteConfig, type Values,
} from "./sveltia";
import { cmsForPath, readCmsConfig, type CmsKind } from "./cms";

/*
 * Publishing Markdown into GitHub repositories described by Sveltia/Decap
 * config.yml or Pages CMS .pages.yml, using the same forms and save safeguards.
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
  /** Older sites infer their CMS from configPath. */
  cms?: CmsKind;
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

// --- GitHub API -----------------------------------------------------------------

interface ApiResponse {
  status: number;
  body: any;
}

const api = (method: "GET" | "PUT", path: string, body?: unknown) =>
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

function toBase64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
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
 * so look through the tree. Pages CMS uses `.pages.yml` at the repository root.
 */
export async function findSite(input: string, cms?: CmsKind): Promise<{ site: Site; config: SiteConfig }> {
  const named = parseRepo(input);
  if (!named) throw new Error("Enter a GitHub repository, like owner/name or its github.com address.");
  const r = await api("GET", `/repos/${named}`);
  if (r.status === 404) throw new Error(`Can't find ${named}, or your GitHub account can't see it.`);
  if (r.status !== 200) throw apiError(r, "Looking up the repository");
  const repo: string = r.body.full_name; // Follows renames.
  const branch: string = r.body.default_branch;

  const candidates: string[] = [];
  if (cms !== "pages") {
    const tree = await api("GET", `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    if (tree.status !== 200) throw apiError(tree, "Reading the repository's files");
    candidates.push(...(tree.body.tree as { path: string; type: string }[])
      .filter((t) => t.type === "blob" && /(^|\/)config\.ya?ml$/.test(t.path) && /(^|\/)(admin|cms)(\/|$)/i.test(t.path))
      .filter((t) => !/(^|\/)node_modules\//.test(t.path))
      .map((t) => t.path)
      .sort((a, b) => a.split("/").length - b.split("/").length).slice(0, 8));
  }
  // Pages config lives at the repository root. Check it even if the tree was truncated.
  if (cms !== "sveltia") candidates.push(".pages.yml");

  for (const path of candidates) {
    const file = await getFile(repo, branch, path);
    if (!file) continue;
    const kind = cmsForPath(path);
    let config: SiteConfig;
    try {
      config = readCmsConfig(file.content, kind);
    } catch (e) {
      if (kind === "pages") throw new Error(`Can't read .pages.yml: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const contentRepo = config.repo ?? repo;
    const site: Site = {
      id: `${slugify(contentRepo)}${kind === "pages" ? "-pages" : ""}`,
      name: siteName(config, contentRepo),
      repo: contentRepo,
      branch: config.branch ?? branch,
      configRepo: repo,
      configPath: path,
      cms: kind,
      siteUrl: config.siteUrl,
    };
    return { site, config };
  }
  const expected = cms === "pages" ? "Pages CMS config (.pages.yml)" : cms === "sveltia" ? "Sveltia or Decap CMS config (admin/config.yml)" : "CMS config (admin/config.yml or .pages.yml)";
  throw new Error(`No ${expected} found in ${repo}.`);
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

export async function addSite(input: string, cms?: CmsKind): Promise<Site> {
  const { site, config } = await findSite(input, cms);
  configCache.set(site.id, config);
  updateSite(site);
  return site;
}

const configCache = new Map<string, SiteConfig>();

/** A site's current config (fetched fresh, so changes to the site's CMS show up). */
export async function loadSiteConfig(site: Site): Promise<SiteConfig> {
  if (!site.configPath) {
    // Carried over from before configs were read; find it now.
    const found = await findSite(site.configRepo || site.repo, site.cms);
    updateSite({ ...found.site, id: site.id, name: site.name === "Bickerstaff Media" ? found.site.name : site.name });
    configCache.set(site.id, found.config);
    return found.config;
  }
  let file: Awaited<ReturnType<typeof getFile>>;
  try {
    file = await getFile(site.configRepo, site.branch, site.configPath);
  } catch (e) {
    // Offline or briefly unavailable: the last config read still describes the site.
    const cached = configCache.get(site.id);
    if (cached) return cached;
    throw e;
  }
  if (!file) throw new Error(`The CMS config at ${site.configPath} is gone.`);
  const config = readCmsConfig(file.content, site.cms ?? cmsForPath(site.configPath));
  configCache.set(site.id, config);
  return config;
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

export async function saveEntry(localPath: string, text: string, req: SaveRequest, { overwrite = false } = {}): Promise<Link> {
  const { site, collection, values } = req;
  if (collection.unsupported) throw new Error(collection.unsupported);
  const { body } = titleField(collection) ? splitTitle(text) : { body: text };

  // Local images would land in the repo as links to files that aren't there, which
  // can fail the site's build. Until Joyce uploads images, don't send them.
  const localImages = [...body.matchAll(/!\[[^\]]*\]\(\s*<?(?!https?:|data:)([^)\s>]+)/g)];
  if (localImages.length) {
    throw new Error(
      `This has ${localImages.length === 1 ? "a pasted image" : `${localImages.length} pasted images`}, ` +
        "which Joyce can't upload to GitHub yet. Remove them, or use images hosted online, to save it.",
    );
  }

  const stored = getLink(localPath);
  // A link to another site, collection or branch doesn't apply here.
  const link =
    stored && stored.site === site.id && stored.collection === collection.name && stored.branch === site.branch ? stored : undefined;
  if (!link?.path && (!req.name || req.name.startsWith("/") || req.name.includes("\\") || req.name.split("/").some((p) => !p || p === "." || p === ".."))) {
    throw new Error("Enter a file name inside the collection's folder.");
  }
  const path = link?.path ?? entryPath(collection, req.name);
  const remote = await getFile(site.repo, site.branch, path);
  const missing = unfillable(collection, remote ? parseEntry(remote.content).data : undefined);
  if (missing.length) {
    throw new Error(
      `${collection.label} entries need ${missing.map((f) => f.label).join(", ")}, which Joyce can't set. ` +
        "Create the entry in the CMS first, then Joyce can update its text.",
    );
  }
  const content = buildEntry(collection, values, body, remote?.content);

  const base: Link = { site: site.id, collection: collection.name, values, repo: site.repo, branch: site.branch, path };
  // Nothing to commit, and nothing to conflict with.
  if (remote && content === remote.content) {
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
  const res = await api("PUT", contentsPath(site.repo, path), {
    message: `${remote ? "Update" : "Create"} ${collection.labelSingular.toLowerCase()}${draft} “${req.title}” (from Joyce)`,
    content: toBase64(content),
    branch: site.branch,
    ...(remote ? { sha: remote.sha } : {}),
  });
  if (res.status === 409 || res.status === 422) {
    throw new SaveConflict("changed", "The entry changed on GitHub while saving. Try again.");
  }
  if (res.status !== 200 && res.status !== 201) throw apiError(res, "Saving to GitHub");

  const saved: Link = { ...base, sha: res.body.content.sha, savedAt: Date.now(), commitUrl: res.body.commit.html_url };
  setLink(localPath, saved);
  return saved;
}

/** The entry's current front matter on GitHub, for editing an entry saved before. */
export async function remoteEntry(link: Link, site: Site) {
  if (!link.path) return null;
  const file = await getFile(site.repo, site.branch, link.path);
  return file ? parseEntry(file.content) : null;
}

export const fileUrl = (link: Link) => `https://github.com/${link.repo}/blob/${link.branch}/${link.path}`;
