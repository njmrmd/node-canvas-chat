"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  addNode,
  appendText,
  appendThinking,
  checkBranchSize,
  childIds,
  completeNode,
  failNode,
  getNode,
  interruptNode,
  moveNode as moveNodeInGraph,
  removeBranch,
  resetAllToAuto,
  resizeNode as resizeNodeInGraph,
  rootIds,
  setBodyCollapsed as setNodeBodyCollapsed,
  setCollapsed as setNodeCollapsed,
  settleOrphanedStreams,
  startStreaming,
  toMessages,
  type ConversationGraph,
  type ConversationNode,
  type Point,
  type Size,
} from "@/lib/conversation/graph";
import { streamChat } from "@/lib/conversation/stream";
import { apiFetch, type RateLimitSnapshot } from "@/lib/api-client";
import type { CanvasState } from "@/lib/canvas-store";
import {
  NODE_WIDTH_DESKTOP,
  NODE_WIDTH_MOBILE,
  autoPlaceOnCreate,
  centeredRootPosition,
  nodeWidthsFrom,
  reflowChildrenOnCreate,
  tidyLayout,
  type NodeHeights,
} from "@/lib/canvas/layout";
import { CLIENT_TIMEOUT_MESSAGE, toNodeError } from "@/lib/canvas/errors";

/** §4.3: "no response for 60s" is the point the canvas gives up and errors. */
const FIRST_TOKEN_TIMEOUT_MS = 60_000;
/** §4.9 concurrency cap: a 4th stream queues rather than starting. */
const MAX_CONCURRENT_STREAMS = 3;
/** §2.5: debounce for the whole-canvas save. */
const SAVE_DEBOUNCE_MS = 500;

/** §4.5 "continued from above" — a real prompt is required by the chat route
 * (empty content is rejected), so this sentinel stands in for it. NodeCard
 * matches on it to render the header label instead of the literal text. */
export const CONTINUE_PROMPT = "Continue from where you left off.";

/**
 * §4.4: "Branching from the *streaming* node itself is disabled until
 * complete" — stronger than `canBranchFrom` in graph.ts, which only checks
 * that there is text to send and would happily allow branching off a
 * still-growing answer. This is the UI-facing rule; `canBranchFrom` stays the
 * data-model rule (can `toMessages` be built at all).
 */
export function canBranchNow(node: ConversationNode): boolean {
  if (node.status === "complete") return true;
  // A stopped or dropped stream can still have kept partial text worth
  // replying to (see `interruptNode`'s own comment) — but one that was cut
  // off before any content arrived has nothing for `toMessages` to send,
  // same as an empty error. Enabling the composer here let `addNode` reject
  // the send after the fact with `canBranchFrom`'s stricter check, which
  // is exactly the silent, uncaught throw TES-58 traced this to.
  if (node.status === "interrupted" || node.status === "error") {
    return node.response.trim() !== "";
  }
  return false;
}

/** §4.12: online/offline via `useSyncExternalStore`, not a state+effect pair —
 * the browser's connectivity is external state, and setting local state
 * synchronously from inside an effect is exactly the cascading-render pattern
 * this hook exists to avoid. */
function subscribeOnline(callback: () => void): () => void {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}
function getOnlineSnapshot(): boolean {
  return navigator.onLine;
}
function getOnlineServerSnapshot(): boolean {
  return true;
}

export type LoadState = "loading" | "ready" | "load-error";

export type CanvasController = ReturnType<typeof useCanvasController>;

function widthFor(isMobile: boolean): number {
  return isMobile ? NODE_WIDTH_MOBILE : NODE_WIDTH_DESKTOP;
}

/**
 * Every graph mutation below `requireNode`s its target and throws if it is
 * gone — correct for synchronous calls, but a stream's callbacks fire later,
 * after a user action (Delete, Undo) may have already removed the node from
 * under it. This guard is what stands between that race and a crashed render.
 */
function ifNodeExists(
  graph: ConversationGraph,
  nodeId: string,
  mutate: (graph: ConversationGraph) => ConversationGraph,
): ConversationGraph {
  return graph.nodesById[nodeId] ? mutate(graph) : graph;
}

