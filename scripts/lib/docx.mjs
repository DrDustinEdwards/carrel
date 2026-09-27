// Reads a Word document (.docx) into paragraphs of runs, keeping what a manuscript needs (headings,
// italics, bold, alignment, line breaks) and recording everything else it meets as a flag instead of
// guessing at it. Web APIs only (DecompressionStream, TextDecoder), so the same code runs in Node for
// the importer and in workerd for the tests.

/**
 * @typedef {{ text: string, italic: boolean, bold: boolean }} Run
 * @typedef {{ runs: Run[], style: string, center: boolean, lineBreaks: number, pageBreak: boolean }} Paragraph
 * @typedef {{ paragraph: number, what: string, detail: string }} DocFlag  paragraph: the paragraph it belongs to, or the next one when it sits between paragraphs
 */

// ---------- the ZIP container

/**
 * @param {Uint8Array} bytes
 * @param {number} at
 */
function u16(bytes, at) {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

/**
 * @param {Uint8Array} bytes
 * @param {number} at
 */
function u32(bytes, at) {
  return (u16(bytes, at) | (u16(bytes, at + 2) << 16)) >>> 0;
}

/** @param {Uint8Array} data */
async function inflateRaw(data) {
  // A copy, so the Blob gets an ArrayBuffer-backed view rather than a window into the archive.
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The files in a ZIP archive, by name. Stored and deflated entries only, which is what Word and
 * Google Docs write; anything else is refused rather than read wrongly.
 * @param {Uint8Array} bytes
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function readZip(bytes) {
  // The end-of-central-directory record sits in the last 22 bytes plus any archive comment.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("This is not a ZIP archive, so it is not a .docx file.");
  const count = u16(bytes, eocd + 10);
  let at = u32(bytes, eocd + 16);
  if (at === 0xffffffff || count === 0xffff) throw new Error("This archive uses ZIP64, which the importer does not read.");

  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (u32(bytes, at) !== 0x02014b50) throw new Error("The archive's central directory is damaged.");
    const method = u16(bytes, at + 10);
    const size = u32(bytes, at + 20);
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const local = u32(bytes, at + 42);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;

    if (u32(bytes, local) !== 0x04034b50) throw new Error(`The archive entry ${name} is damaged.`);
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    const data = bytes.subarray(start, start + size);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, await inflateRaw(data));
    else throw new Error(`The archive entry ${name} uses compression method ${method}, which the importer does not read.`);
  }
  return files;
}

// ---------- WordprocessingML

/** @param {string} s */
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
    const lower = e.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    return String.fromCodePoint(lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10));
  });
}

/**
 * @param {string} attrs
 * @param {string} name
 */
function attr(attrs, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? decodeEntities(m[1] ?? "") : null;
}

/** `<w:i/>` or `<w:i w:val="1"/>` is on; `w:val="0"` or `"false"` or `"none"` is off. */
function isOn(/** @type {string} */ attrs) {
  const val = attr(attrs, "w:val");
  return val === null || !["0", "false", "off", "none"].includes(val.toLowerCase());
}

/** Paragraph styles Word and Google Docs name for headings, in either spelling. */
const HEADING = /^(?:heading\s?(\d)|title|subtitle)$/i;

/**
 * Character styles that mean emphasis. Anything else named on a run is flagged, since its look is
 * defined in styles.xml and may be italic or not.
 */
const EMPHASIS_STYLES = new Set(["emphasis", "subtleemphasis", "intenseemphasis"]);
const STRONG_STYLES = new Set(["strong"]);

/** Elements whose content is not the manuscript's text, with the flag each one earns. */
const UNSUPPORTED = /** @type {Record<string, [string, string]>} */ ({
  "w:tbl": ["table", "A table was not converted."],
  "w:drawing": ["image", "An image or drawing was not converted."],
  "w:pict": ["image", "An image or drawing was not converted."],
  "w:object": ["object", "An embedded object was not converted."],
  "w:txbxContent": ["text-box", "A text box was not converted."],
  "w:footnoteReference": ["footnote", "A footnote was not converted; its text is in the Word file."],
  "w:endnoteReference": ["endnote", "An endnote was not converted; its text is in the Word file."],
  "w:commentReference": ["comment", "A comment in the Word file was left out."],
  "w:sdt": ["content-control", "A content control was not converted."],
});

/**
 * The document's paragraphs, each a list of runs with italic and bold, plus flags for what could not
 * be converted. Tracked changes are read as Word's final view (insertions kept, deletions dropped)
 * and flagged, since the file was not finished.
 * @param {string} xml word/document.xml
 * @returns {{ paragraphs: Paragraph[], flags: DocFlag[] }}
 */
