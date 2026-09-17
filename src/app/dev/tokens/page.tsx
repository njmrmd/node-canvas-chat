import { notFound } from "next/navigation";
import { COPY } from "@/lib/canvas/copy";

/**
 * The §5 token layer, rendered. Development only — `notFound()` below keeps it
 * off every deployed environment, preview included.
 *
 * Why it exists: spec §12.2 is "every token in §5 exists as a named custom
 * property", and the only honest way to check that is to resolve each one in a
 * browser and look at it. A stylesheet cannot be reviewed by reading it —
 * `light-dark()` in particular resolves against `color-scheme`, so the file
 * says what a token *might* be and only the computed value says what it is.
 *
 * It is also the surface `scripts/capture-tokens.mjs` drives: that script reads
 * the computed value of every swatch here and fails if a token is missing or
 * resolves to the wrong scheme's hex. So this page is not decoration — it is
 * the fixture the check runs against, which is why every list below is derived
 * from one array rather than typed out per swatch.
 *
 * Delete it when the canvas ships and the real surface is the thing to review.
 */

export const dynamic = "force-dynamic";

export const metadata = { title: "Canvas tokens · dev only" };

/** §5.4, in the order the spec lists them. */
const COLOURS = [
  "canvas-bg",
  "canvas-dot",
  "surface-1",
  "surface-2",
  "surface-3",
  "border-subtle",
  "border-default",
  "border-strong",
  "edge-default",
  "text-primary",
  "text-secondary",
  "text-tertiary",
  "accent",
  "accent-hover",
  "accent-fg",
  "accent-soft",
  "success",
  "warning",
  "danger",
  "focus-ring",
] as const;

/** §5.1. Each renders in its own token so the specimen is the real thing. */
const TYPE = [
  ["text-2xl", "Ask anything. Then take it three directions."],
  ["text-lg", "Connect a model to start"],
  ["text-base", "Ask anything…"],
  ["text-sm", "The node body — user and assistant text."],
  ["text-xs", "Thinking"],
  ["text-2xs", "12"],
] as const;

const SPACING = [
  "space-1",
  "space-2",
  "space-3",
  "space-4",
  "space-5",
  "space-6",
  "space-8",
  "space-10",
  "space-12",
] as const;

const RADII = ["radius-sm", "radius-md", "radius-lg", "radius-xl"] as const;
const SHADOWS = ["shadow-1", "shadow-2", "shadow-3"] as const;
const DURATIONS = [
  "dur-fast",
  "dur-base",
  "dur-mid",
  "dur-slow",
  "dur-xslow",
] as const;

/**
 * `default` is not a fourth palette — it is the absence of `data-theme`, which
 * is the state the CSS's own default applies to and therefore the only one that
 * actually tests §11.1.
 *
 * Worth stating because the obvious version of this page is wrong: if every
 * mode sets `data-theme`, then `[data-theme="dark"]` answers every request and
 * the base `color-scheme` declaration is dead code that no check can reach. A
 * capture run against that page reports the theme matrix green no matter what
 * the default says.
 */
const THEMES = ["default", "dark", "light", "system"] as const;
type Theme = (typeof THEMES)[number];

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBlockStart: "var(--space-8)" }}>
      <h2
        style={{
          font: "var(--text-lg)",
          letterSpacing: "var(--tracking-lg)",
          color: "var(--text-primary)",
          margin: 0,
        }}
      >
        {title}
      </h2>
      {note ? (
        <p
          style={{
            font: "var(--text-xs)",
            letterSpacing: "var(--tracking-xs)",
            color: "var(--text-secondary)",
            marginBlock: "var(--space-2) 0",
            maxWidth: "60ch",
          }}
        >
          {note}
        </p>
      ) : null}
      <div style={{ marginBlockStart: "var(--space-4)" }}>{children}</div>
    </section>
  );
}

