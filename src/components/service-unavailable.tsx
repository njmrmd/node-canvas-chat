import { Alert, PageHeading, Shell, TextLink } from "@/components/ui";

/**
 * What a visitor sees on a deployment that has no database.
 *
 * Without this they get the real sign-up form, type an email, choose a
 * password, press the button, and only then learn that nothing can be stored —
 * a `503 not_configured` after the effort rather than before it. The error was
 * always legible; it was just late, and asking someone to invent a password
 * before telling them it cannot be saved is the kind of small dishonesty that
 * decides whether a stranger trusts the rest of the product.
 *
 * `fail closed` is the reason this exists at all: the form is not disabled as a
 * courtesy, it is absent because the server genuinely cannot complete the
 * action. Saying so up front is the legible half of failing closed.
 *
 * The tone is `wait`, not `error`. The visitor did nothing wrong and there is
 * nothing for them to fix, which is exactly the distinction that tone carries.
 *
 * This renders on the server and ships no JavaScript — there is no interaction
 * to hydrate, and a screen that exists to say "not yet" should not depend on a
 * bundle loading first.
 */
export function ServiceUnavailable({ heading }: { heading: string }) {
  return (
    <Shell>
      <PageHeading title={heading}>
        This deployment is not finished being set up.
      </PageHeading>

      <div className="mt-8 flex flex-col gap-4">
        <Alert tone="wait" title="Accounts are not open yet">
          Nothing can be stored on this deployment yet, so creating an account
          would fail. Nothing you do here is sent anywhere. This is on us, not
          on you — please check back shortly.
        </Alert>

        <p className="text-sm leading-relaxed text-muted">
          You can still read the source, and the front page explains what the
          product does.{" "}
          <TextLink href="/">Back to the front page</TextLink>
        </p>
      </div>
    </Shell>
  );
}
