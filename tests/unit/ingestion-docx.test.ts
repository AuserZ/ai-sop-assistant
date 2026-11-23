import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractDocxStructure } from "../../src/server/ingestion/docx";

function zip(entries: Array<{ name: string; body: string; encrypted?: boolean; inflatedSize?: number; deflate?: boolean }>) {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const plain = Buffer.from(entry.body);
    const data = entry.deflate ? deflateRawSync(plain) : plain;
    const local = Buffer.alloc(30);
    const central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.encrypted ? 1 : 0, 6);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(plain), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.inflatedSize ?? plain.length, 22);
    local.writeUInt16LE(name.length, 26);

    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.encrypted ? 1 : 0, 8);
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(plain), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(entry.inflatedSize ?? plain.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, data);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

const baseEntries = (documentXml: string, stylesXml?: string) => [
  {
    name: "[Content_Types].xml",
    body: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  },
  {
    name: "_rels/.rels",
    body: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  },
  ...(stylesXml ? [{ name: "word/styles.xml", body: stylesXml }] : []),
  { name: "word/document.xml", body: documentXml },
];

describe("D3/ADR21 DOCX structured extraction fidelity and archive hardening", () => {
  it("preserves heading hierarchy, numbered procedures, literal tables, numbers and units without paraphrasing", async () => {
    const stylesXml = `
      <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:style w:type="paragraph" w:styleId="CustomH1"><w:name w:val="heading 1"/></w:style>
        <w:style w:type="paragraph" w:styleId="CustomH2"><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
      </w:styles>
    `;
    const documentXml = `
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:pPr><w:pStyle w:val="CustomH1"/></w:pPr><w:r><w:t>1. Sterilization Procedure</w:t></w:r></w:p>
          <w:p><w:pPr><w:pStyle w:val="CustomH2"/></w:pPr><w:r><w:t>1.1 Autoclave Parameters</w:t></w:r></w:p>
          <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Set chamber temperature to 121.5 C.</w:t></w:r></w:p>
          <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Hold pressure at 2.05 bar for 15 minutes.</w:t></w:r></w:p>
          <w:tbl>
            <w:tr><w:trPr><w:tblHeader/></w:trPr>
              <w:tc><w:p><w:r><w:t>Stage</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>Limit</w:t></w:r></w:p></w:tc>
            </w:tr>
            <w:tr>
              <w:tc><w:p><w:r><w:t>Dry Cycle</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>10 min @ 0.15 MPa</w:t></w:r></w:p></w:tc>
            </w:tr>
          </w:tbl>
        </w:body>
      </w:document>
    `;

    const result = await extractDocxStructure(zip(baseEntries(documentXml, stylesXml)));
    expect(result.tableCount).toBe(1);
    expect(result.blocks.map((block) => block.kind)).toEqual(["heading", "heading", "list_item", "list_item", "table"]);
    expect(result.blocks[2]).toMatchObject({
      sectionPath: "1. Sterilization Procedure > 1.1 Autoclave Parameters",
      text: "1. Set chamber temperature to 121.5 C.",
    });
    expect(result.blocks[3]).toMatchObject({
      sectionPath: "1. Sterilization Procedure > 1.1 Autoclave Parameters",
      text: "2. Hold pressure at 2.05 bar for 15 minutes.",
    });
    expect(result.blocks[4].text).toBe("| Stage | Limit |\n| --- | --- |\n| Dry Cycle | 10 min @ 0.15 MPa |");
    expect(result.normalizedText).toContain("121.5 C");
    expect(result.normalizedText).toContain("2.05 bar");
    expect(result.normalizedText).toContain("0.15 MPa");
  });

  it("rejects DOCTYPE declarations, traversal entries, encrypted files, macro containers and zip bombs", async () => {
    const validDoc = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Safe</w:t></w:r></w:p></w:body></w:document>';
    const hostile = [
      zip(baseEntries(`<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${validDoc}`)),
      zip([...baseEntries(validDoc), { name: "../escape.xml", body: "x" }]),
      zip([...baseEntries(validDoc), { name: "secret.bin", body: "x", encrypted: true }]),
      zip([...baseEntries(validDoc), { name: "word/vbaProject.bin", body: "macro" }]),
      zip(baseEntries("x".repeat(4_000_001))),
      Buffer.from("not a zip archive"),
    ];
    for (const payload of hostile) {
      await expect(extractDocxStructure(payload)).rejects.toMatchObject({ code: "DOCX_EXTRACTION_INVALID", transient: false });
    }
  });

  it("R-S05b-1 rejects external OOXML images, subDocuments and settings templates while allowing https hyperlinks", async () => {
    const validDoc = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Safe SOP body</w:t></w:r></w:p></w:body></w:document>';
    const externalImage = zip([
      ...baseEntries(validDoc),
      {
        name: "word/_rels/document.xml.rels",
        body: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://app:3000/api/health/ready" TargetMode="External"/></Relationships>',
      },
    ]);
    const externalSubDoc = zip([
      ...baseEntries(validDoc),
      {
        name: "word/_rels/document.xml.rels",
        body: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/subDocument" Target="file:///etc/passwd" TargetMode="External"/></Relationships>',
      },
    ]);
    const attachedTemplate = zip([
      ...baseEntries(validDoc),
      {
        name: "word/settings.xml",
        body: '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:attachedTemplate w:id="rId1"/></w:settings>',
      },
    ]);
    const validHyperlink = zip([
      ...baseEntries(validDoc),
      {
        name: "word/_rels/document.xml.rels",
        body: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/reference" TargetMode="External"/></Relationships>',
      },
    ]);

    for (const payload of [externalImage, externalSubDoc, attachedTemplate]) {
      await expect(extractDocxStructure(payload)).rejects.toMatchObject({ code: "DOCX_EXTRACTION_INVALID", transient: false });
    }
    const extracted = await extractDocxStructure(validHyperlink);
    expect(extracted.normalizedText).toBe("Safe SOP body");
  });
});
