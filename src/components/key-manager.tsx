"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api-client";
import { withArticle } from "@/lib/article";
import { errorSurfaceFor, type ErrorSurface } from "@/lib/error-surface";
import type { StoredKeySummary } from "@/lib/keys";
import type { ProviderId } from "@/lib/providers/registry";
import {
  AFTER_KEY_CONNECTED,
  AFTER_KEY_CONNECTED_LABEL,
} from "@/lib/routes";
import {
  formatCountdown,
  useSecondsRemaining,
  type RateLimitNotice,
} from "@/lib/rate-limit-notice";
import {
  RateLimitAlert,
  RateLimitCleared,
} from "@/components/rate-limit-alert";
import {
  Alert,
  Button,
  ButtonLink,
  Field,
  PageHeading,
  Shell,
  Spinner,
} from "@/components/ui";

/**
 * Connect, replace and disconnect a model key; sign out; delete the account.
 *
 * This is the highest-trust screen in the product: it asks a stranger to paste
 * a credential that can spend their money. Three things follow from that, and
 * they are design requirements, not decoration.
 *
 * 1. The guarantees are stated *next to the input*, before the paste, not in a
 *    muted paragraph above the fold. Someone deciding whether to trust us is
 *    looking at the field, so that is where the answer has to be.
 * 2. Saving is slow — the server validates the key against the provider before
 *    it stores it — so there is a named verifying state rather than a button
 *    that goes quiet for two seconds.
 * 3. A visitor who does not have a key is not stuck. The rescue path below the
 *    field tells them where to get one and what it will cost them.
 *
 * The key input is write-only by construction. It is cleared the moment the
 * save succeeds, and nothing in this file ever reads a key back from the
 * server — the API has no route that would return one. What renders afterwards
 * is the masked suffix the server sends.
 *
 * Platform Engineer owns what this does. Design Engineer owns how it looks and
 * reads; the visual vocabulary comes from `ui.tsx` and `globals.css`.
 */

type ProviderView = {
  id: ProviderId;
  label: string;
  consoleUrl: string;
  keyPrefix: string;
};

export function KeyManager(props: {
  email: string;
  providers: ProviderView[];
  initialKeys: StoredKeySummary[];
}) {
  const [keys, setKeys] = useState(props.initialKeys);
  const connectedCount = keys.length;

  return (
    <Shell>
      <PageHeading title="Connect your model access">
        One key, pasted once. It is the last thing between you and the canvas.
      </PageHeading>

      <TrustPanel />

      <div className="mt-8 flex flex-col gap-8">
        {props.providers.map((provider) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            stored={keys.find((entry) => entry.provider === provider.id)}
            onChange={(next) =>
              setKeys((current) => {
                const others = current.filter(
                  (entry) => entry.provider !== provider.id,
                );
                return next ? [...others, next] : others;
              })
            }
          />
        ))}
      </div>

      <AccountSection email={props.email} hasKeys={connectedCount > 0} />
    </Shell>
  );
}

/**
 * The trust copy, promoted out of a grey paragraph into the thing you read
 * before you paste. Each line is a claim the implementation actually makes —
 * if one of them stops being true, this panel is the first thing to change.
 */
