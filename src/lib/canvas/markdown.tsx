import { Children, Fragment, cloneElement, isValidElement } from "react";

/**
 * §6 `<NodeCard>`'s assistant markdown: "paragraphs at `space-2` gap, `code`
 * blocks on `surface-2` at `radius-sm` / `space-3` padding, lists at `space-5`
 * indent." Deliberately not a dependency — a full CommonMark parser buys
 * tables, images, blockquotes and HTML passthrough this product has no use
 * for and, for `dangerouslySetInnerHTML`-free renderers, no real safety
 * story either. This covers exactly the four constructs the spec names
 * (paragraphs, fenced code, lists, and the inline `**bold**`/`` `code` ``
 * TES-46 found rendering as literal asterisks and backticks) by building
 * React elements directly, which is XSS-inert by construction: nothing here
 * ever touches `innerHTML`.
 */

const FENCE = /```[^\n]*\n([\s\S]*?)```/g;
const UNORDERED_ITEM = /^\s*[-*]\s+(.*)$/;
const ORDERED_ITEM = /^\s*\d+\.\s+(.*)$/;
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

function renderInline(text: string, keyPrefix: string): React.ReactNode {
  const parts = text.split(INLINE).filter((part) => part !== "");
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={key}
          style={{
            font: "var(--text-code)",
            background: "var(--surface-2)",
            borderRadius: "var(--radius-sm)",
            padding: "0 4px",
          }}
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

function renderProseBlock(block: string, key: string): React.ReactNode {
  const lines = block.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return null;

  const isUnordered = UNORDERED_ITEM.test(lines[0]);
  const isOrdered = ORDERED_ITEM.test(lines[0]);

  if (isUnordered || isOrdered) {
    const pattern = isUnordered ? UNORDERED_ITEM : ORDERED_ITEM;
    const Tag = isUnordered ? "ul" : "ol";
    return (
      <Tag
        key={key}
        style={{
          margin: 0,
          paddingLeft: "var(--space-5)",
          // Tailwind's preflight resets `ol`/`ul` to `list-style: none`, which
          // without this override renders a numbered or bulleted list as
          // indistinguishable plain lines — no marker at all, not even a dash.
          listStyleType: isUnordered ? "disc" : "decimal",
          listStylePosition: "outside",
        }}
      >
        {lines.map((line, index) => {
          const match = line.match(pattern);
          return <li key={index}>{renderInline(match ? match[1] : line, `${key}-${index}`)}</li>;
        })}
      </Tag>
    );
  }

  return <p key={key} style={{ margin: 0 }}>{renderInline(lines.join(" "), key)}</p>;
}

/**
 * One assistant reply → React nodes, in reading order.
 *
 * `trailingCaret`, when given, is spliced onto the very end of the last
 * block rather than appended after it — §4.4's `<StreamCaret>` "trails the
 * last character", and a caret appended as its own block would instead drop
 * onto a new line below a paragraph, or float below a list/code block
 * entirely. Only the paragraph case can splice inline; a list or code block
 * ending mid-stream is rare (the model finishes an item before yielding the
 * next chunk far more often than not) and falls back to a trailing line.
 */
export function renderMarkdown(text: string, trailingCaret?: React.ReactNode): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let blockIndex = 0;
  FENCE.lastIndex = 0;

  const pushProse = (segment: string) => {
    for (const block of segment.split(/\n\s*\n/)) {
      const rendered = renderProseBlock(block, `b${blockIndex}`);
      if (rendered !== null) {
        nodes.push(rendered);
        blockIndex += 1;
      }
    }
  };

  let match: RegExpExecArray | null;
  while ((match = FENCE.exec(text)) !== null) {
    pushProse(text.slice(cursor, match.index));
    nodes.push(
      <pre
        key={`code${blockIndex}`}
        style={{
          margin: 0,
          background: "var(--surface-2)",
          borderRadius: "var(--radius-sm)",
          padding: "var(--space-3)",
          overflowX: "auto",
          font: "var(--text-code)",
        }}
      >
        <code>{match[1].replace(/\n$/, "")}</code>
      </pre>,
    );
    blockIndex += 1;
    cursor = FENCE.lastIndex;
  }
  pushProse(text.slice(cursor));

  if (trailingCaret) {
    const lastIndex = nodes.length - 1;
    const last = nodes[lastIndex];
    if (isValidElement(last) && last.type === "p") {
      const lastProps = last.props as { children?: React.ReactNode };
      nodes[lastIndex] = cloneElement(
        last,
        { key: last.key },
        ...Children.toArray(lastProps.children),
        trailingCaret,
      );
    } else {
      nodes.push(<Fragment key="trailing-caret">{trailingCaret}</Fragment>);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>{nodes}</div>
  );
}
