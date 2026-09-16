/**
 * The indefinite article for a provider label.
 *
 * "Do not have a Anthropic key?" was hard-coded, and hard-coding it means the
 * sentence breaks again the moment a second provider joins the allowlist. The
 * article is a property of the word, so it is derived from the word.
 *
 * English picks the article by *sound*, not spelling, and sound is not
 * recoverable from a string in the general case — "an hour", "a university",
 * "a one-off" all violate the letter rule. The scope here is provider labels:
 * proper nouns we control, currently `Anthropic` and `OpenAI`, with `Google`,
 * `Mistral` and `AWS` the plausible next ones. The first-letter rule is correct
 * for every one of those, so it is the rule, and this comment is the note that
 * it is a rule about *our labels* rather than about English.
 *
 * The known gap is a label starting with a consonant-sounding vowel or a
 * vowel-sounding consonant — `xAI` should take "an" and would get "a". Add an
 * exception set here if that day comes; do not push the problem back to the
 * call sites, which is where it started.
 */

const VOWELS = new Set(["a", "e", "i", "o", "u"]);

export function articleFor(label: string): "a" | "an" {
  const first = label.trim().charAt(0).toLowerCase();
  return VOWELS.has(first) ? "an" : "a";
}

/** `an Anthropic`, `a Google` — the article and the label, already joined. */
export function withArticle(label: string): string {
  return `${articleFor(label)} ${label}`;
}
