import { createHash } from "node:crypto";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { SaxesParser, type SaxesTagNS } from "saxes";
import { AuthFailure } from "../auth/errors";
import { documentBounds } from "./contracts";
import type { StoredObject } from "./storage";

function invalidFormat(): never { throw new AuthFailure("UPLOAD_INVALID_FORMAT", 422); }

const contentTypesNamespace = "http://schemas.openxmlformats.org/package/2006/content-types";
const relationshipsNamespace = "http://schemas.openxmlformats.org/package/2006/relationships";
const mainDocumentContentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const officeDocumentRelationships = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
]);

function readMetadataElements(xml: string, root: string, namespace: string, child: string) {
  const parser = new SaxesParser({ xmlns: true });
  const elements: Array<Record<string, string>> = [];
  let depth = 0;
  let rootFound = false;
  parser.on("error", invalidFormat);
  parser.on("doctype", invalidFormat);
  parser.on("opentag", (tag: SaxesTagNS) => {
    if (depth === 0) {
      if (rootFound || tag.local !== root || tag.uri !== namespace) invalidFormat();
      rootFound = true;
    } else if (depth === 1) {
      if (tag.uri !== namespace || ![child, ...(root === "Types" ? ["Default"] : [])].includes(tag.local)) invalidFormat();
      const attributes: Record<string, string> = {};
      for (const attribute of Object.values(tag.attributes)) {
        if (attribute.uri === "") attributes[attribute.local] = attribute.value;
      }
      if (/macroenabled|vbaproject|activex/i.test(attributes.ContentType ?? attributes.Type ?? "")) invalidFormat();
      if (tag.local === child) elements.push(attributes);
    } else invalidFormat();
    depth++;
  });
  parser.on("closetag", () => { depth--; });
  parser.on("text", (text) => { if (text.trim()) invalidFormat(); });
  parser.on("cdata", (text) => { if (text.trim()) invalidFormat(); });
  parser.write(xml).close();
  if (!rootFound || depth !== 0) invalidFormat();
  return elements;
}

async function readContainerXml(archive: ZipFile, entry: Entry, signal: AbortSignal) {
  if (entry.uncompressedSize > documentBounds.maximumContainerXmlBytes) invalidFormat();
  const stream = await new Promise<import("node:stream").Readable>((resolve, reject) => {
    archive.openReadStream(entry, (error, opened) => error ? reject(error) : resolve(opened));
  });
  const abort = () => stream.destroy(new Error("Container validation aborted."));
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      signal.throwIfAborted();
      bytes += chunk.length;
      if (bytes > documentBounds.maximumContainerXmlBytes) { stream.destroy(); invalidFormat(); }
      chunks.push(Buffer.from(chunk));
    }
    const xml = Buffer.concat(chunks).toString("utf8");
    return xml;
  } finally { signal.removeEventListener("abort", abort); }
}

async function validateDocx(bytes: Buffer, signal: AbortSignal) {
  if (bytes.readUInt32LE(0) !== 0x04034b50) invalidFormat();
  const archive = await new Promise<ZipFile>((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false },
      (error, opened) => error || !opened ? reject(error ?? new Error("Invalid archive.")) : resolve(opened));
  });
  let expandedBytes = 0;
  const names = new Set<string>();
  let contentTypes = "";
  let relationships = "";
  try {
    if (archive.entryCount > documentBounds.maximumArchiveEntries) invalidFormat();
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new Error("Container validation aborted."));
      signal.addEventListener("abort", abort, { once: true });
      archive.once("error", reject);
      archive.once("end", () => { signal.removeEventListener("abort", abort); resolve(); });
      archive.on("entry", (entry: Entry) => {
        void (async () => {
          signal.throwIfAborted();
          const name = entry.fileName;
          const canonicalName = name.toLowerCase();
          expandedBytes += entry.uncompressedSize;
          if (names.has(canonicalName) || names.size >= documentBounds.maximumArchiveEntries ||
              name.split("/").includes("..") || /[\\\u0000-\u001f]|^\/|^[a-z]:/i.test(name) || entry.isEncrypted() ||
              !entry.canDecodeFileData() || /vbaproject|activex|\.docm$/i.test(name) ||
              expandedBytes > documentBounds.maximumArchiveExpandedBytes ||
              (entry.uncompressedSize > 1_000_000 && entry.uncompressedSize > Math.max(1, entry.compressedSize) * 100)) invalidFormat();
          names.add(canonicalName);
          if (name === "[Content_Types].xml") contentTypes = await readContainerXml(archive, entry, signal);
          if (name === "_rels/.rels") relationships = await readContainerXml(archive, entry, signal);
          archive.readEntry();
        })().catch(reject);
      });
      archive.readEntry();
    });
    const mainParts = readMetadataElements(contentTypes, "Types", contentTypesNamespace, "Override")
      .filter((element) => element.PartName === "/word/document.xml");
    const mainRelationships = readMetadataElements(relationships, "Relationships", relationshipsNamespace, "Relationship")
      .filter((element) => officeDocumentRelationships.has(element.Type));
    if (!names.has("word/document.xml") || mainParts.length !== 1 || mainParts[0].ContentType !== mainDocumentContentType ||
        mainRelationships.length !== 1 || !/^\/?word\/document\.xml$/.test(mainRelationships[0].Target) ||
        mainRelationships[0].TargetMode === "External") invalidFormat();
  } finally { archive.close(); }
}

export async function validateDocumentObject(object: StoredObject, expected: { sizeBytes: number; mimeType: string; sha256: string }, signal: AbortSignal) {
  signal.throwIfAborted();
  if (object.bytes.length !== expected.sizeBytes || object.bytes.length > documentBounds.maximumFileBytes) throw new AuthFailure("UPLOAD_SIZE_MISMATCH", 422);
  if (object.contentType.split(";")[0].trim().toLowerCase() !== expected.mimeType) throw new AuthFailure("UPLOAD_TYPE_MISMATCH", 422);
  if (createHash("sha256").update(object.bytes).digest("hex") !== expected.sha256) throw new AuthFailure("UPLOAD_CHECKSUM_MISMATCH", 422);
  try {
    if (expected.mimeType === "application/pdf") {
      if (!/^%PDF-[12]\.\d/.test(object.bytes.subarray(0, 16).toString("ascii")) || !object.bytes.subarray(-1024).includes(Buffer.from("%%EOF"))) invalidFormat();
    } else await validateDocx(object.bytes, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof AuthFailure) throw error;
    invalidFormat();
  }
  signal.throwIfAborted();
}
