import { ApiError } from "@/lib/http";
import {
  checkEmail,
  checkExistingPassword,
  checkNewPassword,
  normaliseEmail,
} from "@/lib/auth/credentials";

/**
 * Hand-rolled validation rather than a schema library.
 *
 * There are four request shapes in this whole API. A validation dependency
 * would be more code than the code it replaces, and the supply-chain lens says
 * every dependency is a decision. If the surface grows past a dozen shapes,
 * revisit — this is a judgement about size, not a principle about libraries.
 *
 * The rules themselves live in `@/lib/auth/credentials` because the sign-up
 * form applies the same ones in the browser. This module is the server half:
 * it collects per-field messages so the client can render errors next to the
 * input that caused them, and it is the half that actually decides.
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

export function parseEmail(
  value: unknown,
  errors: FieldErrors,
): string | null {
  const message = checkEmail(value);
  if (message) {
    errors.add("email", message);
    return null;
  }
  return normaliseEmail(value as string);
}

export function parseNewPassword(
  value: unknown,
  errors: FieldErrors,
): string | null {
  const message = checkNewPassword(value);
  if (message) {
    errors.add("password", message);
    return null;
  }
  return value as string;
}

/** Sign-in does not re-apply strength rules — only shape. */
export function parseExistingPassword(
  value: unknown,
  errors: FieldErrors,
): string | null {
  const message = checkExistingPassword(value);
  if (message) {
    errors.add("password", message);
    return null;
  }
  return value as string;
}
