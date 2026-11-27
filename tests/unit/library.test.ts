import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeDocumentLibraryCursor,
  deriveSourceSigningKey,
  documentLibraryBounds,
  documentSourceContentQueryInput,
  documentSourceQueryInput,
  encodeDocumentLibraryCursor,
  escapeIlikePattern,
  formatContentDisposition,
  listDocumentsQueryInput,
  signDocumentSourceToken,
  sourceLinkTtlSeconds,
  verifyDocumentSourceToken,
} from "../../src/server/documents/contracts";
import { DocumentRequestError } from "../../src/components/documents/client";

const syntheticSecret = "s07-unit-test-secret-with-at-least-32-characters!";
const signingKey = deriveSourceSigningKey(syntheticSecret);
const sha256 = "b".repeat(64);

describe("S07/D1/D5 SOP library contracts, ILIKE escaping, cursor encoding and signed source tokens", () => {
  it("escapes PostgreSQL ILIKE wildcards %, _ and \\ literally", () => {
    expect(escapeIlikePattern("SOP 100% _v1\\final")).toBe("SOP 100\\% \\_v1\\\\final");
    expect(escapeIlikePattern("plain title")).toBe("plain title");
    expect(escapeIlikePattern("%_\\")).toBe("\\%\\_\\\\");
  });

  it("encodes and decodes opaque keyset cursors and rejects malformed cursors", () => {
    const id = randomUUID();
    const cursor = encodeDocumentLibraryCursor({
      createdAt: "2026-11-23T08:30:00.123456Z",
      id,
    });
    expect(decodeDocumentLibraryCursor(cursor)).toEqual({
      createdAt: "2026-11-23T08:30:00.123456Z",
      id,
    });

    for (const invalid of [
      "",
      "not-base64-json!",
      Buffer.from(JSON.stringify({ createdAt: "not-a-date", id }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ createdAt: "2026-11-23T08:30:00.000Z", id: "bad-id" }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ createdAt: "2026-11-23T08:30:00.000Z", id, extra: 1 }), "utf8").toString("base64url"),
    ]) {
      expect(decodeDocumentLibraryCursor(invalid)).toBeNull();
    }
  });

  it("validates listDocumentsQueryInput bounds, trimming, control characters and cursor integrity", () => {
    const validCursor = encodeDocumentLibraryCursor({
      createdAt: "2026-11-23T08:30:00.000Z",
      id: randomUUID(),
    });

    expect(listDocumentsQueryInput.parse({})).toEqual({
      q: "",
      limit: documentLibraryBounds.defaultLimit,
    });
    expect(
      listDocumentsQueryInput.parse({
        q: "  Lockout Tagout 100%  ",
        limit: "15",
        cursor: validCursor,
      }),
    ).toEqual({
      q: "Lockout Tagout 100%",
      limit: 15,
      cursor: validCursor,
    });

    for (const invalid of [
      { q: "a".repeat(101) },
      { q: "bad\u0000query" },
      { q: "\nleading-newline" },
      { limit: 0 },
      { limit: 51 },
      { limit: "0" },
      { limit: "51" },
      { limit: "12.5" },
      { limit: "abc" },
      { cursor: "invalid-cursor" },
      { unknownParam: "1" },
    ]) {
      expect(listDocumentsQueryInput.safeParse(invalid).success).toBe(false);
    }
  });

  it("validates source authorization and content query parameters including page and section context", () => {
    expect(documentSourceQueryInput.parse({})).toEqual({ disposition: "inline" });
    expect(
      documentSourceQueryInput.parse({
        disposition: "attachment",
        page: "42",
        section: "  Section 4.2 Pressure Limits  ",
      }),
    ).toEqual({
      disposition: "attachment",
      page: 42,
      section: "Section 4.2 Pressure Limits",
    });

    for (const invalid of [
      { disposition: "public" },
      { page: 0 },
      { page: 5001 },
      { page: "0" },
      { page: "-1" },
      { page: "abc" },
      { section: "   " },
      { section: "s".repeat(201) },
      { section: "Section\u0007Bell" },
      { extra: "nope" },
    ]) {
      expect(documentSourceQueryInput.safeParse(invalid).success).toBe(false);
    }

    expect(documentSourceContentQueryInput.safeParse({ token: "abc.def" }).success).toBe(true);
    expect(documentSourceContentQueryInput.safeParse({}).success).toBe(false);
    expect(documentSourceContentQueryInput.safeParse({ token: "" }).success).toBe(false);
    expect(documentSourceContentQueryInput.safeParse({ token: "bad\u0000token" }).success).toBe(false);
    expect(documentSourceContentQueryInput.safeParse({ token: "abc.def", extra: "1" }).success).toBe(false);
  });

  it("signs and verifies short-lived HMAC-SHA256 source tokens and rejects expired, tampered or mismatched tokens", () => {
    const documentId = randomUUID();
    const otherDocumentId = randomUUID();
    const nowSeconds = 1_795_000_000;

    const { token, claims } = signDocumentSourceToken(
      {
        documentId,
        accountId: "user-staff-1",
        role: "STAFF",
        statusAtIssue: "ACTIVE",
        sha256,
        disposition: "inline",
        page: 3,
        section: "Section 3.1 Valve Isolation",
      },
      { nowSeconds, signingKey },
    );

    expect(claims.v).toBe(1);
    expect(claims.iat).toBe(nowSeconds);
    expect(claims.exp).toBe(nowSeconds + sourceLinkTtlSeconds);
    expect(sourceLinkTtlSeconds).toBe(60);

    const verified = verifyDocumentSourceToken(token, documentId, {
      nowSeconds: nowSeconds + 59,
      signingKey,
    });
    expect(verified).toEqual(claims);

    // Exact expiry boundary (nowSeconds >= exp -> 410 SOURCE_LINK_EXPIRED).
    expect(() =>
      verifyDocumentSourceToken(token, documentId, {
        nowSeconds: nowSeconds + 60,
        signingKey,
      }),
    ).toThrowError(expect.objectContaining({ code: "SOURCE_LINK_EXPIRED", status: 410 }));

    // Wrong documentId replay -> 403 SOURCE_LINK_INVALID.
    expect(() =>
      verifyDocumentSourceToken(token, otherDocumentId, {
        nowSeconds: nowSeconds + 10,
        signingKey,
      }),
    ).toThrowError(expect.objectContaining({ code: "SOURCE_LINK_INVALID", status: 403 }));

    // Wrong signing key -> 403 SOURCE_LINK_INVALID.
    const otherKey = deriveSourceSigningKey("different-auth-secret-with-at-least-32-chars!");
    expect(() =>
      verifyDocumentSourceToken(token, documentId, {
        nowSeconds: nowSeconds + 10,
        signingKey: otherKey,
      }),
    ).toThrowError(expect.objectContaining({ code: "SOURCE_LINK_INVALID", status: 403 }));

    // Flip an interior character (index 10) where all 6 base64url bits are significant.
    const [payloadPart, signaturePart] = token.split(".");
    const flippedChar = signaturePart[10] === "A" ? "B" : "A";
    const tamperedSignatureToken = `${payloadPart}.${signaturePart.slice(0, 10)}${flippedChar}${signaturePart.slice(11)}`;
    expect(() =>
      verifyDocumentSourceToken(tamperedSignatureToken, documentId, {
        nowSeconds: nowSeconds + 10,
        signingKey,
      }),
    ).toThrowError(expect.objectContaining({ code: "SOURCE_LINK_INVALID", status: 403 }));

    // Tampered payload with original signature -> 403 SOURCE_LINK_INVALID.
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...claims, accountId: "user-staff-2" }),
      "utf8",
    ).toString("base64url");
    expect(() =>
      verifyDocumentSourceToken(`${tamperedPayload}.${signaturePart}`, documentId, {
        nowSeconds: nowSeconds + 10,
        signingKey,
      }),
    ).toThrowError(expect.objectContaining({ code: "SOURCE_LINK_INVALID", status: 403 }));

    // Wrong schema version signed with valid key -> 403 SOURCE_LINK_INVALID.
    const wrongVersionPayload = Buffer.from(
      JSON.stringify({ ...claims, v: 2 }),
      "utf8",
    ).toString("base64url");
    const wrongVersionToken = signRawPayload(wrongVersionPayload, signingKey);
    expect(() =>
      verifyDocumentSourceToken(wrongVersionToken, documentId, {
        nowSeconds: nowSeconds + 10,
        signingKey,
      }),
    ).toThrowError(expect.objectContaining({ code: "SOURCE_LINK_INVALID", status: 403 }));

    // Excessive TTL signed with valid key -> 403 SOURCE_LINK_INVALID.
    const excessiveTtlPayload = Buffer.from(
      JSON.stringify({ ...claims, exp: claims.iat + sourceLinkTtlSeconds + 1 }),
      "utf8",
    ).toString("base64url");
    expect(() =>
      verifyDocumentSourceToken(signRawPayload(excessiveTtlPayload, signingKey), documentId, {
        nowSeconds: nowSeconds + 10,
        signingKey,
      }),
    ).toThrowError(expect.objectContaining({ code: "SOURCE_LINK_INVALID", status: 403 }));

    for (const malformed of [null, undefined, "", "no-dot", "a.b.c", "bad$char.sig"]) {
      expect(() =>
        verifyDocumentSourceToken(malformed, documentId, {
          nowSeconds: nowSeconds + 10,
          signingKey,
        }),
      ).toThrowError(expect.objectContaining({ code: "SOURCE_LINK_INVALID", status: 403 }));
    }
  });

  it("sanitizes Content-Disposition filenames against header injection, quotes, semicolons and non-ASCII characters", () => {
    expect(formatContentDisposition("inline", "sop-pump-lockout.pdf")).toBe(
      `inline; filename="sop-pump-lockout.pdf"; filename*=UTF-8''sop-pump-lockout.pdf`,
    );

    const injected = formatContentDisposition("attachment", 'evil";\r\nX-Injected: 1/..\\sop(1).pdf');
    expect(injected).not.toMatch(/[\r\n]/);
    expect(injected).toContain('attachment; filename="evil____X-Injected: 1_.._sop(1).pdf"');
    expect(injected).toContain("filename*=UTF-8''");
    expect(injected).toContain("%281%29.pdf");

    const unicode = formatContentDisposition("inline", "SOP — Проверка 75°C.docx");
    expect(unicode).toMatch(/^inline; filename="SOP _ ________ 75_C\.docx"; filename\*=UTF-8''/);
  });

  it("maps source link error codes to safe user-facing messages", () => {
    expect(new DocumentRequestError("SOURCE_LINK_INVALID").message).toContain("invalid");
    expect(new DocumentRequestError("SOURCE_LINK_EXPIRED").message).toContain("expired");
    expect(new DocumentRequestError("SOURCE_OBJECT_MISSING").message).toContain("unavailable");
  });
});

function signRawPayload(encodedPayload: string, key: Buffer): string {
  const sig = createHmac("sha256", key).update(encodedPayload, "utf8").digest("base64url");
  return `${encodedPayload}.${sig}`;
}
