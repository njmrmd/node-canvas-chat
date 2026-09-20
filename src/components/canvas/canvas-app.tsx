"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  canBranchNow,
  useCanvasController,
} from "@/lib/canvas/use-canvas-controller";
import { NodeCard } from "@/components/canvas/node-card";
import { Edge, EdgeMarkerDefs } from "@/components/canvas/edge";
import { Composer } from "@/components/canvas/composer";
import { TopBar } from "@/components/canvas/top-bar";
import { EmptyStateDiagram, StarterChips } from "@/components/canvas/empty-state";
import { ConnectModelCard } from "@/components/canvas/connect-model-card";
import { LinearView } from "@/components/canvas/linear-view";
import { ShortcutsSheet } from "@/components/canvas/shortcuts-sheet";
import { Toast } from "@/components/canvas/toast";
import { copy } from "@/lib/canvas/copy";
import {
  addNode,
  childIds,
  descendantIds,
  pathToRoot,
  rootIds,
  type ConversationGraph,
} from "@/lib/conversation/graph";
import {
  fitViewport,
  focusOn,
  panToLowerThird,
  rectInView,
  screenToCanvas,
  zoomAt,
  ZOOM_STEP_FACTOR,
  type Viewport,
} from "@/lib/canvas/viewport";
import {
  graphBounds,
  NODE_HEIGHT_MAX,
  NODE_HEIGHT_MIN,
  NODE_WIDTH_DESKTOP,
  NODE_WIDTH_MAX,
  NODE_WIDTH_MIN,
  NODE_WIDTH_MOBILE,
  nodeWidthsFrom,
  reflowChildrenOnCreate,
} from "@/lib/canvas/layout";
import { routeWheelEvent } from "@/lib/canvas/wheel-routing";
import type { ModelSpec } from "@/lib/providers/registry";

/** Nominal card height for viewport/pan math — see `layout.ts`'s own note on
 * why this is a constant rather than a measured value. */
const NODE_HEIGHT = 160;
/** §4.9: the point at which dense-graph affordances switch on. Only
 * viewport culling is wired to it in this pass — see the handoff comment at
 * the bottom of this file for what else that threshold is supposed to gate. */
const DENSE_GRAPH_THRESHOLD = 12;
/** §2.4 auto-follow suppression window, and the same window this reuses for
 * "don't fight a keyboard-driven pan either". */
const RECENT_USER_VIEWPORT_CHANGE_MS = 2000;
/** §6.1: a touch-and-hold on a node this long enters drag mode; shorter than
 * this, the same gesture is a pan. Mouse/pen skip the gate entirely — a
 * short drag there is unambiguously a drag, not a pan attempt. */
const LONG_PRESS_MS = 400;
/** Movement past this many px cancels a pending long-press — the finger is
 * panning, not holding still. Also the click-vs-drag tolerance below. */
const TAP_MOVE_TOLERANCE_PX = 4;
const MOBILE_QUERY = "(max-width: 767px)";

/**
 * The composer, the undo toast and anything else that floats over the canvas
 * are rendered *inside* the surface element, because they are positioned
 * against it. They are not the canvas, though, and a pointer landing on them
 * is not a canvas gesture: the surface must not start a pan from it, must not
 * `preventDefault` it (that is what stops a click from focusing the composer),
 * and — the TES-74 bug — must not treat the pointer-up as the "click on empty
 * canvas" that deselects.
 *
 * That deselect is why forking looked broken. Reply on node 2 binds the
 * composer to node 2; the very next click, into the composer or on Send,
 * bubbled here and cleared the selection, and §2.2's fallback rebound the
 * composer to the most recent leaf — node 4. The reply then extended the
 * series instead of branching. Nothing in the graph layer was wrong; the
 * target had been silently reassigned before `send` ever read it.
 */
const CHROME_SELECTOR = '[data-canvas-role="chrome"]';

function isOverCanvasChrome(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(CHROME_SELECTOR) !== null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** TES-90: a card's real, effective width/height right now — its own
 * resized `size` if it has one, otherwise the viewport default / auto. */
function effectiveWidth(node: { size: { width: number; height: number } | null }, defaultWidth: number): number {
  return node.size?.width ?? defaultWidth;
}

/** TES-89: the card body isn't marked as chrome outright — it's still part
 * of the card for select/drag purposes (`data-node-role="card"` covers it
 * too) — it only needs to opt out of *this one* surface behaviour, wheel
 * routing, so it gets its own narrower marker. */
const CARD_BODY_SELECTOR = '[data-canvas-role="card-body"]';

function findCardBodyElement(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest(CARD_BODY_SELECTOR) as HTMLElement | null;
}

function subscribeMobile(callback: () => void): () => void {
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}
function getMobileSnapshot(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches;
}
function getMobileServerSnapshot(): boolean {
  return false;
}

/** Every node hidden by an ancestor's §4.9 collapse — never the collapsed
 * node itself, only what it hides. */
function nodesHiddenByCollapse(graph: ConversationGraph): Set<string> {
  const hidden = new Set<string>();
  for (const id of graph.nodeIds) {
    if (graph.nodesById[id].collapsed) {
      for (const descendantId of descendantIds(graph, id).slice(1)) hidden.add(descendantId);
    }
  }
  return hidden;
}

function leavesByRecency(graph: ConversationGraph) {
  return graph.nodeIds
    .filter((id) => childIds(graph, id).length === 0)
    .map((id) => graph.nodesById[id])
    .sort((a, b) => b.createdAt - a.createdAt);
}

function formatResetTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}

