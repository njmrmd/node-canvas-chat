import { ApiCallError } from "@/lib/api-client";
import type { ErrorCode } from "@/lib/http";
import type { AlertTone } from "@/components/alert";

/**
 * Where every error code goes, in one table.
 *
 * `ApiCallError.code` is the switch, and this module is the whole contract: a
 * call site never decides what tone a failure is, whether it belongs in a
 * banner or beside a field, or what focus does afterwards. If a code renders
 * the wrong thing, the bug is in this table — it is not a judgement call spread
 * across two components.
 *
 * Two policies are baked in and worth stating out loud:
 *
 * 1. **`wait` is for everything that is our fault or our limit.** A rate limit,
 *    a missing env var and a provider timeout are not the user's mistake and
 *    must not be dressed in red as though they were. Those rows say *this one
 *    is on us* in those words.
 * 2. **Never a banner and field errors for the same submit.** A form-level
 *    alert is only produced when there is something the fields do not already
 *    say — otherwise the person reads the same failure twice and has to work
 *    out that it is one failure.
 */

/** What the form should render, and what it should do with focus afterwards. */
export type ErrorSurface = {
  /** The form-level banner, or null when the fields carry the message. */
  alert: {
    tone: AlertTone;
    title?: string;
    message: string;
    /** At most one, and only where retrying is literally the fix. */
    action?: "reload" | "retry";
  } | null;
  /** Field name → message, rendered by `<FieldError>` beside its input. */
  fieldErrors: Record<string, string>;
  /**
   * A link to append to the field message, when the fix is somewhere else.
   *
   * The href lives here and the anchor is rendered by the caller: a message is
   * a string, and the moment markup goes into one, every call site has to be
   * trusted to escape it.
   */
  fieldErrorLink?: { field: string; label: string; href: string };
  /**
   * Which control to focus. `first-invalid` means the first field named in
   * `fieldErrors`; `null` leaves focus on the submit the person just pressed,
   * because a form-level `role="alert"` already announces itself and moving
   * focus away would lose their place.
   */
  focus: "first-invalid" | "password" | null;
  /** Clear the password input — used where the credential pair was rejected. */
  clearPassword?: boolean;
  /**
   * A 429 is a wait with a known end. The caller starts the countdown from
   * `retryAfterSeconds`, disables submit, and shows the same clock in the
   * banner and on the button.
   */
  rateLimit?: { retryAfterSeconds: number };
};

/**
 * Codes that render somewhere other than this form.
 *
 * `no_key_configured` is not an error at all — it is the no-key empty state,
 * and a red banner for something the person has not failed at is the fastest
 * way to make onboarding feel like a rebuke. `unauthenticated` redirects and
 * says its piece on the sign-in screen. `not_found` is a route-level 404.
 */
export type OffFormRoute = "no-key-empty-state" | "sign-in-redirect" | "not-found";

const OFF_FORM: Partial<Record<ErrorCode, OffFormRoute>> = {
  no_key_configured: "no-key-empty-state",
  unauthenticated: "sign-in-redirect",
  not_found: "not-found",
};

export function offFormRouteFor(error: unknown): OffFormRoute | null {
  if (!(error instanceof ApiCallError)) return null;
  return OFF_FORM[error.code] ?? null;
}

/**
 * The banner shown on `/sign-in` after a session expired out from under
 * someone. `wait`, never red: an expired session is not a failure, and the
 * person did nothing wrong by taking too long.
 */
export const SESSION_ENDED: ErrorSurface["alert"] = {
  tone: "wait",
  title: "Your session ended",
  message: "Sign in again to pick up where you were.",
};

/**
 * Maps a caught error onto the surface that should render it.
 *
 * `providerLabel` names the provider in the two copy lines that mention one, so
 * the key screen can say "Anthropic rejected that key" rather than "the
 * provider rejected that key".
 */
