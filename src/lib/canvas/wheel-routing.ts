/**
 * TES-89: the canvas surface's `onWheel` used to call `preventDefault()`
 * unconditionally, so a wheel over an overflowing card body panned the
 * viewport instead of scrolling the card — the card's own `overflowY: auto`
 * never got a chance to run. This is the decision the surface's wheel
 * handler defers to before it touches the viewport: does this wheel event
 * belong to a scrollable card body, or to the canvas underneath it?
 *
 * Pulled out of `canvas-app.tsx` so it can be unit tested without a DOM —
 * the handler itself stays there since it also owns `surfaceRef`,
 * `setViewport` and friends, which aren't worth faking here.
 */

export type CardBodyScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

export type WheelRouting = "card-scroll" | "canvas";

/** A body isn't a scroll target at all unless it actually overflows — a
 * short card must not "feel stuck" just because the pointer happens to be
 * over it (requirement 2). The 1px slack absorbs sub-pixel layout rounding. */
function cardBodyOverflows(body: CardBodyScrollMetrics): boolean {
  return body.scrollHeight > body.clientHeight + 1;
}

/** Whether `body` has room left to move further in the wheel's direction.
 * At either limit, the card has nothing left to give the gesture, so it
 * should fall through to the canvas rather than swallow the event. */
function cardBodyCanScroll(body: CardBodyScrollMetrics, deltaY: number): boolean {
  if (deltaY > 0) return body.scrollTop + body.clientHeight < body.scrollHeight - 1;
  if (deltaY < 0) return body.scrollTop > 1;
  return false;
}

/**
 * Routes a wheel event to either the card body under the pointer or the
 * canvas viewport (pan or zoom).
 *
 * Ctrl/Cmd+wheel (trackpad pinch-zoom included — browsers report it as a
 * ctrl-modified wheel event) always zooms the canvas, even over a card:
 * requirement 3. Everything else goes to an overflowing, scrollable card
 * body if the pointer is over one; otherwise it pans the canvas.
 */
export function routeWheelEvent(params: {
  ctrlKey: boolean;
  metaKey: boolean;
  deltaY: number;
  cardBody: CardBodyScrollMetrics | null;
}): WheelRouting {
  const { ctrlKey, metaKey, deltaY, cardBody } = params;
  if (ctrlKey || metaKey) return "canvas";
  if (cardBody && cardBodyOverflows(cardBody) && cardBodyCanScroll(cardBody, deltaY)) {
    return "card-scroll";
  }
  return "canvas";
}