export function CanvasApp({
  email,
  hasProvider,
  models,
  defaultModelId,
}: {
  email: string;
  hasProvider: boolean;
  models: ModelSpec[];
  defaultModelId: string;
}) {
  const isMobile = useSyncExternalStore(
    subscribeMobile,
    getMobileSnapshot,
    getMobileServerSnapshot,
  );
  const [model, setModel] = useState(defaultModelId);
  /** Real card heights, keyed by node id (TES-77): fed to `autoPlaceOnCreate`
   * and `tidyLayout` so row pitch and overlap checks use what a card actually
   * renders at instead of the nominal `NODE_HEIGHT`. A ref, not state — the
   * `ResizeObserver` below (which populates it) fires far more often than a
   * layout pass needs a re-render. */
  const nodeHeightsRef = useRef(new Map<string, number>());
  /** Render-visible mirror of `nodeHeightsRef` (TES-99): edges below read
   * heights during render, and a ref write alone doesn't schedule one, so a
   * collapsed/resized card's edges stayed anchored to the old geometry until
   * some unrelated render happened to run. Kept as a separate state snapshot
   * rather than reading the ref directly — batched per animation frame with
   * an epsilon so a card streaming tokens doesn't re-render every frame. */
  const [nodeHeights, setNodeHeights] = useState(() => new Map<string, number>());
  const nodeHeightsFrameRef = useRef<number | null>(null);
  /** TES-103 item 2: canvas-space center of the visible content area, read
   * by the controller only at node-create time (never during render — see
   * `visibleCenter`/the effect that fills this in, further down, for the
   * render-safe version). Declared before the controller call so the same
   * stable ref object can be handed in here and populated later; only its
   * `.current` needs to be current by the time a node is actually created. */
  const visibleCenterRef = useRef({ x: 0, y: 0 });
  const controller = useCanvasController({
    provider: "anthropic",
    model,
    isMobile,
    nodeHeightsRef,
    visibleCenterRef,
  });
  const {
    graph,
    viewport,
    setViewport,
    selectedNodeId,
    effectiveComposerTarget,
    composerDisabledReason,
    loadState,
    isOnline,
    rateLimit,
    hasBranchedOnce,
    queuePosition,
    streamStartedAt,
    deletedToast,
    isRootsEmpty,
  } = controller;

  const nodeWidth = isMobile ? NODE_WIDTH_MOBILE : NODE_WIDTH_DESKTOP;

  const surfaceRef = useRef<HTMLDivElement>(null);
  const nodeElsRef = useRef(new Map<string, HTMLDivElement>());
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const viewportRef = useRef(viewport);
  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);
  const graphRef = useRef(graph);
  useEffect(() => {
    graphRef.current = graph;
  }, [graph]);

  // Every other ref lives here too, declared before the callbacks that close
  // over them — `zoomToFit` below reads `lastUserViewportChangeRef` at
  // definition time, and a `const` referenced before its own declaration is a
  // TDZ hazard even though it happens to work once every hook in the
  // component has run once.
  const lastUserViewportChangeRef = useRef(0);
  const spaceHeldRef = useRef(false);
  const panRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startViewport: Viewport;
    // A pan that started over a card is a pending touch drag (§6.1) rather
    // than a background click — the pan-that-never-moved deselect below
    // must not fire for it.
    overCard: boolean;
  } | null>(null);
  const dragRef = useRef<{
    nodeId: string;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startPos: { x: number; y: number };
  } | null>(null);
  /** TES-90: an in-progress corner-handle resize, tracked the same way as
   * `dragRef` — a ref rather than state because it updates on every
   * pointermove and a resize is a controller write, not a local render. */
  const resizeRef = useRef<{
    nodeId: string;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);
  /** Pending touch long-press: set on touch-down over a node, cleared by
   * movement past tolerance, pointer-up, or by firing into `dragRef`. */
  const longPressRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const knownNodeIdsRef = useRef<Set<string>>(new Set());
  const didInitialFitRef = useRef(false);

  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  /** Live footprint of the docked composer (§2.4 "Auto-follow"): the band at
   * the bottom of the surface it overlays, measured rather than assumed,
   * since it varies with the target chip, disabled state and textarea
   * growth. Auto-follow/focus math treats this as outside the visible
   * viewport so a card's bottom never lands behind it (TES-75). */
  const [composerReservedHeight, setComposerReservedHeight] = useState(0);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [focusPathMode, setFocusPathMode] = useState(false);
  const [showLinearView, setShowLinearView] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [starterDraft, setStarterDraft] = useState<string | undefined>(undefined);

  const rovingId =
    focusedNodeId && graph.nodesById[focusedNodeId] ? focusedNodeId : (rootIds(graph)[0] ?? null);

  // ---- Surface size, for zoom-to-fit / viewport culling / keyboard pan ----

  /**
   * A callback ref, not `surfaceRef` plus a `useEffect(..., [])`: the surface
   * `<div>` only exists once `loadState` reaches `"ready"` (the loading and
   * error states render something else entirely), so an effect that runs
   * once at mount finds `surfaceRef.current` still `null` and never attaches
   * an observer at all — `viewportSize` would stay `{0,0}` for the rest of
   * the session. A callback ref fires exactly when this specific node mounts
   * and unmounts, regardless of which branch is rendering it.
   */
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const attachSurfaceRef = useCallback((el: HTMLDivElement | null) => {
    surfaceRef.current = el;
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    resizeObserverRef.current = observer;
  }, []);

  /**
   * The composer chrome is `position: absolute`, so it never affects layout
   * flow — its height has to be measured, not assumed. Reserved height is the
   * gap between the surface's bottom edge and the chrome's top edge (not just
   * the chrome's own height), so it also captures the `space-5` bottom inset
   * for free.
   */
  const composerResizeObserverRef = useRef<ResizeObserver | null>(null);
  const attachComposerChrome = useCallback((el: HTMLDivElement | null) => {
    composerResizeObserverRef.current?.disconnect();
    composerResizeObserverRef.current = null;
    if (!el) {
      setComposerReservedHeight(0);
      return;
    }
    const measure = () => {
      const surfaceEl = surfaceRef.current;
      if (!surfaceEl) return;
      const reserved = surfaceEl.getBoundingClientRect().bottom - el.getBoundingClientRect().top;
      setComposerReservedHeight(Math.max(0, reserved));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    composerResizeObserverRef.current = observer;
    measure();
  }, []);

  /**
   * TES-77: one `ResizeObserver` watching every registered node card, keyed
   * by `data-node-id` (set by `NodeCard` itself). Cards vary 96–420px tall
   * and shrink/grow as they stream, so `nodeHeightsRef` has to track real
   * height rather than the nominal `NODE_HEIGHT` layout.ts falls back to.
   */
  const nodeResizeObserverRef = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.nodeId;
        if (!id) continue;
        const next = entry.contentRect.height;
        const prev = nodeHeightsRef.current.get(id);
        if (prev === undefined || Math.abs(prev - next) > 0.5) {
          nodeHeightsRef.current.set(id, next);
          changed = true;
        }
      }
      if (changed && nodeHeightsFrameRef.current === null) {
        nodeHeightsFrameRef.current = requestAnimationFrame(() => {
          nodeHeightsFrameRef.current = null;
          setNodeHeights(new Map(nodeHeightsRef.current));
        });
      }
    });
    nodeResizeObserverRef.current = observer;
    return () => {
      observer.disconnect();
      if (nodeHeightsFrameRef.current !== null) {
        cancelAnimationFrame(nodeHeightsFrameRef.current);
        nodeHeightsFrameRef.current = null;
      }
    };
  }, []);

  /**
   * One stable callback shared by every card (TES-99), rather than a fresh
   * arrow built per card inside the JSX below. `NodeCard` re-runs its own
   * register/unregister effect whenever the function it was given changes
   * identity — a per-card closure is a new identity every render, so it used
   * to unobserve and re-observe every card on every render regardless of
   * cause. That was silent waste while heights lived only in a ref; once a
   * real height change feeds `setNodeHeights` (below) it stops being silent —
   * each spurious re-observe reports the unchanged current height as if it
   * were new, which schedules another render, which triggers another
   * spurious re-observe, forever. Taking `id` as an argument instead of
   * closing over it means one `useCallback([])` covers every card.
   */
  const handleRegisterNodeRef = useCallback((id: string, el: HTMLDivElement | null) => {
    const prevEl = nodeElsRef.current.get(id);
    if (prevEl && prevEl !== el) nodeResizeObserverRef.current?.unobserve(prevEl);
    if (el) {
      nodeElsRef.current.set(id, el);
      nodeResizeObserverRef.current?.observe(el);
    } else {
      nodeElsRef.current.delete(id);
      if (nodeHeightsRef.current.delete(id)) {
        setNodeHeights(new Map(nodeHeightsRef.current));
      }
    }
  }, []);

  /** Visible content area for auto-follow/focus math (§2.4): the surface
   * minus the composer's reserved band. Not used for zoom-to-fit or render
   * culling — those already have their own margins and aren't about keeping
   * a card clear of the composer. */
  const contentViewportSize = useMemo(
    () => ({
      width: viewportSize.width,
      height: Math.max(0, viewportSize.height - composerReservedHeight),
    }),
    [viewportSize.width, viewportSize.height, composerReservedHeight],
  );

  /** TES-103 item 2: canvas-space point under the center of the visible
   * content area above — the render-safe counterpart to `visibleCenterRef`.
   * A plain `useMemo`, safe to read during render (the skeleton preview
   * below does); mirrored into the ref via effect for the controller, which
   * reads it outside render, at create time. */
  const visibleCenter = useMemo(
    () => screenToCanvas(viewport, { x: contentViewportSize.width / 2, y: contentViewportSize.height / 2 }),
    [viewport, contentViewportSize],
  );
  useEffect(() => {
    visibleCenterRef.current = visibleCenter;
  }, [visibleCenter]);

  const zoomToFit = useCallback(() => {
    const bounds = graphBounds(graphRef.current, nodeWidth);
    if (!bounds || viewportSize.width === 0) return;
    lastUserViewportChangeRef.current = Date.now();
    setViewport(fitViewport(bounds, viewportSize));
  }, [nodeWidth, viewportSize, setViewport]);

  // §2.1 "Default on first load: zoom-to-fit" — but only for a canvas that has
  // never had its viewport saved. A returning canvas restores its own
  // viewport (§2.5), which happens to also default-initialise to this same
  // `{0,0,1}` shape, so this is an approximation: it re-fits a canvas whose
  // saved viewport genuinely was left at that exact value. Accepted rather
  // than plumbing a separate "never persisted" flag through for one edge case.
  useEffect(() => {
    if (didInitialFitRef.current) return;
    if (loadState !== "ready" || viewportSize.width === 0) return;
    didInitialFitRef.current = true;
    if (graph.nodeIds.length === 0) return;
    if (viewport.x !== 0 || viewport.y !== 0 || viewport.zoom !== 1) return;
    zoomToFit();
  }, [loadState, viewportSize, graph.nodeIds.length, viewport, zoomToFit]);

  /**
   * Recovery, not first-load: a viewport saved on one device (§2.5 restores
   * it exactly, by design) can land a returning visit on a different screen
   * size — most concretely a canvas built on desktop, then reopened on a
   * phone — with every node outside the frame and no node to click, drag or
   * `Tab` to as a way back. Whenever a resize leaves nothing at all visible
   * and the user hasn't just touched the viewport themselves, re-fit rather
   * than leave that dead end standing.
   */
  useEffect(() => {
    if (viewportSize.width === 0 || graph.nodeIds.length === 0) return;
    if (Date.now() - lastUserViewportChangeRef.current < RECENT_USER_VIEWPORT_CHANGE_MS) return;
    const hidden = nodesHiddenByCollapse(graph);
    const anyVisible = graph.nodeIds.some((id) => {
      if (hidden.has(id)) return false;
      const node = graph.nodesById[id];
      return rectInView(
        viewportRef.current,
        { x: node.position.x, y: node.position.y, width: nodeWidth, height: NODE_HEIGHT },
        contentViewportSize,
      );
    });
    if (!anyVisible) zoomToFit();
  }, [contentViewportSize, graph, nodeWidth, zoomToFit]);

  // ---- Pan (drag / space-drag / middle-drag / two-finger scroll) ---------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceHeldRef.current = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceHeldRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      // A held-but-not-yet-long-pressed touch on a node is already panning
      // (below); real movement means it's a pan, not a hold, so the pending
      // drag-entry never fires.
      const longPress = longPressRef.current;
      if (longPress && longPress.pointerId === event.pointerId) {
        const moved =
          Math.abs(event.clientX - longPress.startClientX) > TAP_MOVE_TOLERANCE_PX ||
          Math.abs(event.clientY - longPress.startClientY) > TAP_MOVE_TOLERANCE_PX;
        if (moved) {
          clearTimeout(longPress.timer);
          longPressRef.current = null;
        }
      }
      const pan = panRef.current;
      if (pan && pan.pointerId === event.pointerId) {
        lastUserViewportChangeRef.current = Date.now();
        setViewport({
          zoom: pan.startViewport.zoom,
          x: pan.startViewport.x + (event.clientX - pan.startClientX),
          y: pan.startViewport.y + (event.clientY - pan.startClientY),
        });
        return;
      }
      const drag = dragRef.current;
      if (drag && drag.pointerId === event.pointerId) {
        const zoom = viewportRef.current.zoom;
        const dx = (event.clientX - drag.startClientX) / zoom;
        const dy = (event.clientY - drag.startClientY) / zoom;
        controller.moveNode(drag.nodeId, {
          x: drag.startPos.x + dx,
          y: drag.startPos.y + dy,
        });
        return;
      }
      const resize = resizeRef.current;
      if (resize && resize.pointerId === event.pointerId) {
        const zoom = viewportRef.current.zoom;
        const dx = (event.clientX - resize.startClientX) / zoom;
        const dy = (event.clientY - resize.startClientY) / zoom;
        controller.resizeNode(resize.nodeId, {
          width: clamp(resize.startWidth + dx, NODE_WIDTH_MIN, NODE_WIDTH_MAX),
          height: clamp(resize.startHeight + dy, NODE_HEIGHT_MIN, NODE_HEIGHT_MAX),
        });
      }
    };
    const onUp = (event: PointerEvent) => {
      if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
      if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
      if (resizeRef.current?.pointerId === event.pointerId) resizeRef.current = null;
      if (longPressRef.current?.pointerId === event.pointerId) {
        clearTimeout(longPressRef.current.timer);
        longPressRef.current = null;
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (longPressRef.current) clearTimeout(longPressRef.current.timer);
    };
  }, [controller, setViewport]);

  const handleSurfacePointerDown = (event: React.PointerEvent) => {
    if (isRootsEmpty) return; // §4.1: nothing to navigate yet
    if (isOverCanvasChrome(event.target)) return; // composer/toast — not the canvas
    const overCard = (event.target as HTMLElement).closest('[data-node-role="card"]') !== null;
    const wantsPan = event.button === 1 || spaceHeldRef.current || (event.button === 0 && !overCard);
    if (!wantsPan) return;
    event.preventDefault();
    (event.target as Element).setPointerCapture(event.pointerId);
    panRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startViewport: viewportRef.current,
      overCard: false,
    };
  };

  const handleSurfacePointerUp = (event: React.PointerEvent) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    if (pan.overCard) return; // §6.1 pending touch drag — its own gesture, not a background click
    const moved =
      Math.abs(event.clientX - pan.startClientX) > TAP_MOVE_TOLERANCE_PX ||
      Math.abs(event.clientY - pan.startClientY) > TAP_MOVE_TOLERANCE_PX;
    // A pan that never moved is a click on empty canvas: deselect, and the
    // composer rebinds to the most recent leaf (§2.2).
    if (!moved) controller.select(null);
  };

  const handleSurfaceDoubleClick = (event: React.MouseEvent) => {
    if (isRootsEmpty) return;
    if ((event.target as HTMLElement).closest('[data-node-role="card"]')) return;
    zoomToFit();
  };

  const handleWheel = (event: React.WheelEvent) => {
    if (isRootsEmpty) return;
    const cardBodyEl = findCardBodyElement(event.target);
    const routing = routeWheelEvent({
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      deltaY: event.deltaY,
      cardBody: cardBodyEl
        ? {
            scrollTop: cardBodyEl.scrollTop,
            scrollHeight: cardBodyEl.scrollHeight,
            clientHeight: cardBodyEl.clientHeight,
          }
        : null,
    });
    // Let the browser's native scroll run on the card body: no
    // `preventDefault`, no viewport update. This is the TES-89 fix — the
    // surface used to `preventDefault` every wheel event unconditionally,
    // so the card's own `overflowY: auto` (node-card.tsx) never got the
    // event.
    if (routing === "card-scroll") return;
    event.preventDefault();
    lastUserViewportChangeRef.current = Date.now();
    if (event.ctrlKey || event.metaKey) {
      const rect = surfaceRef.current!.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const nextZoom = viewportRef.current.zoom * Math.exp(-event.deltaY * 0.002);
      setViewport(zoomAt(viewportRef.current, nextZoom, anchor));
    } else {
      setViewport({
        ...viewportRef.current,
        x: viewportRef.current.x - event.deltaX,
        y: viewportRef.current.y - event.deltaY,
      });
    }
  };

  const startNodeDrag = useCallback(
    (event: React.PointerEvent, nodeId: string) => {
      if (event.button !== 0 || spaceHeldRef.current) return; // let it bubble to pan
      const node = graphRef.current.nodesById[nodeId];
      if (!node) return;

      if (event.pointerType === "touch") {
        // TES-89: a touch that lands on an overflowing card body is a scroll
        // reach, not a pan-or-drag reach — hand it to the browser's native
        // scroll (the body's own `touchAction: "pan-y"` overrides the
        // surface's `touchAction: "none"` for gestures that start on it) by
        // never arming the pan/long-press machinery below, and without
        // taking pointer capture, which would fight that native scroll.
        // Short cards (the common case) don't overflow, so §6.1's long-press
        // drag is untouched for them; an overflowing card can still be
        // dragged by long-pressing outside the body — the header or padding.
        const cardBody = findCardBodyElement(event.target);
        if (cardBody && cardBody.scrollHeight > cardBody.clientHeight + 1) return;
      }

      const pointerId = event.pointerId;
      const startClientX = event.clientX;
      const startClientY = event.clientY;
      (event.currentTarget as Element).setPointerCapture(pointerId);

      if (event.pointerType === "touch") {
        // §6.1: touch has no hover to disambiguate "reach for the canvas" from
        // "reach for this node", so a bare touch drag pans like it would
        // anywhere else on the surface. Only a held long-press promotes it to
        // a node drag — see the `onMove`/`onUp` window listeners above for the
        // cancel-on-movement and cancel-on-release paths.
        panRef.current = {
          pointerId,
          startClientX,
          startClientY,
          startViewport: viewportRef.current,
          overCard: true,
        };
        longPressRef.current = {
          pointerId,
          startClientX,
          startClientY,
          timer: setTimeout(() => {
            if (longPressRef.current?.pointerId !== pointerId) return;
            longPressRef.current = null;
            panRef.current = null;
            controller.select(nodeId);
            if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(10);
            dragRef.current = {
              nodeId,
              pointerId,
              startClientX,
              startClientY,
              startPos: node.position,
            };
          }, LONG_PRESS_MS),
        };
        return;
      }

      controller.select(nodeId);
      dragRef.current = {
        nodeId,
        pointerId,
        startClientX,
        startClientY,
        startPos: node.position,
      };
    },
    [controller],
  );

  /** TES-90: starts a corner-handle resize. Reads the card's real rendered
   * size off its DOM element (`nodeElsRef`) rather than trusting `node.size`
   * (which is `null` until the first resize) so the drag starts from
   * wherever the card actually is right now, auto-sized or not. */
  const startNodeResize = useCallback(
    (event: React.PointerEvent, nodeId: string) => {
      const el = nodeElsRef.current.get(nodeId);
      if (!el) return;
      const zoom = viewportRef.current.zoom;
      const rect = el.getBoundingClientRect();
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
      resizeRef.current = {
        nodeId,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startWidth: rect.width / zoom,
        startHeight: rect.height / zoom,
      };
    },
    [],
  );

  // ---- Auto-follow (§2.4): pan (never zoom) a newly-created off-screen node
  // into the lower third, unless the user just touched the viewport. -------

  useEffect(() => {
    const prevKnown = knownNodeIdsRef.current;
    const added = graph.nodeIds.filter((id) => !prevKnown.has(id));
    knownNodeIdsRef.current = new Set(graph.nodeIds);
    if (added.length === 0 || viewportSize.width === 0) return;
    if (Date.now() - lastUserViewportChangeRef.current < RECENT_USER_VIEWPORT_CHANGE_MS) return;
    const newest = added
      .map((id) => graph.nodesById[id])
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    const rect = { x: newest.position.x, y: newest.position.y, width: nodeWidth, height: NODE_HEIGHT };
    if (rectInView(viewportRef.current, rect, contentViewportSize)) return;
    setViewport(panToLowerThird(viewportRef.current, rect, contentViewportSize));
  }, [graph, contentViewportSize, nodeWidth, setViewport]);

  /**
   * TES-75: the auto-follow pan above fires on node *creation*, using the
   * nominal `NODE_HEIGHT` — a completed reply with several wrapped lines
   * renders taller than that estimate, so the pan can undershoot and leave
   * the card's real bottom behind the composer. Once a node's stream reaches
   * a terminal state, re-check its actual rendered height (the element
   * `nodeElsRef` already tracks) and re-pan if it still overlaps the
   * composer's reserved band.
   */
  const nodeStatusesRef = useRef<Map<string, string>>(new Map());
  useLayoutEffect(() => {
    const prevStatuses = nodeStatusesRef.current;
    const justSettled = graph.nodeIds.filter((id) => {
      const prev = prevStatuses.get(id);
      return prev === "streaming" && graph.nodesById[id].status !== "streaming";
    });
    nodeStatusesRef.current = new Map(graph.nodeIds.map((id) => [id, graph.nodesById[id].status]));
    if (justSettled.length === 0 || viewportSize.width === 0) return;
    if (Date.now() - lastUserViewportChangeRef.current < RECENT_USER_VIEWPORT_CHANGE_MS) return;
    const newest = justSettled
      .map((id) => graph.nodesById[id])
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    const el = nodeElsRef.current.get(newest.id);
    const renderedHeight = el ? el.getBoundingClientRect().height / viewportRef.current.zoom : NODE_HEIGHT;
    const rect = { x: newest.position.x, y: newest.position.y, width: nodeWidth, height: renderedHeight };
    if (rectInView(viewportRef.current, rect, contentViewportSize)) return;
    setViewport(panToLowerThird(viewportRef.current, rect, contentViewportSize));
  }, [graph, viewportSize, contentViewportSize, nodeWidth, setViewport]);

  // ---- Keyboard (§7.2) ---------------------------------------------------

  const focusNode = useCallback(
    (nodeId: string) => {
      setFocusedNodeId(nodeId);
      const node = graphRef.current.nodesById[nodeId];
      const el = nodeElsRef.current.get(nodeId);
      el?.focus();
      if (!node || viewportSize.width === 0) return;
      const rect = { x: node.position.x, y: node.position.y, width: nodeWidth, height: NODE_HEIGHT };
      if (rectInView(viewportRef.current, rect, contentViewportSize)) return;
      lastUserViewportChangeRef.current = Date.now();
      setViewport(focusOn(rect, contentViewportSize, viewportRef.current.zoom, 0.5));
    },
    [viewportSize, contentViewportSize, nodeWidth, setViewport],
  );

  const zoomCenteredOnFocus = useCallback(
    (nextZoom: number) => {
      const node = rovingId ? graphRef.current.nodesById[rovingId] : null;
      const anchor = node
        ? {
            x: (node.position.x + nodeWidth / 2) * viewportRef.current.zoom + viewportRef.current.x,
            y: (node.position.y + NODE_HEIGHT / 2) * viewportRef.current.zoom + viewportRef.current.y,
          }
        : { x: viewportSize.width / 2, y: viewportSize.height / 2 };
      lastUserViewportChangeRef.current = Date.now();
      setViewport(zoomAt(viewportRef.current, nextZoom, anchor));
    },
    [rovingId, nodeWidth, viewportSize, setViewport],
  );

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const activeTag = (document.activeElement as HTMLElement | null)?.tagName;
    if (activeTag === "TEXTAREA" || activeTag === "INPUT") return; // own their own keys

    const current = rovingId;
    const node = current ? graph.nodesById[current] : null;

    // TES-90: Cmd/Ctrl+Alt+arrows resizes the focused card — checked before
    // the plain Alt+arrows move below, since that condition alone would also
    // match here. Reads the real rendered size off the DOM the same way
    // `startNodeResize` does, so the first keyboard resize doesn't jump from
    // whatever `node.size` happens to be (usually `null`).
    if (
      event.key.startsWith("Arrow") &&
      event.altKey &&
      (event.metaKey || event.ctrlKey) &&
      current &&
      node
    ) {
      event.preventDefault();
      const step = event.shiftKey ? 32 : 8;
      const el = nodeElsRef.current.get(current);
      const rect = el?.getBoundingClientRect();
      const zoom = viewportRef.current.zoom;
      const currentWidth = effectiveWidth(node, nodeWidth);
      const currentHeight = node.size?.height ?? (rect ? rect.height / zoom : NODE_HEIGHT);
      const delta: Record<string, [number, number]> = {
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
      };
      const [dw, dh] = delta[event.key];
      controller.resizeNode(current, {
        width: clamp(currentWidth + dw, NODE_WIDTH_MIN, NODE_WIDTH_MAX),
        height: clamp(currentHeight + dh, NODE_HEIGHT_MIN, NODE_HEIGHT_MAX),
      });
      return;
    }

    if (event.key.startsWith("Arrow") && event.altKey && current && node) {
      event.preventDefault();
      const step = event.shiftKey ? 64 : 16;
      const delta: Record<string, [number, number]> = {
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
      };
      const [dx, dy] = delta[event.key];
      controller.moveNode(current, { x: node.position.x + dx, y: node.position.y + dy });
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      if (deletedToast) {
        event.preventDefault();
        controller.undoDelete();
      }
      return;
    }

    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

    switch (key) {
      case "ArrowUp":
        event.preventDefault();
        if (node?.parentId) focusNode(node.parentId);
        break;
      case "ArrowDown": {
        event.preventDefault();
        if (current) {
          const kids = childIds(graph, current);
          if (kids.length > 0) focusNode(kids[0]);
        }
        break;
      }
      case "ArrowLeft":
      case "ArrowRight": {
        event.preventDefault();
        if (node) {
          const siblings = node.parentId ? childIds(graph, node.parentId) : rootIds(graph);
          const idx = siblings.indexOf(node.id);
          const nextIdx = key === "ArrowLeft" ? idx - 1 : idx + 1;
          if (nextIdx >= 0 && nextIdx < siblings.length) focusNode(siblings[nextIdx]);
        }
        break;
      }
      case "Home": {
        event.preventDefault();
        const [root] = rootIds(graph);
        if (root) focusNode(root);
        break;
      }
      case "End": {
        event.preventDefault();
        const [leaf] = leavesByRecency(graph);
        if (leaf) focusNode(leaf.id);
        break;
      }
      case "Enter":
        if (current) {
          event.preventDefault();
          controller.select(current);
          requestAnimationFrame(() => composerRef.current?.focus());
        }
        break;
      case "b":
        if (current) {
          event.preventDefault();
          controller.branch(current);
          requestAnimationFrame(() => composerRef.current?.focus());
        }
        break;
      case "r":
        if (current) {
          event.preventDefault();
          controller.regenerate(current);
        }
        break;
      case "c":
        if (current) {
          event.preventDefault();
          controller.toggleCollapsed(current);
        }
        break;
      case "m":
        if (current) {
          event.preventDefault();
          controller.toggleBodyCollapsed(current);
        }
        break;
      case "Delete":
      case "Backspace":
        if (current) {
          event.preventDefault();
          controller.requestDelete(current);
        }
        break;
      case "Escape":
        if (current && node?.status === "streaming") {
          event.preventDefault();
          controller.stop(current);
        }
        break;
      case "+":
      case "=":
        event.preventDefault();
        zoomCenteredOnFocus(viewportRef.current.zoom * ZOOM_STEP_FACTOR);
        break;
      case "-":
      case "_":
        event.preventDefault();
        zoomCenteredOnFocus(viewportRef.current.zoom / ZOOM_STEP_FACTOR);
        break;
      case "0":
        event.preventDefault();
        zoomToFit();
        break;
      case "1":
        event.preventDefault();
        zoomCenteredOnFocus(1);
        break;
      case "l":
        event.preventDefault();
        controller.tidy();
        break;
      case "f":
        event.preventDefault();
        setFocusPathMode((v) => !v);
        break;
      case "t":
        event.preventDefault();
        setShowLinearView((v) => !v);
        break;
      case "?":
        event.preventDefault();
        setShowShortcuts(true);
        break;
      default:
        break;
    }
  };

  // ---- Derived render data ------------------------------------------------

  const pathAnchorId = selectedNodeId ?? rovingId;
  const highlightedPath = new Set(
    (focusPathMode || selectedNodeId) && pathAnchorId
      ? pathToRoot(graph, pathAnchorId).map((n) => n.id)
      : [],
  );
  const hiddenByCollapse = nodesHiddenByCollapse(graph);

  const margin = 400;
  const visibleIds = graph.nodeIds.filter((id) => {
    if (hiddenByCollapse.has(id)) return false;
    if (graph.nodeIds.length <= DENSE_GRAPH_THRESHOLD) return true;
    const node = graph.nodesById[id];
    return rectInView(
      viewport,
      { x: node.position.x, y: node.position.y, width: nodeWidth, height: NODE_HEIGHT },
      { width: viewportSize.width + margin * 2, height: viewportSize.height + margin * 2 },
    );
  });

  // TES-102: state of the inbound edge landing on each visible node, keyed
  // by the child (there is exactly one inbound edge per node). Computed once
  // here — rather than inline in the `<Edge>` map below — so the same value
  // also drives the materialised port on `<NodeCard>`; a port and the wire
  // it terminates must always agree, and a single source of truth is what
  // guarantees that instead of two copies of this ternary drifting apart.
  const edgeStateByChildId = new Map<string, "active" | "dimmed" | "default">();
  for (const id of visibleIds) {
    const node = graph.nodesById[id];
    if (!node.parentId || hiddenByCollapse.has(node.parentId)) continue;
    const parent = graph.nodesById[node.parentId];
    const onPath = highlightedPath.has(node.id) && highlightedPath.has(parent.id);
    edgeStateByChildId.set(
      id,
      node.status === "streaming" ? "active" : onPath ? "active" : (focusPathMode || selectedNodeId) ? "dimmed" : "default",
    );
  }
  // A card's outbound port is "active" when the one child on the highlighted
  // path currently reads that way — i.e. some child's inbound state is
  // itself active.
  const activeOutboundParentIds = new Set(
    [...edgeStateByChildId.entries()]
      .filter(([, state]) => state === "active")
      .map(([childId]) => graph.nodesById[childId].parentId)
      .filter((id): id is string => id !== null),
  );

  /** TES-103 item 5: where the *next* branch will land, computed from the
   * moment the composer is bound rather than waiting for a send — reuses
   * `reflowChildrenOnCreate`, the same placement `createAndStream`
   * (`use-canvas-controller.ts`) uses for the real node, so the skeleton can
   * never land somewhere the real card then doesn't. `null` whenever nothing
   * would actually be created right now (composer disabled, or the canvas is
   * still on the empty/starter state — that screen already has its own
   * centered headline and starter chips, and a dashed card behind them would
   * compete with that layout rather than preview anything; scoped to the
   * Branch flow the ticket's complaint was actually about). */
  const previewNodePosition = (() => {
    if (!hasProvider || composerDisabledReason || isRootsEmpty) return null;
    if (!effectiveComposerTarget) return null;
    const { graph: withPreview } = addNode(graph, {
      id: "__tes103_preview__",
      parentId: effectiveComposerTarget,
      prompt: "",
      position: { x: 0, y: 0 },
    });
    const reflowed = reflowChildrenOnCreate(
      withPreview,
      effectiveComposerTarget,
      nodeWidth,
      nodeHeights,
      nodeWidthsFrom(withPreview, nodeWidth),
    );
    return reflowed.nodesById.__tes103_preview__.position;
  })();

  const composerTargetNode = effectiveComposerTarget ? graph.nodesById[effectiveComposerTarget] : null;
  const composerTargetLabel = composerTargetNode
    ? `Node ${graph.nodeIds.indexOf(composerTargetNode.id) + 1}`
    : null;

  const disabledPlaceholder =
    composerDisabledReason === "offline"
      ? copy("composer.placeholder.offline")
      : composerDisabledReason === "rate-limited"
        ? copy("composer.placeholder.rateLimited")
        : composerDisabledReason === "target-unanswered"
          ? copy("branch.disabled")
          : undefined;

  const showRateLimitBanner = rateLimit !== null && rateLimit.remaining <= 0;

  const deleteToastNode = deletedToast ? (
    <Toast
      message={
        deletedToast.count > 0
          ? copy("delete.undo.subtree", { n: deletedToast.count })
          : copy("delete.undo")
      }
      actionLabel={copy("delete.undo.action")}
      onAction={controller.undoDelete}
    />
  ) : null;

  return (
    <main
      className="canvas-surface"
      style={{
        position: "fixed",
        inset: 0,
        height: "100dvh",
        overflow: "hidden",
        overscrollBehavior: "none",
        display: "flex",
        flexDirection: "column",
        background: "var(--canvas-bg)",
        color: "var(--text-primary)",
      }}
    >
      <TopBar
        showCanvasControls={loadState === "ready" && !isRootsEmpty}
        rateLimit={rateLimit}
        models={models}
        model={model}
        onModelChange={setModel}
        onZoomIn={() => zoomCenteredOnFocus(viewportRef.current.zoom * ZOOM_STEP_FACTOR)}
        onZoomOut={() => zoomCenteredOnFocus(viewportRef.current.zoom / ZOOM_STEP_FACTOR)}
        onZoomToFit={zoomToFit}
        onTidy={controller.tidy}
        zoomPercent={Math.round(viewport.zoom * 100)}
        email={email}
        isMobile={isMobile}
      />

      {!isOnline ? (
        <div
          role="status"
          style={{
            padding: "var(--space-2) var(--space-5)",
            background: "var(--surface-2)",
            color: "var(--text-secondary)",
            font: "var(--text-xs)",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          {copy("offline.banner")}
        </div>
      ) : null}

      {showRateLimitBanner && rateLimit ? (
        <div
          role="status"
          style={{
            padding: "var(--space-2) var(--space-5)",
            background: "var(--surface-2)",
            color: "var(--warning)",
            font: "var(--text-xs)",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          {copy("limit.banner", {
            total: rateLimit.limit,
            time: formatResetTime(rateLimit.resetSeconds),
          })}
        </div>
      ) : null}

      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {loadState === "loading" ? (
          <CanvasLoadingSkeleton />
        ) : loadState === "load-error" ? (
          <CanvasLoadError />
        ) : (
          <div
            ref={attachSurfaceRef}
            role="application"
            aria-roledescription="conversation canvas"
            aria-label="Conversation canvas. Press T for a linear, screen-reader-friendly transcript of the current path."
            tabIndex={-1}
            onPointerDown={handleSurfacePointerDown}
            onPointerUp={handleSurfacePointerUp}
            onDoubleClick={handleSurfaceDoubleClick}
            onWheel={handleWheel}
            onKeyDown={handleKeyDown}
            style={{
              position: "absolute",
              inset: 0,
              overflow: "hidden",
              touchAction: "none",
              backgroundImage:
                viewport.zoom >= 0.4
                  ? `radial-gradient(var(--canvas-dot) 1px, transparent 1px)`
                  : undefined,
              backgroundSize: `${24 * viewport.zoom}px ${24 * viewport.zoom}px`,
              backgroundPosition: `${viewport.x}px ${viewport.y}px`,
            }}
          >
            {/* §5.8: cyanotype paper + millimetre grid + grain. All three are
             * `display: none` outside `prefers-color-scheme: dark` (canvas.css)
             * — see that file's header note on why dark-chrome-only is a media
             * query here rather than a class this component would have to
             * compute. Rendered unconditionally, including the empty-canvas
             * state, since the paper is the surface itself, not a decoration
             * that waits for a first node. Purely decorative: aria-hidden,
             * `pointerEvents: "none"`, and the paint order below the edges/
             * node layers this file already z-indexes. */}
            <div aria-hidden="true" className="cv-paper-layer" style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />
            <div
              aria-hidden="true"
              className="cv-mm-grid cv-mm-grid-major"
              style={{
                position: "absolute",
                left: -16000,
                top: -16000,
                width: 32000,
                height: 32000,
                transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
                transformOrigin: "0 0",
                pointerEvents: "none",
              }}
            />
            <div
              aria-hidden="true"
              className="cv-mm-grid cv-mm-grid-minor"
              style={{
                position: "absolute",
                left: -16000,
                top: -16000,
                width: 32000,
                height: 32000,
                transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
                transformOrigin: "0 0",
                // §5.8: the minor rule reads as moiré below zoom 0.4 — same
                // threshold the existing dot-grid above already fades out at.
                opacity: viewport.zoom < 0.4 ? 0 : 1,
                pointerEvents: "none",
              }}
            />
            <div
              aria-hidden="true"
              className="cv-grain-layer"
              style={{ position: "absolute", inset: 0, zIndex: "var(--z-grain)", pointerEvents: "none" }}
            />

            {isRootsEmpty ? (
              <>
                <EmptyCanvasContent
                  hasProvider={hasProvider}
                  starterDraft={starterDraft}
                  onPickStarter={setStarterDraft}
                  onSend={controller.send}
                  composerRef={composerRef}
                />
                {/* Reachable only by deleting the last remaining root — the
                 * canvas goes straight from one node to `canvas.empty`, and
                 * the undo path has to survive that transition too. */}
                {deleteToastNode ? (
                  <div
                    style={{
                      position: "absolute",
                      left: "50%",
                      bottom: "var(--space-5)",
                      transform: "translateX(-50%)",
                      zIndex: "var(--z-toast)",
                    }}
                  >
                    {deleteToastNode}
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <svg
                  className="cv-world"
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    overflow: "visible",
                    pointerEvents: "none",
                    zIndex: "var(--z-edges)",
                  }}
                >
                  <EdgeMarkerDefs />
                  <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
                    {visibleIds.map((id) => {
                      const node = graph.nodesById[id];
                      if (!node.parentId || hiddenByCollapse.has(node.parentId)) return null;
                      const parent = graph.nodesById[node.parentId];
                      const state = edgeStateByChildId.get(id) ?? "default";
                      return (
                        <Edge
                          key={id}
                          from={{
                            x: parent.position.x,
                            y: parent.position.y,
                            width: effectiveWidth(parent, nodeWidth),
                            height: nodeHeights.get(parent.id) ?? NODE_HEIGHT,
                          }}
                          to={{
                            x: node.position.x,
                            y: node.position.y,
                            width: effectiveWidth(node, nodeWidth),
                            height: nodeHeights.get(node.id) ?? NODE_HEIGHT,
                          }}
                          state={state}
                          pending={node.status === "draft" || node.status === "streaming"}
                        />
                      );
                    })}
                  </g>
                </svg>

                <div
                  className="cv-world"
                  style={{
                    position: "absolute",
                    inset: 0,
                    transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
                    transformOrigin: "0 0",
                    zIndex: "var(--z-node)",
                  }}
                >
                  {visibleIds.map((id) => {
                    const node = graph.nodesById[id];
                    const isSelected = id === effectiveComposerTarget;
                    const siblings = node.parentId ? childIds(graph, node.parentId) : rootIds(graph);
                    return (
                      <div
                        key={id}
                        className="cv-node-slot"
                        style={{ transform: `translate(${node.position.x}px, ${node.position.y}px)` }}
                      >
                        <NodeCard
                          node={node}
                          width={effectiveWidth(node, nodeWidth)}
                          height={node.size?.height ?? null}
                          isSelected={isSelected}
                          tabIndex={id === rovingId ? 0 : -1}
                          childCount={childIds(graph, id).length}
                          depth={pathToRoot(graph, id).length - 1}
                          siblingIndex={siblings.indexOf(id)}
                          siblingCount={siblings.length}
                          queueAhead={queuePosition[id] ?? null}
                          streamStartedAt={streamStartedAt[id] ?? null}
                          canBranch={canBranchNow(node) && !isRootsEmpty}
                          branchDisabledReason={
                            canBranchNow(node) ? null : copy("branch.disabled")
                          }
                          onSelect={() => controller.select(id)}
                          onFocusNode={() => setFocusedNodeId(id)}
                          onBranch={() => {
                            controller.branch(id);
                            requestAnimationFrame(() => composerRef.current?.focus());
                          }}
                          onRegenerate={() => controller.regenerate(id)}
                          onDelete={() => controller.requestDelete(id)}
                          onRetry={() => controller.retry(id)}
                          onRemove={() => controller.removeErrorNode(id)}
                          onContinue={() => controller.continueNode(id)}
                          onStop={() => controller.stop(id)}
                          onToggleCollapsed={() => controller.toggleCollapsed(id)}
                          onToggleBodyCollapsed={() => controller.toggleBodyCollapsed(id)}
                          onPointerDownCard={(event) => startNodeDrag(event, id)}
                          onPointerDownResizeHandle={(event) => startNodeResize(event, id)}
                          onRegisterRef={handleRegisterNodeRef}
                          showFirstRunPulse={
                            !hasBranchedOnce && node.parentId === null && node.status === "complete"
                          }
                          portInboundState={edgeStateByChildId.get(id) ?? "default"}
                          portOutboundActive={activeOutboundParentIds.has(id)}
                        />
                      </div>
                    );
                  })}
                  {previewNodePosition ? (
                    <div
                      className="cv-node-slot"
                      aria-hidden="true"
                      style={{
                        transform: `translate(${previewNodePosition.x}px, ${previewNodePosition.y}px)`,
                      }}
                    >
                      <div
                        style={{
                          width: nodeWidth,
                          minHeight: 120,
                          display: "flex",
                          flexDirection: "column",
                          gap: "var(--space-2)",
                          padding: "var(--space-4)",
                          borderRadius: "var(--radius-lg)",
                          border: "1px dashed var(--border-default)",
                          pointerEvents: "none",
                        }}
                      >
                        <div className="cv-skeleton-bar" style={{ height: 10, width: "40%", borderRadius: "var(--radius-full)" }} />
                        <div className="cv-skeleton-bar" style={{ height: 10, width: "100%", borderRadius: "var(--radius-full)" }} />
                        <div className="cv-skeleton-bar" style={{ height: 10, width: "70%", borderRadius: "var(--radius-full)" }} />
                      </div>
                    </div>
                  ) : null}
                </div>
              </>
            )}

            {!isRootsEmpty ? (
              <div
                ref={attachComposerChrome}
                data-canvas-role="chrome"
                style={{
                  position: "absolute",
                  left: "50%",
                  bottom: "var(--space-5)",
                  transform: "translateX(-50%)",
                  width: "100%",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: "var(--space-3)",
                  padding: "0 var(--space-4)",
                  zIndex: "var(--z-composer)",
                  pointerEvents: "none",
                }}
              >
                {deleteToastNode ? (
                  <div style={{ pointerEvents: "auto", zIndex: "var(--z-toast)" }}>{deleteToastNode}</div>
                ) : null}
                <div style={{ pointerEvents: "auto", width: "100%", maxWidth: 640 }}>
                  {hasProvider ? (
                    <Composer
                      variant="docked"
                      targetLabel={composerTargetLabel}
                      disabled={composerDisabledReason !== null}
                      disabledPlaceholder={disabledPlaceholder}
                      onSend={controller.send}
                      composerRef={composerRef}
                      onEscape={() => {
                        if (effectiveComposerTarget) nodeElsRef.current.get(effectiveComposerTarget)?.focus();
                      }}
                    />
                  ) : (
                    <ConnectModelCard />
                  )}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {showLinearView && pathAnchorId ? (
        <LinearView path={pathToRoot(graph, pathAnchorId)} onClose={() => setShowLinearView(false)} />
      ) : null}

      {showShortcuts ? <ShortcutsSheet onClose={() => setShowShortcuts(false)} /> : null}
    </main>
  );
}

function EmptyCanvasContent({
  hasProvider,
  starterDraft,
  onPickStarter,
  onSend,
  composerRef,
}: {
  hasProvider: boolean;
  starterDraft: string | undefined;
  onPickStarter: (text: string) => void;
  onSend: (text: string) => void;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-5)",
        gap: "var(--space-3)",
      }}
    >
      <div style={{ maxWidth: 560, width: "100%", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <span style={{ font: "var(--text-sm)", color: "var(--text-secondary)" }}>Node Canvas Chat</span>
        <h1
          style={{
            font: "var(--text-2xl)",
            letterSpacing: "var(--tracking-2xl)",
            color: "var(--text-primary)",
            textAlign: "center",
            marginTop: "var(--space-3)",
          }}
        >
          {copy("empty.headline")}
        </h1>

        <div style={{ marginTop: "var(--space-6)", width: "100%" }}>
          {hasProvider ? (
            <Composer
              variant="centered"
              targetLabel={null}
              disabled={false}
              initialValue={starterDraft}
              onSend={onSend}
              composerRef={composerRef}
            />
          ) : (
            <ConnectModelCard />
          )}
        </div>

        {hasProvider ? <StarterChips onPick={onPickStarter} /> : null}

        <div style={{ marginTop: "var(--space-8)" }}>
          <EmptyStateDiagram />
        </div>
      </div>
    </div>
  );
}

function CanvasLoadingSkeleton() {
  return (
    <div
      aria-busy="true"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundImage: `radial-gradient(var(--canvas-dot) 1px, transparent 1px)`,
        backgroundSize: "24px 24px",
      }}
    >
      <div
        className="cv-skeleton-bar"
        style={{ width: 320, height: 160, borderRadius: "var(--radius-lg)" }}
      />
    </div>
  );
}

function CanvasLoadError() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundImage: `radial-gradient(var(--canvas-dot) 1px, transparent 1px)`,
        backgroundSize: "24px 24px",
      }}
    >
      <div
        style={{
          background: "var(--surface-1)",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-2)",
          padding: "var(--space-5)",
          textAlign: "center",
        }}
      >
        <p style={{ font: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
          {copy("canvas.loadError")}
        </p>
        <button
          type="button"
          className="cv-focus-ring"
          onClick={() => window.location.reload()}
          style={{
            marginTop: "var(--space-3)",
            height: 36,
            padding: "0 var(--space-4)",
            borderRadius: "var(--radius-md)",
            background: "var(--accent)",
            color: "var(--accent-fg)",
            font: "var(--text-xs)",
          }}
        >
          {copy("canvas.loadRetry")}
        </button>
      </div>
    </div>
  );
}
