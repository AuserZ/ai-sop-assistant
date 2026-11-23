import { crc32, deflateSync } from "node:zlib";

export function syntheticPdf(targetBytes?: number) {
  const base = renderSyntheticPdf(0);
  if (targetBytes === undefined) return base;
  if (!Number.isSafeInteger(targetBytes) || targetBytes < base.length || targetBytes > 20_000_000) throw new RangeError("Invalid synthetic PDF size.");
  let padding = targetBytes - base.length;
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = renderSyntheticPdf(padding);
    if (result.length === targetBytes) return result;
    padding += targetBytes - result.length;
  }
  throw new Error("Synthetic PDF size did not converge.");
}

function renderSyntheticPdf(paddingBytes: number) {
  const content = `BT /F1 12 Tf 72 720 Td (Synthetic SOP upload fixture) Tj 0 -20 Td (Test-only document.) Tj ET\n${" ".repeat(paddingBytes)}`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
  ];
  let source = "%PDF-1.7\n";
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(source);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const crossReferenceOffset = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${crossReferenceOffset}\n%%EOF\n`;
  return Buffer.from(source);
}

export function syntheticDocx() {
  return buildZip([
    { name: "[Content_Types].xml", body: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: "_rels/.rels", body: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: "word/document.xml", body: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic SOP upload fixture</w:t></w:r></w:p></w:body></w:document>' },
  ]);
}

export function syntheticRichDocx() {
  return buildZip([
    { name: "[Content_Types].xml", body: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: "_rels/.rels", body: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    {
      name: "word/document.xml",
      body: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Section 1 Valve Calibration</w:t></w:r></w:p>
        <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Set line regulator V-14 to 2.75 bar.</w:t></w:r></w:p>
        <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Hold pressure for 15 minutes at 75 C.</w:t></w:r></w:p>
        <w:tbl>
          <w:tr><w:trPr><w:tblHeader/></w:trPr>
            <w:tc><w:p><w:r><w:t>Parameter</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>Target Limit</w:t></w:r></w:p></w:tc>
          </w:tr>
          <w:tr>
            <w:tc><w:p><w:r><w:t>Pressure</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>2.75 bar</w:t></w:r></w:p></w:tc>
          </w:tr>
          <w:tr>
            <w:tc><w:p><w:r><w:t>Hold Time</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>15 minutes</w:t></w:r></w:p></w:tc>
          </w:tr>
        </w:tbl>
      </w:body></w:document>`,
    },
  ]);
}

function buildZip(entries: Array<{ name: string; body: string }>) {
  const parts: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), body = Buffer.from(entry.body);
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc32(body), 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(body), 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    parts.push(local, name, body); directory.push(central, name); offset += local.length + name.length + body.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}

const bitmapFont5x7: Record<string, string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  "I": ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
};

export function syntheticScannedPdf() {
  const width = 960;
  const height = 380;
  const scale = 5;
  const pixels = Buffer.alloc(width * height, 255);
  const lines = ["SYNTHETIC SOP TEST", "PRESSURE 2.5 BAR", "WAIT 10 MINUTES", "TEMPERATURE 75 C"];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const originY = 36 + lineIndex * 84;
    let originX = 44;
    for (const character of line) {
      const glyph = bitmapFont5x7[character] ?? bitmapFont5x7[" "];
      for (let row = 0; row < glyph.length; row++) {
        for (let col = 0; col < glyph[row].length; col++) {
          if (glyph[row][col] !== "1") continue;
          for (let dy = 0; dy < scale; dy++) {
            const py = originY + row * scale + dy;
            if (py < 0 || py >= height) continue;
            for (let dx = 0; dx < scale; dx++) {
              const px = originX + col * scale + dx;
              if (px >= 0 && px < width) pixels[py * width + px] = 0;
            }
          }
        }
      }
      originX += 5 * scale + 10;
    }
  }

  const compressedImage = deflateSync(pixels);
  const contentStream = Buffer.from("q 540 0 0 213.75 36 530 cm /Im0 Do Q\n", "ascii");
  const chunks: Buffer[] = [Buffer.from("%PDF-1.7\n%\xff\xff\xff\xff\n", "binary")];
  const offsets: number[] = [];
  let length = chunks[0].length;
  const appendObject = (id: number, body: Buffer) => {
    offsets.push(length);
    const header = Buffer.from(`${id} 0 obj\n`, "ascii");
    const footer = Buffer.from("\nendobj\n", "ascii");
    chunks.push(header, body, footer);
    length += header.length + body.length + footer.length;
  };

  appendObject(1, Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii"));
  appendObject(2, Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "ascii"));
  appendObject(3, Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>", "ascii"));
  appendObject(4, Buffer.concat([
    Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressedImage.length} >>\nstream\n`, "ascii"),
    compressedImage,
    Buffer.from("\nendstream", "ascii"),
  ]));
  appendObject(5, Buffer.concat([
    Buffer.from(`<< /Length ${contentStream.length} >>\nstream\n`, "ascii"),
    contentStream,
    Buffer.from("endstream", "ascii"),
  ]));

  const xrefOffset = length;
  let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, "ascii"));
  return Buffer.concat(chunks);
}
