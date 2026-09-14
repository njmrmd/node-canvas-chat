"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ApiCallError, apiFetch } from "@/lib/api-client";
import type { StoredKeySummary } from "@/lib/keys";
import type { ProviderId } from "@/lib/providers/registry";

/**
 * Connect, replace and disconnect a model key; sign out; delete the account.
 *
 * The key input is write-only by construction. It is cleared the moment the
 * save succeeds, and nothing in this file ever reads a key back from the
 * server — the API has no route that would return one. What renders afterwards
 * is the masked suffix the server sends.
 *
 * Platform Engineer owns what this does. Design Engineer owns how it looks and
 * reads — this is a working baseline, not the visual direction.
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

  return (
    <div className="flex min-h-dvh flex-col items-center px-6 py-16">
      <main className="w-full max-w-md">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">
          Node Canvas Chat
        </p>

        <h1 className="mt-5 text-2xl font-semibold tracking-tight">
          Connect your model access
        </h1>
        <p className="mt-2 text-pretty text-sm leading-relaxed text-muted">
          Your key is encrypted before it is stored and is never sent back to
          this browser. Every model call is made from our server, so the key
          never touches the page you are reading.
        </p>

        <div className="mt-10 flex flex-col gap-8">
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

        <AccountSection email={props.email} />
      </main>
    </div>
  );
}

function ProviderRow(props: {
  provider: ProviderView;
  stored?: StoredKeySummary;
  onChange: (next: StoredKeySummary | null) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const { key } = await apiFetch<{ key: StoredKeySummary }>(
        `/api/keys/${props.provider.id}`,
        { method: "PUT", body: { apiKey: value } },
      );

      // Clear immediately. The key has no further use in this browser.
      setValue("");
      setNotice("Key verified and saved.");
      props.onChange(key);
    } catch (caught) {
      setError(
        caught instanceof ApiCallError
          ? (caught.fields.apiKey ?? caught.message)
          : "Something went wrong. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      await apiFetch(`/api/keys/${props.provider.id}`, { method: "DELETE" });
      props.onChange(null);
      setNotice("Key removed.");
    } catch (caught) {
      setError(
        caught instanceof ApiCallError
          ? caught.message
          : "Could not remove that key.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-t border-hairline pt-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium">{props.provider.label}</h2>
        <a
          href={props.provider.consoleUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-xs text-muted underline decoration-hairline underline-offset-4 hover:decoration-current"
        >
          Get a key
        </a>
      </div>

      {props.stored ? (
        <div className="mt-3 flex items-center justify-between gap-4">
          <p className="font-mono text-sm">
            <span aria-hidden="true">••••••••</span>
            <span className="sr-only">Key ending in </span>
            {props.stored.last4}
          </p>
          <button
            type="button"
            onClick={disconnect}
            disabled={busy}
            className="text-xs text-muted underline decoration-hairline underline-offset-4 hover:decoration-current disabled:opacity-50"
          >
            Disconnect
          </button>
        </div>
      ) : null}

      <form onSubmit={save} className="mt-3 flex flex-col gap-2">
        <label htmlFor={`key-${props.provider.id}`} className="sr-only">
          {props.provider.label} API key
        </label>

        <input
          id={`key-${props.provider.id}`}
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={`${props.provider.keyPrefix}…`}
          // A key is not a password for this site; never offer to save it.
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `key-${props.provider.id}-error` : undefined}
          className="rounded-md border border-hairline bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-foreground/30 disabled:opacity-50"
        />

        <button
          type="submit"
          disabled={busy || value.trim() === ""}
          className="self-start rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy
            ? "Checking…"
            : props.stored
              ? "Replace key"
              : "Connect key"}
        </button>

        {error ? (
          <p
            id={`key-${props.provider.id}-error`}
            role="alert"
            className="text-sm"
          >
            {error}
          </p>
        ) : notice ? (
          <p className="text-sm text-muted">{notice}</p>
        ) : null}
      </form>
    </section>
  );
}

function AccountSection({ email }: { email: string }) {
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
    <section className="mt-12 border-t border-hairline pt-6">
      <p className="text-sm text-muted">
        Signed in as <span className="font-mono">{email}</span>
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <button
          type="button"
          onClick={signOut}
          disabled={busy}
          className="underline decoration-hairline underline-offset-4 hover:decoration-current disabled:opacity-50"
        >
          Sign out
        </button>

        {confirming ? (
          <span className="flex items-center gap-3 text-muted">
            <span>Delete the account and the stored key?</span>
            <button
              type="button"
              onClick={deleteAccount}
              disabled={busy}
              className="underline decoration-hairline underline-offset-4 hover:decoration-current disabled:opacity-50"
            >
              Yes, delete
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="underline decoration-hairline underline-offset-4 hover:decoration-current disabled:opacity-50"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy}
            aria-describedby="delete-account-consequence"
            className="text-muted underline decoration-hairline underline-offset-4 hover:decoration-current disabled:opacity-50"
          >
            Delete account
          </button>
        )}
      </div>

      {/*
        Deletion stays visible and spelled out rather than tucked behind a
        settings page: with no password reset yet, this is the only self-service
        way to remove an account and the key stored against it.
      */}
      <p
        id="delete-account-consequence"
        className="mt-3 text-pretty text-xs leading-relaxed text-muted"
      >
        Deleting removes your account and the stored key immediately, signs out
        every session, and cannot be undone. Your key stays valid at the
        provider — revoke it there too if you want it dead.
      </p>
    </section>
  );
}
