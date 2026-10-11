import { useEffect, useState } from "react";
import type { Card } from "../canvas/model";
import { loadWebsitePreview } from "../canvas/websitePreview";

export function WebsiteCard({ card, revision }: { card: Card; revision: number }) {
  const [preview, setPreview] = useState<{ url: string; html?: string; failed?: boolean } | null>(null);
  const url = card.url!;
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    void loadWebsitePreview(url, revision > 0).then(html => {
      if (!cancelled) setPreview({ url, html });
    }).catch(() => { if (!cancelled) setPreview({ url, failed: true }); });
    return () => { cancelled = true; };
  }, [url, revision]);
  const current = preview?.url === url ? preview : null;
  const scale = (card.width - 2) / 390;
  return <div className="canvas-website-content">
    <div className="canvas-website-preview" aria-hidden="true">
      {current?.html ? <iframe title={`Mobile preview of ${card.title || new URL(url).hostname}`} sandbox="" referrerPolicy="no-referrer"
        tabIndex={-1} srcDoc={current.html} style={{ width: 390, height: Math.max(200, (card.height - 47) / scale), transform: `scale(${scale})` }} />
        : <div className="canvas-website-placeholder"><span>↗</span><span>{current?.failed ? "Preview unavailable" : "Loading preview…"}</span><small>Double-click to open website</small></div>}
    </div>
    <div className="canvas-website-caption"><div><strong>{card.title || new URL(url).hostname}</strong><span>{url.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span></div><span aria-hidden="true">↗</span></div>
  </div>;
}
