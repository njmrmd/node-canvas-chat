import { validateApiKey } from "@/lib/providers/anthropic";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { requireSessionUser } from "@/lib/auth/session";
import { ApiError, json, noContent, readJsonBody, withRoute } from "@/lib/http";
import { deleteKey, saveKey } from "@/lib/keys";
import { requireProvider } from "@/lib/providers/registry";
import { POLICIES, enforce, rateLimitHeaders, userSubject } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ provider: string }> };

/** Keys are opaque to us, but an empty or absurd value is not worth a round trip. */
const KEY_MIN_LENGTH = 20;
const KEY_MAX_LENGTH = 500;

/**
 * PUT /api/keys/:provider — connect or replace a key.
 *
 * Validate first, store second. A key that the provider rejects never reaches
 * the database, so "saved" always means "worked at least once".
 */
export const PUT = withRoute(
  "keys.put",
  async (request: Request, context: Context) => {
    assertSameOrigin(request);

    const user = await requireSessionUser();
    const limit = await enforce(POLICIES.keyWrite, userSubject(user.id));

    // The path segment is a lookup key into the allowlist, never a value we
    // pass on. An unknown provider is rejected here.
    const provider = requireProvider((await context.params).provider);

    const body = await readJsonBody(request);
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";

    if (apiKey.length < KEY_MIN_LENGTH || apiKey.length > KEY_MAX_LENGTH) {
      throw new ApiError("invalid_request", "Paste the full API key.", {
        fields: { apiKey: "Paste the full API key." },
      });
    }

    // Throws `invalid_api_key` with a sentence the user can act on. The key is
    // not written anywhere on this path.
    await validateApiKey(apiKey);

    const saved = await saveKey(user.id, provider.id, apiKey);

    return json({ key: saved }, { headers: rateLimitHeaders(limit) });
  },
);

/**
 * DELETE /api/keys/:provider — disconnect.
 *
 * Scoped to the caller's own rows, so a signed-in user cannot delete another
 * account's key by naming a provider.
 */
export const DELETE = withRoute(
  "keys.delete",
  async (request: Request, context: Context) => {
    assertSameOrigin(request);

    const user = await requireSessionUser();
    const provider = requireProvider((await context.params).provider);

    const deleted = await deleteKey(user.id, provider.id);
    if (!deleted) {
      throw new ApiError(
        "not_found",
        `No ${provider.label} key is connected to this account.`,
      );
    }

    return noContent();
  },
);
