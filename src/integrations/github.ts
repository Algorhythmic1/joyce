import { invoke } from "@tauri-apps/api/core";
import { parseDocument, stringify } from "yaml";
import { basename, displayName, isTauri, slugify } from "../fs";

/** Where posts go. Defaults match the Bickerstaff Media (Astrolabe) Astro site. */
export interface GithubTarget {
  repo: string;
  branch: string;
  folder: string;
  extension: "mdx" | "md";
  author: string;
  /** Client ID of a GitHub OAuth app with Device Flow enabled. */
  clientId: string;
}

export interface PostFields {
  title: string;
  slug: string;
  description: string;
  tags: string[];
  author: string;
  /** YYYY-MM-DD */
  pubDate: string;
  draft: boolean;
}

/** What we remember about a local document's post, keyed by its local path. */
export interface Link {
  fields: PostFields;
  repo?: string;
  branch?: string;
  /** Repo-relative path of the post, once saved. */
  path?: string;
  /** Blob SHA we last wrote; used to notice edits made elsewhere (e.g. in the CMS). */
  sha?: string;
  savedAt?: number;
  commitUrl?: string;
}

export const DEFAULT_TARGET: GithubTarget = {
  repo: "AlgorhythmicIndustries/bickerstaff-media-site",
  branch: "master",
  folder: "src/content/blog",
  extension: "mdx",
  author: "Bickerstaff Media",
  clientId: "",
};

const TARGET_KEY = "joyce:github-target";
const LINKS_KEY = "joyce:github-links";

export const available = isTauri;

export function loadTarget(): GithubTarget {
  try {
    return { ...DEFAULT_TARGET, ...JSON.parse(localStorage.getItem(TARGET_KEY) ?? "{}") };
  } catch {
    return DEFAULT_TARGET;
  }
}
export const saveTarget = (t: GithubTarget) => localStorage.setItem(TARGET_KEY, JSON.stringify(t));

function loadLinks(): Record<string, Link> {
  try {
    return JSON.parse(localStorage.getItem(LINKS_KEY) ?? "{}");
  } catch {
    return {};
  }
}
const saveLinks = (links: Record<string, Link>) => localStorage.setItem(LINKS_KEY, JSON.stringify(links));

export const getLink = (localPath: string): Link | undefined => loadLinks()[localPath];

export function setLink(localPath: string, link: Link) {
  saveLinks({ ...loadLinks(), [localPath]: link });
}

/** Keeps links attached when a document, or a folder containing documents, is renamed. */
export function moveLinks(from: string, to: string) {
  const links = loadLinks();
  const moved = Object.fromEntries(
    Object.entries(links).map(([p, l]) => [p === from || p.startsWith(from + "/") ? to + p.slice(from.length) : p, l]),
  );
  saveLinks(moved);
}

export function forgetLinks(path: string) {
  saveLinks(Object.fromEntries(Object.entries(loadLinks()).filter(([p]) => p !== path && !p.startsWith(path + "/"))));
}

// --- Converting a document into a post ------------------------------------

/** A leading `# Heading` is the post title; the site renders the title itself. */
export function splitTitle(text: string): { title: string | null; body: string } {
  const m = text.match(/^\s*#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/);
  if (!m) return { title: null, body: text };
  return { title: m[1].trim(), body: text.slice(m[0].length).replace(/^\s*\n/, "") };
}

export { slugify };

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

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function defaultFields(localPath: string, text: string, target: GithubTarget): PostFields {
  const title = splitTitle(text).title ?? displayName(basename(localPath));
  return { title, slug: slugify(title), description: "", tags: [], author: target.author, pubDate: today(), draft: true };
}

/**
 * Builds the file. Front matter keys that Joyce doesn't manage (hero image,
 * featured, updatedDate…) are kept from the existing post, in their original order.
 */
export function buildPostFile(fields: PostFields, text: string, target: GithubTarget, existing?: string): string {
  const prior = existing ? parsePostFile(existing).data : {};
  const managed = {
    title: fields.title,
    description: fields.description,
    pubDate: fields.pubDate,
    author: fields.author,
    tags: fields.tags,
    draft: fields.draft,
  };
  const data: Record<string, unknown> = existing ? { ...prior, ...managed } : { ...managed, featured: false };
  if (!existing) {
    // New posts follow the CMS's field order, with draft last.
    delete data.draft;
    data.draft = fields.draft;
  }
  let body = splitTitle(text).body.trim();
  if (target.extension === "mdx") body = escapeMdx(body);
  return `---\n${stringify(data, { lineWidth: 0 })}---\n\n${body}\n`;
}

export function parsePostFile(content: string): { data: Record<string, unknown>; body: string } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: content };
  const data = parseDocument(m[1]).toJS() ?? {};
  return { data, body: content.slice(m[0].length) };
}

