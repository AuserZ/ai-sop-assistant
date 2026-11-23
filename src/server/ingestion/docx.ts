import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { SaxesParser, type SaxesTagNS } from "saxes";
import { documentBounds } from "../documents/contracts";
import { ingestionLimits, IngestionStageError, type ExtractedBlock } from "./contracts";

const wordprocessingNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const relationshipsNamespace = "http://schemas.openxmlformats.org/package/2006/relationships";
const externalHyperlinkRelationships = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink",
]);
const wordprocessingNamespaces = new Set([
  wordprocessingNamespace,
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);

function invalidDocx(): never {
  throw new IngestionStageError("DOCX_EXTRACTION_INVALID", false, 422);
}

function validateDocxRelationshipsXml(xml: string) {
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0;
  let rootFound = false;
  parser.on("error", invalidDocx);
  parser.on("doctype", invalidDocx);
  parser.on("opentag", (tag: SaxesTagNS) => {
    if (depth === 0) {
      if (rootFound || tag.local !== "Relationships" || tag.uri !== relationshipsNamespace) invalidDocx();
      rootFound = true;
    } else if (depth === 1) {
      if (tag.uri !== relationshipsNamespace || tag.local !== "Relationship") invalidDocx();
      const attributes: Record<string, string> = {};
      for (const attribute of Object.values(tag.attributes)) {
        if (attribute.uri === "") attributes[attribute.local] = attribute.value;
      }
      const type = (attributes.Type ?? "").trim();
      const target = (attributes.Target ?? "").trim();
      const targetMode = (attributes.TargetMode ?? "").trim().toLowerCase();
      if (/macroenabled|vbaproject|activex/i.test(type)) invalidDocx();
      const hasUriScheme = /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//") || target.startsWith("\\\\");
      if (targetMode === "external" || hasUriScheme) {
        if (!externalHyperlinkRelationships.has(type) || !/^https?:\/\//i.test(target)) {
          invalidDocx();
        }
      }
    } else {
      invalidDocx();
    }
    depth++;
  });
  parser.on("closetag", () => { depth--; });
  parser.on("text", (text) => { if (text.trim()) invalidDocx(); });
  parser.on("cdata", (text) => { if (text.trim()) invalidDocx(); });
  parser.write(xml).close();
  if (!rootFound || depth !== 0) invalidDocx();
}

function validateDocxSettingsXml(xml: string) {
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0;
  let rootFound = false;
  parser.on("error", invalidDocx);
  parser.on("doctype", invalidDocx);
  parser.on("opentag", (tag: SaxesTagNS) => {
    if (depth === 0) {
      if (rootFound || tag.local !== "settings" || !wordprocessingNamespaces.has(tag.uri)) invalidDocx();
      rootFound = true;
    }
    const localLower = tag.local.toLowerCase();
    if (localLower === "attachedtemplate" || localLower === "mailmerge") invalidDocx();
    depth++;
  });
  parser.on("closetag", () => { depth--; });
  parser.write(xml).close();
  if (!rootFound || depth !== 0) invalidDocx();
}

async function readBoundedEntry(archive: ZipFile, entry: Entry, maximumBytes: number, signal?: AbortSignal) {
  if (entry.uncompressedSize > maximumBytes) invalidDocx();
  const stream = await new Promise<import("node:stream").Readable>((resolve, reject) => {
    archive.openReadStream(entry, (error, opened) => (error ? reject(error) : resolve(opened)));
  });
  const abort = () => stream.destroy(new Error("DOCX extraction aborted."));
  signal?.addEventListener("abort", abort, { once: true });
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        stream.destroy();
        invalidDocx();
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function getWordAttribute(tag: SaxesTagNS, localName: string): string | undefined {
  for (const attribute of Object.values(tag.attributes)) {
    if (attribute.local === localName && (attribute.uri === wordprocessingNamespace || attribute.uri === "")) {
      return attribute.value;
    }
  }
  return undefined;
}

function parseStyleHeadingLevels(stylesXml: string): Map<string, number> {
  const levels = new Map<string, number>();
  if (!stylesXml) return levels;
  const parser = new SaxesParser({ xmlns: true });
  let currentStyleId: string | null = null;
  let currentIsParagraph = false;
  parser.on("error", invalidDocx);
  parser.on("doctype", invalidDocx);
  parser.on("opentag", (tag: SaxesTagNS) => {
    if (tag.uri !== wordprocessingNamespace) return;
    if (tag.local === "style") {
      currentStyleId = getWordAttribute(tag, "styleId") ?? null;
      currentIsParagraph = getWordAttribute(tag, "type") === "paragraph";
    } else if (currentStyleId && currentIsParagraph) {
      if (tag.local === "name") {
        const value = getWordAttribute(tag, "val") ?? "";
        const match = /^heading\s*([1-6])$/i.exec(value.trim());
        if (match) levels.set(currentStyleId, Number(match[1]));
      } else if (tag.local === "outlineLvl") {
        const raw = getWordAttribute(tag, "val");
        if (raw !== undefined && /^[0-5]$/.test(raw)) {
          levels.set(currentStyleId, Number(raw) + 1);
        }
      }
    }
  });
  parser.on("closetag", (tag: SaxesTagNS) => {
    if (tag.uri === wordprocessingNamespace && tag.local === "style") {
      currentStyleId = null;
      currentIsParagraph = false;
    }
  });
  parser.write(stylesXml).close();
  return levels;
}

function escapePipeCell(value: string) {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function formatMarkdownTable(rows: string[][]) {
  const nonEmptyRows = rows.filter((row) => row.some((cell) => cell.trim().length > 0));
  if (nonEmptyRows.length === 0) return "";
  const columnCount = Math.max(...nonEmptyRows.map((row) => row.length));
  const padded = nonEmptyRows.map((row) => {
    const cells = row.map(escapePipeCell);
    while (cells.length < columnCount) cells.push("");
    return cells;
  });
  const header = `| ${padded[0].join(" | ")} |`;
  const separator = `| ${Array.from({ length: columnCount }, () => "---").join(" | ")} |`;
  const body = padded.slice(1).map((row) => `| ${row.join(" | ")} |`);
  return [header, separator, ...body].join("\n");
}

function resolveHeadingLevel(styleId: string | undefined, outlineLevel: number | undefined, styleLevels: Map<string, number>) {
  if (outlineLevel !== undefined && outlineLevel >= 1 && outlineLevel <= 6) return outlineLevel;
  if (!styleId) return undefined;
  const fromStyles = styleLevels.get(styleId);
  if (fromStyles) return fromStyles;
  const direct = /^heading\s*([1-6])$/i.exec(styleId.trim());
  return direct ? Number(direct[1]) : undefined;
}

export type DocxExtractionResult = {
  blocks: ExtractedBlock[];
  rawText: string;
  normalizedText: string;
  tableCount: number;
  sectionPaths: string[];
};

function parseDocumentXml(documentXml: string, styleLevels: Map<string, number>): DocxExtractionResult {
  const parser = new SaxesParser({ xmlns: true });
  const blocks: ExtractedBlock[] = [];
  const headingStack: string[] = [];
  const sectionPaths = new Set<string>();
  const listCounters = new Map<string, number>();

  let inBody = false;
  let tableDepth = 0;
  let inParagraph = false;
  let inParagraphProps = false;
  let inNumProps = false;
  let inText = false;
  let paragraphText = "";
  let paragraphStyleId: string | undefined;
  let paragraphOutlineLevel: number | undefined;
  let paragraphNumId: string | undefined;
  let paragraphIlvl: string | undefined;

  let currentTableRows: string[][] = [];
  let currentRowCells: string[] = [];
  let currentCellParagraphs: string[] = [];
  let inCell = false;
  let tableCount = 0;

  const currentSectionPath = () => {
    const path = headingStack.filter((entry) => entry.length > 0).join(" > ");
    return path || "Document";
  };

  parser.on("error", invalidDocx);
  parser.on("doctype", invalidDocx);

  parser.on("opentag", (tag: SaxesTagNS) => {
    if (tag.uri !== wordprocessingNamespace) return;
    if (tag.local === "body") {
      inBody = true;
      return;
    }
    if (!inBody) return;

    if (tag.local === "tbl") {
      tableDepth++;
      if (tableDepth === 1) {
        currentTableRows = [];
      }
      return;
    }
    if (tableDepth === 1 && tag.local === "tr") {
      currentRowCells = [];
      return;
    }
    if (tableDepth === 1 && tag.local === "tc") {
      inCell = true;
      currentCellParagraphs = [];
      return;
    }
    if (tag.local === "p") {
      inParagraph = true;
      paragraphText = "";
      paragraphStyleId = undefined;
      paragraphOutlineLevel = undefined;
      paragraphNumId = undefined;
      paragraphIlvl = undefined;
      return;
    }
    if (!inParagraph) return;

    if (tag.local === "pPr") {
      inParagraphProps = true;
    } else if (inParagraphProps && tag.local === "pStyle") {
      paragraphStyleId = getWordAttribute(tag, "val");
    } else if (inParagraphProps && tag.local === "outlineLvl") {
      const raw = getWordAttribute(tag, "val");
      if (raw !== undefined && /^[0-5]$/.test(raw)) {
        paragraphOutlineLevel = Number(raw) + 1;
      }
    } else if (inParagraphProps && tag.local === "numPr") {
      inNumProps = true;
    } else if (inNumProps && tag.local === "numId") {
      paragraphNumId = getWordAttribute(tag, "val");
    } else if (inNumProps && tag.local === "ilvl") {
      paragraphIlvl = getWordAttribute(tag, "val");
    } else if (tag.local === "t") {
      inText = true;
    } else if (tag.local === "tab") {
      paragraphText += "\t";
    } else if (tag.local === "br" || tag.local === "cr") {
      paragraphText += "\n";
    }
  });

  parser.on("text", (text: string) => {
    if (inParagraph && inText) {
      paragraphText += text;
    }
  });

  parser.on("closetag", (tag: SaxesTagNS) => {
    if (tag.uri !== wordprocessingNamespace) return;
    if (tag.local === "body") {
      inBody = false;
      return;
    }
    if (!inBody) return;

    if (tag.local === "t") {
      inText = false;
      return;
    }
    if (tag.local === "numPr") {
      inNumProps = false;
      return;
    }
    if (tag.local === "pPr") {
      inParagraphProps = false;
      return;
    }
    if (tag.local === "p") {
      const cleaned = paragraphText.replace(/\r\n/g, "\n").trim();
      if (inCell && tableDepth === 1) {
        if (cleaned) currentCellParagraphs.push(cleaned);
      } else if (tableDepth === 0 && cleaned) {
        const headingLevel = resolveHeadingLevel(paragraphStyleId, paragraphOutlineLevel, styleLevels);
        if (headingLevel !== undefined) {
          headingStack.length = headingLevel - 1;
          headingStack[headingLevel - 1] = cleaned;
          const sectionPath = currentSectionPath();
          sectionPaths.add(sectionPath);
          blocks.push({ kind: "heading", headingLevel, sectionPath, text: cleaned });
        } else if (paragraphNumId !== undefined) {
          const levelKey = `${paragraphNumId}:${paragraphIlvl ?? "0"}`;
          const nextIndex = (listCounters.get(levelKey) ?? 0) + 1;
          listCounters.set(levelKey, nextIndex);
          const alreadyPrefixed = /^(?:\d+[.)]|[-•*])\s+/.test(cleaned);
          const formatted = alreadyPrefixed ? cleaned : `${nextIndex}. ${cleaned}`;
          const sectionPath = currentSectionPath();
          sectionPaths.add(sectionPath);
          blocks.push({ kind: "list_item", sectionPath, text: formatted });
        } else {
          const sectionPath = currentSectionPath();
          sectionPaths.add(sectionPath);
          blocks.push({ kind: "paragraph", sectionPath, text: cleaned });
        }
      }
      inParagraph = false;
      paragraphText = "";
      return;
    }
    if (tableDepth === 1 && tag.local === "tc") {
      currentRowCells.push(currentCellParagraphs.join(" "));
      currentCellParagraphs = [];
      inCell = false;
      return;
    }
    if (tableDepth === 1 && tag.local === "tr") {
      if (currentRowCells.length > 0) {
        currentTableRows.push(currentRowCells);
      }
      currentRowCells = [];
      return;
    }
    if (tag.local === "tbl") {
      if (tableDepth === 1) {
        const formatted = formatMarkdownTable(currentTableRows);
        if (formatted) {
          tableCount++;
          const sectionPath = currentSectionPath();
          sectionPaths.add(sectionPath);
          blocks.push({ kind: "table", sectionPath, text: formatted, rows: currentTableRows });
        }
        currentTableRows = [];
      }
      tableDepth = Math.max(0, tableDepth - 1);
    }
  });

  parser.write(documentXml).close();

  const rawText = blocks.map((block) => block.text).join("\n\n");
  const normalizedText = rawText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

  return {
    blocks,
    rawText,
    normalizedText,
    tableCount,
    sectionPaths: Array.from(sectionPaths),
  };
}

export async function extractDocxStructure(bytes: Buffer, signal?: AbortSignal): Promise<DocxExtractionResult> {
  signal?.throwIfAborted();
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) invalidDocx();

  const archive = await new Promise<ZipFile>((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false }, (error, opened) =>
      error || !opened ? reject(new IngestionStageError("DOCX_EXTRACTION_INVALID", false, 422)) : resolve(opened),
    );
  });

  let expandedBytes = 0;
  const seenNames = new Set<string>();
  let documentXml = "";
  let stylesXml = "";
  let settingsXml = "";
  const relsXmlEntries: string[] = [];

  try {
    if (archive.entryCount > documentBounds.maximumArchiveEntries) invalidDocx();
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new Error("DOCX extraction aborted."));
      signal?.addEventListener("abort", abort, { once: true });
      archive.once("error", () => reject(new IngestionStageError("DOCX_EXTRACTION_INVALID", false, 422)));
      archive.once("end", () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      });
      archive.on("entry", (entry: Entry) => {
        void (async () => {
          signal?.throwIfAborted();
          const name = entry.fileName;
          const canonicalName = name.toLowerCase();
          expandedBytes += entry.uncompressedSize;
          if (
            seenNames.has(canonicalName) ||
            seenNames.size >= documentBounds.maximumArchiveEntries ||
            name.split("/").includes("..") ||
            /[\\\u0000-\u001f]|^\/|^[a-z]:/i.test(name) ||
            entry.isEncrypted() ||
            !entry.canDecodeFileData() ||
            /vbaproject|activex|\.docm$/i.test(name) ||
            expandedBytes > documentBounds.maximumArchiveExpandedBytes ||
            (entry.uncompressedSize > 1_000_000 && entry.uncompressedSize > Math.max(1, entry.compressedSize) * 100)
          ) {
            invalidDocx();
          }
          seenNames.add(canonicalName);
          if (name === "word/document.xml") {
            documentXml = await readBoundedEntry(archive, entry, ingestionLimits.maxDocxXmlBytes, signal);
          } else if (name === "word/styles.xml") {
            stylesXml = await readBoundedEntry(archive, entry, ingestionLimits.maxDocxStylesXmlBytes, signal);
          } else if (canonicalName === "word/settings.xml") {
            settingsXml = await readBoundedEntry(archive, entry, documentBounds.maximumContainerXmlBytes, signal);
          } else if (canonicalName.endsWith(".rels")) {
            relsXmlEntries.push(await readBoundedEntry(archive, entry, documentBounds.maximumContainerXmlBytes, signal));
          }
          archive.readEntry();
        })().catch(reject);
      });
      archive.readEntry();
    });

    if (!documentXml) invalidDocx();
    for (const relsXml of relsXmlEntries) validateDocxRelationshipsXml(relsXml);
    if (settingsXml) validateDocxSettingsXml(settingsXml);
    const styleLevels = parseStyleHeadingLevels(stylesXml);
    return parseDocumentXml(documentXml, styleLevels);
  } finally {
    archive.close();
  }
}
