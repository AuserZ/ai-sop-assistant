import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DocumentStorage, StoredObject } from "../../src/server/documents/storage";
import { extractDocumentContent } from "../../src/server/ingestion/extract";
import { syntheticDocx, syntheticPdf } from "../fixtures/document-files";

const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
const env = { CONVERSION_URL: "http://convert-worker:8092", PADDLEOCR_URL: "http://paddleocr:8091" };

function memoryStorage(initial: Record<string, StoredObject> = {}) {
  const objects = new Map<string, StoredObject>(Object.entries(initial));
  const storage: DocumentStorage = {
    authorizeUpload: vi.fn(),
    read: vi.fn(async (key: string) => objects.get(key) ?? null),
    create: vi.fn(async (key: string, object: StoredObject) => {
      if (objects.has(key)) throw new Error("PreconditionFailed");
      objects.set(key, object);
    }),
  };
  return { storage, objects };
}

function ocrPass(lines: Array<{ text: string; confidence: number }>) {
  return {
    result: "PASS",
    pipelineVersion: "paddleocr-v1",
    verificationStatus: "UNVERIFIED",
    input: { sha256: "a".repeat(64), width: 1000, height: 800 },
    models: { detection: "PP-OCRv5_mobile_det", recognition: "en_PP-OCRv5_mobile_rec" },
    segmentCount: lines.length,
    segments: lines.map((line, index) => ({
      order: index,
      text: line.text,
      confidence: line.confidence,
      box: [[0, 0], [100, 0], [100, 20], [0, 20]],
    })),
    text: lines.map((line) => line.text).join("\n"),
  };
}

