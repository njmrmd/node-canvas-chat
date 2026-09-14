"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ApiCallError, apiFetch } from "@/lib/api-client";
import { Consequence } from "@/components/consequence";

/**
 * Sign-up and sign-in. One component, because the two forms differ only in
 * their endpoint and their copy — and keeping them together means the error
 * handling cannot drift between them.
 *
 * Platform Engineer owns what this does. Design Engineer owns how it looks and
 * reads.
 */

type Mode = "sign-up" | "sign-in";

/**
 * There is no password reset yet. That is a deliberate, recorded gap rather
 * than an oversight — so it gets said out loud at the moment the password is
 * chosen, and again on the screen where a locked-out person lands. A stranger
 * locked out with no warning is a worse impression than a missing feature
 * honestly labelled.
 *
 * Both are `Consequence` blocks rather than hint text. The rule about length
 * is advice and can live in the small muted slot under the field; the warning
 * is the part that changes what someone does with the next thirty seconds, and
 * advice-weight type is where a warning goes to be ignored.
 */
const NO_RESET = {
  signUp: {
    lead: "Save this password somewhere you can find it again.",
    detail:
      "There is no reset yet, so a lost password cannot be recovered.",
  },
  signIn: {
    lead: "Forgotten your password? We cannot reset it yet — that is a gap on our side, not a policy.",
    detail:
      "The way back in is a new account, and you will need to reconnect your model key.",
  },
} as const;

const COPY = {
  "sign-up": {
    heading: "Create an account",
    subheading:
      "You bring your own model access. We never see your provider bill, and you can delete your account and your key at any time.",
    submit: "Create account",
    busy: "Creating account…",
    endpoint: "/api/auth/signup",
    footer: "Already have an account?",
    footerLink: "Sign in",
    footerHref: "/sign-in",
    autoComplete: "new-password",
    passwordHint: "At least 10 characters. Length beats punctuation.",
    warning: NO_RESET.signUp,
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
    warning: null,
    note: NO_RESET.signIn,
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
            describedBy={copy.warning ? ["password-no-reset"] : undefined}
            disabled={busy}
          />

          {/*
            Inside the form and above the submit button: the warning has to be
            passed on the way to the commitment, not found afterwards.
          */}
          {copy.warning ? (
            <Consequence
              id="password-no-reset"
              emphasis="region"
              lead={copy.warning.lead}
              detail={copy.warning.detail}
            />
          ) : null}

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

        {/*
          Separated from the footer by a rule. Stacked directly under "No
          account yet? Create one" it read as a second, competing sign-up
          prompt; it is its own answer to its own question.
        */}
        {copy.note ? (
          <div className="mt-8 border-t border-hairline pt-6">
            <Consequence lead={copy.note.lead} detail={copy.note.detail} />
          </div>
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
  describedBy?: string[];
  autoComplete: string;
  disabled: boolean;
}) {
  // All of them, not the first one that applies. The old version swapped the
  // hint out for the error, so the moment someone got the password rule wrong
  // was the moment a screen reader stopped reading them the rule.
  const describedBy =
    [
      props.error ? `${props.id}-error` : null,
      props.hint ? `${props.id}-hint` : null,
      ...(props.describedBy ?? []),
    ]
      .filter(Boolean)
      .join(" ") || undefined;

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
      ) : null}

      {props.hint ? (
        <p id={`${props.id}-hint`} className="text-sm text-muted">
          {props.hint}
        </p>
      ) : null}
    </div>
  );
}
