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

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
