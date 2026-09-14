import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { maskedSuffix, openApiKey, sealApiKey } from "./vault";

/**
 * The key vault is the highest-trust code in the product, so it is the code
 * that gets tested. These run without a database — the vault is pure.
 */

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const KEY = "sk-ant-api03-EXAMPLE-NOT-A-REAL-KEY-0000000000-abcd";

let originalEnv: string | undefined;

before(() => {
  originalEnv = process.env.KEY_VAULT_ENCRYPTION_KEY;
  process.env.KEY_VAULT_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

after(() => {
  if (originalEnv === undefined) delete process.env.KEY_VAULT_ENCRYPTION_KEY;
  else process.env.KEY_VAULT_ENCRYPTION_KEY = originalEnv;
});

describe("key vault", () => {
  it("round-trips a key for the account that stored it", () => {
    const sealed = sealApiKey(KEY, USER_A, "anthropic");
    assert.equal(openApiKey(sealed, USER_A, "anthropic"), KEY);
  });

  it("never stores the plaintext in the ciphertext", () => {
    const sealed = sealApiKey(KEY, USER_A, "anthropic");
    assert.ok(!sealed.ciphertext.toString("utf8").includes("sk-ant"));
    assert.ok(!sealed.ciphertext.toString("utf8").includes(KEY));
  });

  it("uses a fresh IV per seal, so the same key never encrypts alike", () => {
    const first = sealApiKey(KEY, USER_A, "anthropic");
    const second = sealApiKey(KEY, USER_A, "anthropic");
    assert.notDeepEqual(first.iv, second.iv);
    assert.notDeepEqual(first.ciphertext, second.ciphertext);
  });

  it("refuses to decrypt another account's ciphertext", () => {
    // The threat: an attacker with database *write* access moves Alice's row
    // onto Bob's account to read her key through the app. The AAD binding is
    // what stops it.
    const sealed = sealApiKey(KEY, USER_A, "anthropic");
    assert.throws(() => openApiKey(sealed, USER_B, "anthropic"), {
      code: "no_key_configured",
    });
  });

  it("refuses to decrypt under a different provider", () => {
    const sealed = sealApiKey(KEY, USER_A, "anthropic");
    assert.throws(() => openApiKey(sealed, USER_A, "openai"), {
      code: "no_key_configured",
    });
  });

  it("detects a tampered ciphertext rather than returning garbage", () => {
    const sealed = sealApiKey(KEY, USER_A, "anthropic");
    sealed.ciphertext[0] ^= 0xff;
    assert.throws(() => openApiKey(sealed, USER_A, "anthropic"), {
      code: "no_key_configured",
    });
  });

  it("fails closed when the server key is missing", () => {
    const saved = process.env.KEY_VAULT_ENCRYPTION_KEY;
    delete process.env.KEY_VAULT_ENCRYPTION_KEY;
    try {
      // The failure must be a refusal, never a fallback to storing plaintext.
      assert.throws(() => sealApiKey(KEY, USER_A, "anthropic"), {
        code: "not_configured",
      });
    } finally {
      process.env.KEY_VAULT_ENCRYPTION_KEY = saved;
    }
  });

  it("fails closed when the server key is the wrong length", () => {
    const saved = process.env.KEY_VAULT_ENCRYPTION_KEY;
    process.env.KEY_VAULT_ENCRYPTION_KEY = randomBytes(16).toString("base64");
    try {
      assert.throws(() => sealApiKey(KEY, USER_A, "anthropic"), {
        code: "not_configured",
      });
    } finally {
      process.env.KEY_VAULT_ENCRYPTION_KEY = saved;
    }
  });

  it("cannot be decrypted by a different server key", () => {
    // This is the preview-cannot-read-production guarantee.
    const sealed = sealApiKey(KEY, USER_A, "anthropic");
    const saved = process.env.KEY_VAULT_ENCRYPTION_KEY;
    process.env.KEY_VAULT_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    try {
      assert.throws(() => openApiKey(sealed, USER_A, "anthropic"), {
        code: "no_key_configured",
      });
    } finally {
      process.env.KEY_VAULT_ENCRYPTION_KEY = saved;
    }
  });

  it("masks to the last four characters only", () => {
    assert.equal(maskedSuffix(KEY), "abcd");
    assert.equal(maskedSuffix(KEY).length, 4);
  });
});
