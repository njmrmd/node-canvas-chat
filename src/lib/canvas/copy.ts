/**
 * Every user-facing string on the canvas, in one table.
 *
 * Spec §9 exists "so nobody invents them at build time", and a table only
 * achieves that if reaching for it is easier than typing a literal. So the
 * strings are `as const`, the keys are a closed union, and `copy()` refuses at
 * compile time to render a template whose placeholders you have not supplied —
 * `copy("limit.chip")` does not type-check, and neither does passing `{used}`
 * without `{total}`.
 *
 * This is transcription, not authorship. Every string below appears verbatim in
 * the spec; where the spec needs a string it does not have, the gap is recorded
 * at the bottom of this file rather than filled in here. Copy is the Design
 * Engineer's, and a plausible-sounding invention is harder to find later than a
 * missing one.
 *
 * Tone rule, from §9, repeated because it is the thing most likely to erode:
 * state what happened and what to do next. No exclamation marks, no apologies,
 * no "Oops". Never blame the user for an error the system caused.
 */

/**
 * §9's table, verbatim.
 *
 * `{name}` placeholders are the spec's own. They are part of the string's type,
 * which is what makes the arity check below work.
 */
const SPEC_9 = {
  "empty.headline": "Ask anything. Then take it three directions.",
  "empty.sub":
    "Every message becomes a card. Branch from any card to explore another path.",
  "composer.placeholder": "Ask anything…",
  "composer.placeholder.reply": "Reply to this node…",
  "composer.target": "Replying to · {label}",
  "coach.branch": "Branch from here to try a different direction.",
  "node.status.thinking": "Thinking",
  "node.status.thinkingLong": "Still working…",
  "node.status.queued": "Queued · {n} ahead",
  "node.status.stopped": "Stopped",
  "node.action.continue": "Continue",
  "node.action.regenerate": "Regenerate",
  "node.action.retry": "Retry",
  "node.action.branch": "Branch",
  "node.continuedFrom": "continued from above",
  "delete.confirm": "Delete this node and {n} below it?",
  "delete.confirm.single": "Delete this node?",
  "delete.undo": "Node deleted.",
  "limit.chip": "{used} / {total} today",
  "limit.banner":
    "You've used your {total} messages for today. Resets in {time}.",
  "provider.headline": "Connect a model to start",
  "provider.sub":
    "Bring your own API key. It's encrypted and only used for your requests.",
  "provider.cta": "Connect model access",
  "offline.banner":
    "You're offline. Your canvas is here, but new messages will fail.",
  "branch.disabled": "Available when the reply finishes.",
} as const;

/**
 * Strings the spec states verbatim *outside* §9.
 *
 * §9 claims to be the whole inventory and is not — the §4.6 error table alone
 * is six user-facing sentences. These are quoted from the section named on each
 * group, not written here, so the table stays a transcription. Flagged to
 * Design Engineer: these belong in §9 so there is one list rather than two.
 */
const SPEC_ELSEWHERE = {
  /* §4.6 — the plain-language failure line, never a raw provider error. */
  "node.error.auth": "Your model key was rejected. Check it in Settings.",
  "node.error.timeout": "The model didn't respond in time.",
  "node.error.network": "Couldn't reach the model. Check your connection.",
  "node.error.content_filter": "The provider declined this request.",
  "node.error.context_too_long":
    "This branch is too long for the model's context window.",
  "node.error.unknown": "Something went wrong on our side.",

  /* §4.6 — the actions that sit under those lines. */
  "node.action.remove": "Remove",
  "node.action.openSettings": "Open settings",
  "node.action.branchFromEarlier": "Branch from an earlier node",

  /* §3 — chosen so that branching is immediately worth doing. */
  "starter.1": "Name this product three different ways",
  "starter.2": "Explain recursion — then explain it to a 10-year-old",
  "starter.3": "Draft a cold email I can A/B",

  /* §4.12 and §4.7 give these as exact quoted placeholder text, just not in
   * the §9 table — the same "quoted from prose" treatment as the group above. */
  "composer.placeholder.offline": "Offline",
  "composer.placeholder.rateLimited": "Daily limit reached",
} as const;

/**
 * Strings the build needs that §9 does not name at all — not a transcription,
 * because there is nothing to transcribe. Placeholder text, not final copy;
 * flagged to Design Engineer in the same breath as this file's existing gap
 * list below rather than treated as settled.
 */
