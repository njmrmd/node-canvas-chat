import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { promisify } from "node:util";

/**
 * `promisify` resolves to `scrypt`'s 3-argument overload, which drops the
 * options we need. Assert the 4-argument shape rather than call the callback
 * form by hand at every site.
 */
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Password verifiers using Node's built-in scrypt.
 *
 * Supply chain: the right number of dependencies for hashing a password is
 * zero. scrypt is memory-hard, is in the standard library, and is the option
 * OWASP lists alongside argon2 and bcrypt. Adding a native bcrypt binding for
 * a marginal difference would be a worse trade than the parameters below.
 *
 * N=2^15, r=8, p=1 costs ~32 MB and ~100 ms per verify on Vercel's function
 * CPU. That is deliberately slow enough to make offline cracking expensive and
 * fast enough that sign-in does not feel broken. maxmem must be raised above
 * Node's 32 MB default or scrypt throws at these parameters.
 */
const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEM = 192 * 1024 * 1024;

const SALT_BYTES = 16;

/*
 * The length bounds moved to `@/lib/auth/credentials`, which the sign-up form
 * also imports. This module pulls in `node:crypto`, so it cannot be the shared
 * home for anything the browser needs.
 */

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  return scryptAsync(password.normalize("NFKC"), salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEM,
  });
}

/** Returns `scrypt$N$r$p$<salt base64>$<hash base64>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt);
  return [
    "scrypt",
    N,
    R,
    P,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

/**
 * Constant-time verify. Parameters come from the stored string rather than the
 * constants above, so raising the cost later does not invalidate existing
 * accounts.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");

  let actual: Buffer;
  try {
    actual = await scryptAsync(
      password.normalize("NFKC"),
      salt,
      expected.length,
      { N: Number(n), r: Number(r), p: Number(p), maxmem: MAX_MEM },
    );
  } catch {
    return false;
  }

  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * A verifier for an email that does not exist, so sign-in spends the same CPU
 * whether or not the account is real. Without this, response time is an
 * account-enumeration oracle.
 */
let dummyVerifier: Promise<string> | null = null;

export function dummyPasswordHash(): Promise<string> {
  dummyVerifier ??= hashPassword(randomBytes(24).toString("base64"));
  return dummyVerifier;
}
