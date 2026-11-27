import type { ReactNode } from "react";

export type SafeMarkdownBlock =
  | { kind: "ordered-list"; items: Array<{ stepNumber: number; text: string }> }
  | { kind: "unordered-list"; items: string[] }
  | { kind: "paragraph"; text: string };

export type SafeInlineToken =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "code"; text: string };

const orderedItemPattern = /^(\d{1,2})\.\s+(.+)$/;
const unorderedItemPattern = /^[-*]\s+(.+)$/;
const inlineTokenPattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;

export function parseSafeInlineTokens(input: string): SafeInlineToken[] {
  const tokens: SafeInlineToken[] = [];
  let cursor = 0;

  for (const match of input.matchAll(inlineTokenPattern)) {
    const raw = match[0];
    const index = match.index ?? 0;
    if (index > cursor) {
      tokens.push({ kind: "text", text: input.slice(cursor, index) });
    }
    if (raw.startsWith("**") && raw.endsWith("**") && raw.length > 4) {
      tokens.push({ kind: "strong", text: raw.slice(2, -2) });
    } else if (raw.startsWith("`") && raw.endsWith("`") && raw.length > 2) {
      tokens.push({ kind: "code", text: raw.slice(1, -1) });
    } else {
      tokens.push({ kind: "text", text: raw });
    }
    cursor = index + raw.length;
  }

  if (cursor < input.length) {
    tokens.push({ kind: "text", text: input.slice(cursor) });
  }

  return tokens.length > 0 ? tokens : [{ kind: "text", text: input }];
}

export function parseSafeMarkdownBlocks(content: string): SafeMarkdownBlock[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: SafeMarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      index++;
      continue;
    }

    const orderedMatch = orderedItemPattern.exec(trimmed);
    if (orderedMatch) {
      const items: Array<{ stepNumber: number; text: string }> = [];
      while (index < lines.length) {
        const line = lines[index].trim();
        const match = orderedItemPattern.exec(line);
        if (!match) break;
        items.push({ stepNumber: Number(match[1]), text: match[2].trim() });
        index++;
      }
      blocks.push({ kind: "ordered-list", items });
      continue;
    }

    const unorderedMatch = unorderedItemPattern.exec(trimmed);
    if (unorderedMatch) {
      const items: string[] = [];
      while (index < lines.length) {
        const line = lines[index].trim();
        const match = unorderedItemPattern.exec(line);
        if (!match) break;
        items.push(match[1].trim());
        index++;
      }
      blocks.push({ kind: "unordered-list", items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const line = lines[index].trim();
      if (!line || orderedItemPattern.test(line) || unorderedItemPattern.test(line)) break;
      paragraphLines.push(line);
      index++;
    }
    blocks.push({ kind: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

function renderInline(text: string): ReactNode[] {
  return parseSafeInlineTokens(text).map((token, index) => {
    if (token.kind === "strong") {
      return (
        <strong key={index} className="font-semibold text-[#0f172a]">
          {token.text}
        </strong>
      );
    }
    if (token.kind === "code") {
      return (
        <code
          key={index}
          className="tabular-nums rounded-[var(--radius-sm)] border border-[#e2e8f0] bg-[#f1f5f9] px-1.5 py-0.5 font-mono text-[0.875em] text-[#0f172a]"
        >
          {token.text}
        </code>
      );
    }
    return <span key={index}>{token.text}</span>;
  });
}

export function SafeMarkdown({ content }: { content: string }) {
  const blocks = parseSafeMarkdownBlocks(content);
  return (
    <div className="tabular-nums max-w-[68ch] space-y-3 text-sm leading-relaxed text-[#0f172a] sm:text-base">
      {blocks.map((block, blockIndex) => {
        if (block.kind === "ordered-list") {
          return (
            <ol
              key={blockIndex}
              start={block.items[0]?.stepNumber ?? 1}
              className="list-decimal space-y-2 pl-5 marker:font-mono marker:font-medium marker:text-[#475569]"
            >
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex} value={item.stepNumber} className="break-words pl-1">
                  {renderInline(item.text)}
                </li>
              ))}
            </ol>
          );
        }
        if (block.kind === "unordered-list") {
          return (
            <ul key={blockIndex} className="list-disc space-y-1.5 pl-5 marker:text-[#64748b]">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex} className="break-words pl-1">
                  {renderInline(item)}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={blockIndex} className="break-words">
            {renderInline(block.text)}
          </p>
        );
      })}
    </div>
  );
}
