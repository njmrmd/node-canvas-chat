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
 * Points at the signed-in front door, which is a real screen: it names what is
 * and is not live, and it is where the canvas will open from. An earlier change
 * removed this action because `/` was then the marketing scaffold and the trip
 * was a circle; `SignedIn()` in `app/page.tsx` has since made it a destination.
 *
 * The label is deliberately not "Start chatting". Naming an action after
 * something that has not shipped spends the user's trust at the exact moment
 * they have just handed over a credential — the button moves them on, and the
 * sentence beside it says what is missing.
 *
 * When the canvas lands: point this at it, change the label to name it, and
 * update the matching sentences in `key-manager.tsx` and `SignedIn()`.
 */
export const AFTER_KEY_CONNECTED = "/";
export const AFTER_KEY_CONNECTED_LABEL = "Continue";
