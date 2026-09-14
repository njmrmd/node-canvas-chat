import { ApiError } from "@/lib/http";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/crypto/password";

/**
 * Hand-rolled validation rather than a schema library.
 *
 * There are four request shapes in this whole API. A validation dependency
 * would be more code than the code it replaces, and the supply-chain lens says
 * every dependency is a decision. If the surface grows past a dozen shapes,
 * revisit — this is a judgement about size, not a principle about libraries.
 *
 * Everything here collects per-field messages so the client can render errors
 * next to the input that caused them.
 */

export class FieldErrors {
  private readonly fields: Record<string, string> = {};

  add(field: string, message: string): void {
    this.fields[field] ??= message;
  }

  throwIfAny(): void {
    if (Object.keys(this.fields).length > 0) {
      throw new ApiError("invalid_request", "Please check the form and try again.", {
        fields: this.fields,
      });
    }
  }
}

/**
 * Deliberately permissive: `something@something.tld` with no whitespace. A
 * stricter regex rejects real addresses, and we do not need to *prove* the
 * address is deliverable — we only need it to be a sane unique handle.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const EMAIL_MAX_LENGTH = 254; // RFC 5321 practical maximum.

/** Normalises to lowercase — the unique index is the case-insensitivity guard. */
export function parseEmail(
  value: unknown,
  errors: FieldErrors,
): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    errors.add("email", "Enter your email address.");
    return null;
  }

  const email = value.trim().toLowerCase();
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) {
    errors.add("email", "That does not look like an email address.");
    return null;
  }

  return email;
}

export function parseNewPassword(
  value: unknown,
  errors: FieldErrors,
): string | null {
  if (typeof value !== "string" || value === "") {
    errors.add("password", "Choose a password.");
    return null;
  }

  if (value.length < PASSWORD_MIN_LENGTH) {
    errors.add(
      "password",
      `Use at least ${PASSWORD_MIN_LENGTH} characters. Length beats punctuation.`,
    );
    return null;
  }

  if (value.length > PASSWORD_MAX_LENGTH) {
    errors.add("password", `Use at most ${PASSWORD_MAX_LENGTH} characters.`);
    return null;
  }

  return value;
}

/** Sign-in does not re-apply strength rules — only shape. */
export function parseExistingPassword(
  value: unknown,
  errors: FieldErrors,
): string | null {
  if (typeof value !== "string" || value === "") {
    errors.add("password", "Enter your password.");
    return null;
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    // Do not spend scrypt CPU on an oversized candidate.
    errors.add("password", "Enter your password.");
    return null;
  }
  return value;
}
