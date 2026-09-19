import { test } from "node:test";
import assert from "node:assert/strict";

import { buildThinkingParam } from "./anthropic";
import { PROVIDERS } from "./registry";

test("requests adaptive thinking for a model that supports it", () => {
  assert.deepEqual(buildThinkingParam(true), {
    type: "adaptive",
    display: "summarized",
  });
});

test("omits thinking entirely for a model that does not support adaptive thinking", () => {
  assert.equal(buildThinkingParam(false), undefined);
});

test("Haiku 4.5 is registered as not supporting adaptive thinking", () => {
  const haiku = PROVIDERS.anthropic.models.find(
    (model) => model.id === "claude-haiku-4-5",
  );
  assert.equal(haiku?.supportsAdaptiveThinking, false);
});

test("Opus 5 and Sonnet 5 are registered as supporting adaptive thinking", () => {
  for (const id of ["claude-opus-5", "claude-sonnet-5"]) {
    const model = PROVIDERS.anthropic.models.find((m) => m.id === id);
    assert.equal(model?.supportsAdaptiveThinking, true, id);
  }
});
