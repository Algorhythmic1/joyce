import { looksLikeCmsConfig, parseConfig } from "./sveltia";
import { looksLikePagesConfig, parsePagesConfig } from "./pages";

export type CmsKind = "sveltia" | "pages";
export const cmsName = (cms: CmsKind) => cms === "pages" ? "Pages CMS" : "Sveltia / Decap CMS";
export const cmsForPath = (path: string): CmsKind => path === ".pages.yml" ? "pages" : "sveltia";

export function readCmsConfig(text: string, cms: CmsKind) {
  const matches = cms === "pages" ? looksLikePagesConfig(text) : looksLikeCmsConfig(text);
  if (!matches) throw new Error(`This file isn't a valid ${cmsName(cms)} config.`);
  return cms === "pages" ? parsePagesConfig(text) : parseConfig(text);
}
