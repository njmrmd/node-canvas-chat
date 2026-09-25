import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError, DEFAULT_MAX_BODY_BYTES, readJsonBody } from "./http";

function jsonRequest(body: string, headers: Record<string, string> = {}) {
  return new Request("https://example.test/api", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError);
    return error.code;
  }
  assert.fail("expected readJsonBody to reject");
}

describe("readJsonBody", () => {
  it("parses a JSON object under the default cap", async () => {
    assert.deepEqual(await readJsonBody(jsonRequest('{"a":1}')), { a: 1 });
  });

  it("refuses a body over the default cap as payload_too_large", async () => {
    const body = JSON.stringify({ text: "x".repeat(DEFAULT_MAX_BODY_BYTES) });
    assert.equal(await rejectionCode(readJsonBody(jsonRequest(body))), "payload_too_large");
  });

  it("accepts the same body when the route raises its own cap", async () => {
    const body = JSON.stringify({ text: "x".repeat(DEFAULT_MAX_BODY_BYTES) });
    const parsed = await readJsonBody(jsonRequest(body), {
      maxBytes: 2 * DEFAULT_MAX_BODY_BYTES,
    });
    assert.equal((parsed.text as string).length, DEFAULT_MAX_BODY_BYTES);
  });

  it("counts UTF-8 bytes, not characters", async () => {
    // 100 three-byte characters: 100 chars, 300+ bytes.
    const body = JSON.stringify({ text: "€".repeat(100) });
    assert.equal(
      await rejectionCode(readJsonBody(jsonRequest(body), { maxBytes: 200 })),
      "payload_too_large",
    );
  });

  it("refuses early on an oversized Content-Length", async () => {
    const request = jsonRequest("{}", { "content-length": String(10 * 1024 * 1024) });
    assert.equal(await rejectionCode(readJsonBody(request)), "payload_too_large");
  });

  it("still requires a JSON content type and a plain object", async () => {
    const text = new Request("https://example.test/api", { method: "POST", body: "{}" });
    assert.equal(await rejectionCode(readJsonBody(text)), "invalid_request");
    assert.equal(await rejectionCode(readJsonBody(jsonRequest("[1]"))), "invalid_request");
    assert.equal(await rejectionCode(readJsonBody(jsonRequest("{"))), "invalid_request");
  });
});
