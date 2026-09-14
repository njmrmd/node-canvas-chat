import { query, queryOne } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { maskedSuffix, openApiKey, sealApiKey } from "@/lib/crypto/vault";
import type { ProviderId } from "@/lib/providers/registry";

/**
 * Every read and write of a stored key goes through this module, and every
 * statement in it is scoped by `user_id`.
 *
 * `authentication vs authorization`: the session tells us *who* is calling;
 * these predicates decide *what they may touch*. A route that has resolved a
 * session has not yet authorized anything. Keeping the ownership predicate in
 * the SQL rather than in a JavaScript check after the fetch means there is no
 * version of "we loaded the row and then forgot to compare the owner".
 */

export type StoredKeySummary = {
  provider: ProviderId;
  /** The last four characters. The only key-derived value we ever return. */
  last4: string;
  createdAt: string;
  updatedAt: string;
};

export async function listKeys(userId: string): Promise<StoredKeySummary[]> {
  const rows = await query<{
    provider: string;
    last4: string;
    created_at: Date;
    updated_at: Date;
  }>(
    `select provider, last4, created_at, updated_at
       from provider_keys
      where user_id = $1
      order by provider`,
    [userId],
  );

  return rows.map((row) => ({
    provider: row.provider as ProviderId,
    last4: row.last4,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

/**
 * Stores (or replaces) a key. The caller is expected to have validated it
 * against the provider first — we do not want to persist a key we already know
 * does not work.
 */
export async function saveKey(
  userId: string,
  provider: ProviderId,
  apiKey: string,
): Promise<StoredKeySummary> {
  const sealed = sealApiKey(apiKey, userId, provider);

  const row = await queryOne<{ created_at: Date; updated_at: Date }>(
    `insert into provider_keys
            (user_id, provider, ciphertext, iv, auth_tag, key_version, last4)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (user_id, provider) do update
            set ciphertext  = excluded.ciphertext,
                iv          = excluded.iv,
                auth_tag    = excluded.auth_tag,
                key_version = excluded.key_version,
                last4       = excluded.last4,
                updated_at  = now()
      returning created_at, updated_at`,
    [
      userId,
      provider,
      sealed.ciphertext,
      sealed.iv,
      sealed.authTag,
      sealed.keyVersion,
      maskedSuffix(apiKey),
    ],
  );

  if (!row) {
    throw new ApiError("internal_error", "Could not save that key.");
  }

  return {
    provider,
    last4: maskedSuffix(apiKey),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Decrypts a key for one server-side provider call.
 *
 * This is the only function in the codebase that produces a plaintext user
 * key, and it has exactly one caller: the chat route, which passes the value
 * straight to the provider SDK. It must never be returned from a route, put in
 * a template, or logged.
 */
export async function getDecryptedKey(
  userId: string,
  provider: ProviderId,
): Promise<string> {
  const row = await queryOne<{
    ciphertext: Buffer;
    iv: Buffer;
    auth_tag: Buffer;
    key_version: number;
  }>(
    `select ciphertext, iv, auth_tag, key_version
       from provider_keys
      where user_id = $1 and provider = $2`,
    [userId, provider],
  );

  if (!row) {
    throw new ApiError(
      "no_key_configured",
      "Connect a key for this provider before sending a message.",
    );
  }

  return openApiKey(
    {
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.auth_tag,
      keyVersion: row.key_version,
    },
    userId,
    provider,
  );
}

/** Returns false when the account had no key for that provider. */
export async function deleteKey(
  userId: string,
  provider: ProviderId,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    "delete from provider_keys where user_id = $1 and provider = $2 returning id",
    [userId, provider],
  );
  return rows.length > 0;
}
