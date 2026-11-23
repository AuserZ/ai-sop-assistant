import { createHash } from "node:crypto";
import { ingestionLimits, type ChunkDraft, type ExtractedBlockKind, type ExtractedPageDraft } from "./contracts";

type ChunkUnit = {
  kind: ExtractedBlockKind;
  text: string;
  sectionPath: string;
  pageIndex: number | null;
  headingLevel?: number;
  preOverlapped?: boolean;
};

export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function isMarkdownTableLine(line: string) {
  const trimmed = line.trim();
  return trimmed.includes("|") && (trimmed.startsWith("|") || trimmed.split("|").length >= 3);
}

function isLikelyHeading(line: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 100) return false;
  if (/^#{1,6}\s+\S/.test(trimmed)) return true;
  if (/^(?:section|appendix|part)\s+[0-9A-Za-z]+(?:[.: -]+\S.*)?$/i.test(trimmed)) return true;
  if (/^\d+(?:\.\d+)+\s+[A-Za-z][^\n]{1,80}$/.test(trimmed) && !/[.!?]$/.test(trimmed)) return true;
  if (trimmed.length >= 4 && trimmed.length <= 70 && /^[A-Z0-9][A-Z0-9\s/&-]+$/.test(trimmed) && /[A-Z]{3}/.test(trimmed)) {
    return true;
  }
  return false;
}

function headingLabel(line: string) {
  return line.trim().replace(/^#{1,6}\s+/, "").trim();
}

function isListItemLine(line: string) {
  return /^\s*(?:\d+[.)]|[a-z][.)]|step\s+\d+[:.)]?|[-•*])\s+\S/i.test(line);
}

function parsePdfPageToUnits(page: ExtractedPageDraft, state: { sectionPath: string }): ChunkUnit[] {
  const text = page.normalizedText.trim();
  if (!text || page.pageKind === "blank") return [];

  const units: ChunkUnit[] = [];
  const lines = text.split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index++;
      continue;
    }

    if (isMarkdownTableLine(trimmed)) {
      const tableLines: string[] = [];
      while (index < lines.length && isMarkdownTableLine(lines[index])) {
        tableLines.push(lines[index].trimEnd());
        index++;
      }
      units.push({ kind: "table", text: tableLines.join("\n"), sectionPath: state.sectionPath, pageIndex: page.pageIndex });
      continue;
    }

    if (isLikelyHeading(trimmed)) {
      state.sectionPath = headingLabel(trimmed);
      units.push({ kind: "heading", headingLevel: 1, text: trimmed, sectionPath: state.sectionPath, pageIndex: page.pageIndex });
      index++;
      continue;
    }

    if (isListItemLine(trimmed)) {
      const stepLines = [trimmed];
      index++;
      while (
        index < lines.length &&
        lines[index].trim().length > 0 &&
        !isListItemLine(lines[index]) &&
        !isLikelyHeading(lines[index]) &&
        !isMarkdownTableLine(lines[index])
      ) {
        stepLines.push(lines[index].trim());
        index++;
      }
      units.push({ kind: "list_item", text: stepLines.join("\n"), sectionPath: state.sectionPath, pageIndex: page.pageIndex });
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim().length > 0 &&
      !isLikelyHeading(lines[index]) &&
      !isListItemLine(lines[index]) &&
      !isMarkdownTableLine(lines[index])
    ) {
      paragraphLines.push(lines[index].trimEnd());
      index++;
    }
    units.push({ kind: "paragraph", text: paragraphLines.join("\n").trim(), sectionPath: state.sectionPath, pageIndex: page.pageIndex });
  }

  return units;
}

