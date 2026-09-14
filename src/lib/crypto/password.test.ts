import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashPassword, verifyPassword } from "./password";

describe("password verifier", () => {
  it("verifies the password it hashed", async () => {
    const stored = await hashPassword("correct horse battery staple");
    assert.equal(
      await verifyPassword("correct horse battery staple", stored),
      true,
    );
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    assert.equal(await verifyPassword("Correct horse battery staple", stored), false);
    assert.equal(await verifyPassword("", stored), false);
  });

  it("never stores the password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    assert.ok(!stored.includes("correct horse battery staple"));
  });

  it("salts, so identical passwords hash differently", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");
    assert.notEqual(first, second);
    // Both still verify — the salt travels with the hash.
    assert.equal(await verifyPassword("correct horse battery staple", first), true);
    assert.equal(await verifyPassword("correct horse battery staple", second), true);
  });

  it("records its parameters so the cost can be raised later", async () => {
    const stored = await hashPassword("correct horse battery staple");
    const [scheme, n, r, p] = stored.split("$");
    assert.equal(scheme, "scrypt");
    assert.equal(Number(n), 32768);
    assert.equal(Number(r), 8);
    assert.equal(Number(p), 1);
  });

  it("normalises unicode, so the same typed password always verifies", async () => {
    // "é" composed vs decomposed: identical to the user, different bytes.
    const stored = await hashPassword("café password");
    assert.equal(await verifyPassword("café password", stored), true);
  });

  it("returns false for a malformed stored value instead of throwing", async () => {
    // A row corrupted or written by something else must fail closed, not 500.
    for (const bad of ["", "not-a-hash", "scrypt$1$2", "bcrypt$a$b$c$d$e"]) {
      assert.equal(await verifyPassword("anything", bad), false);
    }
  });
});
