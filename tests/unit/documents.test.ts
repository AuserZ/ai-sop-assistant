import { createHash, randomUUID } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { documentQuotaBytes, storageConfiguration } from "../../src/server/documents/config";
import { documentBounds, uploadInput } from "../../src/server/documents/contracts";
import { validateDocumentObject } from "../../src/server/documents/format";
import { createR2Storage, readBoundedObject } from "../../src/server/documents/storage";
import { syntheticRichDocx, syntheticScannedPdf } from "../fixtures/document-files";

const pdf = Buffer.from("%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
const pdfMime = "application/pdf";
const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const metadata = (bytes = pdf, mimeType = pdfMime) => ({ requestKey: randomUUID(), title: "Synthetic SOP", fileName: mimeType === pdfMime ? "synthetic.pdf" : "synthetic.docx", mimeType, sizeBytes: bytes.length, sha256: digest(bytes) });
const signal = () => new AbortController().signal;

function zip(entries: { name: string; body: string; encrypted?: boolean; inflatedSize?: number; deflate?: boolean }[]) {
  const locals: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), plain = Buffer.from(entry.body), data = entry.deflate ? deflateRawSync(plain) : plain;
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(entry.encrypted ? 1 : 0, 6);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8); local.writeUInt32LE(crc32(plain), 14); local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.inflatedSize ?? plain.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(entry.encrypted ? 1 : 0, 8);
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10); central.writeUInt32LE(crc32(plain), 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(entry.inflatedSize ?? plain.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); directory.push(central, name); offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
const docxEntries = () => [
  { name: "[Content_Types].xml", body: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
  { name: "_rels/.rels", body: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
  { name: "word/document.xml", body: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>' },
];

afterEach(() => vi.restoreAllMocks());

describe("D2/ADR03 upload contracts, formats and signed storage boundary", () => {
  it("allows only strict matching PDF/DOCX metadata and the initial decimal20MB bound", () => {
    expect(uploadInput.safeParse(metadata()).success).toBe(true);
    expect(uploadInput.safeParse({ ...metadata(), sizeBytes: 20_000_000 }).success).toBe(true);
    for (const changes of [{ sizeBytes: 20_000_001 }, { sizeBytes: 0 }, { fileName: "../sop.pdf" }, { fileName: "sop.docx" },
      { fileName: "sop\n.pdf" }, { mimeType: "application/octet-stream" }, { sha256: "A".repeat(64) }, { objectKey: "foreign" }]) {
      expect(uploadInput.safeParse({ ...metadata(), ...changes }).success).toBe(false);
    }
  });

  it("requires explicit quota and confines synthetic endpoints to loopback", () => {
    expect(documentQuotaBytes({ DOCUMENT_UPLOAD_QUOTA_BYTES: "100000000" })).toBe(100000000);
    for (const value of [undefined, "0", "-1", "2.1", "9007199254740992"]) expect(() => documentQuotaBytes({ DOCUMENT_UPLOAD_QUOTA_BYTES: value })).toThrow();
    const env = { R2_BUCKET: "synthetic-bucket", R2_ENDPOINT: `https://${"a".repeat(32)}.eu.r2.cloudflarestorage.com`, R2_ACCESS_KEY_ID: "synthetic", R2_SECRET_ACCESS_KEY: "synthetic-only" };
    expect(storageConfiguration(env).forcePathStyle).toBe(false);
    expect(() => storageConfiguration({ ...env, R2_ENDPOINT: "https://foreign.example" })).toThrow();
    expect(() => storageConfiguration({ ...env, R2_ENDPOINT: "http://127.0.0.1:8787/local" })).toThrow();
    const local = { ...env, SOP_LOCAL_STORAGE_FIXTURE_ENABLED: "1", R2_ENDPOINT: "http://127.0.0.1:8787/cdn-cgi/local/r2/s3", AUTH_BASE_URL: "http://127.0.0.1:3000" };
    expect(storageConfiguration(local).forcePathStyle).toBe(true);
    expect(() => storageConfiguration({ ...local, AUTH_BASE_URL: "https://public.example" })).toThrow();
  });

  it("signs the actual key, exact length, type and create-only header without exposing a Content-Length browser header", async () => {
    const storage = createR2Storage({ bucket: "synthetic-bucket", endpoint: "http://127.0.0.1:8787/cdn-cgi/local/r2/s3", forcePathStyle: true,
      credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic-only" } });
    const result = await storage.authorizeUpload({ stagingKey: "staging/synthetic-key", mimeType: pdfMime, sizeBytes: pdf.length,
      uploadExpiresAt: new Date(Date.now() + 120000) });
    const url = new URL(result.url);
    expect(url.pathname).toBe("/cdn-cgi/local/r2/s3/synthetic-bucket/staging/synthetic-key");
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(["content-length", "content-type", "host", "if-none-match"]);
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(120);
    expect(result.headers).toEqual({ "Content-Type": pdfMime, "If-None-Match": "*" });
    expect(result.sizeBytes).toBe(pdf.length);
    await expect(storage.authorizeUpload({ stagingKey: "x", mimeType: pdfMime, sizeBytes: 1, uploadExpiresAt: new Date(0) })).rejects.toMatchObject({ code: "UPLOAD_EXPIRED" });
  });

  it("rejects byte20000001 in an actual stream and destroys it regardless of metadata", async () => {
    const destroy = vi.fn();
    let reads = 0;
    const body = { destroy, async *[Symbol.asyncIterator]() { reads++; yield Buffer.alloc(20_000_000); reads++; yield Buffer.from([0]); reads++; yield Buffer.from([1]); } };
    await expect(readBoundedObject(body, documentBounds.maximumFileBytes, signal())).rejects.toMatchObject({ code: "UPLOAD_SIZE_MISMATCH" });
    expect(destroy).toHaveBeenCalledOnce();
    expect(reads).toBe(2);
  });

  it("verifies actual PDF bytes, type, length and SHA256 independently", async () => {
    await expect(validateDocumentObject({ bytes: pdf, contentType: pdfMime }, metadata(), signal())).resolves.toBeUndefined();
    await expect(validateDocumentObject({ bytes: pdf, contentType: docxMime }, metadata(), signal())).rejects.toMatchObject({ code: "UPLOAD_TYPE_MISMATCH" });
    await expect(validateDocumentObject({ bytes: Buffer.concat([pdf, Buffer.from("x")]), contentType: pdfMime }, metadata(), signal())).rejects.toMatchObject({ code: "UPLOAD_SIZE_MISMATCH" });
    await expect(validateDocumentObject({ bytes: pdf, contentType: pdfMime }, { ...metadata(), sha256: "0".repeat(64) }, signal())).rejects.toMatchObject({ code: "UPLOAD_CHECKSUM_MISMATCH" });
    const invalid = Buffer.from("not a PDF %%EOF");
    await expect(validateDocumentObject({ bytes: invalid, contentType: pdfMime }, metadata(invalid), signal())).rejects.toMatchObject({ code: "UPLOAD_INVALID_FORMAT" });
  });

  it("accepts a bounded DOCX container and rejects ZIP masquerades, duplicate/traversal/encrypted/macro entries", async () => {
    const valid = zip(docxEntries());
    await expect(validateDocumentObject({ bytes: valid, contentType: docxMime }, metadata(valid, docxMime), signal())).resolves.toBeUndefined();
    const invalidArchives = [zip([{ name: "unrelated.txt", body: "synthetic" }]), Buffer.from("PK\x03\x04fake"),
      zip([...docxEntries(), { name: "word/document.xml", body: "duplicate" }]),
      zip([...docxEntries(), { name: "../escape", body: "invalid" }]),
      zip([...docxEntries(), { name: "encrypted.bin", body: "invalid", encrypted: true }]),
      zip([...docxEntries(), { name: "word/vbaProject.bin", body: "macro" }])];
    for (const bytes of invalidArchives) await expect(validateDocumentObject({ bytes, contentType: docxMime }, metadata(bytes, docxMime), signal())).rejects.toMatchObject({ code: "UPLOAD_INVALID_FORMAT" });
  });

  it("bounds actual XML inflation, archive entry budgets and entity declarations", async () => {
    const base = docxEntries();
    const adversarial = [
      zip([{ ...base[0], body: "x".repeat(262145), deflate: true, inflatedSize: 100 }, ...base.slice(1)]),
      zip([{ ...base[0], body: "<!DOCTYPE x [<!ENTITY e SYSTEM 'https://example.invalid'>]>" + base[0].body }, ...base.slice(1)]),
      zip([...base, { name: "huge.bin", body: "x", deflate: true, inflatedSize: 100_000_001 }]),
      zip([...base, ...Array.from({ length: 2048 }, (_, index) => ({ name: `entries/${index}`, body: "" }))]),
    ];
    for (const bytes of adversarial) await expect(validateDocumentObject({ bytes, contentType: docxMime }, metadata(bytes, docxMime), signal())).rejects.toMatchObject({ code: "UPLOAD_INVALID_FORMAT" });
  });

  it("rejects malformed, commented, wrong-namespace and entity-obscured macro metadata", async () => {
    const base = docxEntries();
    const override = '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>';
    const invalid = [
      zip([{ ...base[0], body: `junk ${override}` }, ...base.slice(1)]),
      zip([{ ...base[0], body: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><!--${override}--><Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macro&#69;nabled.main+xml"/></Types>` }, ...base.slice(1)]),
      zip([{ ...base[0], body: `<Types xmlns="https://example.invalid/not-ooxml">${override}</Types>` }, ...base.slice(1)]),
      zip([base[0], { ...base[1], body: 'junk /officeDocument Target="word/document.xml"' }, base[2]]),
      zip([{ ...base[0], body: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><!--${override}--></Types>` }, ...base.slice(1)]),
    ];
    for (const bytes of invalid) await expect(validateDocumentObject({ bytes, contentType: docxMime }, metadata(bytes, docxMime), signal())).rejects.toMatchObject({ code: "UPLOAD_INVALID_FORMAT" });
  });

  it("reads actual namespaced elements and standard numeric entities", async () => {
    const base = docxEntries();
    const bytes = zip([{ ...base[0], body: base[0].body.replace("main+xml", "ma&#105;n+xml") }, ...base.slice(1)]);
    await expect(validateDocumentObject({ bytes, contentType: docxMime }, metadata(bytes, docxMime), signal())).resolves.toBeUndefined();
  });

  it("R-S05b-1 rejects external OOXML relationships and attached templates while allowing https hyperlinks", async () => {
    const base = docxEntries();
    const externalImageRels = {
      name: "word/_rels/document.xml.rels",
      body: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://app:3000/api/health/ready" TargetMode="External"/></Relationships>',
    };
    const externalSubDocRels = {
      name: "word/_rels/document.xml.rels",
      body: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/subDocument" Target="file:///etc/passwd" TargetMode="External"/></Relationships>',
    };
    const attachedTemplateSettings = {
      name: "word/settings.xml",
      body: '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:attachedTemplate w:id="rId1"/></w:settings>',
    };
    const safeHyperlinkRels = {
      name: "word/_rels/document.xml.rels",
      body: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/sop-ref" TargetMode="External"/></Relationships>',
    };

    for (const extra of [externalImageRels, externalSubDocRels, attachedTemplateSettings]) {
      const bytes = zip([...base, extra]);
      await expect(validateDocumentObject({ bytes, contentType: docxMime }, metadata(bytes, docxMime), signal())).rejects.toMatchObject({ code: "UPLOAD_INVALID_FORMAT" });
    }
    const allowed = zip([...base, safeHyperlinkRels]);
    await expect(validateDocumentObject({ bytes: allowed, contentType: docxMime }, metadata(allowed, docxMime), signal())).resolves.toBeUndefined();
    const scannedPdf = syntheticScannedPdf();
    await expect(validateDocumentObject({ bytes: scannedPdf, contentType: pdfMime }, metadata(scannedPdf, pdfMime), signal())).resolves.toBeUndefined();
    const richDocx = syntheticRichDocx();
    await expect(validateDocumentObject({ bytes: richDocx, contentType: docxMime }, metadata(richDocx, docxMime), signal())).resolves.toBeUndefined();
  });
});