export default async function CanvasTokensPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();

  const requested = (await searchParams).theme;
  const theme: Theme = isTheme(requested) ? requested : "default";

  return (
    // `<main>` rather than a div: `scripts/lib/cdp.mjs` treats its presence as
    // the signal that a navigation has committed, and it is the page's main
    // content regardless.
    <main
      className="canvas-surface"
      // Omitted entirely for `default`, so the base rule is what resolves.
      data-theme={theme === "default" ? undefined : theme}
      style={{
        minHeight: "100dvh",
        background: "var(--canvas-bg)",
        padding: "var(--space-6) var(--space-5) var(--space-12)",
        fontFamily: "var(--font-canvas)",
      }}
    >
      <header>
        <h1
          style={{
            font: "var(--text-2xl)",
            letterSpacing: "var(--tracking-2xl)",
            color: "var(--text-primary)",
            margin: 0,
          }}
        >
          Canvas tokens
        </h1>
        <p
          style={{
            font: "var(--text-sm)",
            color: "var(--text-secondary)",
            marginBlock: "var(--space-2) 0",
            maxWidth: "70ch",
          }}
        >
          Spec §5, resolved. Dark is the default; <code>system</code> follows{" "}
          <code>prefers-color-scheme</code>.
        </p>
        <nav
          style={{
            display: "flex",
            gap: "var(--space-2)",
            marginBlockStart: "var(--space-4)",
          }}
        >
          {THEMES.map((name) => (
            <a
              key={name}
              href={`/dev/tokens?theme=${name}`}
              data-theme-link={name}
              style={{
                font: "var(--text-xs)",
                letterSpacing: "var(--tracking-xs)",
                padding: "var(--space-2) var(--space-3)",
                borderRadius: "var(--radius-full)",
                border: "1px solid var(--border-default)",
                background:
                  name === theme ? "var(--accent-soft)" : "var(--surface-1)",
                color: name === theme ? "var(--accent)" : "var(--text-secondary)",
                textDecoration: "none",
              }}
            >
              {name}
            </a>
          ))}
        </nav>
      </header>

      <Section
        title="§5.4 Colour"
        note="Each chip is filled with the token named beneath it. The capture script reads these computed fills, so a token that stops resolving shows up as a failed check rather than as a chip nobody looked at."
      >
        <ul
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))",
            gap: "var(--space-3)",
            listStyle: "none",
            margin: 0,
            padding: 0,
          }}
        >
          {COLOURS.map((name) => (
            <li key={name}>
              <div
                data-token={name}
                style={{
                  height: 56,
                  borderRadius: "var(--radius-md)",
                  background: `var(--${name})`,
                  border: "1px solid var(--border-default)",
                }}
              />
              <p
                style={{
                  font: "var(--text-xs)",
                  letterSpacing: "var(--tracking-xs)",
                  color: "var(--text-secondary)",
                  marginBlock: "var(--space-2) 0",
                }}
              >
                {name}
              </p>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="§5.1 Type"
        note="Rendered in the token itself, including its tracking. Inter is not loaded yet — the canvas route wires it — so these fall through to the spec's fallback stack."
      >
        <div style={{ display: "grid", gap: "var(--space-4)" }}>
          {TYPE.map(([name, sample]) => (
            <div key={name}>
              <span
                style={{
                  font: "var(--text-2xs)",
                  letterSpacing: "var(--tracking-2xs)",
                  color: "var(--text-tertiary)",
                }}
              >
                {name}
              </span>
              <p
                data-type-token={name}
                style={{
                  font: `var(--${name})`,
                  letterSpacing: `var(--tracking-${name.replace("text-", "")})`,
                  color: "var(--text-primary)",
                  margin: 0,
                }}
              >
                {sample}
              </p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="§5.2 Spacing — 4px base">
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          {SPACING.map((name) => (
            <div
              key={name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-3)",
              }}
            >
              <span
                style={{
                  font: "var(--text-2xs)",
                  letterSpacing: "var(--tracking-2xs)",
                  color: "var(--text-tertiary)",
                  width: 72,
                }}
              >
                {name}
              </span>
              <span
                data-token={name}
                style={{
                  height: 12,
                  width: `var(--${name})`,
                  background: "var(--accent)",
                  borderRadius: "var(--radius-full)",
                }}
              />
            </div>
          ))}
        </div>
      </Section>

      <Section title="§5.3 Radius / §5.5 Elevation">
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-5)" }}>
          {RADII.map((name) => (
            <div key={name}>
              <div
                data-token={name}
                style={{
                  width: 88,
                  height: 64,
                  background: "var(--surface-1)",
                  border: "1px solid var(--border-default)",
                  borderRadius: `var(--${name})`,
                }}
              />
              <p
                style={{
                  font: "var(--text-2xs)",
                  color: "var(--text-tertiary)",
                  marginBlock: "var(--space-2) 0",
                }}
              >
                {name}
              </p>
            </div>
          ))}
          {SHADOWS.map((name) => (
            <div key={name}>
              <div
                data-token={name}
                style={{
                  width: 88,
                  height: 64,
                  background: "var(--surface-1)",
                  borderRadius: "var(--radius-lg)",
                  boxShadow: `var(--${name})`,
                }}
              />
              <p
                style={{
                  font: "var(--text-2xs)",
                  color: "var(--text-tertiary)",
                  marginBlock: "var(--space-2) 0",
                }}
              >
                {name}
              </p>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="§5.6 Motion"
        note="Values only. Nothing on this page animates — the durations are what the canvas components read, and §5.6 caps every one of them at 380ms."
      >
        <ul
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--space-2)",
            listStyle: "none",
            margin: 0,
            padding: 0,
          }}
        >
          {DURATIONS.map((name) => (
            <li
              key={name}
              data-token={name}
              style={{
                font: "var(--text-xs)",
                letterSpacing: "var(--tracking-xs)",
                color: "var(--text-secondary)",
                background: "var(--surface-2)",
                borderRadius: "var(--radius-full)",
                padding: "var(--space-1) var(--space-3)",
              }}
            >
              {name}
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="§9 Copy"
        note="Every user-facing string the spec states, rendered from the same table the components read. If a string looks wrong here it is wrong everywhere."
      >
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(140px, max-content) 1fr",
            gap: "var(--space-2) var(--space-4)",
            margin: 0,
          }}
        >
          {Object.entries(COPY).map(([key, value]) => (
            <div key={key} style={{ display: "contents" }}>
              <dt
                style={{
                  font: "var(--text-2xs)",
                  letterSpacing: "var(--tracking-2xs)",
                  color: "var(--text-tertiary)",
                }}
              >
                {key}
              </dt>
              <dd
                style={{
                  font: "var(--text-sm)",
                  color: "var(--text-primary)",
                  margin: 0,
                }}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </Section>
    </main>
  );
}
