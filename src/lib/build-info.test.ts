import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildInfo } from "./build-info";

const SHA = "12147ea0e7c222b8505868fef9529656a0b86b66";

describe("buildInfo", () => {
  it("reports Vercel's git variables when they are populated", () => {
    assert.deepEqual(
      buildInfo({
        VERCEL: "1",
        VERCEL_TARGET_ENV: "preview",
        VERCEL_GIT_COMMIT_SHA: SHA,
        VERCEL_GIT_COMMIT_REF: "platform/auth-keys-ratelimit",
      }),
      {
        environment: "preview",
        commit: "12147ea",
        branch: "platform/auth-keys-ratelimit",
      },
    );
  });

  it("falls back to the deploy script's values when Vercel blanks its own", () => {
    // The TES-17 regression exactly: the variables exist and are empty, so a
    // `??` fallback never fires.
    assert.deepEqual(
      buildInfo({
        VERCEL: "1",
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_SHA: "",
        VERCEL_GIT_COMMIT_REF: "",
        BUILD_COMMIT: "12147ea",
        BUILD_BRANCH: "platform/auth-keys-ratelimit",
      }),
      {
        environment: "preview",
        commit: "12147ea",
        branch: "platform/auth-keys-ratelimit",
      },
    );
  });

  it("says `unknown` on a deployment that has no provenance at all", () => {
    // Never an empty string: a blank field reads as a rendering bug, while
    // `unknown` reads as the deploy problem it actually is.
    assert.deepEqual(
      buildInfo({ VERCEL: "1", VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: "" }),
      { environment: "preview", commit: "unknown", branch: "unknown" },
    );
  });

  it("says `local` off-platform", () => {
    assert.deepEqual(buildInfo({}), {
      environment: "local",
      commit: "local",
      branch: "local",
    });
  });

  it("flags a deploy built from a dirty checkout, and only then", () => {
    const dirty = buildInfo({ VERCEL: "1", BUILD_COMMIT: SHA, BUILD_DIRTY: "1" });
    assert.equal(dirty.dirty, true);

    const clean = buildInfo({ VERCEL: "1", BUILD_COMMIT: SHA, BUILD_DIRTY: "" });
    assert.equal("dirty" in clean, false);
  });
});
