import { constants as fsConstants } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const FILE_MAX_BYTES = 20 * 1024 * 1024;
const FILE_TOTAL_TEXT_MAX_CHARS = 100_000;
const FILE_MAX_TRANSLATION_UNITS = 500;
const UNIT_MAX_CHARS = 1_500;
const OFFICE_ARCHIVE_MAX_BYTES = 200 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".txt", ".log", ".csv", ".md", ".markdown"]);
const OFFICE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx"]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function fail(code, message, exitCode = 7, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.exitCode = exitCode;
  throw error;
}

function decodeXmlText(value) {
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)))
    .replace(/&amp;/g, "&");
}

function encodeXmlText(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function appendUnits(units, text) {
  const characters = [...text];
  const indexes = [];
  let start = 0;
  while (start < characters.length) {
    let end = Math.min(start + UNIT_MAX_CHARS, characters.length);
    if (end < characters.length) {
      const lowerBound = start + Math.floor(UNIT_MAX_CHARS * 0.6);
      for (let index = end; index > lowerBound; index -= 1) {
        if (/[。！？.!?；;，,\s]/u.test(characters[index - 1] ?? "")) {
          end = index;
          break;
        }
      }
    }
    indexes.push(units.push({ text: characters.slice(start, end).join("") }) - 1);
    start = end;
  }
  return indexes;
}

function validateUnits(units) {
  if (!units.length) fail("FILE_TEXT_EMPTY", "文件中未提取到可翻译文本");
  if (units.length > FILE_MAX_TRANSLATION_UNITS) {
    fail("FILE_TOO_LARGE", `文件包含 ${units.length} 个翻译片段，最多支持 ${FILE_MAX_TRANSLATION_UNITS} 个，请分批处理`);
  }
  const total = units.reduce((sum, unit) => sum + [...unit.text].length, 0);
  if (total > FILE_TOTAL_TEXT_MAX_CHARS) {
    fail("FILE_TOO_LARGE", `文件可翻译文本超过 ${FILE_TOTAL_TEXT_MAX_CHARS} 字符，请分批处理`);
  }
}

function createTextDocument(filePath, source, extension) {
  const units = [];
  const ranges = [];
  const addRange = (start, end, text, csvQuoted = false, csvField = false) => {
    if (!text.trim()) return;
    ranges.push({ start, end, unitIndexes: appendUnits(units, text), ...(csvQuoted ? { csvQuoted } : {}), ...(csvField ? { csvField } : {}) });
  };
  if (extension === ".csv") {
    let cursor = 0;
    while (cursor < source.length) {
      if (source[cursor] === '"') {
        const start = cursor + 1;
        cursor += 1;
        while (cursor < source.length) {
          if (source[cursor] === '"' && source[cursor + 1] === '"') cursor += 2;
          else if (source[cursor] === '"') break;
          else cursor += 1;
        }
        addRange(start, cursor, source.slice(start, cursor).replace(/""/g, '"'), true, true);
        if (source[cursor] === '"') cursor += 1;
      } else if (source[cursor] === "," || source[cursor] === "\r" || source[cursor] === "\n") cursor += 1;
      else {
        const fieldStart = cursor;
        while (cursor < source.length && !/[\r\n,]/.test(source[cursor] ?? "")) cursor += 1;
        const raw = source.slice(fieldStart, cursor);
        const leading = raw.length - raw.trimStart().length;
        const text = raw.trim();
        addRange(fieldStart + leading, fieldStart + leading + text.length, text, false, true);
      }
    }
  }
  let inFence = false;
  let fence = "";
  for (const match of source.matchAll(/[^\r\n]+/g)) {
    if (extension === ".csv") break;
    const line = match[0];
    const trimmed = line.trim();
    if (extension === ".md" || extension === ".markdown") {
      const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
      if (fenceMatch) {
        if (!inFence) { inFence = true; fence = fenceMatch[1][0]; }
        else if (fenceMatch[1][0] === fence) { inFence = false; fence = ""; }
        continue;
      }
      if (inFence || /^(    |\t)/.test(line)) continue;
    }
    if (!trimmed) continue;
    const leading = line.length - line.trimStart().length;
    const prefix = extension === ".md" || extension === ".markdown"
      ? (line.slice(leading).match(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/)?.[0] ?? "")
      : "";
    const start = match.index + leading + prefix.length;
    const text = line.slice(leading + prefix.length).trimEnd();
    if (extension === ".md" || extension === ".markdown") {
      const protectedPattern = /`+[^`]*`+|https?:\/\/[^\s)\]]+|<[^>]+>|[*_~]+|[!\[\]()]/g;
      let contentStart = 0;
      let protectedMatch;
      while ((protectedMatch = protectedPattern.exec(text)) !== null) {
        addRange(start + contentStart, start + protectedMatch.index, text.slice(contentStart, protectedMatch.index));
        contentStart = protectedMatch.index + protectedMatch[0].length;
      }
      addRange(start + contentStart, start + text.length, text.slice(contentStart));
    } else addRange(start, start + text.length, text);
  }
  validateUnits(units);
  return {
    sourcePath: filePath, sourceExtension: extension, outputExtension: extension, units,
    render(translations) {
      let output = source;
      for (const range of [...ranges].reverse()) {
        const translated = range.unitIndexes.map((index) => translations[index] ?? "").join("");
        const escaped = translated.replace(/"/g, '""');
        const encoded = range.csvQuoted
          ? escaped
          : range.csvField && /[",\r\n]/.test(translated) ? `"${escaped}"` : translated;
        output = `${output.slice(0, range.start)}${encoded}${output.slice(range.end)}`;
      }
      return encoder.encode(output);
    },
  };
}

function xmlTextNodes(xml, textTag, offset) {
  const nodes = [];
  const pattern = new RegExp(`<${textTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${textTag}>`, "g");
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const content = match[1] ?? "";
    const contentOffset = match[0].indexOf(content);
    nodes.push({ start: offset + match.index + contentOffset, end: offset + match.index + contentOffset + content.length });
  }
  return nodes;
}

function collectRunGroups(xml, paragraphTag, runTag, propertiesTag, textTag, units) {
  const groups = [];
  const paragraphPattern = new RegExp(`<${paragraphTag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${paragraphTag}>`, "g");
  let paragraph;
  while ((paragraph = paragraphPattern.exec(xml)) !== null) {
    const runPattern = new RegExp(`<${runTag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${runTag}>`, "g");
    let run;
    let previousRunEnd = 0;
    let previousStyle = null;
    let current = null;
    const flush = () => {
      if (current?.text.trim()) groups.push({ unitIndexes: appendUnits(units, current.text), nodes: current.nodes });
      current = null;
    };
    while ((run = runPattern.exec(paragraph[0])) !== null) {
      const gap = paragraph[0].slice(previousRunEnd, run.index);
      if (/<\/?w:(?:hyperlink|fldSimple)\b/.test(gap)) { flush(); previousStyle = null; }
      previousRunEnd = run.index + run[0].length;
      const offset = paragraph.index + run.index;
      const nodes = xmlTextNodes(run[0], textTag, offset);
      const text = nodes.map((node) => decodeXmlText(xml.slice(node.start, node.end))).join("");
      if (!text.trim()) {
        if (/<w:(?:tab|br|instrText)\b/.test(run[0])) { flush(); previousStyle = null; }
        continue;
      }
      const style = run[0].match(new RegExp(`<${propertiesTag}(?:\\s[^>]*)?\\s*/>|<${propertiesTag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${propertiesTag}>`))?.[0] ?? "";
      if (current && style === previousStyle) { current.text += text; current.nodes.push(...nodes); }
      else { flush(); current = { text, nodes: [...nodes] }; previousStyle = style; }
    }
    flush();
  }
  return groups;
}

function collectContainerGroups(xml, containerTag, textTag, units) {
  const groups = [];
  const pattern = new RegExp(`<${containerTag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${containerTag}>`, "g");
  let container;
  while ((container = pattern.exec(xml)) !== null) {
    const nodes = xmlTextNodes(container[0], textTag, container.index);
    const text = nodes.map((node) => decodeXmlText(xml.slice(node.start, node.end))).join("");
    if (text.trim()) groups.push({ unitIndexes: appendUnits(units, text), nodes });
  }
  return groups;
}

function replaceXmlGroups(xml, groups, translations) {
  const replacements = [];
  for (const group of groups) {
    group.nodes.forEach((node, index) => replacements.push({
      ...node,
      text: index === 0
        ? encodeXmlText(group.unitIndexes.map((unitIndex) => translations[unitIndex] ?? "").join(""))
        : "",
    }));
  }
  let output = xml;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`;
  }
  return output;
}

async function loadFflate(skillDirectory) {
  return import("fflate").catch(() => fail(
    "FILE_DEPENDENCY_MISSING",
    `缺少文件依赖，请运行：npm ci --omit=dev --prefix "${skillDirectory}"`,
  ));
}

async function createOfficeDocument(filePath, extension, skillDirectory) {
  const { strToU8, unzipSync, zipSync } = await loadFflate(skillDirectory);
  let files;
  try {
    const source = await readFile(filePath);
    let unpackedBytes = 0;
    files = unzipSync(new Uint8Array(source.buffer, source.byteOffset, source.byteLength), {
      filter(entry) {
        unpackedBytes += entry.originalSize;
        if (unpackedBytes > OFFICE_ARCHIVE_MAX_BYTES) fail("FILE_TOO_LARGE", "Office 文档解压后超过 200MB");
        return true;
      },
    });
  } catch (error) {
    if (error?.code) throw error;
    fail("FILE_READ_ERROR", "Office 文件不是有效的 Open XML 文档", 7, error);
  }
  const units = [];
  const parts = [];
  const names = Object.keys(files).filter((name) => {
    if (extension === ".docx") return /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/.test(name);
    if (extension === ".xlsx") return name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(name);
    return /^ppt\/slides\/slide\d+\.xml$/.test(name);
  });
  for (const name of names) {
    let xml;
    try { xml = decoder.decode(files[name]); }
    catch (error) { fail("FILE_READ_ERROR", `Office XML 编码无效：${name}`, 7, error); }
    const groups = extension === ".docx"
      ? collectRunGroups(xml, "w:p", "w:r", "w:rPr", "w:t", units)
      : extension === ".pptx"
        ? collectRunGroups(xml, "a:p", "a:r", "a:rPr", "a:t", units)
        : collectContainerGroups(xml, name === "xl/sharedStrings.xml" ? "si" : "is", "t", units);
    if (groups.length) parts.push({ name, xml, groups });
  }
  validateUnits(units);
  return {
    sourcePath: filePath, sourceExtension: extension, outputExtension: extension, units,
    render(translations) {
      const outputFiles = { ...files };
      for (const part of parts) outputFiles[part.name] = strToU8(replaceXmlGroups(part.xml, part.groups, translations));
      return zipSync(outputFiles, { level: 6 });
    },
  };
}

function docxParagraph(text) {
  return `<w:p><w:r><w:t xml:space="preserve">${encodeXmlText(text)}</w:t></w:r></w:p>`;
}

async function createDocx(pages, skillDirectory) {
  const { strToU8, zipSync } = await loadFflate(skillDirectory);
  const body = pages.map((paragraphs, pageIndex) => {
    const content = paragraphs.map(docxParagraph).join("");
    return pageIndex === pages.length - 1 ? content : `${content}<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
  }).join("");
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const relationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(relationships),
    "word/document.xml": strToU8(document),
  }, { level: 6 });
}

async function createPdfDocument(filePath, skillDirectory) {
  const unpdf = await import("unpdf").catch(() => fail(
    "FILE_DEPENDENCY_MISSING",
    `缺少文件依赖，请运行：npm ci --omit=dev --prefix "${skillDirectory}"`,
  ));
  let pages;
  try {
    const source = await readFile(filePath);
    const pdf = await unpdf.getDocumentProxy(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
    pages = (await unpdf.extractText(pdf, { mergePages: false })).text.map((page) => page.trim());
  } catch (error) {
    fail("FILE_READ_ERROR", `PDF 解析失败：${error.message}`, 7, error);
  }
  const units = [];
  const pageIndexes = pages.map((page) => page.split(/\n\s*\n|\n/)
    .map((paragraph) => paragraph.trim()).filter(Boolean)
    .map((paragraph) => appendUnits(units, paragraph)));
  validateUnits(units);
  return {
    sourcePath: filePath, sourceExtension: ".pdf", outputExtension: ".docx", units,
    render(translations) {
      return createDocx(pageIndexes.map((page) => page.map((indexes) =>
        indexes.map((index) => translations[index] ?? "").join(""))), skillDirectory);
    },
  };
}

export async function prepareFileTranslation(filePath, skillDirectory) {
  filePath = path.resolve(filePath);
  let fileStat;
  try { fileStat = await stat(filePath); }
  catch (error) { fail("FILE_READ_ERROR", `无法读取文件：${filePath}`, 7, error); }
  if (!fileStat.isFile()) fail("FILE_READ_ERROR", `路径不是文件：${filePath}`);
  if (fileStat.size > FILE_MAX_BYTES) fail("FILE_TOO_LARGE", "文件超过 20MB，请压缩或分批处理");
  const extension = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) {
    let source;
    try { source = decoder.decode(await readFile(filePath)).replace(/^\uFEFF/, ""); }
    catch (error) { fail("FILE_READ_ERROR", `文件不是有效的 UTF-8 文本：${filePath}`, 7, error); }
    return createTextDocument(filePath, source, extension);
  }
  if (OFFICE_EXTENSIONS.has(extension)) return createOfficeDocument(filePath, extension, skillDirectory);
  if (extension === ".pdf") return createPdfDocument(filePath, skillDirectory);
  fail("FILE_FORMAT_UNSUPPORTED", `不支持的文件格式：${extension || "无扩展名"}`);
}

export function translatedText(_prepared, translations) {
  return translations.join("\n");
}

export async function writeTranslatedFile(prepared, translations, targetLang, requestedPath) {
  const expectedExtension = prepared.outputExtension;
  let outputPath = requestedPath ? path.resolve(requestedPath) : "";
  if (requestedPath && path.extname(outputPath).toLowerCase() !== expectedExtension) {
    fail("INVALID_ARGUMENT", `输出文件必须使用 ${expectedExtension} 扩展名`, 2);
  }
  if (!outputPath) {
    const parsed = path.parse(prepared.sourcePath);
    const language = targetLang.replace(/[^a-z0-9-]/gi, "_").toUpperCase();
    for (let suffix = 0; suffix < 1000; suffix += 1) {
      const index = suffix ? `.${suffix}` : "";
      const candidate = path.join(parsed.dir, `${parsed.name}_${language}${index}${expectedExtension}`);
      try { await access(candidate, fsConstants.F_OK); }
      catch { outputPath = candidate; break; }
    }
  }
  try {
    const rendered = await prepared.render(translations);
    await writeFile(outputPath, rendered, { flag: "wx" });
    return { outputPath, fallback: false };
  } catch (error) {
    if (error?.code) return { outputPath: null, fallback: true };
    fail("FILE_WRITE_ERROR", `无法写入译文文件：${outputPath}`, 7, error);
  }
}
