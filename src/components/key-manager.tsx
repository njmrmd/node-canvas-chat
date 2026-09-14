"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api-client";
import { errorSurfaceFor, type ErrorSurface } from "@/lib/error-surface";
import type { StoredKeySummary } from "@/lib/keys";
import type { ProviderId } from "@/lib/providers/registry";
import {
  formatCountdown,
  useSecondsRemaining,
  type RateLimitNotice,
} from "@/lib/rate-limit-notice";
import { AFTER_KEY_CONNECTED, AFTER_KEY_CONNECTED_LABEL } from "@/lib/routes";
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
  TextLink,
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
    setBusy(true);
    setSurface(null);
    setRateLimit(null);

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
           * The success state, with somewhere to go. A confirmation that ends
           * in a full stop leaves the user on the last screen of onboarding
           * wondering whether onboarding is over.
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
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted">
                  Remove the stored {props.provider.label} key? Chat stops
                  working until you paste another one.
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={disconnect}
                    disabled={busy}
                  >
                    {busy ? <Spinner /> : null}
                    Remove key
                  </Button>
                  <Button
                    type="button"
                    variant="quiet"
                    onClick={() => setConfirmingDisconnect(false)}
                    disabled={busy}
                  >
                    Keep it
                  </Button>
                </div>
              </div>
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
            <Button type="submit" disabled={busy || waiting || value.trim() === ""}>
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
    <aside className="mt-2 rounded-md border border-hairline px-4 py-3.5 text-sm leading-relaxed text-muted">
      <p className="font-medium text-foreground">
        Do not have a {provider.label} key?
      </p>
      <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-4">
        <li>
          Open the{" "}
          <TextLink href={provider.consoleUrl} external>
            {provider.label} console
          </TextLink>{" "}
          and create an API key.
        </li>
        <li>
          Copy it straight away — the console shows the full key once and never
          again.
        </li>
        <li>
          Paste it above. It starts with{" "}
          <code className="font-mono">{provider.keyPrefix}</code>.
        </li>
      </ol>
      <p className="mt-2.5">
        API keys are billed by {provider.label}, not by us, and a brand-new
        account usually needs a payment method before its keys will work.
      </p>
    </aside>
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
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="destructive"
                onClick={deleteAccount}
                disabled={busy}
              >
                {busy ? <Spinner /> : null}
                Yes, delete everything
              </Button>
              <Button
                type="button"
                variant="quiet"
                onClick={() => setConfirming(false)}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
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
