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
 * The canvas route does not exist yet (TES-5), so this points at the landing
 * page today. When the canvas lands, change this constant and the "Start
 * chatting" action on the key screen follows it; nothing else needs editing.
 */
export const AFTER_KEY_CONNECTED = "/";
export const AFTER_KEY_CONNECTED_LABEL = "Start chatting";
