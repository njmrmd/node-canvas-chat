/**
 * Where this deployment thinks it lives.
 *
 * Only one thing needs this: `metadataBase`. Open Graph and Twitter cards must
 * carry absolute URLs — a crawler unfurling a link in someone else's chat app
 * has no page to resolve `/opengraph-image.png` against — and Next builds those
 * absolute URLs by composing `metadataBase` with the relative paths it already
 * knows. Get this wrong and the unfurl silently loses its picture, which is the
 * one failure mode nobody notices until the link is already sent.
 *
 * The ordering below is deliberate:
 *
 *   1. `NEXT_PUBLIC_SITE_URL` — set this the day a real domain exists. It wins
 *      over everything, including Vercel's own idea of the project.
 *   2. A preview deployment points at *itself*. `VERCEL_PROJECT_PRODUCTION_URL`
 *      is tempting and wrong here: it would make a preview link unfurl with
 *      production's artwork, so the very thing a preview exists to check — does
 *      this build's card look right — is the thing it cannot show.
 *   3. Production points at the project's stable production URL, not at the
 *      per-deployment `VERCEL_URL`, so a shared link does not rot the moment
 *      the next deploy lands.
 *   4. Off-platform, localhost.
 *
 * Blank is missing, for the reason spelled out at length in `build-info.ts`:
 * Vercel sets several of these to the empty string rather than leaving them
 * unset, and `??` does not fire on `""`.
 *
 * Note for whoever tests an unfurl against a preview: Vercel's deployment
 * protection blocks unauthenticated crawlers, so a protected preview URL will
 * not unfurl anywhere no matter what this returns. Test on production, or on a
 * preview with protection off.
 */

const LOCAL = "http://localhost:3000";

function present(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function siteUrl(): URL {
  const explicit = present(process.env.NEXT_PUBLIC_SITE_URL);
  if (explicit) return new URL(explicit);

  const isProduction = present(process.env.VERCEL_ENV) === "production";

  const production = present(process.env.VERCEL_PROJECT_PRODUCTION_URL);
  if (isProduction && production) return new URL(`https://${production}`);

  const deployment = present(process.env.VERCEL_URL);
  if (deployment) return new URL(`https://${deployment}`);

  if (production) return new URL(`https://${production}`);

  return new URL(LOCAL);
}
