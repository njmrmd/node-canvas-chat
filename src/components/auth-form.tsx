"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ApiCallError, apiFetch } from "@/lib/api-client";

/**
 * Sign-up and sign-in. One component, because the two forms differ only in
 * their endpoint and their copy — and keeping them together means the error
 * handling cannot drift between them.
 *
 * Platform Engineer owns what this does. Design Engineer owns how it looks and
 * reads; the styling here is a working baseline, not the visual direction.
 */

type Mode = "sign-up" | "sign-in";

/**
 * There is no password reset yet. That is a deliberate, recorded gap rather
 * than an oversight — so it gets said out loud at the moment the password is
 * chosen, and again on the screen where a locked-out person lands. A stranger
 * locked out with no warning is a worse impression than a missing feature
 * honestly labelled.
 */
const NO_RECOVERY_HINT =
  "At least 10 characters. Length beats punctuation. Write it down — there is no password reset yet, so a lost password cannot be recovered.";

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
    passwordHint: NO_RECOVERY_HINT,
    note: null,
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
    passwordHint: undefined,
    note: "Forgotten your password? There is no reset yet — create a new account to carry on. You will need to reconnect your model key.",
  },
} as const satisfies Record<Mode, unknown>;

export function AuthForm({ mode }: { mode: Mode }) {
  const copy = COPY[mode];
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setFormError(null);
    setFieldErrors({});

    try {
      await apiFetch(copy.endpoint, {
        method: "POST",
        body: { email, password },
      });

      // `refresh` before `push`: the response just set the session cookie, and
      // any server-component payload cached from the signed-out state would
      // otherwise render first.
      router.refresh();
      router.push("/keys");
    } catch (error) {
      if (error instanceof ApiCallError) {
        setFieldErrors(error.fields);
        // A field-level error is shown next to its input; only surface a
        // banner when there is something the fields do not already say.
        setFormError(
          Object.keys(error.fields).length > 0 ? null : error.message,
        );
      } else {
        setFormError("Something went wrong. Please try again.");
      }
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 py-16">
      <main className="w-full max-w-sm">
        <Link
          href="/"
          className="font-mono text-xs uppercase tracking-[0.18em] text-muted"
        >
          Node Canvas Chat
        </Link>

        <h1 className="mt-5 text-2xl font-semibold tracking-tight">
          {copy.heading}
        </h1>
        <p className="mt-2 text-pretty text-sm leading-relaxed text-muted">
          {copy.subheading}
        </p>

        <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4" noValidate>
          {formError ? (
            <p
              role="alert"
              className="rounded-md border border-hairline px-3 py-2 text-sm"
            >
              {formError}
            </p>
          ) : null}

          <Field
            id="email"
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            error={fieldErrors.email}
            autoComplete="email"
            disabled={busy}
          />

          <Field
            id="password"
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            error={fieldErrors.password}
            autoComplete={copy.autoComplete}
            hint={copy.passwordHint}
            disabled={busy}
          />

          <button
            type="submit"
            disabled={busy}
            className="mt-2 rounded-md bg-foreground px-4 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? copy.busy : copy.submit}
          </button>
        </form>

        <p className="mt-6 text-sm text-muted">
          {copy.footer}{" "}
          <Link
            href={copy.footerHref}
            className="underline decoration-hairline underline-offset-4 hover:decoration-current"
          >
            {copy.footerLink}
          </Link>
        </p>

        {copy.note ? (
          <p className="mt-3 text-pretty text-xs leading-relaxed text-muted">
            {copy.note}
          </p>
        ) : null}
      </main>
    </div>
  );
}

function Field(props: {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  autoComplete: string;
  disabled: boolean;
}) {
  const describedBy = props.error
    ? `${props.id}-error`
    : props.hint
      ? `${props.id}-hint`
      : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={props.id} className="text-sm font-medium">
        {props.label}
      </label>

      <input
        id={props.id}
        name={props.id}
        type={props.type}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        autoComplete={props.autoComplete}
        required
        disabled={props.disabled}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy}
        className="rounded-md border border-hairline bg-transparent px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-foreground/30 disabled:opacity-50"
      />

      {props.error ? (
        <p id={`${props.id}-error`} className="text-sm" role="alert">
          {props.error}
        </p>
      ) : props.hint ? (
        <p id={`${props.id}-hint`} className="text-xs text-muted">
          {props.hint}
        </p>
      ) : null}
    </div>
  );
}
