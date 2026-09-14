import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ApiError } from "@/lib/http";

/**
 * The BYO key vault: AES-256-GCM over a user's provider API key.
 *
 * Where the key lives: `provider_keys.ciphertext`, in our Postgres. Never in
 * a cookie, never in localStorage, never in a response body, never in a log.
 *
 * What encrypts it: a 32-byte server-held key in KEY_VAULT_ENCRYPTION_KEY,
 * which exists only in the Vercel environment. Production and Preview hold
 * *different* values, so a preview deployment structurally cannot decrypt a
 * production key.
 *
 * Who can read it: the server, inside a request that has already proven the
 * session owns the row. Nothing else — there is no route that returns it.
 *
 * What an attacker with database read access gets: ciphertext, a random IV, a
 * GCM tag and the last four characters of the key. AES-256-GCM with a
 * server-side key is not brute-forcible from that material, so the dump is
 * inert without also compromising the Vercel environment. That is the whole
 * point of splitting the two.
 *
 * Additional authenticated data binds each ciphertext to `<userId>:<provider>`.
 * An attacker with database *write* access therefore cannot move Alice's
 * ciphertext onto Bob's row and have it decrypt — the tag check fails.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for.
const KEY_BYTES = 32;

/** Bumped when the server key rotates; stored alongside each row. */
export const CURRENT_KEY_VERSION = 1;

function encryptionKey(): Buffer {
  const raw = process.env.KEY_VAULT_ENCRYPTION_KEY;
  if (!raw) {
    // Fail closed. A missing vault key must never degrade to storing plaintext.
    throw new ApiError(
      "not_configured",
      "Key storage is not configured for this deployment yet.",
    );
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new ApiError(
      "not_configured",
      "Key storage is misconfigured for this deployment.",
    );
  }
  return key;
}

/** True when this deployment can actually encrypt. Used by health reporting. */
export function isVaultConfigured(): boolean {
  const raw = process.env.KEY_VAULT_ENCRYPTION_KEY;
  return Boolean(raw) && Buffer.from(raw!, "base64").length === KEY_BYTES;
}

export type SealedKey = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
};

function aad(userId: string, provider: string): Buffer {
  return Buffer.from(`${userId}:${provider}`, "utf8");
}

export function sealApiKey(
  plaintext: string,
  userId: string,
  provider: string,
): SealedKey {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  cipher.setAAD(aad(userId, provider));

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return {
    ciphertext,
    iv,
    authTag: cipher.getAuthTag(),
    keyVersion: CURRENT_KEY_VERSION,
  };
}

export function openApiKey(
  sealed: SealedKey,
  userId: string,
  provider: string,
): string {
  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), sealed.iv);
  decipher.setAAD(aad(userId, provider));
  decipher.setAuthTag(sealed.authTag);

  try {
    return Buffer.concat([
      decipher.update(sealed.ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Tag mismatch: tampered row, wrong account, or a rotated server key.
    // Fail closed and tell the user something actionable.
    throw new ApiError(
      "no_key_configured",
      "Your saved key could not be read. Please reconnect it.",
    );
  }
}

/**
 * The only plaintext-derived value we are willing to show a browser. Four
 * characters of a key with 40+ characters of entropy identifies which key you
 * pasted without narrowing an attacker's search in any useful way.
 */
export function maskedSuffix(apiKey: string): string {
  return apiKey.slice(-4);
}
