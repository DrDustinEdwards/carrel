// The importer's test documents, written here as WordprocessingML and zipped into real .docx files,
// in the shape Google Docs exports (Title and Heading1 paragraph styles, w:i w:val="1" on runs).
// TEST_MANUSCRIPT is the short test document Dustin chose over the real manuscript: two chapters, one
// scene break, italics and bold. PROBLEMS holds what the importer must flag rather than guess at.

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** @param {string} s */
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A run. Google Docs writes w:rtl and a w:val on every toggle, which the reader must cope with.
 * @param {string} text
 * @param {{ i?: boolean, b?: boolean }} [f]
 */
export const r = (text, f = {}) =>
  `<w:r><w:rPr><w:rtl w:val="0"/>${f.i ? '<w:i w:val="1"/>' : ""}${f.b ? '<w:b w:val="1"/>' : ""}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

/**
 * A paragraph.
 * @param {string} runs
 * @param {{ style?: string, center?: boolean }} [o]
 */
export const p = (runs, o = {}) =>
  `<w:p><w:pPr>${o.style ? `<w:pStyle w:val="${o.style}"/>` : ""}${o.center ? '<w:jc w:val="center"/>' : ""}<w:rPr><w:i w:val="1"/></w:rPr></w:pPr>${runs}</w:p>`;

/** @param {string} body */
export const documentXml = (body) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`;

export const TEST_MANUSCRIPT = documentXml(
  [
    p(r("The Crossing (a test manuscript)"), { style: "Title" }),
    p(r("Arrival"), { style: "Heading1" }),
    p(r("The truck quit a mile past the ") + r("low-water", { i: true }) + r(" crossing. I let it roll to the shoulder.")),
    p(r("I walked the rest of the way. The river was ") + r("loud", { b: true }) + r(", and the cedar smelled like pencil shavings.")),
    p(r("* * *"), { center: true }),
    p(r("At the gate there was a new lock, brass, and it was shut.")),
    p(r("The Letters"), { style: "Heading1" }),
    p(r("Wade set the envelope on the table. ") + r("It's got your name on it, ", { i: true }) + r("he said.")),
    p(r("I did not open it. Not that night.")),
  ].join(""),
);

export const PROBLEMS = documentXml(
  [
    p(r("A note before the story, 3 * 4 = 12.")),
    p(r("One"), { style: "Heading 1" }),
    p(r("Plain ") + '<w:r><w:rPr><w:i w:val="0"/></w:rPr><w:t>not italic</w:t></w:r>' + r(" and ") + '<w:r><w:rPr><w:rStyle w:val="Emphasis"/></w:rPr><w:t>styled</w:t></w:r>' + r(".")),
    p(r("A table follows.")),
    `<w:tbl><w:tr><w:tc>${p(r("cell text"))}</w:tc></w:tr></w:tbl>`,
    p(r("An image: ") + '<w:r><w:drawing><wp:inline xmlns:wp="x"/></w:drawing></w:r>' + r(" and a note") + '<w:r><w:footnoteReference w:id="1"/></w:r>' + r(".")),
    p(r("Kept ") + `<w:ins w:id="1" w:author="x"><w:r><w:t>inserted</w:t></w:r></w:ins>` + `<w:del w:id="2" w:author="x"><w:r><w:delText>deleted</w:delText></w:r></w:del>` + r(" text.")),
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${r("a list item")}</w:p>`,
    p(r("Line one") + "<w:r><w:br/></w:r>" + r("line two")),
    p(""),
    p(""),
    p(r("After blank lines.")),
    p(r("A part"), { style: "Heading2" }),
    p(r("# not a heading, *not* emphasis_either")),
    p(r("Centered words."), { center: true }),
    p(r("Page") + '<w:r><w:br w:type="page"/></w:r>'),
    p(r("Smart “quotes” stay, and so does café.")),
  ].join(""),
);

const PARTS = {
  "[Content_Types].xml":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
  "_rels/.rels":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  "word/_rels/document.xml.rels":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  "word/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="52"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>`,
};

// ---------- a ZIP writer, enough for these files (stored or deflated, CRC-32 as Word requires)

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** @param {Uint8Array} bytes */
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {Uint8Array} data */
async function deflateRaw(data) {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {Record<string, string>} files
 * @param {{ deflate?: boolean }} [opts]
 */
export async function zip(files, opts = {}) {
  /** @type {number[]} */
  const out = [];
  /** @type {number[]} */
  const central = [];
  const u16 = (/** @type {number[]} */ a, /** @type {number} */ n) => a.push(n & 0xff, (n >>> 8) & 0xff);
  const u32 = (/** @type {number[]} */ a, /** @type {number} */ n) => a.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  let count = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = new TextEncoder().encode(name);
    const raw = new TextEncoder().encode(text);
    const method = opts.deflate ? 8 : 0;
    const data = method === 8 ? await deflateRaw(raw) : raw;
    const offset = out.length;
    const header = (/** @type {number[]} */ a, /** @type {boolean} */ isCentral) => {
      u32(a, isCentral ? 0x02014b50 : 0x04034b50);
      if (isCentral) u16(a, 20);
      u16(a, 20);
      u16(a, 0x0800); // UTF-8 names
      u16(a, method);
      u16(a, 0);
      u16(a, 0x21); // 1980-01-01
      u32(a, crc32(raw));
      u32(a, data.length);
      u32(a, raw.length);
      u16(a, nameBytes.length);
      u16(a, 0);
      if (isCentral) {
        u16(a, 0);
        u16(a, 0);
        u16(a, 0);
        u32(a, 0);
        u32(a, offset);
      }
      a.push(...nameBytes);
    };
    header(out, false);
    for (const b of data) out.push(b);
    header(central, true);
    count++;
  }
  const centralOffset = out.length;
  out.push(...central);
  u32(out, 0x06054b50);
  u16(out, 0);
  u16(out, 0);
  u16(out, count);
  u16(out, count);
  u32(out, central.length);
  u32(out, centralOffset);
  u16(out, 0);
  return new Uint8Array(out);
}

/**
 * @param {string} document
 * @param {{ deflate?: boolean }} [opts]
 */
export function docx(document, opts = { deflate: true }) {
  return zip({ ...PARTS, "word/document.xml": document }, opts);
}
