import Link from "next/link";
import { getSessionUser } from "@/lib/auth/session";
import { isDatabaseConfigured } from "@/lib/db";
import { PROVIDERS } from "@/lib/providers/registry";

/**
 * The front door. This is the first thing a stranger sees, and the only page
 * on the site that has to explain the product to someone who was handed a link
 * with no context — so the one job here is: say what this is, then offer the
 * way in.
 *
 * Deliberately not here: build metadata. `/api/health` already reports the
 * environment, branch and commit, and that is the right home for it.
 *
 * The styling uses the tokens in `globals.css` and mirrors the control shapes
 * in `components/ui.tsx` (44px targets, the same focus ring) so the first two
 * steps of the journey read as one product. It deliberately does not import
 * `ui.tsx` yet: that shell is a form column at `--measure`, and a hero is not.
 * Folding this page into those primitives is a follow-up once the pre-canvas
 * design pass lands. Design Engineer owns how this reads and looks.
 */

export const dynamic = "force-dynamic";

const GITHUB_URL = "https://github.com/njmrmd/node-canvas-chat";

const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/**
 * `min-h-11` keeps both actions at or above the 44px tap target — the whole
 * point of this page is that a thumb on a phone can reach sign-up.
 */
const CONTROL = `inline-flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium transition-colors ${FOCUS_RING}`;

const TEXT_LINK = `rounded-xs underline decoration-hairline underline-offset-4 transition-colors hover:decoration-current ${FOCUS_RING}`;

const steps = [
  {
    title: "Create an account",
    body: "An email and a password. No card, no team setup, no onboarding wizard.",
  },
  {
    title: `Connect an ${PROVIDERS.anthropic.label} key`,
    body: "Paste your own API key. It is encrypted before it is stored, never returned to the browser, and deleting your account deletes it with you.",
  },
  {
    title: "Branch the conversation",
    body: "Ask something, then fork any reply into a new direction. The version you started with stays on the canvas next to it.",
  },
];

export default async function Home() {
  // A visitor who already has a session should not be asked to sign up again.
  // Guarded on the database being configured so this page still renders when
  // it is not — the front door must never 500.
  const user = isDatabaseConfigured() ? await getSessionUser() : null;

  return (
    <div className="flex min-h-dvh flex-col px-6 py-16 sm:justify-center">
      <main className="mx-auto w-full max-w-xl">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">
          Node Canvas Chat
        </p>

        <h1 className="mt-5 text-balance text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
          A conversation is a graph, not a list.
        </h1>

        <p className="mt-4 text-pretty leading-relaxed text-muted">
          Every exchange is a card on a canvas. Branch from any card to take an
          idea somewhere else, and keep the version you started with — instead
          of scrolling back through a thread to find where it went wrong.
        </p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          {user ? (
            <PrimaryLink href="/keys">Continue</PrimaryLink>
          ) : (
            <>
              <PrimaryLink href="/sign-up">Create an account</PrimaryLink>
              <Link
                href="/sign-in"
                className={`${CONTROL} border border-transparent text-muted hover:text-foreground`}
              >
                I already have an account
              </Link>
            </>
          )}
        </div>

        <p className="mt-4 text-sm leading-relaxed text-muted">
          {user ? (
            <>You are signed in. Pick up where you left off.</>
          ) : (
            <>
              You bring your own model access: you will need an{" "}
              <a
                href={PROVIDERS.anthropic.consoleUrl}
                className={TEXT_LINK}
                target="_blank"
                rel="noreferrer"
              >
                {PROVIDERS.anthropic.label} API key
              </a>
              , which takes about a minute to create. You connect it straight
              after signing up, and we never see your provider bill.
            </>
          )}
        </p>

        {/* Signed out only: "1. Create an account" is stale advice for someone
            who already has one. */}
        {user ? null : (
          <ol className="mt-12 divide-y divide-hairline border-y border-hairline">
            {steps.map((step, index) => (
              <li key={step.title} className="flex gap-4 py-4">
                <span
                  aria-hidden="true"
                  className="font-mono text-xs leading-6 text-muted"
                >
                  {index + 1}
                </span>
                <div>
                  <h2 className="text-sm font-medium leading-6">{step.title}</h2>
                  <p className="mt-1 text-pretty text-sm leading-relaxed text-muted">
                    {step.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}

        <p className="mt-8 text-sm text-muted">
          Open source, MIT licensed.{" "}
          <a
            className={TEXT_LINK}
            href={GITHUB_URL}
          >
            Source on GitHub
          </a>
        </p>
      </main>
    </div>
  );
}

/** The primary action shape shared with the auth screens' submit button. */
function PrimaryLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`${CONTROL} border border-foreground bg-foreground text-background hover:opacity-90`}
    >
      {children}
    </Link>
  );
}