// --- GitHub API -----------------------------------------------------------

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

export async function account(target: GithubTarget): Promise<Account> {
  const [user, repo] = await Promise.all([api("GET", "/user"), api("GET", `/repos/${target.repo}`)]);
  if (user.status !== 200) throw apiError(user, "Checking your GitHub account");
  if (repo.status === 404) throw new Error(`Can't find ${target.repo}, or your account can't see it.`);
  if (repo.status !== 200) throw apiError(repo, "Checking the repository");
  return { login: user.body.login, canPush: !!repo.body.permissions?.push };
}

const contentsPath = (target: GithubTarget, path: string) =>
  `/repos/${target.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;

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

async function getFile(target: GithubTarget, path: string): Promise<{ sha: string; content: string } | null> {
  const res = await api("GET", `${contentsPath(target, path)}?ref=${encodeURIComponent(target.branch)}`);
  if (res.status === 404) return null;
  if (res.status !== 200) throw apiError(res, "Reading the post from GitHub");
  return { sha: res.body.sha, content: fromBase64(res.body.content) };
}

/** Thrown when saving would clobber something; the user can retry with `overwrite`. */
export class SaveConflict extends Error {
  constructor(public kind: "exists" | "changed", message: string) {
    super(message);
  }
}

export async function savePost(
  localPath: string,
  text: string,
  fields: PostFields,
  target: GithubTarget,
  { overwrite = false } = {},
): Promise<Link> {
  // Local images would land in the repo as links to files that aren't there, which
  // can fail the site's build. Until Joyce uploads images, don't send them.
  const localImages = [...splitTitle(text).body.matchAll(/!\[[^\]]*\]\(\s*<?(?!https?:|data:)([^)\s>]+)/g)];
  if (localImages.length) {
    throw new Error(
      `This post has ${localImages.length === 1 ? "a pasted image" : `${localImages.length} pasted images`}, ` +
        "which Joyce can't upload to GitHub yet. Remove them, or use images hosted online, to save it.",
    );
  }

  const stored = getLink(localPath);
  // A link to a different repo or branch (the target was changed) doesn't apply here.
  const link = stored?.repo === target.repo && stored.branch === target.branch ? stored : undefined;
  const path = link?.path ?? `${target.folder.replace(/\/$/, "")}/${fields.slug}.${target.extension}`;
  const remote = await getFile(target, path);

  const content = buildPostFile(fields, text, target, remote?.content);
  // Nothing to commit, and nothing to conflict with.
  if (remote && content === remote.content) {
    const unchanged = { ...link, fields, repo: target.repo, branch: target.branch, path, sha: remote.sha, savedAt: Date.now() };
    setLink(localPath, unchanged);
    return unchanged;
  }

  if (remote && !overwrite) {
    if (!link?.sha) {
      throw new SaveConflict("exists", `A post named “${fields.slug}” already exists. Change the file name, or overwrite that post.`);
    }
    if (remote.sha !== link.sha) {
      throw new SaveConflict("changed", "This post was changed on GitHub (maybe in the CMS) since Joyce last saved it.");
    }
  }

  const verb = fields.draft ? "draft" : "post";
  const res = await api("PUT", contentsPath(target, path), {
    message: `${remote ? "Update" : "Create"} ${verb} “${fields.title}” (from Joyce)`,
    content: toBase64(content),
    branch: target.branch,
    ...(remote ? { sha: remote.sha } : {}),
  });
  if (res.status === 409 || res.status === 422) {
    throw new SaveConflict("changed", "The post changed on GitHub while saving. Try again.");
  }
  if (res.status !== 200 && res.status !== 201) throw apiError(res, "Saving to GitHub");

  const saved: Link = {
    fields,
    repo: target.repo,
    branch: target.branch,
    path,
    sha: res.body.content.sha,
    savedAt: Date.now(),
    commitUrl: res.body.commit.html_url,
  };
  setLink(localPath, saved);
  return saved;
}

export const fileUrl = (link: Link) => `https://github.com/${link.repo}/blob/${link.branch}/${link.path}`;
