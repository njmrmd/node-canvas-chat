"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api-client";
import { errorSurfaceFor, type ErrorSurface } from "@/lib/error-surface";
import {
  EMAIL_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  checkCredentials,
} from "@/lib/auth/credentials";
import { DEFAULT_SIGNED_IN_PATH, safeNextPath } from "@/lib/auth/next-path";
import {
  formatCountdown,
  useSecondsRemaining,
  type RateLimitNotice,
} from "@/lib/rate-limit-notice";
import { RateLimitAlert, RateLimitCleared } from "@/components/rate-limit-alert";
import {
  Alert,
  Button,
  Field,
  PageHeading,
  Shell,
  Spinner,
  TextLink,
} from "@/components/ui";

/**
 * Sign-up and sign-in. One component, because the two forms differ only in
 * their endpoint and their copy — and keeping them together means the error
 * handling cannot drift between them.
 *
 * The form validates before it submits. That is not politeness: `/api/auth/*`
 * is rate limited per IP, so a mistyped password used to cost a stranger one
 * of the few sign-up attempts their address gets. The rules come from
 * `@/lib/auth/credentials`, which the API imports too, so the browser can
 * never refuse something the server would have taken, or vice versa. The
 * server still decides — this only stops the pointless round trip.
 *
 * Platform Engineer owns what this does. Design Engineer owns how it looks and
 * reads; every visual decision here comes from the shared primitives in
 * `ui.tsx` and the tokens in `globals.css`, so the two screens cannot drift
 * apart from each other or from the key screen.
 */

type Mode = "sign-up" | "sign-in";

const COPY = {
  "sign-up": {
    heading: "Create an account",
    subheading:
      "You bring your own model access. We never see your provider bill, and you can delete everything in one click.",
    submit: "Create account",
    busy: "Creating account…",
    endpoint: "/api/auth/signup",
    footer: "Already have an account?",
    footerLink: "Sign in",
    footerHref: "/sign-in",
    autoComplete: "new-password",
  },
  "sign-in": {
    heading: "Sign in",
    subheading: "Welcome back.",
    submit: "Sign in",
    busy: "Signing in…",
    endpoint: "/api/auth/signin",
    footer: "No account yet?",
    footerLink: "Create one",
    footerHref: "/sign-up",
    autoComplete: "current-password",
  },
} as const satisfies Record<Mode, unknown>;

