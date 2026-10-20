import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../fs";
import { websiteUrl } from "./websites";

type Page = { url: string; html: string };
const cache = new Map<string, Promise<string>>();

/** Render static mobile HTML in an opaque sandbox, with no scripts or navigation. */
export function previewDocument(page: Page): string {
  const doc = new DOMParser().parseFromString(page.html, "text/html");
  doc.querySelectorAll("script, iframe, frame, frameset, object, embed, base, meta[http-equiv], meta[name=viewport], link:not([rel=stylesheet])").forEach(el => el.remove());
  doc.querySelectorAll("*").forEach(el => {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name) || ["autofocus", "srcdoc", "autoplay"].includes(attr.name)) el.removeAttribute(attr.name);
    }
  });
  const base = doc.createElement("base"); base.href = websiteUrl(page.url);
  const csp = doc.createElement("meta"); csp.httpEquiv = "Content-Security-Policy";
  csp.content = "default-src 'none'; style-src http: https: 'unsafe-inline'; img-src http: https: data:; font-src http: https: data:; base-uri http: https:; form-action 'none'";
  const viewport = doc.createElement("meta"); viewport.name = "viewport"; viewport.content = "width=device-width, initial-scale=1";
  doc.head.prepend(csp, base, viewport);
  const style = doc.createElement("style");
  style.textContent = "html { overflow: hidden; color-scheme: light; } body { min-width: 0; } * { animation: none !important; transition: none !important; }";
  doc.head.append(style);
  if (!doc.body.textContent?.trim() && !doc.body.querySelector("img, picture, svg")) {
    throw new Error("This site needs JavaScript to show a preview.");
  }
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

export function loadWebsitePreview(url: string, refresh = false): Promise<string> {
  url = websiteUrl(url);
  if (refresh) cache.delete(url);
  let request = cache.get(url);
  if (!request) {
    request = (async () => {
      if (isTauri) return previewDocument(await invoke<Page>("website_preview", { url }));
      // UI-only development can preview sites that allow browser CORS requests.
      const response = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(15000) });
      if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) throw new Error("Preview unavailable");
      const html = await response.text();
      if (html.length > 2 * 1024 * 1024) throw new Error("Preview unavailable");
      return previewDocument({ url: response.url || url, html });
    })();
    cache.set(url, request);
    if (cache.size > 32) cache.delete(cache.keys().next().value!);
    const current = request;
    void request.catch(() => { if (cache.get(url) === current) cache.delete(url); });
  }
  return request;
}

export async function openWebsite(url: string): Promise<void> {
  url = websiteUrl(url);
  if (isTauri) await invoke("website_open", { url });
  else window.open(url, "_blank", "noopener,noreferrer");
}
