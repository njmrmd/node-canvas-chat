/**
 * The one place the flow's forward edges are written down.
 *
 * A success state that does not say what happens next is a dead end, so every
 * screen in the pre-canvas flow ends in a link from here.
 */

export const SIGN_IN = "/sign-in";
export const SIGN_UP = "/sign-up";
export const KEYS = "/keys";

/**
 * Where a user goes once their key is connected — the last step of onboarding
 * hands off to the product.
 *
 * Deliberately unused right now. The canvas route does not exist yet (TES-5),
 * and pointing this at the landing page closed a circle: key screen → `/` →
 * back to the key screen. A forward action that returns you to the front door
 * reads as a broken link, not as a feature that has not shipped, so the key
 * screen ends in a sentence until there is somewhere real to go.
 *
 * When the canvas lands: point this at it and restore the `ButtonLink` in
 * `key-manager.tsx`. Both ends of that loop — here and the signed-in landing
 * page — say "the canvas is not live yet" and both need updating together.
 */
export const AFTER_KEY_CONNECTED = "/";
export const AFTER_KEY_CONNECTED_LABEL = "Start chatting";
