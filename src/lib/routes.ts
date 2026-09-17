/**
 * The one place the flow's forward edges are written down.
 *
 * A success state that does not say what happens next is a dead end, so every
 * screen in the pre-canvas flow ends in a link from here.
 */

export const SIGN_IN = "/sign-in";
export const SIGN_UP = "/sign-up";
export const KEYS = "/keys";
export const CANVAS = "/canvas";

/**
 * Where a user goes once their key is connected — the last step of onboarding
 * hands off to the product.
 *
 * TES-5 landed, so this points at the canvas itself rather than the signed-in
 * front door it used to name as a placeholder — see the comment this replaced
 * for why that redirection existed and what it was waiting on.
 */
export const AFTER_KEY_CONNECTED = CANVAS;
export const AFTER_KEY_CONNECTED_LABEL = "Open the canvas";