export function readDocumentXml(xml) {
  /** @type {Paragraph[]} */
  const paragraphs = [];
  /** @type {DocFlag[]} */
  const flags = [];
  /** @type {Paragraph | null} */
  let para = null;
  let inRunProps = false;
  let inParaProps = false;
  let runItalic = false;
  let runBold = false;
  let inText = false;
  let skipDepth = 0; // inside an unsupported element or a deletion
  let fieldDepth = 0; // inside a field's instruction text
  const seenFlags = new Set();

  /**
   * @param {string} what
   * @param {string} detail
   */
  const flag = (what, detail) => {
    const key = `${paragraphs.length}:${what}:${detail}`;
    if (seenFlags.has(key)) return;
    seenFlags.add(key);
    flags.push({ paragraph: paragraphs.length, what, detail });
  };

  /** @param {string} text */
  const addText = (text) => {
    if (!para || skipDepth > 0 || fieldDepth > 0 || text === "") return;
    const last = para.runs.at(-1);
    if (last && last.italic === runItalic && last.bold === runBold) last.text += text;
    else para.runs.push({ text, italic: runItalic, bold: runBold });
  };

  const TOKEN = /<(\/?)([\w:]+)([^>]*?)(\/?)>|([^<]+)/g;
  for (const m of xml.matchAll(TOKEN)) {
    const [, closing, name = "", attrs = "", selfClosing, text] = m;
    if (text !== undefined) {
      if (inText) addText(decodeEntities(text));
      continue;
    }
    if (name.startsWith("?") || name.startsWith("!")) continue;

    // Unsupported content: flagged once, then skipped to its end.
    if (Object.hasOwn(UNSUPPORTED, name) || name === "w:del" || name === "w:moveFrom") {
      if (!closing) {
        if (name === "w:del" || name === "w:moveFrom") flag("tracked-change", "A tracked deletion was dropped, as Word's final view shows it.");
        else {
          const [what, detail] = UNSUPPORTED[name] ?? ["", ""];
          flag(what, detail);
        }
        if (!selfClosing) skipDepth++;
      } else {
        skipDepth = Math.max(0, skipDepth - 1);
      }
      continue;
    }
    if (skipDepth > 0) continue;

    switch (name) {
      case "w:p":
        if (!closing) {
          para = { runs: [], style: "", center: false, lineBreaks: 0, pageBreak: false };
          if (selfClosing) {
            paragraphs.push(para);
            para = null;
          }
        } else if (para) {
          paragraphs.push(para);
          para = null;
        }
        break;
      case "w:pPr":
        inParaProps = !closing && !selfClosing;
        break;
      case "w:pStyle":
        if (para && inParaProps) para.style = attr(attrs, "w:val") ?? "";
        break;
      case "w:jc":
        if (para && inParaProps) para.center = attr(attrs, "w:val") === "center";
        break;
      case "w:numPr":
        if (inParaProps) flag("list", "A list item was converted as a plain paragraph.");
        break;
      case "w:r":
        if (!closing) {
          runItalic = false;
          runBold = false;
        }
        break;
      case "w:rPr":
        // Paragraph-mark properties (inside w:pPr) describe the pilcrow, not any text.
        inRunProps = !closing && !selfClosing && !inParaProps;
        break;
      case "w:i":
        if (inRunProps) runItalic = isOn(attrs);
        break;
      case "w:b":
        if (inRunProps) runBold = isOn(attrs);
        break;
      case "w:rStyle":
        if (inRunProps) {
          const style = (attr(attrs, "w:val") ?? "").toLowerCase();
          if (EMPHASIS_STYLES.has(style)) runItalic = true;
          else if (STRONG_STYLES.has(style)) runBold = true;
          else flag("character-style", `A run uses the character style "${attr(attrs, "w:val")}", whose look was not read; check it.`);
        }
        break;
      case "w:u":
        if (inRunProps && isOn(attrs) && attr(attrs, "w:val") !== "none") flag("underline", "Underlined text was converted without the underline.");
        break;
      case "w:strike":
      case "w:dstrike":
        if (inRunProps && isOn(attrs)) flag("strikethrough", "Struck-through text was kept as plain text; decide whether it belongs.");
        break;
      case "w:vertAlign":
        if (inRunProps && attr(attrs, "w:val") !== "baseline") flag("superscript", "Superscript or subscript text was converted as plain text.");
        break;
      case "w:t":
        inText = !closing && !selfClosing;
        break;
      case "w:tab":
        if (!inParaProps) addText("\t");
        break;
      case "w:br":
        if (para) {
          const type = attr(attrs, "w:type");
          if (type === "page" || type === "column") para.pageBreak = true;
          else {
            para.lineBreaks++;
            addText("\n");
          }
        }
        break;
      case "w:cr":
        if (para) {
          para.lineBreaks++;
          addText("\n");
        }
        break;
      case "w:noBreakHyphen":
        addText("-");
        break;
      case "w:softHyphen":
        break;
      case "w:sym":
        flag("symbol", `A symbol from the font "${attr(attrs, "w:font")}" was left out.`);
        break;
      case "w:ins":
      case "w:moveTo":
        if (!closing) flag("tracked-change", "A tracked insertion was kept, as Word's final view shows it.");
        break;
      case "w:fldChar":
        if (attr(attrs, "w:fldCharType") === "begin") fieldDepth++;
        else if (attr(attrs, "w:fldCharType") === "separate") fieldDepth = Math.max(0, fieldDepth - 1);
        break;
      case "w:instrText":
        if (!closing) flag("field", "A field (such as a page number or cross-reference) was converted as its displayed text.");
        break;
      case "w:fldSimple":
        if (!closing) flag("field", "A field (such as a page number or cross-reference) was converted as its displayed text.");
        break;
      default:
        break;
    }
  }
  return { paragraphs, flags };
}

/**
 * @param {Paragraph} p
 * @returns {{ level: number, kind: "title" | "subtitle" | "heading" } | null}
 */
export function headingOf(p) {
  const m = HEADING.exec(p.style.replace(/[-_ ]/g, ""));
  if (!m) return null;
  if (/^title$/i.test(p.style)) return { level: 0, kind: "title" };
  if (/^subtitle$/i.test(p.style)) return { level: 0, kind: "subtitle" };
  return { level: Number(m[1]), kind: "heading" };
}

/**
 * Reads a .docx file's bytes.
 * @param {Uint8Array} bytes
 */
export async function readDocx(bytes) {
  const files = await readZip(bytes);
  const document = files.get("word/document.xml");
  if (!document) throw new Error("The archive has no word/document.xml, so it is not a Word document.");
  return readDocumentXml(new TextDecoder().decode(document));
}
