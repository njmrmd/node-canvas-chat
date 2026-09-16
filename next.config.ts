import path from "node:path";
import type { NextConfig } from "next";

/**
 * Security headers are on from the first commit rather than bolted on later —
 * the "secure defaults" lens. HSTS is safe to send because Vercel serves every
 * deployment over HTTPS and redirects plain HTTP.
 *
 * Content-Security-Policy is deliberately NOT set here yet: Next's inline
 * bootstrap scripts need a per-request nonce, which belongs in middleware. That
 * lands with the auth work rather than in the scaffold, so we do not ship a
 * permissive `unsafe-inline` policy that looks like protection and is not.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
];

const nextConfig: NextConfig = {
  // Pin the workspace root. Without this, Turbopack walks up looking for a
  // lockfile and can land on an unrelated one outside the project.
  turbopack: { root: path.resolve(__dirname) },

  /*
   * Development only — this has no effect on any deployment.
   *
   * Next blocks cross-origin requests to dev-only endpoints, and the allowlist
   * it ships with covers `localhost` but not `127.0.0.1`. They are the same
   * machine and not the same origin, so opening the dev server at
   * `http://127.0.0.1:<port>` gets the hot-reload websocket answered with a
   * bare `Unauthorized` — not even a status line, which is why the browser
   * reports the uninformative `ERR_INVALID_HTTP_RESPONSE`.
   *
   * The dev client waits on that socket before it hydrates, so the symptom is
   * not "hot reload is broken". It is that every page renders its server markup
   * and then never becomes interactive: no form submits, no button responds,
   * and the only clue is a websocket error in the console. Anything driving the
   * app over the DevTools protocol — `scripts/screenshot.mjs` and the
   * `scripts/capture-*.mjs` harnesses — sees a dead page and reports it as a
   * missing element.
   *
   * Fixed here rather than by telling everyone to type `localhost`, because
   * "use the other loopback name" is not a thing anyone remembers, and headless
   * Chrome is routinely pointed at the numeric address.
   */
  allowedDevOrigins: ["127.0.0.1"],

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
