import { getSessionUser } from "@/lib/auth/session";
import { isDatabaseConfigured } from "@/lib/db";
import { PROVIDERS } from "@/lib/providers/registry";
import { ConversationGraph } from "@/components/conversation-graph";
import { ButtonLink, PageHeading, Shell, TextLink } from "@/components/ui";
import { KEYS, SIGN_IN, SIGN_UP } from "@/lib/routes";

/**
 * The front door. This is the first thing a stranger sees, and the only page
 * on the site that has to explain the product to someone who was handed a link
 * with no context — so the one job here is: say what this is, then offer the
 * way in.
 *
 * Deliberately not here: build metadata. `/api/health` already reports the
 * environment, branch and commit, and that is the right home for it.
 *
 * Two frames, because two different people arrive here. A stranger gets the
 * hero: centred, one screen, `max-w-xl` — a hero and a form column are
 * different objects, so this one is not at `--measure`. Someone already signed
 * in gets `Shell`, the same frame as `/sign-in` and `/keys`, because they are
 * inside the product and should not be sold to a second time.
 *
 * Every control comes from `components/ui.tsx`. Local copies of the button and
 * link shapes lived here once and had already drifted from the originals.
 */

export const dynamic = "force-dynamic";

const GITHUB_URL = "https://github.com/njmrmd/node-canvas-chat";

const steps = [
  {
    title: "Create an account",
    body: "Email and password. No card, no team setup.",
  },
  {
    title: `Connect an ${PROVIDERS.anthropic.label} key`,
    body: "Paste your own API key. It is encrypted before it is stored and never returned to the browser.",
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

  if (user) return <SignedIn />;

  return (
    <div className="flex min-h-dvh flex-col px-6 py-16 sm:justify-center">
      <main className="mx-auto w-full max-w-xl">
        {/* A `<p>`, not a link: here it would only point at itself. */}
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">
          Node Canvas Chat
        </p>

        <h1 className="mt-5 text-balance text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
          A conversation is a graph, not a list.
        </h1>

        {/*
         * The lede gets its own type level — 18px in `--foreground`, against
         * 14px muted everywhere below it. It is the sentence that installs the
         * mental model, so it must not read like the licence line.
         */}
        <p className="mt-4 text-pretty text-lg leading-relaxed text-foreground">
          Every exchange is a card on a canvas. Branch from any card to take an
          idea somewhere else, and keep the version you started with — instead
          of scrolling back through a thread to find where it went wrong.
        </p>

        {/* The claim above is spatial, so it gets shown as well as stated, and
            it is shown *before* the ask — a stranger should understand what
            they are signing up for while they are still reading the sentence
            that promised it. Decorative and aria-hidden; the lede is its text
            equivalent. */}
        <ConversationGraph className="mt-8 w-full max-w-[28rem]" />

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <ButtonLink href={SIGN_UP}>Create an account</ButtonLink>
          <ButtonLink href={SIGN_IN} variant="secondary">
            Sign in
          </ButtonLink>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-muted">
          You will need your own{" "}
          <TextLink href={PROVIDERS.anthropic.consoleUrl} external>
            {PROVIDERS.anthropic.label} API key
          </TextLink>
          . It takes about a minute to create, and we never see your provider
          bill.
        </p>

        {/*
         * The group label is the only `<h2>` on the page, so the outline reads
         * h1 → h2 rather than four siblings. The `<ol>` carries the order; the
         * numerals are decoration and stay hidden from assistive tech.
         */}
        <h2 className="mt-12 font-mono text-xs uppercase tracking-[0.18em] text-muted">
          How it works
        </h2>

        <ol className="mt-4 divide-y divide-hairline border-y border-hairline">
          {steps.map((step, index) => (
            <li key={step.title} className="flex gap-4 py-4">
              <span
                aria-hidden="true"
                className="font-mono text-xs leading-6 text-muted"
              >
                {index + 1}
              </span>
              <div>
                <p className="text-sm font-medium leading-6">{step.title}</p>
                <p className="mt-1 text-pretty text-sm leading-relaxed text-muted">
                  {step.body}
                </p>
              </div>
            </li>
          ))}
        </ol>

        <p className="mt-8 text-sm text-muted">
          Open source, MIT licensed.{" "}
          <TextLink href={GITHUB_URL} external>
            Source on GitHub
          </TextLink>
        </p>
      </main>
    </div>
  );
}

/**
 * The signed-in front door.
 *
 * Not the hero. Someone returning has already bought the pitch, and showing it
 * to them again left roughly 330px of content floating in a vertically-centred
 * phone screen. This is the product's own frame, and it says plainly what is
 * and is not live rather than implying the button opens a canvas.
 */
function SignedIn() {
  return (
    <Shell>
      <PageHeading title="Welcome back.">
        Your model access lives on the key screen. The canvas is not live yet —
        when it is, it will open from here.
      </PageHeading>

      <div className="mt-8">
        <ButtonLink href={KEYS}>Manage model access</ButtonLink>
      </div>
    </Shell>
  );
}