export function errorSurfaceFor(
  error: unknown,
  options?: { providerLabel?: string; keyField?: string },
): ErrorSurface {
  const provider = options?.providerLabel ?? "The provider";
  const keyField = options?.keyField ?? "apiKey";

  // Not an `ApiCallError` at all: a bug in our own client code, not a response.
  if (!(error instanceof ApiCallError)) {
    return {
      alert: {
        tone: "error",
        title: "Something went wrong on our side",
        message: "Something went wrong. Please try again.",
        action: "retry",
      },
      fieldErrors: {},
      focus: null,
    };
  }

  switch (error.code) {
    /*
     * `fields` present means the server named the offending inputs, so the
     * messages go beside them verbatim and there is no banner. Values are kept:
     * re-typing a form you almost got right is the punishment for a typo.
     */
    case "invalid_request":
      if (Object.keys(error.fields).length > 0) {
        return {
          alert: null,
          fieldErrors: error.fields,
          focus: "first-invalid",
        };
      }
      return {
        alert: {
          tone: "error",
          title: "We could not send that",
          message: error.message,
        },
        fieldErrors: {},
        focus: null,
      };

    /*
     * Never say which half was wrong. Naming the email as valid turns the sign
     * -in form into an account-enumeration oracle, so the message covers the
     * pair and the password is the only thing cleared.
     */
    case "invalid_credentials":
      return {
        alert: {
          tone: "error",
          title: "That email and password do not match",
          message:
            "Check both and try again. If you have never signed up, create an account.",
        },
        fieldErrors: {},
        focus: "password",
        clearPassword: true,
      };

    /*
     * Beside the email field, not in a banner — the email is the thing to
     * change. The "Sign in instead" link is rendered by the caller, because a
     * link inside a string is how you end up with markup in a message.
     */
    case "email_taken":
      return {
        alert: null,
        fieldErrors: {
          email: "That email is already registered.",
        },
        fieldErrorLink: {
          field: "email",
          label: "Sign in instead",
          href: "/sign-in",
        },
        focus: "first-invalid",
      };

    /*
     * The value is deliberately kept. A key is pasted from a console that shows
     * it exactly once; making someone re-fetch it because we cleared the input
     * is an expensive way to say "typo".
     */
    case "invalid_api_key":
      return {
        alert: null,
        fieldErrors: {
          [keyField]: `${provider} rejected that key. Check it and paste again — your key was not stored.`,
        },
        focus: "first-invalid",
      };

    case "rate_limited":
      return {
        alert: {
          tone: "wait",
          title: "Too many attempts",
          message: error.message,
        },
        fieldErrors: {},
        focus: null,
        rateLimit: { retryAfterSeconds: error.retryAfterSeconds ?? 0 },
      };

    /*
     * The token is stale, which a reload fixes and nothing the user types will.
     * So the action is the fix, not a suggestion.
     */
    case "csrf_failed":
      return {
        alert: {
          tone: "error",
          title: "We could not create the account",
          message: error.message,
          action: "reload",
        },
        fieldErrors: {},
        focus: null,
      };

    // Our misconfiguration. Says so, and says nothing was sent anywhere.
    case "not_configured":
      return {
        alert: {
          tone: "wait",
          title: "This one is on us",
          message:
            "The service is not fully set up yet. Nothing you typed was sent anywhere. Try again in a minute.",
          action: "retry",
        },
        fieldErrors: {},
        focus: null,
      };

    // Their outage, our problem to explain. Note what did *not* happen to the key.
    case "provider_unavailable":
      return {
        alert: {
          tone: "wait",
          title: "This one is on us",
          message: `${provider} did not answer in time. Your key was not changed and nothing you typed was sent anywhere else. Try again in a minute.`,
          action: "retry",
        },
        fieldErrors: {},
        focus: null,
      };

    /*
     * A build limitation, not a fault and not a wait — no amount of retrying
     * adds a provider — so there is no action button.
     */
    case "unsupported_provider":
    case "unsupported_model":
      return {
        alert: {
          tone: "error",
          title: "Not available yet",
          message: "That provider is not connected in this build.",
        },
        fieldErrors: {},
        focus: null,
      };

    case "forbidden":
      return {
        alert: {
          tone: "error",
          message: "You do not have access to that.",
        },
        fieldErrors: {},
        focus: null,
      };

    /*
     * These three render elsewhere entirely — see `offFormRouteFor`. The rows
     * are here so the switch stays exhaustive and a reader of this file can see
     * that they were routed rather than forgotten.
     */
    case "no_key_configured":
    case "unauthenticated":
    case "not_found":
      return { alert: null, fieldErrors: {}, focus: null };

    case "internal_error":
    default:
      return {
        alert: {
          tone: "error",
          title: "Something went wrong on our side",
          message: error.message,
          action: "retry",
        },
        fieldErrors: {},
        focus: null,
      };
  }
}
