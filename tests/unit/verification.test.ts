import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  reprocessDocumentInput,
  splitReviewHighlights,
  verifyDocumentInput,
} from "../../src/server/verification/contracts";
import { verificationErrorMessage } from "../../src/components/verification/client";

const sha = "a".repeat(64);

describe("S06/ADR17 verification contracts, highlighting and safe error mapping", () => {
  it("validates strict approve/reject/reprocess inputs and enforces explicit confirmation and rejection notes", () => {
    const validApprove = {
      decision: "APPROVE" as const,
      expectedSha256: sha,
      expectedJobId: randomUUID(),
      expectedPipelineVersion: "document-ingestion-v1",
      expectedAttemptId: randomUUID(),
      explicitConfirmation: true as const,
      resolvedIssueIds: [randomUUID()],
    };
    expect(verifyDocumentInput.safeParse(validApprove).success).toBe(true);
    expect(
      verifyDocumentInput.safeParse({
        ...validApprove,
        decision: "REJECT",
        notes: "Digit mismatch on page 2 pressure limit.",
      }).success,
    ).toBe(true);

    for (const invalid of [
      { ...validApprove, explicitConfirmation: false },
      { ...validApprove, explicitConfirmation: undefined },
      { ...validApprove, expectedAttemptId: undefined },
      { ...validApprove, expectedAttemptId: "not-a-uuid" },
      { ...validApprove, decision: "REJECT" },
      { ...validApprove, decision: "REJECT", notes: "   " },
      { ...validApprove, expectedSha256: "A".repeat(64) },
      { ...validApprove, expectedJobId: "not-a-uuid" },
      { ...validApprove, notes: "bad\u0000char" },
      { ...validApprove, status: "ACTIVE" },
    ]) {
      expect(verifyDocumentInput.safeParse(invalid).success).toBe(false);
    }

    expect(reprocessDocumentInput.safeParse({ expectedSha256: sha }).success).toBe(true);
    expect(reprocessDocumentInput.safeParse({ expectedSha256: "short" }).success).toBe(false);
    expect(reprocessDocumentInput.safeParse({ expectedSha256: sha, extra: true }).success).toBe(false);
  });

  it("highlights suspicious numeric/unit spans and search matches without altering literal text", () => {
    const text = "Set chamber pressure to 2.5 bar for 15 minutes at 75 C.";
    const quantitySegments = splitReviewHighlights(text);
    expect(quantitySegments.map((segment) => segment.text).join("")).toBe(text);
    const highlightedQuantities = quantitySegments
      .filter((segment) => segment.kind === "quantity")
      .map((segment) => segment.text);
    expect(highlightedQuantities).toEqual(expect.arrayContaining(["2.5 bar", "15 minutes", "75 C"]));

    const searchSegments = splitReviewHighlights(text, "pressure");
    expect(searchSegments.map((segment) => segment.text).join("")).toBe(text);
    expect(searchSegments.some((segment) => segment.kind === "search" && segment.text === "pressure")).toBe(true);
    expect(searchSegments.some((segment) => segment.kind === "quantity" && segment.text === "2.5 bar")).toBe(true);
  });

  it("maps verification error codes to safe user-facing messages without leaking unknown internals", () => {
    expect(verificationErrorMessage("FORBIDDEN")).toBe("Only Admins can verify SOPs.");
    expect(verificationErrorMessage("VERIFICATION_STALE_SNAPSHOT")).toContain("Refresh");
    expect(verificationErrorMessage("DOCUMENT_ALREADY_ACTIVE")).toContain("ACTIVE");
    const unknown = verificationErrorMessage("RAW_SQL_SECRET_DETAIL");
    expect(unknown).not.toContain("RAW_SQL_SECRET_DETAIL");
  });
});
