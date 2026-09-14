"use client";

import { Alert } from "@/components/alert";
import { formatCountdown } from "@/lib/rate-limit-notice";

/**
 * A wait, not a failure.
 *
 * Shared by the auth screens and the key screen so a 429 reads the same way
 * wherever it lands, and toned `wait` rather than `error` on purpose: the
 * person did nothing wrong, and time fixes this where effort does not. Dressing
 * our own limit in red tells a stranger they made a mistake during sign-up.
 *
 * The banner and the submit button read from the same `secondsLeft`, so they
 * cannot disagree — "You can try again in 0:47" above a button that says
 * something else is the defect this replaces.
 *
 * The ticking number is `aria-hidden` and paired with a static sentence.
 * `role="alert"` on a live counter re-announces the entire banner every second,
 * which is unusable; the clock is for eyes and the sentence is for ears.
 */
export function RateLimitAlert({
  secondsLeft,
  id,
}: {
  secondsLeft: number;
  id?: string;
}) {
  return (
    <Alert tone="wait" title="Too many attempts" id={id}>
      <p>
        <span aria-hidden="true" className="tabular-nums">
          You can try again in {formatCountdown(secondsLeft)}.
        </span>
        <span className="sr-only">
          You can try again shortly. The button unlocks itself when the limit
          resets.
        </span>{" "}
        This protects the account, not just the server.
      </p>
    </Alert>
  );
}

/**
 * What gets said when the clock reaches zero.
 *
 * Polite, and deliberately not an `Alert`: the person is waiting on purpose and
 * has been watching a countdown, so interrupting them with `role="alert"` to
 * announce the thing they were already expecting is noise. The banner is gone
 * by now and the button has re-enabled itself — this is the screen-reader
 * equivalent of both.
 */
export function RateLimitCleared() {
  return (
    <p role="status" className="sr-only">
      You can try again now.
    </p>
  );
}
