import type { RerankedPassage } from "../retrieval/contracts";
import { extractKeywordTokens } from "../retrieval/search";
import {
  generatorCandidateSchema,
  type GeneratorClaim,
  type SupportedGeneratorCandidate,
} from "./contracts";

export type DeterministicFailureCode =
  | "INVALID_CANDIDATE_SCHEMA"
  | "UNKNOWN_OR_DUPLICATE_CHUNK_ID"
  | "FORBIDDEN_URL_OR_INJECTION"
  | "PROCEDURAL_STEP_NUMBERING_INVALID"
  | "PROCEDURAL_ORDER_INVERTED"
  | "UNSUPPORTED_QUANTITY_OR_UNIT"
  | "UNSUPPORTED_SOP_CODE"
  | "CONDITION_OR_POLARITY_VIOLATION"
  | "TABLE_ROW_MISMATCH"
  | "UNGROUNDED_CLAIM";

export type DeterministicFailureReason = {
  code: DeterministicFailureCode;
  claimIndex?: number;
};

export type DeterministicValidationResult =
  | { ok: true }
  | { ok: false; reasons: DeterministicFailureReason[] };

export type ParsedPipeTable = {
  caption: string;
  headers: string[];
  rows: string[][];
};

export type ExtractedQuantity = {
  raw: string;
  comparator: string | null;
  value: string;
  unit: string;
};

const forbiddenUrlPatterns = [
  /\b(?:https?|ftp|file):\/\//i,
  /\bjavascript:/i,
  /\bdata:/i,
  /\[[^\]]+\]\([^)]+\)/,
];

const injectionLeakPatterns = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above|existing)\s+(?:instructions?|rules?|sops?|prompts?)/i,
  /system\s+prompt\s+override/i,
  /always\s+(?:rank|select|return|cite)\s+this\s+chunk/i,
  /\bopenai_api_key\b/i,
  /\bauth_secret\b/i,
  /reveal\s+(?:the\s+)?(?:system\s+prompt|secrets?|api\s+keys?|credentials?)/i,
  /override\s+(?:retrieval|reranker|safety|verification|system)/i,
];

