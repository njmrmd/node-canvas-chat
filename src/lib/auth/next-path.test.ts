import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_SIGNED_IN_PATH,
  resolveNextPath,
  safeNextPath,
  signInHref,
} from "./next-path";

describe("safeNextPath", () => {
  it("keeps an in-app destination", () => {
    assert.equal(safeNextPath("/keys"), "/keys");
    assert.equal(safeNextPath("/canvas/abc?panel=nodes"), "/canvas/abc?panel=nodes");
  });

  it("refuses anything that could leave the origin", () => {
    for (const value of [
      "https://evil.example/keys",
      "//evil.example",
      "/\\evil.example",
      "/%2f%2fevil.example",
      "/%5c%5cevil.example",
      "http:/evil.example",
      "javascript:alert(1)",
      "keys",
      "",
    ]) {
      assert.equal(safeNextPath(value), null, value);
    }
  });

  it("refuses a value that is not a string", () => {
    // `?next=/a&next=/b` arrives as an array.
    assert.equal(safeNextPath(["/keys", "/keys"]), null);
    assert.equal(safeNextPath(undefined), null);
  });

  it("refuses a malformed percent escape rather than guessing", () => {
    assert.equal(safeNextPath("/%zz"), null);
  });

  it("refuses control characters and whitespace", () => {
    assert.equal(safeNextPath("/keys\nSet-Cookie: x=1"), null);
    assert.equal(safeNextPath("/two words"), null);
  });

  it("refuses the auth screens, which would be a loop", () => {
    assert.equal(safeNextPath("/sign-in"), null);
    assert.equal(safeNextPath("/sign-up?next=%2Fsign-in"), null);
  });

  it("refuses an absurdly long value", () => {
    assert.equal(safeNextPath(`/${"a".repeat(600)}`), null);
  });
});

describe("resolveNextPath", () => {
  it("falls back to the default rather than returning null", () => {
    assert.equal(resolveNextPath("//evil.example"), DEFAULT_SIGNED_IN_PATH);
    assert.equal(resolveNextPath(undefined), DEFAULT_SIGNED_IN_PATH);
    assert.equal(resolveNextPath("/keys"), "/keys");
  });
});

describe("signInHref", () => {
  it("encodes the destination it carries", () => {
    assert.equal(signInHref("/canvas/abc?panel=nodes"), "/sign-in?next=%2Fcanvas%2Fabc%3Fpanel%3Dnodes");
  });

  it("omits the parameter entirely when there is nothing safe to carry", () => {
    assert.equal(signInHref("https://evil.example"), "/sign-in");
    assert.equal(signInHref(null), "/sign-in");
  });
});