export function AuthForm({ mode, next }: { mode: Mode; next?: string }) {
  const copy = COPY[mode];
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  /** The banner, already resolved to tone + copy by the routing table. */
  const [formAlert, setFormAlert] = useState<ErrorSurface["alert"]>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [fieldErrorLink, setFieldErrorLink] =
    useState<ErrorSurface["fieldErrorLink"]>(undefined);
  const [rateLimit, setRateLimit] = useState<RateLimitNotice | null>(null);

  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // A 429 is a wait with a known end, so the submit stays disabled until the
  // clock runs out rather than inviting another attempt that cannot succeed.
  const secondsLeft = useSecondsRemaining(rateLimit);
  const waiting = rateLimit !== null && secondsLeft > 0;

  // Re-checked here even though the page already checked it: this prop is one
  // `?next=` edit away from being attacker-controlled, and it ends up in a
  // client-side navigation.
  const destination = safeNextPath(next) ?? DEFAULT_SIGNED_IN_PATH;
  const footerHref = next
    ? `${copy.footerHref}?next=${encodeURIComponent(destination)}`
    : copy.footerHref;

  /** Clears a field's error as soon as the user starts fixing it. */
  function clearFieldError(field: string) {
    setFieldErrors((current) => {
      if (!(field in current)) return current;
      const remaining = { ...current };
      delete remaining[field];
      return remaining;
    });
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || waiting) return;

    /*
     * Everything clears at t=0, before anything is sent.
     *
     * Not cosmetic: re-submitting an unchanged form would otherwise leave an
     * identical banner on screen and the person has no evidence the button did
     * anything at all. Feedback has to be caused by the action.
     */
    setFormAlert(null);
    setFieldErrors({});
    setFieldErrorLink(undefined);
    setRateLimit(null);

    const local = checkCredentials(mode, { email, password });
    if (Object.keys(local).length > 0) {
      setFieldErrors(local);
      // Put the cursor on the first thing that is wrong, so fixing it is one
      // keystroke away rather than a hunt down the form.
      (local.email ? emailRef : passwordRef).current?.focus();
      return;
    }

    setBusy(true);

    try {
      await apiFetch(copy.endpoint, {
        method: "POST",
        body: { email, password },
      });

      // `refresh` before `push`: the response just set the session cookie, and
      // any server-component payload cached from the signed-out state would
      // otherwise render first.
      router.refresh();
      router.push(destination);
    } catch (error) {
      /*
       * One table decides all of this — tone, banner-or-field, copy, focus. The
       * form does not interpret error codes; it renders what it is handed.
       */
      const surface = errorSurfaceFor(error);

      setFormAlert(surface.alert);
      setFieldErrors(surface.fieldErrors);
      setFieldErrorLink(surface.fieldErrorLink);
      if (surface.rateLimit) {
        setRateLimit({
          message: surface.alert?.message ?? "",
          retryAfterSeconds: surface.rateLimit.retryAfterSeconds,
        });
      }
      if (surface.clearPassword) setPassword("");
      setBusy(false);

      /*
       * Focus moves for a field error and never for a banner. `role="alert"`
       * already announces the banner, and pulling focus off the button the
       * person just pressed loses their place on the form.
       */
      if (surface.focus === "password") {
        passwordRef.current?.focus();
      } else if (surface.focus === "first-invalid") {
        (surface.fieldErrors.email ? emailRef : passwordRef).current?.focus();
      }
    }
  }

  return (
    <Shell>
      <PageHeading title={copy.heading}>{copy.subheading}</PageHeading>

      {/*
       * `noValidate` stays on, and the checks above replace it. The browser
       * knows the answer, but it delivers it in a transient bubble that is
       * unstyleable, disappears on the next keystroke, and reads differently
       * in every browser. The messages render in the same slot as the
       * server's instead — one error surface, which Design Engineer owns.
       */}
      <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4" noValidate>
        {/*
          * At most one banner, always above the first field. The shell is
          * top-anchored, so this pushes the fields down and never moves the
          * heading the person is reading — and no space is reserved for a
          * banner that is usually absent.
          */}
        {waiting ? (
          <RateLimitAlert secondsLeft={secondsLeft} id="rate-limit-alert" />
        ) : rateLimit ? (
          // The clock ran out: banner gone, button live again, said politely.
          <RateLimitCleared />
        ) : formAlert ? (
          <Alert
            tone={formAlert.tone}
            title={formAlert.title}
            action={
              formAlert.action === "reload"
                ? { label: "Reload the page", onClick: () => location.reload() }
                : formAlert.action === "retry"
                  ? {
                      label: "Try again",
                      onClick: () => setFormAlert(null),
                    }
                  : undefined
            }
          >
            {formAlert.message}
          </Alert>
        ) : null}

        <Field
          ref={emailRef}
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={(value) => {
            setEmail(value);
            clearFieldError("email");
          }}
          error={
            fieldErrors.email ? (
              <>
                {fieldErrors.email}
                {fieldErrorLink?.field === "email" ? (
                  <>
                    {" "}
                    <TextLink href={fieldErrorLink.href}>
                      {fieldErrorLink.label}
                    </TextLink>
                    .
                  </>
                ) : null}
              </>
            ) : undefined
          }
          autoComplete="email"
          autoFocus
          required
          maxLength={EMAIL_MAX_LENGTH}
          disabled={busy}
        />

        <Field
          ref={passwordRef}
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={(value) => {
            setPassword(value);
            clearFieldError("password");
          }}
          error={fieldErrors.password}
          autoComplete={copy.autoComplete}
          required
          minLength={mode === "sign-up" ? PASSWORD_MIN_LENGTH : undefined}
          maxLength={PASSWORD_MAX_LENGTH}
          hint={
            mode === "sign-up"
              ? `At least ${PASSWORD_MIN_LENGTH} characters. Length beats punctuation.`
              : undefined
          }
          /*
           * Said at the moment the password is chosen, not in a footer.
           * There is no reset email yet, and a stranger who discovers that
           * after losing the password has a worse impression of us than one
           * who was told plainly before they committed.
           */
          note={
            mode === "sign-up"
              ? "There is no password reset yet. If you lose this password, you lose the account and the key stored with it — save it in your password manager now."
              : undefined
          }
          disabled={busy}
        />

        <Button
          type="submit"
          disabled={busy || waiting}
          full
          className="mt-2"
          aria-describedby={waiting ? "rate-limit-alert" : undefined}
        >
          {busy ? (
            <>
              <Spinner />
              {copy.busy}
            </>
          ) : waiting ? (
            <>
              <span aria-hidden="true" className="tabular-nums">
                Try again in {formatCountdown(secondsLeft)}
              </span>
              <span className="sr-only">
                Locked until the rate limit resets
              </span>
            </>
          ) : (
            copy.submit
          )}
        </Button>
      </form>

      <p className="mt-4 text-sm text-muted">
        {copy.footer} <TextLink href={footerHref}>{copy.footerLink}</TextLink>
      </p>
    </Shell>
  );
}
