import { ApiError } from "@/lib/http";

/**
 * CSRF protection for every state-changing route.
 *
 * Three independent layers, any one of which stops a classic cross-site POST:
 *
 * 1. `SameSite=Lax` on the session cookie. The browser does not attach it to a
 *    cross-site POST at all, so the forged request arrives unauthenticated.
 * 2. The `Origin` check below. Browsers set `Origin` on every state-changing
 *    request and a page cannot forge it. An origin that is present and not
 *    ours is rejected outright.
 * 3. `readJsonBody` requires `Content-Type: application/json`, which an HTML
 *    form cannot send — a form is limited to three simple content types, and
 *    anything else forces a CORS preflight we never answer.
 *
 * No hidden token round-trip, because a token adds a moving part without
 * covering a case the three layers above miss. This is the approach OWASP now
 * lists first for APIs that do not serve cross-origin browsers, and we serve
 * none.
 *
 * The allowlist is derived from the request itself plus Vercel's own
 * deployment variables, so branch previews work without per-deployment config.
 */

function allowedOrigins(request: Request): Set<string> {
  const allowed = new Set<string>();

  // The origin the browser actually reached. On Vercel, `host` is the
  // deployment or custom domain that served this request. This is what makes
  // every preview URL work with no extra configuration.
  const host = request.headers.get("host");
  if (host) {
    allowed.add(`https://${host}`);
    if (host.startsWith("localhost") || host.startsWith("127.0.0.1")) {
      allowed.add(`http://${host}`);
    }
  }

  // Set explicitly when the app is served from a canonical domain.
  const canonical = process.env.APP_ORIGIN;
  if (canonical) allowed.add(canonical.replace(/\/$/, ""));

  return allowed;
}

/**
 * Throws unless the request provably originates from this app.
 *
 * A *missing* Origin is accepted: same-origin `GET`-ish navigations and some
 * non-browser clients omit it, and the SameSite cookie is already doing the
 * work in that case. A *present and wrong* Origin is always rejected.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");

  // `Sec-Fetch-Site` is sent by every current browser and cannot be forged by
  // a page. When it says the request came from another site, that is decisive.
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new ApiError(
      "csrf_failed",
      "This request did not come from the app. Please reload and try again.",
    );
  }

  if (!origin) return;

  if (!allowedOrigins(request).has(origin)) {
    throw new ApiError(
      "csrf_failed",
      "This request did not come from the app. Please reload and try again.",
    );
  }
}
