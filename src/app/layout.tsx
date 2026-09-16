import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { siteUrl } from "@/lib/site-url";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * The link, as a stranger first meets it.
 *
 * "Done" for this MVP is the CEO sending someone a link. In a DM that link is
 * not a page — it is an unfurl: a title, a sentence and a picture, rendered by
 * Slack or iMessage before anyone has decided whether to click. That card is
 * the first impression, and until now it was a bare domain and the words "Node
 * Canvas Chat", which tell a stranger nothing about what the thing does.
 *
 * So the title states the premise rather than naming the product, and the card
 * carries the same drawing the landing page opens with. `metadataBase` is what
 * turns the relative image path into the absolute URL a crawler can fetch — see
 * `lib/site-url.ts` for why it is resolved per environment.
 *
 * The image itself comes from `opengraph-image.png` by file convention: Next
 * finds it, hashes it, and emits `og:image` with the right type and dimensions.
 * It is regenerated from the real component by `scripts/og-image.mjs` — never
 * hand-edited.
 */

const PRODUCT = "Node Canvas Chat";

/**
 * The lede, compressed to one line. Long enough to say what happens, short
 * enough to survive Twitter's truncation — the branch/keep clause is the part
 * that must not be cut, so it goes first.
 */
const DESCRIPTION =
  "Branch any reply into a new direction and keep the version you started with. Every exchange is a card on a canvas, not another line in a thread. Bring your own model key.";

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: {
    // The premise, not the product name. Someone scanning a message preview
    // reads about six words, and "Node Canvas Chat" spends all six saying
    // nothing.
    default: `${PRODUCT} — a conversation is a graph, not a list`,
    template: `%s · ${PRODUCT}`,
  },
  description: DESCRIPTION,
  applicationName: PRODUCT,
  openGraph: {
    type: "website",
    siteName: PRODUCT,
    title: `${PRODUCT} — a conversation is a graph, not a list`,
    description: DESCRIPTION,
    url: "/",
  },
  twitter: {
    // The 1200x630 card, shown large. `summary` would crop this artwork to a
    // square thumbnail and the fork — the only thing the picture is about —
    // is what a square crop throws away.
    card: "summary_large_image",
    title: `${PRODUCT} — a conversation is a graph, not a list`,
    description: DESCRIPTION,
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full font-sans">{children}</body>
    </html>
  );
}
