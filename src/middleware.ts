import { NextResponse, type NextRequest } from "next/server";

/**
 * Content-Security-Policy with a per-request nonce.
 *
 * The scaffold (TES-3) deliberately shipped every other security header but
 * not CSP, because a nonce has to be generated per request and that needs
 * middleware. This is that middleware — the alternative would have been a
 * `'unsafe-inline'` policy, which looks like protection and is not.
 *
 * Next injects its bootstrap scripts with the nonce it finds in this header,
 * so no application code has to thread it through.
 *
 * This file runs on the edge runtime. It must not import `node:crypto`, `pg`,
 * or anything under `@/lib` that does — hence `crypto.getRandomValues`.
 *
 * It is *not* an authorization boundary. There is no session check here on
 * purpose: authorization happens in each route handler against the database,
 * where the answer can actually be trusted.
 */
export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
    "base64",
  );

  const isDev = process.env.NODE_ENV !== "production";

  const csp = [
    "default-src 'self'",
    // `strict-dynamic` lets Next's nonced bootstrap load its own chunks while
    // still refusing anything an injection could introduce. `unsafe-eval` is
    // dev-only: the dev server's React refresh needs it, production does not.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${isDev ? "'unsafe-eval'" : ""}`,
    // React and Tailwind emit inline style attributes. Styles cannot exfiltrate
    // data the way scripts can, so this is the accepted trade.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    // The app only ever talks to its own origin — provider calls are made from
    // the server, so the browser never needs to reach api.anthropic.com.
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ]
    .join("; ")
    .replace(/\s{2,}/g, " ")
    .trim();

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and the favicon — those are served
     * straight from the CDN and a policy header on them buys nothing while
     * costing a middleware invocation.
     */
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