const unitAlternatives = [
  "calendar days",
  "business days",
  "consecutive minutes",
  "consecutive commercial batches",
  "commercial batches",
  "CFU/mL",
  "EU/mL",
  "uS/cm",
  "µS/cm",
  "μS/cm",
  "°C",
  "°F",
  "m/s",
  "mmHg",
  "mbar",
  "seconds",
  "second",
  "minutes",
  "minute",
  "hours",
  "hour",
  "weeks",
  "week",
  "months",
  "month",
  "years",
  "year",
  "days",
  "day",
  "meters",
  "meter",
  "batches",
  "rolls",
  "rpm",
  "sec",
  "hrs",
  "kPa",
  "bar",
  "psi",
  "ppb",
  "ppm",
  "Pa",
  "Nm",
  "mg",
  "kg",
  "mL",
  "µL",
  "uL",
  "μL",
  "µg",
  "ug",
  "μg",
  "ng",
  "mm",
  "cm",
  "min",
  "%",
  "C",
  "F",
  "g",
  "L",
  "m",
  "h",
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const unitPatternSource = unitAlternatives.map(escapeRegex).join("|");
// Matches unary-signed numbers (e.g., -20.0), unsigned standalone numbers, or the upper end of hyphenated numeric ranges (2-8), while excluding alphanumeric code suffixes (SOP-101).
const signedNumberSource =
  "(?:(?<=^|[\\s(\\[,:;<>≤≥=±])-\\d+(?:\\.\\d+)?|(?<![A-Za-z0-9_.-])\\d+(?:\\.\\d+)?|(?<=\\d-)\\d+(?:\\.\\d+)?)";

const suffixQuantityPattern = new RegExp(
  `(?:(?<comparator><=|>=|≤|≥|(?<!=)<(?!=)|(?<!=)>(?!=)|±)\\s*)?(?<value>${signedNumberSource})\\s*(?<unit>${unitPatternSource})(?![A-Za-z0-9/°µμ])`,
  "g",
);
const prefixPhPattern = /\bpH\s+(?<value>\d+(?:\.\d+)?)(?![A-Za-z0-9.])/gi;
const standaloneNumberPattern = new RegExp(`${signedNumberSource}(?![A-Za-z0-9_.])`, "g");
const sopCodePattern = /\bSOP-\d+[A-Za-z0-9-]*\b/gi;

const prohibitionCuePattern =
  /\b(?:do\s+not|don't|must\s+not|mustn't|never|shall\s+not|cannot|can't|prohibited|forbidden)\b/i;
const restrictionCuePattern =
  /\b(?:do\s+not|don't|must\s+not|never|shall\s+not|cannot|not|no|zero|until|only\s+after|only\s+when|only\s+if|only|before|unless|prohibited|without)\b/i;
const conditionalTriggerPattern = /\b(?:if|until|unless|only\s+after|only\s+when|only\s+if)\b/i;
const explicitConditionalGatePattern = /\b(?:if|until|unless)\b/i;
const preservedConditionalCuePattern = /\b(?:if|until|unless|when|only|except)\b/i;

const boundValueSource = "(?:(?<=^|[\\s(\\[,:;<>≤≥=±])-\\d+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)";
const lowerBoundPrefixPattern = new RegExp(
  `(?:>=|≥|(?<!=)>(?!=)|\\b(?:at\\s+least|minimum|min|above|exceeds|exceeding|more\\s+than|greater\\s+than|over)\\b)\\s*(?<val>${boundValueSource})(?![A-Za-z0-9_.])`,
  "gi",
);
const upperBoundPrefixPattern = new RegExp(
  `(?:<=|≤|(?<!=)<(?!=)|\\b(?:at\\s+most|maximum|max|below|under|less\\s+than|drops\\s+below|within|no\\s+more\\s+than)\\b)\\s*(?<val>${boundValueSource})(?![A-Za-z0-9_.])`,
  "gi",
);
// Post-quantity bounds ("121.0 °C minimum", "80.0 °C max"); require an explicit unit before abbreviated "min" so "20 min" (minutes) is never misread.
const lowerBoundSuffixPattern = new RegExp(
  `(?<val>${signedNumberSource})(?:\\s*(?:${unitPatternSource})\\s+\\b(?:minimum|min)\\b|\\s+\\bminimum\\b)`,
  "gi",
);
const upperBoundSuffixPattern = new RegExp(
  `(?<val>${signedNumberSource})(?:\\s*(?:${unitPatternSource})\\s+\\b(?:maximum|max)\\b|\\s+\\bmaximum\\b)`,
  "gi",
);

export function containsInjectionDirective(text: string): boolean {
  return injectionLeakPatterns.some((pattern) => pattern.test(text));
}

export function containsForbiddenUrl(text: string): boolean {
  return forbiddenUrlPatterns.some((pattern) => pattern.test(text));
}

export function extractSopCodes(text: string): string[] {
  const matches = text.match(sopCodePattern) ?? [];
  return Array.from(new Set(matches.map((code) => code.toUpperCase())));
}

export function normalizeLexicalToken(token: string): string {
  const lower = token.toLowerCase();
  if (lower.length > 4 && lower.endsWith("ies")) return `${lower.slice(0, -3)}y`;
  if (lower.length > 4 && lower.endsWith("ing")) return lower.slice(0, -3);
  if (lower.length > 4 && lower.endsWith("ed")) return lower.slice(0, -2);
  if (lower.length > 3 && lower.endsWith("s") && !lower.endsWith("ss")) return lower.slice(0, -1);
  return lower;
}

export function extractNumberedSteps(text: string): Array<{ stepNumber: number; text: string; offset: number }> {
  const markerRegex = /(?:^|[\n:]\s*|(?<=[.;])\s+)(\d{1,2})\.\s+(?=[A-Za-z])/g;
  const markers: Array<{ stepNumber: number; matchIndex: number; contentStart: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = markerRegex.exec(text)) !== null) {
    const stepNumber = Number(match[1]);
    if (!Number.isInteger(stepNumber) || stepNumber < 1 || stepNumber > 30) continue;
    markers.push({
      stepNumber,
      matchIndex: match.index,
      contentStart: match.index + match[0].length,
    });
  }

  if (markers.length === 0) return [];

  // Keep only the first contiguous sequence starting at step 1 so unrelated numbers are never misread.
  const startIndex = markers.findIndex((entry) => entry.stepNumber === 1);
  if (startIndex === -1) return [];

  const sequential: typeof markers = [];
  let expected = 1;
  for (let index = startIndex; index < markers.length; index++) {
    if (markers[index].stepNumber === expected) {
      sequential.push(markers[index]);
      expected++;
    }
  }
  if (sequential.length === 0) return [];

  return sequential
    .map((entry, index) => {
      const next = sequential[index + 1];
      const sliceEnd = next ? next.matchIndex : text.length;
      const body = text
        .slice(entry.contentStart, sliceEnd)
        .replace(/\s+/g, " ")
        .trim();
      return {
        stepNumber: entry.stepNumber,
        text: body,
        offset: entry.contentStart,
      };
    })
    .filter((step) => step.text.length > 0);
}

function isMarkdownDividerRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function isNumericCell(cell: string): boolean {
  return /^(?:<=|>=|≤|≥|<|>|±)?\s*-?\d+(?:\.\d+)?(?:\s*[A-Za-z°%µμ/]+)?$/.test(cell.trim());
}

export function parsePipeTable(text: string): ParsedPipeTable | null {
  if (!text.includes("|")) return null;

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const pipeLines = lines.filter((line) => line.includes("|"));
  if (pipeLines.length >= 2) {
    // Restrict caption to at most the immediate title line directly preceding the first pipe row so mixed prose is never absorbed into caption exemptions.
    const firstPipeIndex = lines.findIndex((line) => line.includes("|"));
    const precedingLine =
      firstPipeIndex > 0 && !lines[firstPipeIndex - 1].includes("|")
        ? lines[firstPipeIndex - 1]
        : "";
    const immediateCaption =
      precedingLine.length > 0 &&
      precedingLine.length <= 160 &&
      !/^\d+\.\s+/.test(precedingLine)
        ? precedingLine
        : "";

    const firstLineParts = pipeLines[0].split("|").map((part) => part.trim());
    let caption = immediateCaption;
    let headerCells = firstLineParts.filter((part) => part.length > 0);

    if (!pipeLines[0].startsWith("|") && firstLineParts[0].length > 0 && headerCells.length >= 3) {
      caption = caption ? `${caption} ${firstLineParts[0]}` : firstLineParts[0];
      headerCells = firstLineParts.slice(1).filter((part) => part.length > 0);
    }

    const rows: string[][] = [];
    for (let index = 1; index < pipeLines.length; index++) {
      const cells = pipeLines[index]
        .split("|")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      if (cells.length === 0 || isMarkdownDividerRow(cells)) continue;
      if (cells.length === headerCells.length) {
        rows.push(cells);
      }
    }

    if (headerCells.length >= 2 && rows.length >= 1) {
      return { caption, headers: headerCells, rows };
    }
  }

  // Flat single-line pipe table: "<caption?> | H1 | H2 | ... | R1C1 | R1C2 | ..."
  const firstPipeIndex = text.indexOf("|");
  if (firstPipeIndex === -1) return null;
  const caption = text.slice(0, firstPipeIndex).trim();
  const cells = text
    .slice(firstPipeIndex)
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (cells.length < 4) return null;

  let bestWidth = 0;
  let bestScore = -Infinity;

  for (let width = 2; width <= Math.min(8, Math.floor(cells.length / 2)); width++) {
    if (cells.length % width !== 0) continue;
    const rowCount = cells.length / width;
    if (rowCount < 2) continue;

    const headerRow = cells.slice(0, width);
    const dataRows: string[][] = [];
    for (let row = 1; row < rowCount; row++) {
      dataRows.push(cells.slice(row * width, (row + 1) * width));
    }

    let score = 0;
    const headerHasDigits = headerRow.some((cell) => /\d/.test(cell));
    score += headerHasDigits ? -10 : 6;

    const lastHeader = headerRow[width - 1].toLowerCase();
    if (lastHeader === "unit" || lastHeader.includes("required") || lastHeader.includes("limit")) {
      score += 4;
    }

    for (let col = 0; col < width; col++) {
      const colValues = dataRows.map((row) => row[col]);
      const numericCount = colValues.filter(isNumericCell).length;
      if (numericCount === dataRows.length) score += 4;
      const withinCount = colValues.filter((val) => /^within\b/i.test(val)).length;
      if (withinCount === dataRows.length) score += 3;
      const unitCount = colValues.filter((val) =>
        /^(?:mg|g|kg|mL|L|µL|uL|μL|µg|ug|μg|ng|ppb|ppm|uS\/cm|µS\/cm|μS\/cm|CFU\/mL|EU\/mL|°C|°F|bar|mbar|mmHg|Pa|kPa|rpm|mm|cm|%)$/.test(
          val,
        ),
      ).length;
      if (unitCount === dataRows.length) score += 5;
    }

    if (width >= 3) score += 1;

    if (score > bestScore) {
      bestScore = score;
      bestWidth = width;
    }
  }

  if (bestWidth < 2 || bestScore < 0) return null;

  const headers = cells.slice(0, bestWidth);
  const rows: string[][] = [];
  for (let offset = bestWidth; offset < cells.length; offset += bestWidth) {
    rows.push(cells.slice(offset, offset + bestWidth));
  }
  return { caption, headers, rows };
}

function normalizeComparator(raw: string | undefined): string | null {
  if (!raw) return null;
  if (raw === "≤") return "<=";
  if (raw === "≥") return ">=";
  return raw;
}

export function extractQuantityTokens(text: string): ExtractedQuantity[] {
  const results: ExtractedQuantity[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(suffixQuantityPattern)) {
    const value = match.groups?.value;
    const unit = match.groups?.unit;
    if (!value || !unit) continue;
    const comparator = normalizeComparator(match.groups?.comparator);
    const key = `${comparator ?? ""}|${value}|${unit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ raw: match[0].trim(), comparator, value, unit });
  }

  for (const match of text.matchAll(prefixPhPattern)) {
    const value = match.groups?.value;
    if (!value) continue;
    const key = `|${value}|pH`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ raw: match[0].trim(), comparator: null, value, unit: "pH" });
  }

  return results;
}

export function extractStandaloneNumbers(text: string): string[] {
  const matches = text.match(standaloneNumberPattern) ?? [];
  return Array.from(new Set(matches));
}

function normalizeUnitSpacing(unit: string): string {
  return unit.replace(/\s+/g, " ").trim();
}

function exactNumberPatternSource(numericValue: string): string {
  if (numericValue.startsWith("-")) {
    return `(?<=^|[\\s(\\[,:;<>≤≥=±])${escapeRegex(numericValue)}(?![A-Za-z0-9_.])`;
  }
  return `(?:(?<![A-Za-z0-9_.-])|(?<=\\d-))${escapeRegex(numericValue)}(?![A-Za-z0-9_.])`;
}

export function containsExactNumberToken(haystack: string, numericValue: string): boolean {
  return new RegExp(exactNumberPatternSource(numericValue)).test(haystack);
}

function comparatorPrefixPatternSource(comparator: string): string {
  switch (comparator) {
    case "<":
      return "(?:(?<!=)<(?!=)|\\b(?:below|under|less\\s+than|drops\\s+below)\\b)\\s*";
    case "<=":
      return "(?:<=|≤|\\b(?:at\\s+most|maximum|max|no\\s+more\\s+than)\\b)\\s*";
    case ">":
      return "(?:(?<!=)>(?!=)|\\b(?:above|exceeds|exceeding|more\\s+than|greater\\s+than|over)\\b)\\s*";
    case ">=":
      return "(?:>=|≥|\\b(?:at\\s+least|minimum|min)\\b)\\s*";
    case "±":
      return "±\\s*";
    default:
      return `${escapeRegex(comparator)}\\s*`;
  }
}

export function cellMatchesExactUnit(cell: string, expectedUnit: string): boolean {
  const normalizedUnit = normalizeUnitSpacing(expectedUnit);
  const trimmedCell = normalizeUnitSpacing(cell);
  if (trimmedCell === normalizedUnit) return true;
  const unitRegexText = escapeRegex(normalizedUnit).replace(/\s+/g, "\\s+");
  const caseInsensitive = normalizedUnit.length >= 4 && !normalizedUnit.includes("/");
  const flags = caseInsensitive ? "i" : "";
  const pattern = new RegExp(
    `(?:^|[\\s\\d])${unitRegexText}(?![A-Za-z0-9/°µμ])`,
    flags,
  );
  return pattern.test(trimmedCell);
}

export function containsExactQuantityInText(haystack: string, quantity: ExtractedQuantity): boolean {
  const unit = normalizeUnitSpacing(quantity.unit);
  if (unit === "pH") {
    const phPattern = new RegExp(`\\bpH\\s+${escapeRegex(quantity.value)}(?![0-9.])`, "i");
    return phPattern.test(haystack);
  }

  // Unit identity is case-sensitive for ambiguous short SI symbols (e.g., m vs M, mg vs g, C vs F).
  const unitRegexText = escapeRegex(unit).replace(/\s+/g, "\\s+");
  const caseInsensitive = unit.length >= 4 && !unit.includes("/");
  const flags = caseInsensitive ? "i" : "";
  const valueSource = exactNumberPatternSource(quantity.value);
  const comparatorSource = quantity.comparator ? comparatorPrefixPatternSource(quantity.comparator) : "";
  const pattern = new RegExp(
    `${comparatorSource}${valueSource}\\s*${unitRegexText}(?![A-Za-z0-9/°µμ])`,
    flags,
  );
  return pattern.test(haystack);
}

function cellMatchesQuantityValue(cell: string, quantity: ExtractedQuantity): boolean {
  const valueSource = exactNumberPatternSource(quantity.value);
  if (quantity.comparator) {
    const comparatorSource = comparatorPrefixPatternSource(quantity.comparator);
    return new RegExp(`${comparatorSource}${valueSource}`, "i").test(cell);
  }
  return new RegExp(valueSource).test(cell);
}

function supportedRowsForQuantity(table: ParsedPipeTable, quantity: ExtractedQuantity): Set<number> {
  const matching = new Set<number>();
  table.rows.forEach((row, rowIndex) => {
    const rowJoined = row.join(" | ");
    if (containsExactQuantityInText(rowJoined, quantity)) {
      matching.add(rowIndex);
      return;
    }

    const hasValueInRow = row.some((cell) => cellMatchesQuantityValue(cell, quantity));
    if (!hasValueInRow) return;

    const hasUnitInRow = row.some((cell) => cellMatchesExactUnit(cell, quantity.unit));
    if (hasUnitInRow) {
      matching.add(rowIndex);
    }
  });
  return matching;
}

export function quantitySupportedInTable(table: ParsedPipeTable, quantity: ExtractedQuantity): boolean {
  return supportedRowsForQuantity(table, quantity).size > 0;
}

function identifyNamedTableRows(claimText: string, table: ParsedPipeTable): Set<number> {
  const namedRowIndices = new Set<number>();
  table.rows.forEach((row, rowIndex) => {
    const primaryCell = row[0] ?? "";
    const rowKeyWords = extractKeywordTokens(primaryCell, 6).filter(
      (token) => token.length >= 3 && /^[a-z]+$/i.test(token),
    );
    if (rowKeyWords.length > 0) {
      const hasWordMatch = rowKeyWords.some((word) =>
        new RegExp(`\\b${escapeRegex(word)}\\b`, "i").test(claimText),
      );
      if (hasWordMatch) {
        namedRowIndices.add(rowIndex);
      }
      return;
    }

    const primaryNumbers = extractStandaloneNumbers(primaryCell);
    if (
      primaryNumbers.length > 0 &&
      primaryNumbers.every((num) => containsExactNumberToken(claimText, num))
    ) {
      namedRowIndices.add(rowIndex);
    }
  });
  return namedRowIndices;
}

function validateTableRowConsistency(
  claimText: string,
  table: ParsedPipeTable,
  nonTableCorpus: string,
): boolean {
  const namedRowIndices = identifyNamedTableRows(claimText, table);

  const claimQuantities = extractQuantityTokens(claimText).filter((quantity) => {
    if (containsExactQuantityInText(table.caption, quantity)) return false;
    // Skip quantities already verbatim-grounded in a non-table cited passage (valid multi-chunk prose+table claim).
    if (nonTableCorpus.length > 0 && containsExactQuantityInText(nonTableCorpus, quantity)) {
      return false;
    }
    return true;
  });

  for (const quantity of claimQuantities) {
    const supportedRows = supportedRowsForQuantity(table, quantity);
    if (supportedRows.size === 0) {
      return false;
    }
    if (
      namedRowIndices.size > 0 &&
      !Array.from(supportedRows).some((rowIndex) => namedRowIndices.has(rowIndex))
    ) {
      return false;
    }
  }

  const claimNumbers = extractStandaloneNumbers(claimText).filter((num) => {
    if (containsExactNumberToken(table.caption, num)) return false;
    if (nonTableCorpus.length > 0 && containsExactNumberToken(nonTableCorpus, num)) {
      return false;
    }
    return true;
  });

  if (claimNumbers.length === 0) return true;

  const rowsPerNumber: Array<Set<number>> = [];
  for (const num of claimNumbers) {
    const matchingRows = new Set<number>();
    table.rows.forEach((row, rowIndex) => {
      if (row.some((cell) => containsExactNumberToken(cell, num))) {
        matchingRows.add(rowIndex);
      }
    });
    if (matchingRows.size > 0) {
      if (
        namedRowIndices.size > 0 &&
        !Array.from(matchingRows).some((rowIndex) => namedRowIndices.has(rowIndex))
      ) {
        return false;
      }
      rowsPerNumber.push(matchingRows);
    }
  }

  if (rowsPerNumber.length < 2) return true;

  const firstRowSet = rowsPerNumber[0];
  for (const rowIndex of firstRowSet) {
    if (rowsPerNumber.every((set) => set.has(rowIndex))) {
      return true;
    }
  }

  if (namedRowIndices.size < 2) return false;
  return rowsPerNumber.every((set) => Array.from(set).some((rowIndex) => namedRowIndices.has(rowIndex)));
}

function splitSourceUnits(text: string): Array<{ text: string; offset: number }> {
  const steps = extractNumberedSteps(text);
  if (steps.length > 0) {
    return steps.map((step) => ({ text: step.text, offset: step.offset }));
  }

  const units: Array<{ text: string; offset: number }> = [];
  const sentenceRegex = /[^.\n]+(?:\.(?=\d)[^.\n]*)*\.?/g;
  let match: RegExpExecArray | null;
  while ((match = sentenceRegex.exec(text)) !== null) {
    const trimmed = match[0].trim();
    if (trimmed.length >= 6) {
      units.push({ text: trimmed, offset: match.index });
    }
  }
  return units.length > 0 ? units : [{ text, offset: 0 }];
}

function findBestMatchingSourceUnit(
  claimText: string,
  citedPassages: RerankedPassage[],
): { unitText: string; offset: number; chunkId: string; overlapRatio: number } | null {
  const claimTokens = new Set(extractKeywordTokens(claimText, 48).map(normalizeLexicalToken));
  if (claimTokens.size === 0) return null;

  let best: { unitText: string; offset: number; chunkId: string; overlapRatio: number } | null = null;

  for (const passage of citedPassages) {
    const units = splitSourceUnits(passage.text);
    for (const unit of units) {
      const unitTokens = new Set(extractKeywordTokens(unit.text, 64).map(normalizeLexicalToken));
      if (unitTokens.size === 0) continue;
      let shared = 0;
      for (const token of claimTokens) {
        if (unitTokens.has(token)) shared++;
      }
      const ratio = shared / claimTokens.size;
      if (!best || ratio > best.overlapRatio) {
        best = {
          unitText: unit.text,
          offset: unit.offset,
          chunkId: passage.chunkId,
          overlapRatio: ratio,
        };
      }
    }
  }

  return best;
}

function extractBounds(text: string): { lower: Set<string>; upper: Set<string> } {
  const lower = new Set<string>();
  const upper = new Set<string>();

  for (const match of text.matchAll(lowerBoundPrefixPattern)) {
    const val = match.groups?.val;
    if (val) lower.add(val);
  }
  for (const match of text.matchAll(lowerBoundSuffixPattern)) {
    const val = match.groups?.val;
    if (val) lower.add(val);
  }
  for (const match of text.matchAll(upperBoundPrefixPattern)) {
    const val = match.groups?.val;
    if (val) upper.add(val);
  }
  for (const match of text.matchAll(upperBoundSuffixPattern)) {
    const val = match.groups?.val;
    if (val) upper.add(val);
  }
  return { lower, upper };
}

function checkConditionAndPolarity(claimText: string, citedPassages: RerankedPassage[]): boolean {
  const combinedSource = citedPassages.map((passage) => passage.text).join(" ");
  const bestUnit = findBestMatchingSourceUnit(claimText, citedPassages);

  // Reject newly invented prohibition when no cited passage contains any prohibition/negation.
  if (prohibitionCuePattern.test(claimText) && !restrictionCuePattern.test(combinedSource)) {
    return false;
  }

  // Check comparator polarity inversion against cited source (e.g., "< 80.0" -> "> 80.0", "121.0 °C minimum" -> "maximum").
  const claimBounds = extractBounds(claimText);
  const sourceBounds = extractBounds(combinedSource);
  for (const val of claimBounds.lower) {
    if (sourceBounds.upper.has(val) && !sourceBounds.lower.has(val)) {
      return false;
    }
  }
  for (const val of claimBounds.upper) {
    if (sourceBounds.lower.has(val) && !sourceBounds.upper.has(val)) {
      return false;
    }
  }

  if (!bestUnit || bestUnit.overlapRatio < 0.35) {
    return true;
  }

  const sourceUnit = bestUnit.unitText;

  // Reject dropped prohibition (e.g., source "Do not open door until..." -> claim "Open door...").
  if (prohibitionCuePattern.test(sourceUnit) && !restrictionCuePattern.test(claimText)) {
    return false;
  }

  // Reject dropped "only after" / "only when" safety gate when the action is claimed without the gate.
  if (/\bonly\s+(?:after|when|if)\b/i.test(sourceUnit) && !/\b(?:only|after|when|if|before|until)\b/i.test(claimText)) {
    return false;
  }

  // Reject dropped conditional gate (e.g., "unless marked heat-sensitive") or any dropped conditional numeric threshold.
  if (explicitConditionalGatePattern.test(sourceUnit) && !preservedConditionalCuePattern.test(claimText)) {
    return false;
  }

  if (conditionalTriggerPattern.test(sourceUnit)) {
    const sourceConditionNumbers = extractStandaloneNumbers(sourceUnit);
    if (sourceConditionNumbers.length > 0) {
      const claimNumbers = new Set(extractStandaloneNumbers(claimText));
      const preservedAllConditionNumbers = sourceConditionNumbers.every((num) => claimNumbers.has(num));
      if (!preservedAllConditionNumbers) {
        return false;
      }
    }
  }

  return true;
}

function computeClaimGroundedOverlap(claim: GeneratorClaim, citedPassages: RerankedPassage[]): number {
  const claimTokens = extractKeywordTokens(claim.text, 64)
    .filter((token) => token.length >= 3 || /\d/.test(token))
    .map(normalizeLexicalToken);
  if (claimTokens.length === 0) return 0;

  const corpusTokens = new Set(
    citedPassages.flatMap((passage) =>
      extractKeywordTokens(`${passage.documentTitle} ${passage.sectionPath} ${passage.text}`, 512).map(
        normalizeLexicalToken,
      ),
    ),
  );

  let matched = 0;
  for (const token of claimTokens) {
    if (corpusTokens.has(token)) matched++;
  }
  return matched / claimTokens.length;
}

function locateClaimAnchor(
  claim: GeneratorClaim,
  passageById: Map<string, RerankedPassage>,
): { documentId: string; sequence: number; offset: number | null } | null {
  const passages = claim.chunkIds
    .map((id) => passageById.get(id))
    .filter((passage): passage is RerankedPassage => Boolean(passage));
  if (passages.length === 0) return null;

  const primary = passages.reduce((min, item) => (item.sequence < min.sequence ? item : min), passages[0]);
  const directIndex = primary.text.toLowerCase().indexOf(claim.text.slice(0, 32).toLowerCase());
  if (directIndex >= 0) {
    return { documentId: primary.documentId, sequence: primary.sequence, offset: directIndex };
  }

  const matchedUnit = findBestMatchingSourceUnit(claim.text, [primary]);
  return {
    documentId: primary.documentId,
    sequence: primary.sequence,
    offset: matchedUnit && matchedUnit.overlapRatio >= 0.45 ? matchedUnit.offset : null,
  };
}

export function validateCandidateDeterministically(
  rawCandidate: unknown,
  passages: RerankedPassage[],
): DeterministicValidationResult {
  const parsed = generatorCandidateSchema.safeParse(rawCandidate);
  if (!parsed.success || parsed.data.status !== "supported") {
    return { ok: false, reasons: [{ code: "INVALID_CANDIDATE_SCHEMA" }] };
  }

  const candidate: SupportedGeneratorCandidate = parsed.data;
  const passageById = new Map(passages.map((passage) => [passage.chunkId, passage]));
  const reasons: DeterministicFailureReason[] = [];

  for (let index = 0; index < candidate.claims.length; index++) {
    const claim = candidate.claims[index];

    if (containsForbiddenUrl(claim.text) || containsInjectionDirective(claim.text)) {
      reasons.push({ code: "FORBIDDEN_URL_OR_INJECTION", claimIndex: index });
    }

    const seenChunkIds = new Set<string>();
    const citedPassages: RerankedPassage[] = [];
    let validChunkIds = true;

    for (const chunkId of claim.chunkIds) {
      if (seenChunkIds.has(chunkId) || !passageById.has(chunkId)) {
        validChunkIds = false;
        break;
      }
      seenChunkIds.add(chunkId);
      citedPassages.push(passageById.get(chunkId)!);
    }

    if (!validChunkIds || citedPassages.length === 0) {
      reasons.push({ code: "UNKNOWN_OR_DUPLICATE_CHUNK_ID", claimIndex: index });
      continue;
    }

    if (candidate.isProcedural) {
      if (claim.stepNumber !== index + 1) {
        reasons.push({ code: "PROCEDURAL_STEP_NUMBERING_INVALID", claimIndex: index });
      }
    }

    const combinedSourceCorpus = citedPassages
      .map((passage) => `${passage.documentTitle} ${passage.sectionPath} ${passage.text}`)
      .join("\n");

    const parsedTables: ParsedPipeTable[] = [];
    const nonTableSegments: string[] = [];
    for (const passage of citedPassages) {
      const table =
        passage.contentType === "table" || passage.text.includes("|")
          ? parsePipeTable(passage.text)
          : null;
      if (table) {
        parsedTables.push(table);
      } else {
        nonTableSegments.push(`${passage.documentTitle} ${passage.sectionPath} ${passage.text}`);
      }
    }
    const nonTableCorpus = nonTableSegments.join("\n");

    // Every SOP code referenced in a claim must belong to its cited passages.
    const claimSopCodes = extractSopCodes(claim.text);
    const sourceSopCodes = new Set(extractSopCodes(combinedSourceCorpus));
    if (claimSopCodes.some((code) => !sourceSopCodes.has(code))) {
      reasons.push({ code: "UNSUPPORTED_SOP_CODE", claimIndex: index });
    }

    // Exact quantity + unit + comparator preservation.
    const claimQuantities = extractQuantityTokens(claim.text);
    for (const quantity of claimQuantities) {
      const supportedVerbatim = containsExactQuantityInText(combinedSourceCorpus, quantity);
      const supportedInTable = parsedTables.some((table) => quantitySupportedInTable(table, quantity));
      if (!supportedVerbatim && !supportedInTable) {
        reasons.push({ code: "UNSUPPORTED_QUANTITY_OR_UNIT", claimIndex: index });
        break;
      }
    }

    // Exact standalone numeric preservation (catches altered values like 121.0 -> 120 and signed -20.0 -> 20.0).
    const claimNumbers = extractStandaloneNumbers(claim.text);
    for (const numericValue of claimNumbers) {
      if (!containsExactNumberToken(combinedSourceCorpus, numericValue)) {
        reasons.push({ code: "UNSUPPORTED_QUANTITY_OR_UNIT", claimIndex: index });
        break;
      }
    }

    // Table row/column binding preservation for cited table chunks.
    for (const table of parsedTables) {
      if (!validateTableRowConsistency(claim.text, table, nonTableCorpus)) {
        reasons.push({ code: "TABLE_ROW_MISMATCH", claimIndex: index });
        break;
      }
    }

    // Safety-critical condition & polarity preservation.
    if (!checkConditionAndPolarity(claim.text, citedPassages)) {
      reasons.push({ code: "CONDITION_OR_POLARITY_VIOLATION", claimIndex: index });
    }

    // Substantive lexical grounding (rejects invented steps absent from cited chunks).
    const overlap = computeClaimGroundedOverlap(claim, citedPassages);
    if (overlap < 0.55) {
      reasons.push({ code: "UNGROUNDED_CLAIM", claimIndex: index });
    }
  }

  // Procedural order verification per SOP document (catches inversions even when another document is interleaved).
  if (candidate.isProcedural && candidate.claims.length >= 2) {
    const lastAnchorByDocument = new Map<
      string,
      { documentId: string; sequence: number; offset: number | null }
    >();
    for (let index = 0; index < candidate.claims.length; index++) {
      const current = locateClaimAnchor(candidate.claims[index], passageById);
      if (!current) continue;
      const previous = lastAnchorByDocument.get(current.documentId);
      if (previous) {
        if (current.sequence < previous.sequence) {
          reasons.push({ code: "PROCEDURAL_ORDER_INVERTED", claimIndex: index });
        } else if (
          current.sequence === previous.sequence &&
          previous.offset !== null &&
          current.offset !== null &&
          current.offset < previous.offset
        ) {
          reasons.push({ code: "PROCEDURAL_ORDER_INVERTED", claimIndex: index });
        }
      }
      lastAnchorByDocument.set(current.documentId, current);
    }
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }
  return { ok: true };
}
