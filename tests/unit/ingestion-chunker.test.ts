import { describe, expect, it } from "vitest";
import { chunkExtractedPages, estimateTokens } from "../../src/server/ingestion/chunker";
import type { ExtractedPageDraft } from "../../src/server/ingestion/contracts";

describe("D3/ADR21 structure-aware SOP chunking", () => {
  it("preserves PDF page spans, headings, literal numbers/units and skips blank pages", () => {
    const pages: ExtractedPageDraft[] = [
      {
        pageIndex: 1,
        pageKind: "native",
        sourceLocationKind: "pdf_page",
        rawText: "Section 1 Safety Lockout\n1. Turn main breaker OFF.\n2. Confirm 0.00 V with calibrated meter.",
        normalizedText: "Section 1 Safety Lockout\n1. Turn main breaker OFF.\n2. Confirm 0.00 V with calibrated meter.",
        ocrConfidence: null,
        ocrModel: null,
        layoutMetadata: null,
      },
      {
        pageIndex: 2,
        pageKind: "blank",
        sourceLocationKind: "pdf_page",
        rawText: "",
        normalizedText: "",
        ocrConfidence: null,
        ocrModel: null,
        layoutMetadata: null,
      },
      {
        pageIndex: 3,
        pageKind: "scanned_ocr",
        sourceLocationKind: "pdf_page",
        rawText: "Section 2 Pressure Release\n1. Vent valve V-12 until gauge reads 0.5 bar.\n2. Wait 10 minutes before opening.",
        normalizedText: "Section 2 Pressure Release\n1. Vent valve V-12 until gauge reads 0.5 bar.\n2. Wait 10 minutes before opening.",
        ocrConfidence: 0.94,
        ocrModel: "det+rec",
        layoutMetadata: null,
      },
    ];

    const chunks = chunkExtractedPages(pages, "application/pdf");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      sequence: 0,
      sectionPath: "Section 1 Safety Lockout",
      pageStart: 1,
      pageEnd: 1,
      contentType: "procedure",
    });
    expect(chunks[0].text).toContain("0.00 V");
    expect(chunks[1]).toMatchObject({
      sequence: 1,
      sectionPath: "Section 2 Pressure Release",
      pageStart: 3,
      pageEnd: 3,
      contentType: "procedure",
    });
    expect(chunks[1].text).toContain("0.5 bar");
    expect(chunks[1].text).toContain("10 minutes");
    expect(chunks[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("sets DOCX pageStart/pageEnd to null, preserves sectionPath and repeats headers when splitting oversized tables", () => {
    const rows = Array.from({ length: 85 }, (_, index) => `| STEP-${index + 1} | Hold pressure at ${(1.5 + index * 0.01).toFixed(2)} bar for ${index + 5} minutes |`);
    const hugeTable = ["| Code | Instruction |", "| --- | --- |", ...rows].join("\n");
    const pages: ExtractedPageDraft[] = [
      {
        pageIndex: 1,
        pageKind: "docx_section_flow",
        sourceLocationKind: "docx_derivative_preview",
        rawText: hugeTable,
        normalizedText: hugeTable,
        ocrConfidence: null,
        ocrModel: null,
        layoutMetadata: null,
        blocks: [
          { kind: "heading", headingLevel: 1, sectionPath: "Calibration Limits", text: "Calibration Limits" },
          { kind: "table", sectionPath: "Calibration Limits", text: hugeTable },
        ],
      },
    ];

    const chunks = chunkExtractedPages(pages, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text.startsWith("Calibration Limits\n\n| Code | Instruction |")).toBe(true);
    for (const chunk of chunks) {
      expect(chunk.pageStart).toBeNull();
      expect(chunk.pageEnd).toBeNull();
      expect(chunk.sectionPath).toBe("Calibration Limits");
      expect(chunk.contentType).toBe("table");
      expect(chunk.text).toContain("| Code | Instruction |");
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(1000);
    }
    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain("STEP-85");
  });

  it("recursively splits oversized narratives with bounded overlap and deterministic hashes", () => {
    const longNarrative = Array.from(
      { length: 90 },
      (_, index) => `Sentence ${index + 1} records batch tolerance ${(index + 1) * 2} mg per liter without deviation.`,
    ).join(" ");
    const page: ExtractedPageDraft = {
      pageIndex: 1,
      pageKind: "native",
      sourceLocationKind: "pdf_page",
      rawText: longNarrative,
      normalizedText: longNarrative,
      ocrConfidence: null,
      ocrModel: null,
      layoutMetadata: null,
    };

    const first = chunkExtractedPages([page], "application/pdf");
    const second = chunkExtractedPages([page], "application/pdf");
    expect(first.length).toBeGreaterThan(1);
    expect(first).toEqual(second);
    expect(first.every((chunk) => chunk.tokenEstimate <= 1000 && chunk.tokenEstimate === estimateTokens(chunk.text))).toBe(true);
    for (let index = 0; index < first.length - 1; index++) {
      const trailing = first[index].text.slice(-120);
      const leading = first[index + 1].text.slice(0, 450);
      const sharedTail = trailing.slice(trailing.indexOf(" ") + 1);
      expect(sharedTail.length).toBeGreaterThan(20);
      expect(leading).toContain(sharedTail);
    }
  });
});
