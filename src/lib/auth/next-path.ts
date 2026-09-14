/**
 * Where to send someone after they sign in.
 *
 * A signed-out visit to `/keys` bounces to `/sign-in?next=%2Fkeys` so that
 * signing in resumes the journey instead of dumping the user on a default
 * page. That parameter is attacker-controlled — anyone can send a link with
 * any `next` they like — so it is an open-redirect hole unless it is checked.
 *
 * Input trust boundaries: the value is hostile. It is accepted only as a
 * same-origin absolute path, matched against the characters RFC 3986 allows in
 * a path or query, and never handed to `new URL` where a scheme or an
 * authority could reappear.
 *
 * A fixed allowlist of destinations would be tighter still, and was the first
 * thing tried — but the canvas routes do not exist yet, and an allowlist that
 * has to be edited every time a page lands is an allowlist that gets removed.
 * The structural check below is what survives contact with a growing app.
 *
 * No `node:` imports: this is shared with a client component.
 */

const MAX_LENGTH = 512;

/** RFC 3986 path/query characters. Notably excludes `\`, whitespace and controls. */
const SAFE_CHARS = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?[\]]*$/;

/** Landing back on an auth screen after authenticating is a loop, not a resume. */
const AUTH_PATHS = ["/sign-in", "/sign-up"];

/** The destination when there is no usable `next`. */
export const DEFAULT_SIGNED_IN_PATH = "/keys";

export function safeNextPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_LENGTH) return null;

  // Must be an absolute path on this origin.
  if (!value.startsWith("/")) return null;

  // `//evil.example` and `/\evil.example` are protocol-relative URLs that most
  // parsers — including browsers following a `Location` header — resolve to a
  // different host. They start with `/`, which is exactly why the check above
  // is not sufficient on its own.
  if (value.startsWith("//") || value.startsWith("/\\")) return null;

  if (!SAFE_CHARS.test(value)) return null;

  // `%2f%2fevil.example` and `%5c` survive the check above as literal percent
  // escapes. Nothing downstream should decode them into an authority, but
  // "should" is not a control — decode once and re-apply the same rule.
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null; // Malformed escape; refuse rather than guess.
  }
  if (
    !decoded.startsWith("/") ||
    decoded.startsWith("//") ||
    decoded.startsWith("/\\")
  ) {
    return null;
  }

  const path = value.split(/[?#]/, 1)[0]!;
  if (AUTH_PATHS.some((auth) => path === auth || path.startsWith(`${auth}/`))) {
    return null;
  }

  return value;
}

/** The checked destination, or the default. Never returns null. */
export function resolveNextPath(value: unknown): string {
  return safeNextPath(value) ?? DEFAULT_SIGNED_IN_PATH;
}

/** Builds `/sign-in?next=…` for a signed-out visitor to a protected page. */
export function signInHref(next?: string | null): string {
  const target = safeNextPath(next);
  return target ? `/sign-in?next=${encodeURIComponent(target)}` : "/sign-in";
}