function splitOversizedTable(unit: ChunkUnit): ChunkUnit[] {
  const lines = unit.text.split("\n");
  if (lines.length <= 2) return [unit];
  const hasSeparator = /^\|\s*---/.test(lines[1]?.trim() ?? "");
  const headerLines = hasSeparator ? lines.slice(0, 2) : lines.slice(0, 1);
  const bodyLines = hasSeparator ? lines.slice(2) : lines.slice(1);
  const headerText = headerLines.join("\n");
  const headerTokens = estimateTokens(headerText);
  // Reserve headroom so a preceding heading can stay attached without exceeding practicalMax.
  const maxTableChunkTokens = ingestionLimits.chunkPracticalMaxTokens - 40;

  const pieces: ChunkUnit[] = [];
  let currentRows: string[] = [];
  let currentTokens = headerTokens;

  for (const row of bodyLines) {
    const rowTokens = estimateTokens(row);
    if (currentRows.length > 0 && currentTokens + rowTokens > maxTableChunkTokens) {
      pieces.push({ ...unit, text: [headerText, ...currentRows].join("\n") });
      currentRows = [row];
      currentTokens = headerTokens + rowTokens;
    } else {
      currentRows.push(row);
      currentTokens += rowTokens;
    }
  }
  if (currentRows.length > 0) {
    pieces.push({ ...unit, text: [headerText, ...currentRows].join("\n") });
  }
  return pieces.length > 0 ? pieces : [unit];
}

function splitOversizedText(unit: ChunkUnit): ChunkUnit[] {
  const maxChars = (ingestionLimits.chunkPracticalMaxTokens - 25) * 4;
  const overlapChars = Math.max(40, Math.floor(ingestionLimits.chunkTargetMaxTokens * 4 * ingestionLimits.chunkOverlapRatio));
  const text = unit.text.trim();
  if (estimateTokens(text) <= ingestionLimits.chunkPracticalMaxTokens) return [unit];

  const pieces: ChunkUnit[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    if (text.length - cursor <= maxChars) {
      const tail = text.slice(cursor).trim();
      if (tail) pieces.push({ ...unit, text: tail, preOverlapped: pieces.length > 0 });
      break;
    }
    const window = text.slice(cursor, cursor + maxChars);
    let cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    if (cut < maxChars * 0.4) {
      const sentenceBoundary = Math.max(window.lastIndexOf(". "), window.lastIndexOf("; "), window.lastIndexOf("? "), window.lastIndexOf("! "));
      if (sentenceBoundary >= maxChars * 0.4) cut = sentenceBoundary + 1;
    }
    if (cut < maxChars * 0.3) {
      const spaceBoundary = window.lastIndexOf(" ");
      cut = spaceBoundary >= maxChars * 0.3 ? spaceBoundary : maxChars;
    }
    const segment = text.slice(cursor, cursor + cut).trim();
    if (segment) pieces.push({ ...unit, text: segment, preOverlapped: pieces.length > 0 });
    const nextCursor = cursor + cut - overlapChars;
    cursor = nextCursor > cursor ? nextCursor : cursor + cut;
    while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
  }

  return pieces.length > 0 ? pieces : [unit];
}

function normalizeUnit(unit: ChunkUnit): ChunkUnit[] {
  if (estimateTokens(unit.text) <= ingestionLimits.chunkPracticalMaxTokens) return [unit];
  if (unit.kind === "table") return splitOversizedTable(unit);
  return splitOversizedText(unit);
}

function joinUnits(units: ChunkUnit[]) {
  let output = "";
  for (let index = 0; index < units.length; index++) {
    const unit = units[index];
    if (index === 0) {
      output = unit.text;
    } else {
      const separator = units[index - 1].kind === "list_item" && unit.kind === "list_item" ? "\n" : "\n\n";
      output += separator + unit.text;
    }
  }
  return output.trim();
}

function classifyContentType(units: ChunkUnit[]): ChunkDraft["contentType"] {
  const nonHeading = units.filter((unit) => unit.kind !== "heading");
  const hasTable = nonHeading.some((unit) => unit.kind === "table");
  const hasProcedure = nonHeading.some((unit) => unit.kind === "list_item");
  const hasParagraph = nonHeading.some((unit) => unit.kind === "paragraph");

  if (hasTable && !hasProcedure && !hasParagraph) return "table";
  if (hasTable && (hasProcedure || hasParagraph)) return "mixed";
  if (hasProcedure) return "procedure";
  return "narrative";
}