describe("D3/ADR21/ADR22 document extraction routing, OCR and preview handling", () => {
  it("routes native, blank, scanned and mixed PDF pages accurately and emits verification issues", async () => {
    const pdfBytes = syntheticPdf();
    const docId = randomUUID();
    const jobId = randomUUID();
    const originalKey = `originals/${docId}/file.pdf`;
    const { storage } = memoryStorage({ [originalKey]: { bytes: pdfBytes, contentType: "application/pdf" } });
    const ocrCalls: string[] = [];

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/pdf/inspect-and-extract")) {
        return Response.json({
          result: "PASS",
          pageCount: 4,
          pages: [
            { pageIndex: 1, nativeText: "Section 1 Native Checklist\n1. Inspect seal before operating the chamber.", imageCount: 0, maxImagePixels: 0 },
            { pageIndex: 2, nativeText: "   ", imageCount: 0, maxImagePixels: 0 },
            { pageIndex: 3, nativeText: "", imageCount: 1, maxImagePixels: 800_000 },
            { pageIndex: 4, nativeText: "Section 4 Mixed Diagram\nVerify valve position on chart below.", imageCount: 1, maxImagePixels: 120_000 },
          ],
        });
      }
      if (url.includes("/pdf/render-page?page=3")) return new Response(validPng, { status: 200, headers: { "content-type": "image/png" } });
      if (url.includes("/pdf/render-page?page=4")) return new Response(validPng, { status: 200, headers: { "content-type": "image/png" } });
      if (url.endsWith("/ocr")) {
        ocrCalls.push(url);
        if (ocrCalls.length === 1) {
          return Response.json(ocrPass([
            { text: "Pressure 2.5 bar", confidence: 0.72 },
            { text: "Hold 10 minutes", confidence: 0.96 },
          ]));
        }
        // Matches direct engine.recognize output returned by infra/paddleocr/server.py.
        return Response.json({
          pipelineVersion: "paddleocr-v1",
          inputSha256: "b".repeat(64),
          pageIndex: 0,
          width: 1000,
          height: 800,
          models: [{ name: "PP-OCRv5_mobile_det" }, { name: "en_PP-OCRv5_mobile_rec" }],
          verificationStatus: "UNVERIFIED",
          segments: [
            { order: 0, text: "Verify valve position on chart below.", confidence: 0.95, box: [[0, 0], [100, 0], [100, 20], [0, 20]] },
            { order: 1, text: "Diagram label: 75 C max", confidence: 0.91, box: [[0, 30], [100, 30], [100, 50], [0, 50]] },
          ],
        });
      }
      throw new Error(`Unexpected worker URL: ${url}`);
    });

    const result = await extractDocumentContent({
      document: {
        id: docId,
        mimeType: "application/pdf",
        sizeBytes: pdfBytes.length,
        sha256: createHash("sha256").update(pdfBytes).digest("hex"),
        originalKey,
      },
      jobId,
      storage,
      fetchImpl: fetchMock,
      env,
    });

    expect(result.previewKey).toBeNull();
    expect(ocrCalls).toHaveLength(2);
    expect(result.pages.map((page) => page.pageKind)).toEqual(["native", "blank", "scanned_ocr", "mixed_ocr"]);
    expect(result.pages[2].normalizedText).toBe("Pressure 2.5 bar\nHold 10 minutes");
    expect(result.pages[3].normalizedText).toContain("Section 4 Mixed Diagram");
    expect(result.pages[3].normalizedText).toContain("Diagram label: 75 C max");
    expect(result.pages[3].normalizedText.match(/Verify valve position on chart below\./g)).toHaveLength(1);

    const issueCodes = result.issues.map((issue) => `${issue.pageIndex}:${issue.issueCode}`);
    expect(issueCodes).toContain("2:BLANK_PAGE");
    expect(issueCodes).toContain("3:LOW_OCR_CONFIDENCE");
    expect(issueCodes).toContain("3:NUMERIC_UNIT_REVIEW");
    expect(issueCodes).toContain("4:MIXED_PAGE_OCR");
    expect(issueCodes).toContain("4:NUMERIC_UNIT_REVIEW");
  });

  it("extracts DOCX natively, stores derivative PDF preview privately and handles idempotent retry", async () => {
    const docxBytes = syntheticDocx();
    const previewBytes = syntheticPdf();
    const docId = randomUUID();
    const jobId = randomUUID();
    const originalKey = `originals/${docId}/file.docx`;
    const { storage, objects } = memoryStorage({
      [originalKey]: { bytes: docxBytes, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    });

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/convert/docx-to-pdf")) {
        return new Response(new Uint8Array(previewBytes), { status: 200, headers: { "content-type": "application/pdf" } });
      }
      if (url.endsWith("/pdf/inspect-and-extract")) {
        return Response.json({ result: "PASS", pageCount: 2, pages: [] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const document = {
      id: docId,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: docxBytes.length,
      sha256: createHash("sha256").update(docxBytes).digest("hex"),
      originalKey,
    };

    const first = await extractDocumentContent({ document, jobId, storage, fetchImpl: fetchMock, env });
    expect(first.previewKey).toBe(`previews/${docId}/${jobId}.pdf`);
    expect(objects.has(first.previewKey!)).toBe(true);
    expect(first.pages[0].pageKind).toBe("docx_section_flow");
    expect(first.pages[0].sourceLocationKind).toBe("docx_derivative_preview");
    expect(first.issues.map((issue) => issue.issueCode)).toContain("DOCX_PREVIEW_PAGINATION_NOTE");

    const retry = await extractDocumentContent({ document, jobId, storage, fetchImpl: fetchMock, env });
    expect(retry.previewKey).toBe(first.previewKey);
    expect(storage.create).toHaveBeenCalledTimes(1);
  });

  it("rejects tampered source bytes and classifies transient vs permanent worker errors", async () => {
    const pdfBytes = syntheticPdf();
    const docId = randomUUID();
    const originalKey = `originals/${docId}/file.pdf`;
    const { storage } = memoryStorage({ [originalKey]: { bytes: pdfBytes, contentType: "application/pdf" } });

    await expect(
      extractDocumentContent({
        document: { id: docId, mimeType: "application/pdf", sizeBytes: pdfBytes.length, sha256: "0".repeat(64), originalKey },
        jobId: randomUUID(),
        storage,
        env,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_INTEGRITY_MISMATCH", transient: false });

    const transientFetch = vi.fn<typeof fetch>(async () => new Response("busy", { status: 503 }));
    await expect(
      extractDocumentContent({
        document: {
          id: docId,
          mimeType: "application/pdf",
          sizeBytes: pdfBytes.length,
          sha256: createHash("sha256").update(pdfBytes).digest("hex"),
          originalKey,
        },
        jobId: randomUUID(),
        storage,
        fetchImpl: transientFetch,
        env,
      }),
    ).rejects.toMatchObject({ code: "PDF_INSPECT_TRANSIENT", transient: true });
  });

  it("preserves short OCR diagram labels on mixed pages and flags native PDF table review", async () => {
    const pdfBytes = syntheticPdf();
    const docId = randomUUID();
    const originalKey = `originals/${docId}/mixed.pdf`;
    const { storage } = memoryStorage({ [originalKey]: { bytes: pdfBytes, contentType: "application/pdf" } });

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/pdf/inspect-and-extract")) {
        return Response.json({
          result: "PASS",
          pageCount: 2,
          pages: [
            {
              pageIndex: 1,
              nativeText: "| Parameter | Limit |\n| --- | --- |\n| Pressure | 2.5 bar |",
              imageCount: 0,
              maxImagePixels: 0,
            },
            {
              pageIndex: 2,
              nativeText: "Section 2 Relief Valve\nConfirm operating line stays below 2.5 bar and 75 C.",
              imageCount: 1,
              maxImagePixels: 80_000,
            },
          ],
        });
      }
      if (url.includes("/pdf/render-page")) return new Response(validPng, { status: 200, headers: { "content-type": "image/png" } });
      if (url.endsWith("/ocr")) {
        return Response.json(ocrPass([
          { text: "Section 2 Relief Valve", confidence: 0.96 },
          { text: "2.5 bar", confidence: 0.93 },
          { text: "75 C", confidence: 0.92 },
        ]));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await extractDocumentContent({
      document: {
        id: docId,
        mimeType: "application/pdf",
        sizeBytes: pdfBytes.length,
        sha256: createHash("sha256").update(pdfBytes).digest("hex"),
        originalKey,
      },
      jobId: randomUUID(),
      storage,
      fetchImpl: fetchMock,
      env,
    });

    expect(result.issues.map((issue) => `${issue.pageIndex}:${issue.issueCode}`)).toContain("1:TABLE_STRUCTURE_REVIEW");
    expect(result.pages[1].normalizedText).toContain("\n2.5 bar\n75 C");
  });

  it("handles OCR FAIL/422/503, DOCX conversion errors and invalid/encrypted/empty PDFs accurately", async () => {
    const pdfBytes = syntheticPdf();
    const docxBytes = syntheticDocx();
    const pdfDoc = {
      id: randomUUID(),
      mimeType: "application/pdf",
      sizeBytes: pdfBytes.length,
      sha256: createHash("sha256").update(pdfBytes).digest("hex"),
      originalKey: "originals/neg.pdf",
    };
    const docxDoc = {
      id: randomUUID(),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: docxBytes.length,
      sha256: createHash("sha256").update(docxBytes).digest("hex"),
      originalKey: "originals/neg.docx",
    };
    const { storage } = memoryStorage({
      [pdfDoc.originalKey]: { bytes: pdfBytes, contentType: pdfDoc.mimeType },
      [docxDoc.originalKey]: { bytes: docxBytes, contentType: docxDoc.mimeType },
    });

    const scannedInspect = () =>
      Response.json({ result: "PASS", pageCount: 1, pages: [{ pageIndex: 1, nativeText: "", imageCount: 1, maxImagePixels: 200_000 }] });

    await expect(
      extractDocumentContent({
        document: pdfDoc,
        jobId: randomUUID(),
        storage,
        env,
        fetchImpl: vi.fn<typeof fetch>(async (u) => {
          const url = String(u);
          if (url.endsWith("/pdf/inspect-and-extract")) return scannedInspect();
          if (url.includes("/pdf/render-page")) return new Response(validPng, { status: 200 });
          return Response.json({ result: "FAIL", code: "OCR_INPUT_PIXELS" });
        }),
      }),
    ).rejects.toMatchObject({ code: "OCR_PAGE_FAILED", transient: false });

    await expect(
      extractDocumentContent({
        document: pdfDoc,
        jobId: randomUUID(),
        storage,
        env,
        fetchImpl: vi.fn<typeof fetch>(async (u) => {
          const url = String(u);
          if (url.endsWith("/pdf/inspect-and-extract")) return scannedInspect();
          if (url.includes("/pdf/render-page")) return new Response(validPng, { status: 200 });
          return new Response(JSON.stringify({ result: "FAIL", code: "OCR_INPUT_FORMAT" }), { status: 422 });
        }),
      }),
    ).rejects.toMatchObject({ code: "OCR_WORKER_FAILED", transient: false });

    await expect(
      extractDocumentContent({
        document: pdfDoc,
        jobId: randomUUID(),
        storage,
        env,
        fetchImpl: vi.fn<typeof fetch>(async (u) => {
          const url = String(u);
          if (url.endsWith("/pdf/inspect-and-extract")) return scannedInspect();
          if (url.includes("/pdf/render-page")) return new Response(validPng, { status: 200 });
          return new Response(JSON.stringify({ result: "FAIL", code: "OCR_BUSY" }), { status: 503 });
        }),
      }),
    ).rejects.toMatchObject({ code: "OCR_WORKER_TRANSIENT", transient: true });

    await expect(
      extractDocumentContent({
        document: pdfDoc,
        jobId: randomUUID(),
        storage,
        env,
        fetchImpl: vi.fn<typeof fetch>(async () => Response.json({ result: "FAIL", code: "PDF_ENCRYPTED" }, { status: 422 })),
      }),
    ).rejects.toMatchObject({ code: "PDF_INSPECT_FAILED", transient: false });

    await expect(
      extractDocumentContent({
        document: pdfDoc,
        jobId: randomUUID(),
        storage,
        env,
        fetchImpl: vi.fn<typeof fetch>(async () => Response.json({ result: "PASS", pageCount: 101, pages: [] })),
      }),
    ).rejects.toMatchObject({ code: "PDF_INSPECT_INVALID", transient: false });

    await expect(
      extractDocumentContent({
        document: pdfDoc,
        jobId: randomUUID(),
        storage,
        env,
        fetchImpl: vi.fn<typeof fetch>(async () => Response.json({ result: "PASS", pageCount: 0, pages: [] })),
      }),
    ).rejects.toMatchObject({ code: "PDF_EMPTY", transient: false });

    for (const [makeResponse, expected] of [
      [() => new Response("bad", { status: 422 }), { code: "DOCX_CONVERSION_FAILED", transient: false }],
      [() => new Response("busy", { status: 503 }), { code: "DOCX_CONVERSION_TRANSIENT", transient: true }],
      [() => new Response("not-a-pdf", { status: 200 }), { code: "DOCX_CONVERSION_FAILED", transient: false }],
    ] as const) {
      await expect(
        extractDocumentContent({
          document: docxDoc,
          jobId: randomUUID(),
          storage,
          env,
          fetchImpl: vi.fn<typeof fetch>(async () => makeResponse()),
        }),
      ).rejects.toMatchObject(expected);
    }
  });
});
