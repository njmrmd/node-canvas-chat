"use client";

import {
  useCallback,
  useEffect,
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
  zoomAt,
  ZOOM_STEP_FACTOR,
  type Viewport,
} from "@/lib/canvas/viewport";
import { graphBounds, NODE_WIDTH_DESKTOP, NODE_WIDTH_MOBILE } from "@/lib/canvas/layout";
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
  const controller = useCanvasController({ provider: "anthropic", model, isMobile });
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
        viewportSize,
      );
    });
    if (!anyVisible) zoomToFit();
  }, [viewportSize, graph, nodeWidth, zoomToFit]);

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
      }
    };
    const onUp = (event: PointerEvent) => {
      if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
      if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
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
    if (rectInView(viewportRef.current, rect, viewportSize)) return;
    setViewport(panToLowerThird(viewportRef.current, rect, viewportSize));
  }, [graph, viewportSize, nodeWidth, setViewport]);

  // ---- Keyboard (§7.2) ---------------------------------------------------

  const focusNode = useCallback(
    (nodeId: string) => {
      setFocusedNodeId(nodeId);
      const node = graphRef.current.nodesById[nodeId];
      const el = nodeElsRef.current.get(nodeId);
      el?.focus();
      if (!node || viewportSize.width === 0) return;
      const rect = { x: node.position.x, y: node.position.y, width: nodeWidth, height: NODE_HEIGHT };
      if (rectInView(viewportRef.current, rect, viewportSize)) return;
      lastUserViewportChangeRef.current = Date.now();
      setViewport(focusOn(rect, viewportSize, viewportRef.current.zoom, 0.5));
    },
    [viewportSize, nodeWidth, setViewport],
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
                      const onPath = highlightedPath.has(node.id) && highlightedPath.has(parent.id);
                      const state =
                        node.status === "streaming" ? "active" : onPath ? "active" : (focusPathMode || selectedNodeId) ? "dimmed" : "default";
                      return (
                        <Edge
                          key={id}
                          from={{ x: parent.position.x + nodeWidth / 2, y: parent.position.y + NODE_HEIGHT }}
                          to={{ x: node.position.x + nodeWidth / 2, y: node.position.y }}
                          state={state}
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
                          width={nodeWidth}
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
                          onEditSubmit={(text) => controller.editSubmit(id, text)}
                          onDelete={() => controller.requestDelete(id)}
                          onRetry={() => controller.retry(id)}
                          onRemove={() => controller.removeErrorNode(id)}
                          onContinue={() => controller.continueNode(id)}
                          onStop={() => controller.stop(id)}
                          onToggleCollapsed={() => controller.toggleCollapsed(id)}
                          onPointerDownCard={(event) => startNodeDrag(event, id)}
                          registerRef={(el) => {
                            if (el) nodeElsRef.current.set(id, el);
                            else nodeElsRef.current.delete(id);
                          }}
                          showFirstRunPulse={
                            !hasBranchedOnce && node.parentId === null && node.status === "complete"
                          }
                        />
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {!isRootsEmpty ? (
              <div
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
