import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { renderMarkdown } from "./markdown";

function html(text: string, trailingCaret?: React.ReactNode): string {
  return renderToStaticMarkup(renderMarkdown(text, trailingCaret) as React.ReactElement);
}

test("renders a plain paragraph", () => {
  assert.match(html("Hello there."), /<p[^>]*>Hello there\.<\/p>/);
});

test("renders **bold** as <strong>, not literal asterisks", () => {
  const out = html("This is **important**.");
  assert.match(out, /<strong>important<\/strong>/);
  assert.doesNotMatch(out, /\*\*/);
});

test("renders `inline code` as <code>, not literal backticks", () => {
  const out = html("Run `npm install` first.");
  assert.match(out, /<code[^>]*>npm install<\/code>/);
  assert.doesNotMatch(out, /`/);
});

test("renders a fenced code block as <pre><code>", () => {
  const out = html("Before.\n\n```js\nconst x = 1;\n```\n\nAfter.");
  assert.match(out, /<pre[^>]*><code>const x = 1;<\/code><\/pre>/);
  assert.match(out, /Before\./);
  assert.match(out, /After\./);
});

test("renders a numbered list as <ol><li>, not literal digits", () => {
  const out = html("1. Fork\n2. Rootline\n3. Branchwork");
  assert.match(out, /<ol[^>]*>/);
  assert.match(out, /<li>Fork<\/li>/);
  assert.match(out, /<li>Rootline<\/li>/);
  assert.match(out, /<li>Branchwork<\/li>/);
});

test("renders a bulleted list as <ul><li>", () => {
  const out = html("- Alpha\n- Beta");
  assert.match(out, /<ul[^>]*>/);
  assert.match(out, /<li>Alpha<\/li>/);
  assert.match(out, /<li>Beta<\/li>/);
});

/*
 * Tailwind's preflight resets `ol`/`ul` to `list-style: none` globally, so a
 * plain <ol><li> with no explicit `list-style-type` renders with no marker at
 * all — not a missing-number bug so much as a missing-*anything* bug. Both
 * list tags need an explicit override or they read as unmarked plain lines.
 */
test("sets an explicit list-style-type, since the app resets the default one", () => {
  assert.match(html("1. Fork\n2. Rootline"), /list-style-type:decimal/);
  assert.match(html("- Alpha\n- Beta"), /list-style-type:disc/);
});

test("splices a trailing caret onto the last paragraph, not a new line", () => {
  const out = html("Still going", "CARET_MARKER");
  const paragraphMatch = out.match(/<p[^>]*>([\s\S]*?)<\/p>/);
  assert.ok(paragraphMatch, "expected a paragraph");
  assert.match(paragraphMatch![1], /Still goingCARET_MARKER/);
});

test("appends the caret as its own trailing node after a list", () => {
  const out = html("- One\n- Two", "CARET_MARKER");
  assert.match(out, /<\/ul>CARET_MARKER/);
});

test("shows just the caret for an empty in-flight response", () => {
  const out = html("", "CARET_MARKER");
  assert.match(out, /^<div[^>]*>CARET_MARKER<\/div>$/);
});
