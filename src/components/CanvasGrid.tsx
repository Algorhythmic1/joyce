import { useEffect, useRef, type RefObject } from "react";
import type { Camera } from "../canvas/model";

/** Decorative only: geometry and hit targets never inherit the surface's deformation. */
export function CanvasGrid({ camera, host }: { camera: Camera; host: RefObject<HTMLDivElement | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const invalidate = useRef<() => void>(() => {});
  useEffect(() => invalidate.current(), [camera]);

  useEffect(() => {
    const element = host.current!, surface = canvas.current!, ctx = surface.getContext("2d");
    if (!ctx) return;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0, width = 0, height = 0, color = "", strength = 0;
    const target = { x: 0, y: 0, strength: 0 }, cursor = { x: 0, y: 0 };
    const draw = () => {
      frame = 0;
      if (document.hidden) return;
      const lerp = motion.matches ? 1 : 0.24;
      cursor.x += (target.x - cursor.x) * lerp;
      cursor.y += (target.y - cursor.y) * lerp;
      strength += (target.strength - strength) * lerp;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = color;
      const c = cameraRef.current;
      let step = 32 * c.zoom;
      // Coarsen on zoom-out instead of drawing thousands of subpixel dots.
      while (step < 18) step *= 2;
      const ox = ((c.x % step) + step) % step, oy = ((c.y % step) + step) % step;
      for (let y = oy - step; y < height + step; y += step) {
        for (let x = ox - step; x < width + step; x += step) {
          const dx = x - cursor.x, dy = y - cursor.y;
          const falloff = Math.exp(-(dx * dx + dy * dy) / (2 * 95 * 95)) * strength;
          const dent = motion.matches ? 0 : falloff;
          // A shallow bowl: compressed spacing, projected depth, and a lit upper slope.
          const px = x - dx * dent * 0.055;
          const py = y - dy * dent * 0.055 + dent * 4;
          ctx.globalAlpha = Math.max(0.055, Math.min(0.32, 0.095 + falloff * 0.18 - dy / 95 * dent * 0.045));
          ctx.beginPath(); ctx.arc(px, py, 1.05 + falloff * 0.18, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      if (Math.abs(target.x - cursor.x) + Math.abs(target.y - cursor.y) > 0.2 || Math.abs(target.strength - strength) > 0.002) schedule();
    };
    const schedule = () => { if (!frame && !document.hidden) frame = requestAnimationFrame(draw); };
    invalidate.current = schedule;
    const resize = () => {
      width = element.clientWidth; height = element.clientHeight;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      surface.width = Math.round(width * dpr); surface.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      color = getComputedStyle(element).getPropertyValue("--text").trim();
      schedule();
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const rect = element.getBoundingClientRect();
      target.x = e.clientX - rect.left; target.y = e.clientY - rect.top; target.strength = 1;
      schedule();
    };
    const leave = () => { target.strength = 0; schedule(); };
    const visibility = () => { if (document.hidden) { cancelAnimationFrame(frame); frame = 0; } else { target.strength = 0; resize(); } };
    const observer = new ResizeObserver(resize);
    const themeObserver = new MutationObserver(resize);
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    observer.observe(element);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    scheme.addEventListener("change", resize); motion.addEventListener("change", schedule);
    element.addEventListener("pointermove", move); element.addEventListener("pointerleave", leave);
    window.addEventListener("blur", leave); document.addEventListener("visibilitychange", visibility);
    resize();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); themeObserver.disconnect(); invalidate.current = () => {};
      scheme.removeEventListener("change", resize); motion.removeEventListener("change", schedule);
      element.removeEventListener("pointermove", move); element.removeEventListener("pointerleave", leave);
      window.removeEventListener("blur", leave); document.removeEventListener("visibilitychange", visibility);
    };
  }, [host]);
  return <canvas ref={canvas} className="canvas-grid" aria-hidden="true" />;
}