function TrustPanel() {
  const guarantees = [
    "Encrypted before it is stored, with a key held only by the server.",
    "Never sent back to this browser. No route returns it, not even to you.",
    "Every model call is made server-side, so the key never touches this page.",
    "Deleting your account deletes the key in the same transaction.",
  ];

  return (
    <section
      aria-labelledby="trust-heading"
      className="mt-6 rounded-md border border-hairline px-4 py-3.5"
    >
      <h2 id="trust-heading" className="text-sm font-medium tracking-tight">
        What happens to your key
      </h2>
      <ul className="mt-2 flex flex-col gap-1.5 text-sm leading-relaxed text-muted">
        {guarantees.map((line) => (
          <li key={line} className="flex gap-2">
            <span aria-hidden="true" className="select-none">
              ·
            </span>
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Turns the table's `action` into a real handler.
 *
 * `reload` is the literal fix for a stale CSRF token and nothing the user types
 * will help; `retry` just dismisses the banner so the submit they already have
 * is the retry. Anything else gets no button — an action that is not the fix is
 * noise stacked on top of a failure.
 */
function alertAction(
  alert: NonNullable<ErrorSurface["alert"]>,
  dismiss: () => void,
) {
  if (alert.action === "reload") {
    return { label: "Reload the page", onClick: () => location.reload() };
  }
  if (alert.action === "retry") return { label: "Try again", onClick: dismiss };
  return undefined;
}

function ProviderRow(props: {
  provider: ProviderView;
  stored?: StoredKeySummary;
  onChange: (next: StoredKeySummary | null) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * One surface, resolved by the routing table. Never a banner *and* a field
   * message for the same submit — the person would read one failure twice and
   * have to work out that it is one failure.
   */
  const [surface, setSurface] = useState<ErrorSurface | null>(null);
  const [rateLimit, setRateLimit] = useState<RateLimitNotice | null>(null);
  /** Set only by a save in this session — drives the forward action. */
  const [justSaved, setJustSaved] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const secondsLeft = useSecondsRemaining(rateLimit);
  const waiting = rateLimit !== null && secondsLeft > 0;
  const fieldId = `key-${props.provider.id}`;
  const keyRef = useRef<HTMLInputElement>(null);

  /** The form is hidden once a key is connected, unless the user asks to replace it. */
  const showForm = !props.stored || replacing;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || waiting) return;

    // Clear at t=0, so a second identical failure still looks like it happened.
    setSurface(null);
    setRateLimit(null);

    /*
     * The empty case is answered here, not by the server and not by a disabled
     * button. `PUT /api/keys/:provider` is rate limited at 20/hour, and a
     * request that cannot succeed should never spend one of those — the same
     * reasoning as the sign-up form in TES-10. So this returns before any
     * network call, and the proof is in the capture script: it fails if a
     * request leaves the browser on an empty submit.
     */
    if (value.trim() === "") {
      setSurface({
        alert: null,
        fieldErrors: {
          apiKey: `Paste your ${props.provider.label} key first — it starts with ${props.provider.keyPrefix}.`,
        },
        focus: null,
      });
      keyRef.current?.focus();
      return;
    }

    setBusy(true);

    try {
      const { key } = await apiFetch<{ key: StoredKeySummary }>(
        `/api/keys/${props.provider.id}`,
        { method: "PUT", body: { apiKey: value } },
      );

      // Clear immediately. The key has no further use in this browser.
      setValue("");
      setJustSaved(true);
      setReplacing(false);
      props.onChange(key);
    } catch (caught) {
      const next = errorSurfaceFor(caught, {
        providerLabel: props.provider.label,
        keyField: "apiKey",
      });

      setSurface(next);
      if (next.rateLimit) {
        setRateLimit({
          message: next.alert?.message ?? "",
          retryAfterSeconds: next.rateLimit.retryAfterSeconds,
        });
      }

      /*
       * The pasted value is deliberately kept on a rejection. A key is shown
       * once by the provider's console; clearing the field would send someone
       * back to generate a new one because they mistyped nothing at all.
       */
      if (next.focus === "first-invalid") keyRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setSurface(null);

    try {
      await apiFetch(`/api/keys/${props.provider.id}`, { method: "DELETE" });
      props.onChange(null);
      setJustSaved(false);
      setConfirmingDisconnect(false);
    } catch (caught) {
      setSurface(errorSurfaceFor(caught, { providerLabel: props.provider.label }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-t border-hairline pt-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium tracking-tight">
          {props.provider.label}
        </h2>
        {props.stored ? (
          <p className="text-xs text-success">Connected</p>
        ) : null}
      </div>

      {props.stored && !replacing ? (
        <div className="mt-3 flex flex-col gap-4">
          {/*
           * The success state, and it ends in a button on purpose (D3/C6).
           *
           * This forward action was removed once, on the reasoning that it
           * closed a circle — key screen → `/` → back to the key screen. That
           * was true when `/` was still the marketing scaffold. It is not true
           * now: `/` has a signed-in state that is the product's own front
           * door, says plainly what is and is not live, and is where the canvas
           * will open from. So the destination is a real place, and the spec's
           * ruling stands — a success state with nowhere to go is where a
           * stranger's evaluation quietly ends.
           *
           * The label is honest rather than aspirational. It does not say
           * "Start a canvas" while there is no canvas; the sentence under it
           * says what has not shipped, and `AFTER_KEY_CONNECTED` is the one
           * line to change when TES-5 lands.
           */}
          {justSaved ? (
            <Alert tone="ok" title="Key verified and saved">
              We checked it against {props.provider.label} before storing it, so
              you know it works.
            </Alert>
          ) : null}

          <p className="font-mono text-sm">
            <span aria-hidden="true">••••••••</span>
            <span className="sr-only">Key ending in </span>
            {props.stored.last4}
          </p>

          <p className="text-sm leading-relaxed text-muted">
            Your key is connected. The canvas is not live yet — it will open
            from your home screen when it is.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <ButtonLink href={AFTER_KEY_CONNECTED}>
              {AFTER_KEY_CONNECTED_LABEL}
            </ButtonLink>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setReplacing(true);
                setJustSaved(false);
              }}
              disabled={busy}
            >
              Replace key
            </Button>
          </div>

          {surface?.alert ? (
            <Alert
              tone={surface.alert.tone}
              title={surface.alert.title}
              action={alertAction(surface.alert, () => setSurface(null))}
            >
              {surface.alert.message}
            </Alert>
          ) : null}

          {/*
           * Destructive, so it is separated from the two actions above by a
           * rule and does not sit in the same row as "Start chatting".
           */}
          <div className="mt-2 border-t border-hairline pt-4">
            {confirmingDisconnect ? (
              <ConfirmStep
                prompt={`Remove the stored ${props.provider.label} key? Chat stops working until you paste another one.`}
                confirmLabel="Remove key"
                cancelLabel="Keep it"
                onConfirm={disconnect}
                onCancel={() => setConfirmingDisconnect(false)}
                busy={busy}
              />
            ) : (
              <Button
                type="button"
                variant="quiet"
                className="-ml-4"
                onClick={() => setConfirmingDisconnect(true)}
                disabled={busy}
              >
                Disconnect this key
              </Button>
            )}
          </div>
        </div>
      ) : null}

      {showForm ? (
        <form onSubmit={save} className="mt-3 flex flex-col gap-4">
          {waiting ? (
            <RateLimitAlert secondsLeft={secondsLeft} />
          ) : rateLimit ? (
            <RateLimitCleared />
          ) : surface?.alert ? (
            <Alert
              tone={surface.alert.tone}
              title={surface.alert.title}
              action={alertAction(surface.alert, () => setSurface(null))}
            >
              {surface.alert.message}
            </Alert>
          ) : null}

          <Field
            id={fieldId}
            label={`${props.provider.label} API key`}
            labelHidden
            type="password"
            value={value}
            onChange={setValue}
            placeholder={`${props.provider.keyPrefix}…`}
            // A key is not a password for this site; never offer to save it.
            autoComplete="off"
            spellCheck={false}
            mono
            disabled={busy}
            ref={keyRef}
            error={surface?.fieldErrors.apiKey}
          />

          <div className="flex flex-wrap items-center gap-3">
            {/*
              Enabled at rest, on purpose. A greyed-out primary on a first-run
              screen hides the affordance and never says why it is refusing —
              the visitor is left to guess that the field is the problem. The
              empty case is caught on press instead, below, where it can be
              explained.
            */}
            <Button type="submit" disabled={busy || waiting}>
              {busy ? (
                <>
                  <Spinner />
                  Verifying with {props.provider.label}…
                </>
              ) : waiting ? (
                <span aria-hidden="true" className="tabular-nums">
                  Try again in {formatCountdown(secondsLeft)}
                </span>
              ) : props.stored ? (
                "Save new key"
              ) : (
                "Connect key"
              )}
            </Button>

            {replacing ? (
              <Button
                type="button"
                variant="quiet"
                onClick={() => {
                  setReplacing(false);
                  setValue("");
                  setSurface(null);
                }}
                disabled={busy}
              >
                Cancel
              </Button>
            ) : null}
          </div>

          {/*
           * The verifying state says who we are talking to and why it is slow.
           * Two seconds of silence on the screen where you just handed over a
           * credential is the worst possible place to look broken.
           */}
          {busy ? (
            <p className="text-xs leading-relaxed text-muted" aria-live="polite">
              Checking the key against {props.provider.label} before storing it.
              This takes a moment.
            </p>
          ) : null}

          {!props.stored ? <RescuePath provider={props.provider} /> : null}
        </form>
      ) : null}
    </section>
  );
}

/**
 * The way out for a visitor who does not have a key.
 *
 * Without this the screen is a wall: a password field with a placeholder that
 * means nothing unless you already know what it is. The three facts that
 * actually unblock someone are where to go, that the key is shown once, and
 * that a provider account needs billing set up before its keys work — the last
 * one is the thing people hit and it is better said here than discovered as an
 * `invalid_api_key` error.
 */
function RescuePath({ provider }: { provider: ProviderView }) {
  return (
    <details className="group mt-2 rounded-md border border-hairline px-4 py-3.5 text-sm leading-relaxed text-muted [&_summary::-webkit-details-marker]:hidden">
      <summary className="-my-1 flex cursor-pointer list-none items-center justify-between gap-3 py-1 font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-foreground">
        I don&rsquo;t have {withArticle(provider.label)} key
        <span
          aria-hidden="true"
          className="shrink-0 text-muted transition-transform group-open:rotate-180"
        >
          <Chevron />
        </span>
      </summary>

      <div className="mt-2.5 flex flex-col gap-2.5">
        <p>
          You need {withArticle(provider.label)} account with billing enabled.
          Create one, open <strong className="font-medium">API keys</strong>,
          and make a key — it starts with{" "}
          <code className="font-mono">{provider.keyPrefix}</code> and takes
          about two minutes.
        </p>
        <p>
          You pay {provider.label} directly for what you use. Typical
          evaluation costs are cents, and nothing is charged by us.
        </p>
        <div className="pt-0.5">
          <ButtonLink href={provider.consoleUrl} variant="secondary" external>
            Open the {provider.label} console
          </ButtonLink>
        </div>
      </div>
    </details>
  );
}

/**
 * The two-step confirm, shared by "disconnect this key" and "delete this
 * account" so the two destructive paths cannot drift apart.
 *
 * Escape cancels, and Cancel takes focus the moment the step opens. Without
 * both, a keyboard user who reaches a destructive confirm has no way out except
 * to tab onto the one button they did not mean to press — and the cancel is
 * where focus belongs anyway, because it is the safe answer.
 *
 * The prompt names the consequence plainly and stops there. No guilt copy and
 * no extra hoops: account deletion is currently the only self-service recovery
 * from a lost password, so making it harder would punish the person it exists
 * for.
 */
function ConfirmStep(props: {
  prompt: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={props.prompt}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || props.busy) return;
        // The confirm is the innermost thing listening; nothing above it should
        // also act on this Escape.
        event.stopPropagation();
        props.onCancel();
      }}
      className="flex flex-col gap-3"
    >
      <p className="text-sm leading-relaxed text-muted">{props.prompt}</p>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="destructive"
          onClick={props.onConfirm}
          disabled={props.busy}
        >
          {props.busy ? <Spinner /> : null}
          {props.confirmLabel}
        </Button>
        <Button
          type="button"
          variant="quiet"
          onClick={props.onCancel}
          disabled={props.busy}
          // Focus the safe answer, not the destructive one.
          autoFocus
        >
          {props.cancelLabel}
        </Button>
      </div>
    </div>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="m4 6 4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AccountSection({
  email,
  hasKeys,
}: {
  email: string;
  hasKeys: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  /**
   * Both of these leave regardless of the outcome. Sign-out is idempotent
   * server-side, and if the request failed the destination redirects a caller
   * who still has a valid session — so there is no state where staying put is
   * the better answer.
   */
  async function signOut() {
    setBusy(true);
    try {
      await apiFetch("/api/auth/signout", { method: "POST" });
    } finally {
      router.refresh();
      router.push("/sign-in");
    }
  }

  async function deleteAccount() {
    setBusy(true);
    try {
      await apiFetch("/api/account", { method: "DELETE" });
    } finally {
      router.refresh();
      router.push("/");
    }
  }

  return (
    <>
      <section className="mt-12 border-t border-hairline pt-6">
        <p className="text-sm text-muted">
          Signed in as <span className="font-mono">{email}</span>
        </p>

        <div className="mt-3">
          <Button
            type="button"
            variant="secondary"
            onClick={signOut}
            disabled={busy}
          >
            Sign out
          </Button>
        </div>
      </section>

      {/*
       * Account deletion is irreversible and takes the stored key with it, so
       * it does not share a row with sign-out. Its own region, its own rule,
       * its own heading, and a confirm step before anything happens — a
       * destructive action should never be one stray click from a benign one.
       */}
      <section
        aria-labelledby="danger-heading"
        className="mt-8 rounded-md border border-danger-border px-4 py-3.5"
      >
        <h2 id="danger-heading" className="text-sm font-medium text-danger">
          Delete this account
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          Removes the account, every session, and
          {hasKeys ? " the stored key" : " any stored key"} in one transaction.
          This cannot be undone and there is no export.
        </p>

        <div className="mt-3">
          {confirming ? (
            <ConfirmStep
              prompt="Delete the account, the stored key and everything in it? This cannot be undone."
              confirmLabel="Yes, delete everything"
              cancelLabel="Cancel"
              onConfirm={deleteAccount}
              onCancel={() => setConfirming(false)}
              busy={busy}
            />
          ) : (
            <Button
              type="button"
              variant="destructive"
              onClick={() => setConfirming(true)}
              disabled={busy}
            >
              Delete account
            </Button>
          )}
        </div>
      </section>
    </>
  );
}
