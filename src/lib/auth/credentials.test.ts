import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  checkCredentials,
  checkEmail,
  checkExistingPassword,
  checkNewPassword,
  normaliseEmail,
} from "./credentials";

/**
 * The cases below are the QA repro from TES-10 verbatim. They are the reason
 * this module exists: each one used to leave the browser and spend a slot in a
 * per-IP rate limit that a stranger needs to create an account.
 */
describe("sign-up form submissions that must not leave the browser", () => {
  it("refuses an empty form", () => {
    assert.deepEqual(checkCredentials("sign-up", { email: "", password: "" }), {
      email: "Enter your email address.",
      password: "Choose a password.",
    });
  });

  it("refuses `not-an-email` / `abc` and says what is wrong with each", () => {
    const fields = checkCredentials("sign-up", {
      email: "not-an-email",
      password: "abc",
    });

    assert.equal(Object.keys(fields).length, 2);
    assert.match(fields.email!, /@/);
    assert.match(fields.password!, new RegExp(String(PASSWORD_MIN_LENGTH)));
  });

  it("lets a valid pair through", () => {
    assert.deepEqual(
      checkCredentials("sign-up", {
        email: "stranger@example.com",
        password: "correct horse battery",
      }),
      {},
    );
  });
});

describe("sign-in uses shape rules only", () => {
  it("accepts a short password that sign-up would reject", () => {
    // An existing account may predate any rule change; refusing to *submit* it
    // would lock out the account rather than protect it.
    assert.equal(checkNewPassword("abc"), `Use at least ${PASSWORD_MIN_LENGTH} characters. Length beats punctuation.`);
    assert.equal(checkExistingPassword("abc"), null);
  });

  it("still refuses an empty password", () => {
    assert.equal(checkExistingPassword(""), "Enter your password.");
  });

  it("refuses an oversized password without saying why", () => {
    const huge = "x".repeat(PASSWORD_MAX_LENGTH + 1);
    assert.equal(checkExistingPassword(huge), "Enter your password.");
    assert.equal(checkNewPassword(huge), `Use at most ${PASSWORD_MAX_LENGTH} characters.`);
  });
});

describe("email", () => {
  it("accepts addresses people actually have", () => {
    for (const value of [
      "a@b.co",
      "first.last+tag@sub.domain.example",
      "  Spaced@Example.COM  ",
    ]) {
      assert.equal(checkEmail(value), null, value);
    }
  });

  it("rejects addresses that cannot be one", () => {
    for (const value of ["", "   ", "not-an-email", "no@tld", "two@@at.com", "a b@c.com", 42, null]) {
      assert.notEqual(checkEmail(value), null, String(value));
    }
  });

  it("normalises case and surrounding space", () => {
    assert.equal(normaliseEmail("  Stranger@Example.COM "), "stranger@example.com");
  });

  it("rejects an address past the RFC 5321 practical maximum", () => {
    assert.notEqual(checkEmail(`${"a".repeat(250)}@example.com`), null);
  });
});
