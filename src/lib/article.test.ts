import assert from "node:assert/strict";
import { test } from "node:test";

import { articleFor, withArticle } from "@/lib/article";

test("article", async (t) => {
  await t.test("takes 'an' before the provider labels we ship", () => {
    // The bug this file exists for: "a Anthropic key".
    assert.equal(articleFor("Anthropic"), "an");
    assert.equal(articleFor("OpenAI"), "an");
  });

  await t.test("takes 'a' before a consonant label", () => {
    assert.equal(articleFor("Google"), "a");
    assert.equal(articleFor("Mistral"), "a");
  });

  await t.test("is case-insensitive", () => {
    assert.equal(articleFor("anthropic"), "an");
    assert.equal(articleFor("google"), "a");
  });

  await t.test("ignores leading whitespace rather than reading it", () => {
    assert.equal(articleFor("  Anthropic"), "an");
  });

  await t.test("joins the article to the label", () => {
    assert.equal(withArticle("Anthropic"), "an Anthropic");
    assert.equal(withArticle("Google"), "a Google");
  });

  await t.test("does not throw on an empty label", () => {
    // Nothing should render this, but a copy helper is not worth a crash.
    assert.equal(articleFor(""), "a");
  });
});