function buildChunk(units: ChunkUnit[], sequence: number, isPdf: boolean): ChunkDraft {
  const text = joinUnits(units);
  const nonHeading = units.find((unit) => unit.kind !== "heading");
  const sectionPath = nonHeading?.sectionPath || units[0]?.sectionPath || "Document";
  let pageStart: number | null = null;
  let pageEnd: number | null = null;
  if (isPdf) {
    const pages = units.map((unit) => unit.pageIndex).filter((value): value is number => value !== null);
    if (pages.length > 0) {
      pageStart = Math.min(...pages);
      pageEnd = Math.max(...pages);
    }
  }
  return {
    sequence,
    sectionPath,
    pageStart,
    pageEnd,
    contentType: classifyContentType(units),
    text,
    contentHash: createHash("sha256").update(text).digest("hex"),
    tokenEstimate: estimateTokens(text),
  };
}

export function chunkExtractedPages(pages: ExtractedPageDraft[], mimeType: string): ChunkDraft[] {
  const isPdf = mimeType === "application/pdf";
  const orderedPages = [...pages].sort((left, right) => left.pageIndex - right.pageIndex);
  const rawUnits: ChunkUnit[] = [];
  const pdfState = { sectionPath: "Document" };

  for (const page of orderedPages) {
    if (page.blocks && page.blocks.length > 0) {
      for (const block of page.blocks) {
        const trimmed = block.text.trim();
        if (!trimmed) continue;
        rawUnits.push({
          kind: block.kind,
          text: trimmed,
          headingLevel: block.headingLevel,
          sectionPath: block.sectionPath || "Document",
          pageIndex: isPdf ? page.pageIndex : null,
        });
      }
    } else {
      rawUnits.push(...parsePdfPageToUnits(page, pdfState));
    }
  }

  const units = rawUnits.flatMap(normalizeUnit);
  if (units.length === 0) return [];

  const drafts: ChunkDraft[] = [];
  let buffer: ChunkUnit[] = [];
  let bufferTokens = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const text = joinUnits(buffer);
    if (text.length > 0) {
      drafts.push(buildChunk(buffer, drafts.length, isPdf));
    }
    buffer = [];
    bufferTokens = 0;
  };

  for (const unit of units) {
    const unitTokens = estimateTokens(unit.text);
    const hasBodyUnits = buffer.some((entry) => entry.kind !== "heading");

    if (unit.kind === "heading" && hasBodyUnits) {
      if (bufferTokens >= ingestionLimits.chunkTargetMinTokens || (unit.headingLevel ?? 1) <= 2) {
        flush();
      }
    } else if (buffer.length > 0 && hasBodyUnits) {
      const combinedTokens = estimateTokens(joinUnits([...buffer, unit]));
      const exceedsHardMax = combinedTokens > ingestionLimits.chunkPracticalMaxTokens;
      const exceedsTarget = combinedTokens > ingestionLimits.chunkTargetMaxTokens;
      const keepingProcedureTogether = unit.kind === "list_item" && buffer[buffer.length - 1]?.kind === "list_item" && !exceedsHardMax;
      if (exceedsHardMax || (exceedsTarget && !keepingProcedureTogether)) {
        const sectionChanged = unit.sectionPath !== buffer[buffer.length - 1]?.sectionPath;
        const candidateOverlap = !unit.preOverlapped &&
          !sectionChanged &&
          buffer.length > 1 &&
          buffer[buffer.length - 1].kind !== "table" &&
          buffer[buffer.length - 1].kind !== "heading"
          ? buffer[buffer.length - 1]
          : null;
        flush();
        if (
          candidateOverlap &&
          estimateTokens(candidateOverlap.text) <= Math.floor(ingestionLimits.chunkTargetMaxTokens * 0.2) &&
          estimateTokens(joinUnits([candidateOverlap, unit])) <= ingestionLimits.chunkPracticalMaxTokens
        ) {
          buffer.push(candidateOverlap);
          bufferTokens += estimateTokens(candidateOverlap.text);
        }
      }
    }

    buffer.push(unit);
    bufferTokens += unitTokens;
  }

  flush();
  return drafts;
}
