-- 0002_canvas — one persisted canvas per account.
--
-- Spec §2.5 lists what survives a reload: the full node graph, every node's
-- position and positionMode, collapsed state, the viewport, the selected node
-- and hasBranchedOnce. §10 fixes "one canvas per account" as MVP scope, so
-- `user_id` is the primary key rather than a separate `canvases.id` with a
-- foreign key — there is no second row to ever address.
--
-- The graph is one jsonb column, not a `nodes` table with a row per node. A
-- per-node table buys queryability the product never needs (nothing here ever
-- reads or writes a single node server-side — the client always has the whole
-- graph in memory and the whole graph is what a reload needs back) and costs a
-- join and a transaction on every debounced position write. At the sizes this
-- spec targets (§4.9 designs for "dense" starting at 12 nodes, ceiling around
-- 200), a whole-document upsert is well inside Postgres's comfort zone and the
-- simpler shape is the right trade.
create table if not exists canvases (
  user_id           uuid        primary key references users(id) on delete cascade,
  -- { nodesById, nodeIds } — see ConversationGraph in src/lib/conversation/graph.ts.
  -- The application validates shape on read; a row that fails to parse is
  -- treated as absent rather than crashing the canvas (see canvas-store.ts).
  graph             jsonb       not null default '{"nodesById":{},"nodeIds":[]}',
  viewport          jsonb       not null default '{"x":0,"y":0,"zoom":1}',
  selected_node_id  text,
  has_branched_once boolean     not null default false,
  updated_at        timestamptz not null default now()
);
