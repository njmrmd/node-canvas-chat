import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertSameOrigin } from "./csrf";

function request(headers: Record<string, string>): Request {
  return new Request("https://app.example/api/auth/signin", {
    method: "POST",
    headers: { host: "app.example", ...headers },
  });
}

describe("CSRF origin check", () => {
  it("allows the app's own origin", () => {
    assert.doesNotThrow(() =>
      assertSameOrigin(
        request({ origin: "https://app.example", "sec-fetch-site": "same-origin" }),
      ),
    );
  });

  it("allows a request with no Origin header", () => {
    // Same-origin navigations and non-browser clients omit it; the SameSite
    // cookie is doing the work in that case.
    assert.doesNotThrow(() => assertSameOrigin(request({})));
  });

  it("rejects a cross-site Origin", () => {
    assert.throws(() => assertSameOrigin(request({ origin: "https://evil.example" })), {
      code: "csrf_failed",
    });
  });

  it("rejects a look-alike origin on the same suffix", () => {
    assert.throws(
      () => assertSameOrigin(request({ origin: "https://app.example.evil.com" })),
      { code: "csrf_failed" },
    );
  });

  it("rejects the plain-HTTP twin of the app's origin", () => {
    assert.throws(() => assertSameOrigin(request({ origin: "http://app.example" })), {
      code: "csrf_failed",
    });
  });

  it("rejects on Sec-Fetch-Site even when Origin is absent", () => {
    assert.throws(() => assertSameOrigin(request({ "sec-fetch-site": "cross-site" })), {
      code: "csrf_failed",
    });
  });

  it("allows Sec-Fetch-Site: none (a typed-in address bar)", () => {
    assert.doesNotThrow(() => assertSameOrigin(request({ "sec-fetch-site": "none" })));
  });

  it("allows http on localhost, so development works", () => {
    const local = new Request("http://localhost:3000/api/auth/signin", {
      method: "POST",
      headers: { host: "localhost:3000", origin: "http://localhost:3000" },
    });
    assert.doesNotThrow(() => assertSameOrigin(local));
  });
});
