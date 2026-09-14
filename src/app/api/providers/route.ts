import { json, withRoute } from "@/lib/http";
import { publicCatalog } from "@/lib/providers/registry";

export const runtime = "nodejs";

/**
 * GET /api/providers — the allowlist, as a catalog.
 *
 * Public and cacheable: it is the same for everyone and contains no secrets.
 * The client renders its provider and model pickers from this rather than
 * hard-coding ids, so the allowlist has exactly one definition.
 */
export const GET = withRoute("providers", async () =>
  json(publicCatalog(), {
    headers: { "Cache-Control": "public, max-age=300" },
  }),
);