const LOCAL_PLACEHOLDERS = {
  /* §6 `<LinearView>` — heading and the Copy-all action. */
  "linearview.heading": "Linear view",
  "linearview.copyAll": "Copy all",
  "linearview.close": "Close linear view",
  /* §6 `<ShortcutsSheet>` — title and its close control. */
  "shortcuts.title": "Keyboard shortcuts",
  "shortcuts.close": "Close",
  /* §4.9 focus-path toggle — the spec names the key (`F`) and "a top-bar
   * toggle" but not its label. */
  "focuspath.toggle": "Focus path",
  /* §4.11 past the 5000ms load budget. */
  "canvas.loadError": "Taking longer than expected.",
  "canvas.loadRetry": "Retry",
  /* §4.6 delete: the spec's confirm-dialog copy, reused as the undo toast's
   * body — see the `delete` implementation note in `use-canvas-controller.ts`
   * for why this ships as an undo toast rather than a blocking dialog. */
  "delete.undo.action": "Undo",
} as const;

export const COPY = { ...SPEC_9, ...SPEC_ELSEWHERE, ...LOCAL_PLACEHOLDERS } as const;

export type CopyKey = keyof typeof COPY;

/**
 * The `{name}` placeholders inside a template, as a union of their names.
 *
 * Recursive over the tail, so a string with two placeholders yields both. A
 * string with none yields `never`, which is what lets `copy()` take exactly one
 * argument for a plain string and exactly two for a template.
 */
type Placeholders<S extends string> =
  S extends `${string}{${infer Name}}${infer Rest}`
    ? Name | Placeholders<Rest>
    : never;

type VarsFor<K extends CopyKey> = Placeholders<(typeof COPY)[K]>;

/** `{n}` is a count everywhere it appears, so numbers are accepted unquoted. */
type Vars<K extends CopyKey> = Record<VarsFor<K>, string | number>;

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Renders a string from the table.
 *
 *   copy("node.status.stopped")            // "Stopped"
 *   copy("limit.chip", { used: 32, total: 50 })
 *
 * The rest-tuple is the whole trick: when a key has no placeholders `VarsFor`
 * is `never`, the tuple is `[]`, and passing a second argument is a type error;
 * when it has some, the tuple is required and its keys are checked. `[…] extends
 * [never]` rather than `VarsFor<K> extends never` because a bare conditional on
 * a naked type parameter distributes over the union and would collapse to
 * `never` for every multi-placeholder key.
 */
export function copy<K extends CopyKey>(
  key: K,
  ...[vars]: [VarsFor<K>] extends [never] ? [] : [Vars<K>]
): string {
  const template: string = COPY[key];

  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = (vars as Record<string, string | number> | undefined)?.[name];

    /*
     * Throwing beats rendering "Queued · {n} ahead" at a stranger. The types
     * already make this unreachable from TypeScript; the guard is for the
     * boundary where a value arrives as `undefined` at runtime anyway — a
     * count that has not loaded, a time that failed to format.
     */
    if (value === undefined || value === null) {
      throw new Error(`copy(${key}): no value for placeholder {${name}}.`);
    }

    return String(value);
  });
}

/**
 * What §9 does not cover yet.
 *
 * Recorded rather than invented. Each of these is a string the build will need
 * and the spec does not state, so it is a question for the Design Engineer, not
 * a blank to fill in. Listed here because a comment in the file that needs them
 * is where someone will actually look.
 *
 * - **Top bar controls (§6 `<TopBar>`):** labels for `Tidy`, the focus-path
 *   toggle, the theme toggle and the account menu. §2.4 and §7.2 call the first
 *   one "Tidy" in prose; the others are unnamed.
 * - **`<LinearView>` (§6):** panel heading and the "Copy-all" button label.
 * - **`<ShortcutsSheet>` (§6):** its title and the label for every row in the
 *   §7.2 key tables.
 * - **Screen-reader strings (§7.3):** the announcement templates are given as
 *   examples in prose — *"Node 4, branch 2 of 3, assistant reply complete, 1
 *   branch below."* — rather than as keyed templates with placeholders. They
 *   need to be the latter before they can be built.
 * - **`<NodeCard>` (§6):** the "Show more" affordance on clamped user text.
 * - **§4.1 renders no `empty.sub`.** The string is in §9 and the empty-state
 *   layout does not place it. One of the two is wrong.
 * - **§4.7's banner and §9's `limit.banner` differ.** §4.7 shows "Resets at
 *   00:00 UTC — in 4h 12m", §9 has "Resets in {time}". §9 is treated as
 *   canonical here, since it is the section that claims to be the inventory.
 */
