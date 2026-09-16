import { notFound } from "next/navigation";
import { ConversationGraph } from "@/components/conversation-graph";

/**
 * The Open Graph card, as a page.
 *
 * Development only — `notFound()` below means this route does not exist on any
 * deployed environment, preview included. It is a stencil for a screenshot, not
 * a surface.
 *
 * Why a route instead of `next/og`:
 *
 * `ImageResponse` renders through Satori, which cannot lay out an inline `<svg>`
 * the way a browser does. Using it would mean keeping a second copy of the
 * drawing — with hard-coded hex colours, because Satori resolves no CSS custom
 * properties and no Tailwind — and a second copy of artwork is a copy that
 * drifts. Rendering the card in the real app instead means the card is drawn by
 * the same component the landing page uses, in the same tokens, in Geist rather
 * than a fallback font, and the export is a plain PNG that every crawler can
 * fetch without running anything.
 *
 * The cost is a committed binary. `scripts/og-image.mjs` regenerates it from
 * this route, so the binary has a source, and the source is here.
 *
 * 1200x630 is fixed on purpose: it is the aspect ratio Slack, iMessage,
 * LinkedIn and X all expect, and the script screenshots this box exactly. The
 * 64px inset is the safe area — X crops a `summary_large_image` slightly, and
 * nothing that carries meaning may sit in what it takes.
 */

export const dynamic = "force-dynamic";

export const metadata = { title: "Open Graph card · dev only" };

export default async function DevOgPage() {
  if (process.env.NODE_ENV !== "development") notFound();

  return (
    <main className="flex h-[630px] w-[1200px] items-center justify-between gap-14 bg-background px-16">
      <div className="max-w-[560px]">
        <p className="font-mono text-[20px] uppercase tracking-[0.18em] text-muted">
          Node Canvas Chat
        </p>

        {/*
         * The same sentence as the `<h1>` on `/`. Repetition is the point: the
         * card is a promise, and the page has to be recognisably the thing that
         * was promised (Peak-End — this is one of the two moments that decide
         * whether a stranger keeps going).
         */}
        <p className="mt-6 text-balance text-[56px] font-semibold leading-[1.08] tracking-tight text-foreground">
          A conversation is a graph, not a list.
        </p>

        {/*
         * Balanced, not ragged: unbalanced this wraps to "with." alone on the
         * second line, and a one-word last line is the kind of thing a reader
         * does not name but does notice on a card that only gets one look.
         */}
        <p className="mt-6 text-balance text-[24px] leading-snug text-muted">
          Branch any reply. Keep the version you started with.
        </p>
      </div>

      <ConversationGraph className="w-[420px] shrink-0" />
    </main>
  );
}
