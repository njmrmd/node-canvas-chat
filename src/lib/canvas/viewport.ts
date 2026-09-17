import type { Bounds } from "@/lib/canvas/layout";

/** §2.1. */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2.0;
export const ZOOM_STEP_FACTOR = 1.2;
/** 1px wheel delta = 0.002 zoom (§2.1). */
export const WHEEL_ZOOM_SENSITIVITY = 0.002;

export type Viewport = { x: number; y: number; zoom: number };

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/**
 * Zooms `viewport` to `nextZoom`, holding `anchor` (a point in screen space)
 * fixed on the canvas — the pointer under a wheel/pinch, or the viewport
 * centre for a keyboard/button zoom (§2.1 "zoom origin").
 */
export function zoomAt(
  viewport: Viewport,
  nextZoomRaw: number,
  anchor: { x: number; y: number },
): Viewport {
  const nextZoom = clampZoom(nextZoomRaw);
  if (nextZoom === viewport.zoom) return viewport;

  // The canvas-space point under the anchor must resolve to the same
  // screen-space anchor after the zoom.
  const canvasX = (anchor.x - viewport.x) / viewport.zoom;
  const canvasY = (anchor.y - viewport.y) / viewport.zoom;

  return {
    zoom: nextZoom,
    x: anchor.x - canvasX * nextZoom,
    y: anchor.y - canvasY * nextZoom,
  };
}

export function panBy(viewport: Viewport, dx: number, dy: number): Viewport {
  return { ...viewport, x: viewport.x + dx, y: viewport.y + dy };
}

export function screenToCanvas(
  viewport: Viewport,
  point: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom,
  };
}

/**
 * §2.1 "zoom-to-fit, clamped to max 1.0" on first load; also used for the
 * `0` shortcut, the zoom-to-fit button and double-click-empty.
 */
export function fitViewport(
  bounds: Bounds,
  viewportSize: { width: number; height: number },
  options?: { padding?: number; maxZoom?: number },
): Viewport {
  const padding = options?.padding ?? 96;
  const maxZoom = options?.maxZoom ?? 1.0;

  const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY);

  const zoom = clampZoom(
    Math.min(
      maxZoom,
      (viewportSize.width - padding * 2) / contentWidth,
      (viewportSize.height - padding * 2) / contentHeight,
    ),
  );

  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;

  return {
    zoom,
    x: viewportSize.width / 2 - centerX * zoom,
    y: viewportSize.height / 2 - centerY * zoom,
  };
}

/** Pans (never zooms) so `rect` sits in the lower third of the viewport — §2.4 auto-follow. */
export function panToLowerThird(
  viewport: Viewport,
  rect: { x: number; y: number; width: number; height: number },
  viewportSize: { width: number; height: number },
): Viewport {
  const targetScreenY = viewportSize.height * 0.66 - (rect.height / 2) * viewport.zoom;
  const targetScreenX = viewportSize.width / 2 - (rect.width / 2) * viewport.zoom;

  const currentScreenX = rect.x * viewport.zoom + viewport.x;
  const currentScreenY = rect.y * viewport.zoom + viewport.y;

  return panBy(
    viewport,
    targetScreenX - currentScreenX,
    targetScreenY - currentScreenY,
  );
}

/** True when `rect` (canvas space) is fully inside the visible viewport. */
export function rectInView(
  viewport: Viewport,
  rect: { x: number; y: number; width: number; height: number },
  viewportSize: { width: number; height: number },
): boolean {
  const screenX = rect.x * viewport.zoom + viewport.x;
  const screenY = rect.y * viewport.zoom + viewport.y;
  const screenWidth = rect.width * viewport.zoom;
  const screenHeight = rect.height * viewport.zoom;

  return (
    screenX >= 0 &&
    screenY >= 0 &&
    screenX + screenWidth <= viewportSize.width &&
    screenY + screenHeight <= viewportSize.height
  );
}

/** Pans+zooms so `rect` centres horizontally at `yFraction` of the viewport — §6.1 zoom-to-node. */
export function focusOn(
  rect: { x: number; y: number; width: number; height: number },
  viewportSize: { width: number; height: number },
  zoom: number,
  yFraction: number,
): Viewport {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;

  return {
    zoom,
    x: viewportSize.width / 2 - centerX * zoom,
    y: viewportSize.height * yFraction - centerY * zoom,
  };
}