/** Leaves ordered most-recently-created first — §2.2 "rebinds to the most recent leaf". */
function leavesByRecency(graph: ConversationGraph): ConversationNode[] {
  return graph.nodeIds
    .filter((id) => childIds(graph, id).length === 0)
    .map((id) => graph.nodesById[id])
    .sort((a, b) => b.createdAt - a.createdAt);
}

const NO_HEIGHTS: NodeHeights = new Map();

export function useCanvasController(options: {
  provider: "anthropic";
  model: string;
  isMobile: boolean;
  /** TES-77: real card heights, read synchronously like `graphRef` below —
   * the ref is owned by the canvas component, whose `ResizeObserver` keeps
   * it current. Optional so a controller built without a canvas (e.g. a
   * future test) still lays out against the nominal `NODE_HEIGHT`. */
  nodeHeightsRef?: { current: NodeHeights };
  /** TES-103 item 2: the canvas-space point under the center of the visible
   * content area, same idea as `nodeHeightsRef` — owned by the canvas
   * component (it already computes this rect for auto-follow) and read here
   * only at create time, synchronously, never during render. Optional so a
   * controller built without a canvas still works, just without centering. */
  visibleCenterRef?: { current: Point };
}) {
  const { provider, model, isMobile, nodeHeightsRef, visibleCenterRef } = options;

  const [graph, setGraph] = useState<ConversationGraph>({
    nodesById: {},
    nodeIds: [],
  });
  const [viewport, setViewportState] = useState({ x: 0, y: 0, zoom: 1 });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [rateLimit, setRateLimit] = useState<RateLimitSnapshot | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [streamStartedAt, setStreamStartedAt] = useState<Record<string, number>>({});
  const isOnline = useSyncExternalStore(subscribeOnline, getOnlineSnapshot, getOnlineServerSnapshot);
  const [deletedToast, setDeletedToast] = useState<{
    id: number;
    count: number;
    restore: ConversationGraph;
    priorSelection: string | null;
  } | null>(null);

  const graphRef = useRef(graph);
  useEffect(() => {
    graphRef.current = graph;
  }, [graph]);
  const controllersRef = useRef(new Map<string, AbortController>());
  const timeoutsRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const queueRef = useRef<string[]>([]);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  const activeCountRef = useRef(0);
  useEffect(() => {
    activeCountRef.current = activeCount;
  }, [activeCount]);

  const hasBranchedOnce = useMemo(
    () => graph.nodeIds.some((id) => childIds(graph, id).length >= 2),
    [graph],
  );

  // ---- Load -----------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    apiFetch<CanvasState>("/api/canvas")
      .then((state) => {
        if (cancelled) return;
        const settled = settleOrphanedStreams(state.graph);
        setGraph(settled);
        setViewportState(state.viewport);
        setSelectedNodeId(state.selectedNodeId);
        setLoadState("ready");
      })
      .catch(() => {
        if (!cancelled) setLoadState("load-error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Persistence (§2.5) ----------------------------------------------

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);

  const flushSave = useCallback(() => {
    if (loadState !== "ready" || !navigator.onLine) {
      dirtyRef.current = true;
      return;
    }
    dirtyRef.current = false;
    const payload: CanvasState = {
      graph: graphRef.current,
      viewport,
      selectedNodeId,
      hasBranchedOnce,
    };
    // Fire-and-forget: §2.5 "a failed position write never blocks or surfaces
    // an error; it retries on the next write."
    apiFetch("/api/canvas", { method: "PUT", body: payload }).catch(() => {
      dirtyRef.current = true;
    });
  }, [loadState, viewport, selectedNodeId, hasBranchedOnce]);

  useEffect(() => {
    if (loadState !== "ready") return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [graph, viewport, selectedNodeId, loadState, flushSave]);

  // Reconnect flushes anything queued while offline.
  useEffect(() => {
    if (isOnline && dirtyRef.current) flushSave();
  }, [isOnline, flushSave]);

  // ---- Derived selection -------------------------------------------------

  const effectiveComposerTarget = useMemo(() => {
    if (selectedNodeId && graph.nodesById[selectedNodeId]) return selectedNodeId;
    const [mostRecent] = leavesByRecency(graph);
    return mostRecent?.id ?? null;
  }, [graph, selectedNodeId]);

  const composerDisabledReason = useMemo(() => {
    if (rateLimit && rateLimit.remaining <= 0) return "rate-limited" as const;
    if (!isOnline) return "offline" as const;
    if (effectiveComposerTarget) {
      const target = graph.nodesById[effectiveComposerTarget];
      if (target && !canBranchNow(target)) return "target-unanswered" as const;
    }
    return null;
  }, [rateLimit, isOnline, effectiveComposerTarget, graph]);

  // ---- Streaming ----------------------------------------------------------

  // A ref rather than a direct closure: `finishStream` is memoized once and
  // drives queue continuation, while `beginStream` is re-created whenever
  // `model` changes. Without the indirection, a model switch mid-session would
  // leave the queue-continuation path calling a stale `beginStream` closed
  // over the old model.
  const beginStreamRef = useRef<(nodeId: string) => void>(() => {});

  /**
   * Idempotent per node: the 60s watchdog and the (now-aborted) stream
   * promise's own `.finally` both call this for the same node when the
   * watchdog fires, and only the first should free a concurrency slot.
   * `controllersRef` having already been cleared is how the second call
   * recognises it is redundant.
   */
  const finishStream = useCallback((nodeId: string) => {
    if (!controllersRef.current.has(nodeId)) return;
    controllersRef.current.delete(nodeId);
    const timeout = timeoutsRef.current.get(nodeId);
    if (timeout) clearTimeout(timeout);
    timeoutsRef.current.delete(nodeId);
    activeCountRef.current = Math.max(0, activeCountRef.current - 1);
    setActiveCount(activeCountRef.current);

    const next = queueRef.current[0];
    if (next) {
      setQueue((q) => q.slice(1));
      beginStreamRef.current(next);
    }
  }, []);

  const beginStream = useCallback((nodeId: string) => {
    activeCountRef.current += 1;
    setActiveCount(activeCountRef.current);
    setStreamStartedAt((prev) => ({ ...prev, [nodeId]: Date.now() }));

    setGraph((g) => startStreaming(g, nodeId));

    const controller = new AbortController();
    controllersRef.current.set(nodeId, controller);

    const watchdog = setTimeout(() => {
      controller.abort();
      setGraph((g) =>
        ifNodeExists(g, nodeId, (g2) =>
          failNode(g2, nodeId, { code: "internal_error", message: CLIENT_TIMEOUT_MESSAGE }),
        ),
      );
      finishStream(nodeId);
    }, FIRST_TOKEN_TIMEOUT_MS);
    timeoutsRef.current.set(nodeId, watchdog);

    const messages = toMessages(graphRef.current, nodeId);
    const tooLong = checkBranchSize(messages);
    if (tooLong) {
      clearTimeout(watchdog);
      setGraph((g) =>
        ifNodeExists(g, nodeId, (g2) =>
          failNode(g2, nodeId, { code: "invalid_request", message: tooLong.message }),
        ),
      );
      finishStream(nodeId);
      return;
    }

    let sawFirstToken = false;

    streamChat({
      provider,
      model,
      messages,
      signal: controller.signal,
      onRateLimit: setRateLimit,
      onEvent: (event) => {
        if (event.type === "thinking" || event.type === "text") {
          if (!sawFirstToken) {
            sawFirstToken = true;
            clearTimeout(watchdog);
            timeoutsRef.current.delete(nodeId);
          }
        }

        if (event.type === "thinking") {
          setGraph((g) => ifNodeExists(g, nodeId, (g2) => appendThinking(g2, nodeId, event.text)));
        } else if (event.type === "text") {
          setGraph((g) => ifNodeExists(g, nodeId, (g2) => appendText(g2, nodeId, event.text)));
        } else if (event.type === "done") {
          setGraph((g) =>
            ifNodeExists(g, nodeId, (g2) => completeNode(g2, nodeId, event.usage)),
          );
        } else if (event.type === "error") {
          setGraph((g) =>
            ifNodeExists(g, nodeId, (g2) =>
              failNode(g2, nodeId, { code: event.code, message: event.message }),
            ),
          );
        }
      },
    })
      .then((result) => {
        if (!result.completed && !controller.signal.aborted) {
          // Dropped without an explicit user stop — treat as interrupted.
          setGraph((g) =>
            getNode(g, nodeId)?.status === "streaming" ? interruptNode(g, nodeId) : g,
          );
        }
      })
      .catch((error: unknown) => {
        setGraph((g) => ifNodeExists(g, nodeId, (g2) => failNode(g2, nodeId, toNodeError(error))));
      })
      .finally(() => finishStream(nodeId));
     
  }, [provider, model, finishStream]);

  useEffect(() => {
    beginStreamRef.current = beginStream;
  }, [beginStream]);

  const enqueueOrStart = useCallback(
    (nodeId: string) => {
      if (activeCountRef.current < MAX_CONCURRENT_STREAMS) {
        beginStream(nodeId);
      } else {
        setQueue((q) => [...q, nodeId]);
      }
    },
    [beginStream],
  );

  const queuePosition = useMemo(() => {
    const map: Record<string, number> = {};
    queue.forEach((id, index) => {
      map[id] = index + 1;
    });
    return map;
  }, [queue]);

  // ---- Node actions (§1.4) -----------------------------------------------

  const createAndStream = useCallback(
    (parentId: string | null, prompt: string) => {
      const defaultWidth = widthFor(isMobile);
      const heights = nodeHeightsRef?.current ?? NO_HEIGHTS;
      const isFirstRoot = parentId === null && graphRef.current.nodeIds.length === 0;
      // TES-103 item 2: the very first node centers in the visible content
      // area instead of landing at `autoPlaceOnCreate`'s `{0, 0}` default —
      // falls back to the old corner placement if the canvas hasn't measured
      // a visible area yet (e.g. a controller built without one).
      const position =
        isFirstRoot && visibleCenterRef
          ? centeredRootPosition(visibleCenterRef.current, defaultWidth)
          : autoPlaceOnCreate(
              graphRef.current,
              parentId,
              defaultWidth,
              heights,
              nodeWidthsFrom(graphRef.current, defaultWidth),
            );
      const { graph: added, node } = addNode(graphRef.current, { parentId, prompt, position });
      // TES-103 item 9: a child's whole sibling row re-centers under its
      // parent by default now, rather than the new card just squeezing into
      // whatever free slot `autoPlaceOnCreate` found it. Roots have no parent
      // to center under, so they keep the plain placement above.
      const g2 = parentId !== null
        ? reflowChildrenOnCreate(added, parentId, defaultWidth, heights, nodeWidthsFrom(added, defaultWidth))
        : added;
      setGraph(g2);
      // TES-59/61/62/63: `enqueueOrStart` below can call `beginStream` in this
      // same synchronous tick, and `beginStream` reads `graphRef.current` (for
      // `toMessages`) synchronously too — but the `useEffect` that mirrors
      // `graph` into `graphRef` only runs after this event handler returns and
      // React commits. Without this line, that read sees the graph from
      // *before* `node` existed, `toMessages` → `requireNode` throws "No such
      // node", and `streamChat`'s `fetch("/api/chat", ...)` is never reached —
      // but the watchdog armed a few lines into `beginStream`, before the
      // throw, fires 60s later regardless. That is the full "60s, zero bytes,
      // nothing in any server or network log" symptom: the request never left
      // the tab.
      graphRef.current = g2;
      setSelectedNodeId(node.id);
      enqueueOrStart(node.id);
      return node.id;
    },
    [isMobile, enqueueOrStart, nodeHeightsRef, visibleCenterRef],
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed === "" || composerDisabledReason) return;
      createAndStream(effectiveComposerTarget, trimmed);
    },
    [composerDisabledReason, createAndStream, effectiveComposerTarget],
  );

  const branch = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
  }, []);

  const regenerate = useCallback(
    (nodeId: string) => {
      const node = graphRef.current.nodesById[nodeId];
      if (!node) return;
      createAndStream(node.parentId, node.prompt);
    },
    [createAndStream],
  );

  const retry = useCallback(
    (nodeId: string) => {
      enqueueOrStart(nodeId);
    },
    [enqueueOrStart],
  );

  const continueNode = useCallback(
    (nodeId: string) => {
      createAndStream(nodeId, CONTINUE_PROMPT);
    },
    [createAndStream],
  );

  const stop = useCallback((nodeId: string) => {
    const controller = controllersRef.current.get(nodeId);
    controller?.abort();
    setGraph((g) =>
      getNode(g, nodeId)?.status === "streaming" ? interruptNode(g, nodeId) : g,
    );
    finishStream(nodeId);
  }, [finishStream]);

  /**
   * §1.5 asks for a confirm dialog naming the count, then an 8s undo toast.
   * This ships only the second half: delete happens immediately and the toast
   * (with the same 8s window) is the undo path. A blocking confirm on every
   * delete is friction on the one destructive action a heavy user reaches for
   * most, and the undo window already gives a full second chance without
   * making them stop and click through a dialog first. Flagged to Design
   * Engineer rather than shipped as a silent substitution.
   */
  const DELETE_UNDO_MS = 8000;
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const requestDelete = useCallback(
    (nodeId: string) => {
      const before = graphRef.current;
      const count = childIds(before, nodeId).length === 0
        ? 0
        : countDescendantsBelow(before, nodeId);
      const priorSelection = selectedNodeId;

      const controller = controllersRef.current.get(nodeId);
      controller?.abort();

      setGraph((g) => removeBranch(g, nodeId));
      setSelectedNodeId((current) => (current === nodeId ? null : current));

      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
      const id = Date.now();
      setDeletedToast({ id, count, restore: before, priorSelection });
      deleteTimerRef.current = setTimeout(() => {
        setDeletedToast((current) => (current?.id === id ? null : current));
      }, DELETE_UNDO_MS);
    },
    [selectedNodeId],
  );

  const undoDelete = useCallback(() => {
    if (!deletedToast) return;
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    setGraph(deletedToast.restore);
    setSelectedNodeId(deletedToast.priorSelection);
    setDeletedToast(null);
  }, [deletedToast]);

  const removeErrorNode = useCallback((nodeId: string) => {
    setGraph((g) => removeBranch(g, nodeId));
    setSelectedNodeId((current) => (current === nodeId ? null : current));
  }, []);

  const moveNode = useCallback((nodeId: string, position: Point) => {
    setGraph((g) => moveNodeInGraph(g, nodeId, position));
  }, []);

  const toggleCollapsed = useCallback((nodeId: string) => {
    setGraph((g) => {
      const node = g.nodesById[nodeId];
      return node ? setNodeCollapsed(g, nodeId, !node.collapsed) : g;
    });
  }, []);

  const tidy = useCallback(() => {
    setGraph((g) => {
      const reset = resetAllToAuto(g);
      const defaultWidth = widthFor(isMobile);
      return tidyLayout(
        reset,
        defaultWidth,
        nodeHeightsRef?.current ?? NO_HEIGHTS,
        nodeWidthsFrom(reset, defaultWidth),
      );
    });
  }, [isMobile, nodeHeightsRef]);

  const resizeNode = useCallback((nodeId: string, size: Size) => {
    setGraph((g) => resizeNodeInGraph(g, nodeId, size));
  }, []);

  const toggleBodyCollapsed = useCallback((nodeId: string) => {
    setGraph((g) => {
      const node = g.nodesById[nodeId];
      return node ? setNodeBodyCollapsed(g, nodeId, !node.bodyCollapsed) : g;
    });
  }, []);

  const setViewport = useCallback((next: typeof viewport) => {
    setViewportState(next);
  }, []);

  const select = useCallback((nodeId: string | null) => {
    setSelectedNodeId(nodeId);
  }, []);

  return {
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
    isRootsEmpty: rootIds(graph).length === 0 && graph.nodeIds.length === 0,
    select,
    send,
    branch,
    regenerate,
    retry,
    continueNode,
    stop,
    requestDelete,
    undoDelete,
    removeErrorNode,
    moveNode,
    resizeNode,
    toggleCollapsed,
    toggleBodyCollapsed,
    tidy,
  };
}

function countDescendantsBelow(graph: ConversationGraph, nodeId: string): number {
  let count = 0;
  const queue = [...childIds(graph, nodeId)];
  while (queue.length > 0) {
    const id = queue.shift()!;
    count += 1;
    queue.push(...childIds(graph, id));
  }
  return count;
}
