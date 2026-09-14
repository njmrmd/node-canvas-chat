"use client";

import { useEffect, useState } from "react";
import { ApiCallError } from "@/lib/api-client";

/**
 * The client half of a 429.
 *
 * The server's `error.message` already names the limit and when it lifts, but
 * it says so once, in the past tense — "try again in 38 minutes" is wrong a
 * minute later and the user has no way to tell when it became safe to retry.
 * So we keep the sentence and put a live clock under it, and hold the submit
 * button disabled until the clock runs out. A rate limit should read as a wait
 * with a known end, not as a failure the user has to guess their way out of.
 */

export type RateLimitNotice = {
  /** The server's sentence, safe to display verbatim. */
  message: string;
  /** Seconds the server said to wait, from `Retry-After`. */
  retryAfterSeconds: number;
};

/**
 * Builds a notice from a caught error, or returns null when the error was not
 * a rate limit. A 429 without `Retry-After` still produces a notice — it just
 * has no clock, so the caller falls back to the server's sentence.
 *
 * Each 429 makes a fresh object, which is what `useSecondsRemaining` uses to
 * tell a new refusal from a re-render of the same one.
 */
export function rateLimitNoticeFrom(error: unknown): RateLimitNotice | null {
  if (!(error instanceof ApiCallError) || error.code !== "rate_limited") {
    return null;
  }

  return {
    message: error.message,
    retryAfterSeconds: error.retryAfterSeconds ?? 0,
  };
}

/**
 * Seconds left on `notice`, counting down once a second to zero. Pass `null`
 * when no limit is in force.
 *
 * The count starts from what the server said and decrements, rather than being
 * recomputed from the wall clock. A backgrounded tab throttles timers, so this
 * can drift *long* — it will claim more time remaining than there really is.
 * That is the safe direction: the button unlocks late rather than early, and
 * the server is the thing that actually decides either way.
 */
export function useSecondsRemaining(notice: RateLimitNotice | null): number {
  const [remaining, setRemaining] = useState(0);
  const [tracked, setTracked] = useState<RateLimitNotice | null>(null);

  // Adjusting state during render, which is React's own answer to "reset state
  // when a prop changes". Doing it in an effect instead would render once with
  // the previous count first, and on a countdown that is a visible jump.
  if (tracked !== notice) {
    setTracked(notice);
    setRemaining(notice?.retryAfterSeconds ?? 0);
  }

  useEffect(() => {
    if (tracked === null) return;

    const id = setInterval(() => {
      setRemaining((left) => Math.max(0, left - 1));
    }, 1000);

    return () => clearInterval(id);
  }, [tracked]);

  return remaining;
}

/** `m:ss`, the shape people read a wait in. */
export function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
