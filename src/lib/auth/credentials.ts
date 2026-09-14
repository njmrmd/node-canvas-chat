/**
 * The credential rules, in one place, usable from both sides of the wire.
 *
 * The server is the only thing that can *enforce* these; the browser copy
 * exists so that a typo never becomes a network request. `/api/auth/*` is rate
 * limited per IP because it is an unauthenticated surface, and before this
 * module existed every mistyped password spent a slot in that budget — a
 * stranger could lock themselves out of signing up by fumbling the form.
 *
 * Both sides importing the same functions is the point: a client check that
 * disagrees with the server check is worse than no client check, because it
 * rejects input the server would have accepted.
 *
 * This file must stay free of `node:` imports and of anything that reaches the
 * database — it is bundled into a client component.
 */

export const PASSWORD_MIN_LENGTH = 10;
/**
 * bcrypt's 72-byte truncation does not apply to scrypt, but an unbounded
 * password is a denial-of-service knob: the caller controls how much we hash.
 */
export const PASSWORD_MAX_LENGTH = 200;

/** RFC 5321 practical maximum. */
export const EMAIL_MAX_LENGTH = 254;

/**
 * Deliberately permissive: `something@something.tld` with no whitespace. A
 * stricter regex rejects real addresses, and we do not need to *prove* the
 * address is deliverable — we only need it to be a sane unique handle.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Each check returns the message to show beside the field, or `null` when the
 * value is acceptable. One message per field: the first thing that is wrong is
 * the only thing worth saying.
 */
export function checkEmail(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return "Enter your email address.";
  }

  const email = normaliseEmail(value);
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) {
    return "That does not look like an email address. Check for a missing “@”.";
  }

  return null;
}

export function checkNewPassword(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return "Choose a password.";

  if (value.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters. Length beats punctuation.`;
  }

  if (value.length > PASSWORD_MAX_LENGTH) {
    return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  }

  return null;
}

/** Sign-in does not re-apply strength rules — only shape. */
export function checkExistingPassword(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return "Enter your password.";
  // Do not spend scrypt CPU on an oversized candidate. The message stays the
  // generic one so the response cannot confirm a password's length.
  if (value.length > PASSWORD_MAX_LENGTH) return "Enter your password.";
  return null;
}

/** Normalises to lowercase — the unique index is the case-insensitivity guard. */
export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

export type CredentialMode = "sign-up" | "sign-in";

/**
 * The whole form at once, in the shape the client already renders and the API
 * already returns: field name → message. Empty means "worth a round trip".
 */
export function checkCredentials(
  mode: CredentialMode,
  values: { email: string; password: string },
): Record<string, string> {
  const fields: Record<string, string> = {};

  const email = checkEmail(values.email);
  if (email) fields.email = email;

  const password =
    mode === "sign-up"
      ? checkNewPassword(values.password)
      : checkExistingPassword(values.password);
  if (password) fields.password = password;

  return fields;
}
