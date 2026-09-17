import { test } from "node:test";
import assert from "node:assert/strict";

import { COPY, copy, type CopyKey } from "./copy";

test("renders a string that has no placeholders", () => {
  assert.equal(copy("node.status.stopped"), "Stopped");
  assert.equal(copy("provider.cta"), "Connect model access");
});

test("substitutes a single placeholder", () => {
  assert.equal(copy("node.status.queued", { n: 2 }), "Queued · 2 ahead");
  assert.equal(
    copy("composer.target", { label: "Node 1" }),
    "Replying to · Node 1",
  );
});

test("substitutes every placeholder in a multi-slot template", () => {
  assert.equal(copy("limit.chip", { used: 32, total: 50 }), "32 / 50 today");
  assert.equal(
    copy("limit.banner", { total: 50, time: "4h 12m" }),
    "You've used your 50 messages for today. Resets in 4h 12m.",
  );
});

/*
 * The types make this unreachable from TypeScript, which is exactly why it
 * needs a test: the guard exists for the runtime boundary where a count has not
 * loaded or a duration failed to format, and a guard with no test is a guard
 * someone deletes as dead code.
 */
test("throws rather than rendering a placeholder at a stranger", () => {
  assert.throws(
    () => copy("node.status.queued", { n: undefined as unknown as number }),
    /no value for placeholder \{n\}/,
  );
});

/*
 * The compile-time half of the contract, asserted where it can fail.
 *
 * `@ts-expect-error` is itself an error when the line it marks type-checks, so
 * each of these fails `pnpm typecheck` the moment the signature stops rejecting
 * the call. That makes the arity rule a tested guarantee rather than a comment
 * about one. Nothing here runs — the block exists for the compiler.
 */
test("rejects malformed calls at compile time", () => {
  // @ts-expect-error — "limit.chip" declares {used} and {total}.
  const missingEntirely = () => copy("limit.chip");
  // @ts-expect-error — {total} is declared and not supplied.
  const missingOne = () => copy("limit.chip", { used: 1 });
  // @ts-expect-error — {totl} is not a placeholder in the template.
  const misspelled = () => copy("limit.chip", { used: 1, totl: 2 });
  // @ts-expect-error — "node.status.stopped" takes no variables.
  const spurious = () => copy("node.status.stopped", { n: 1 });
  // @ts-expect-error — not a key in the table.
  const unknownKey = () => copy("node.status.pondering");

  assert.ok(
    [missingEntirely, missingOne, misspelled, spurious, unknownKey].every(
      (f) => typeof f === "function",
    ),
  );
});

/**
 * §9's table, re-listed from the spec rather than derived from the module, so
 * that dropping or renaming a key fails here instead of silently shrinking the
 * inventory the spec says is complete.
 */
const SPEC_9_KEYS: readonly CopyKey[] = [
  "empty.headline",
  "empty.sub",
  "composer.placeholder",
  "composer.placeholder.reply",
  "composer.target",
  "coach.branch",
  "node.status.thinking",
  "node.status.thinkingLong",
  "node.status.queued",
  "node.status.stopped",
  "node.action.continue",
  "node.action.regenerate",
  "node.action.retry",
  "node.action.branch",
  "node.continuedFrom",
  "delete.confirm",
  "delete.confirm.single",
  "delete.undo",
  "limit.chip",
  "limit.banner",
  "provider.headline",
  "provider.sub",
  "provider.cta",
  "offline.banner",
  "branch.disabled",
];

test("carries every key in spec §9", () => {
  for (const key of SPEC_9_KEYS) {
    assert.ok(key in COPY, `§9 key missing from the table: ${key}`);
    assert.notEqual(COPY[key], "", `§9 key is empty: ${key}`);
  }
});

/*
 * §9's tone rule, made executable. "No exclamation marks, no apologies, no
 * 'Oops'. Never blame the user" is the kind of rule that holds until someone
 * adds one cheerful string at 5pm.
 */
test("obeys the §9 tone rule", () => {
  for (const [key, value] of Object.entries(COPY)) {
    assert.ok(!value.includes("!"), `${key} uses an exclamation mark: ${value}`);
    assert.doesNotMatch(
      value,
      /\b(oops|sorry|whoops|uh[- ]oh)\b/i,
      `${key} apologises: ${value}`,
    );
  }
});

/*
 * Every `{slot}` a template declares must be one `copy()` actually fills. A
 * typo'd brace renders as literal punctuation on the card, which is the one
 * failure this module exists to prevent.
 */
test("leaves no unrendered braces once every slot is supplied", () => {
  for (const key of Object.keys(COPY) as CopyKey[]) {
    const slots = [...COPY[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const vars = Object.fromEntries(slots.map((name) => [name, "x"]));

    const rendered = (copy as (k: CopyKey, v?: unknown) => string)(key, vars);

    assert.doesNotMatch(rendered, /[{}]/, `${key} left a brace: ${rendered}`);
  }
});
