import { notFound } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { KeyManager } from "@/components/key-manager";
import { PROVIDERS, PROVIDER_IDS } from "@/lib/providers/registry";

/**
 * A design harness. Development only — `notFound()` below means this route
 * does not exist on any deployed environment, preview included.
 *
 * Why it exists: the key screen is the most design-sensitive surface in the
 * product and it cannot be reached without a database and a live session. The
 * database is still blocked, and the visual work should not wait for it. This
 * mounts the *real* `KeyManager` and `AuthForm` — not copies, not mock-ups —
 * with fixed props, so a screenshot taken here is a screenshot of the thing
 * that ships.
 *
 * Security: it reads no session, touches no database, and holds no credential.
 * The `email` and `last4` below are literals. Even so it is gated, because a
 * route that renders a signed-in surface should never be reachable by someone
 * who is not signed in, regardless of how little it can do.
 *
 * Delete this when the canvas lands and a real signed-in environment exists to
 * screenshot instead.
 */

export const dynamic = "force-dynamic";

export const metadata = { title: "Screens · dev only" };

const SCREENS = {
  "sign-up": <AuthForm mode="sign-up" />,
  "sign-in": <AuthForm mode="sign-in" />,
  keys: (
    <KeyManager
      email="stranger@example.com"
      initialKeys={[]}
      providers={PROVIDER_IDS.map((id) => ({
        id,
        label: PROVIDERS[id].label,
        consoleUrl: PROVIDERS[id].consoleUrl,
        keyPrefix: PROVIDERS[id].keyPrefix,
      }))}
    />
  ),
  "keys-connected": (
    <KeyManager
      email="stranger@example.com"
      initialKeys={[
        {
          provider: "anthropic",
          last4: "9f2c",
          createdAt: "2026-09-14T12:00:00.000Z",
          updatedAt: "2026-09-14T12:00:00.000Z",
        },
      ]}
      providers={PROVIDER_IDS.map((id) => ({
        id,
        label: PROVIDERS[id].label,
        consoleUrl: PROVIDERS[id].consoleUrl,
        keyPrefix: PROVIDERS[id].keyPrefix,
      }))}
    />
  ),
} as const;

type ScreenName = keyof typeof SCREENS;

function isScreenName(value: unknown): value is ScreenName {
  return typeof value === "string" && value in SCREENS;
}

export default async function DevScreensPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();

  const screen = (await searchParams).screen;
  if (!isScreenName(screen)) {
    return (
      <main className="mx-auto max-w-md px-6 py-16">
        <h1 className="text-lg font-semibold">Screens (dev only)</h1>
        <ul className="mt-4 flex flex-col gap-2 text-sm">
          {Object.keys(SCREENS).map((name) => (
            <li key={name}>
              <a className="underline" href={`/dev/screens?screen=${name}`}>
                {name}
              </a>
            </li>
          ))}
        </ul>
      </main>
    );
  }

  return SCREENS[screen];
}
