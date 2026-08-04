from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
import html
from pathlib import Path
import re
from typing import Callable, NoReturn
from zipfile import BadZipFile, ZIP_DEFLATED, ZipFile, ZipInfo


FILE_MAX_BYTES = 20 * 1024 * 1024
FILE_TOTAL_TEXT_MAX_CHARS = 100_000
FILE_MAX_TRANSLATION_UNITS = 500
UNIT_MAX_CHARS = 1_500
OFFICE_ARCHIVE_MAX_BYTES = 200 * 1024 * 1024
PDFPLUMBER_VERSION = "0.11.10"
TEXT_EXTENSIONS = {".txt", ".log", ".csv", ".md", ".markdown"}
OFFICE_EXTENSIONS = {".docx", ".xlsx", ".pptx"}


class FileDocumentError(Exception):
    def __init__(self, code: str, message: str, exit_code: int = 7) -> None:
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


def fail(code: str, message: str, exit_code: int = 7) -> NoReturn:
    raise FileDocumentError(code, message, exit_code)


@dataclass
class PreparedFile:
    source_path: Path
    source_extension: str
    output_extension: str
    units: list[str]
    render: Callable[[list[str]], bytes]


def decode_xml_text(value: str) -> str:
    return html.unescape(value)


def encode_xml_text(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def append_units(units: list[str], text: str) -> list[int]:
    indexes: list[int] = []
    start = 0
    while start < len(text):
        end = min(start + UNIT_MAX_CHARS, len(text))
        if end < len(text):
            lower_bound = start + int(UNIT_MAX_CHARS * 0.6)
            for index in range(end, lower_bound, -1):
                if re.match(r"[。！？.!?；;，,\s]", text[index - 1]):
                    end = index
                    break
        indexes.append(len(units))
        units.append(text[start:end])
        start = end
    return indexes


def validate_units(units: list[str]) -> None:
    if not units:
        fail("FILE_TEXT_EMPTY", "文件中未提取到可翻译文本")
    if len(units) > FILE_MAX_TRANSLATION_UNITS:
        fail(
            "FILE_TOO_LARGE",
            f"文件包含 {len(units)} 个翻译片段，最多支持 {FILE_MAX_TRANSLATION_UNITS} 个，请分批处理",
        )
    if sum(len(unit) for unit in units) > FILE_TOTAL_TEXT_MAX_CHARS:
        fail("FILE_TOO_LARGE", f"文件可翻译文本超过 {FILE_TOTAL_TEXT_MAX_CHARS} 字符，请分批处理")


def create_text_document(file_path: Path, source: str, extension: str) -> PreparedFile:
    units: list[str] = []
    ranges: list[tuple[int, int, list[int], bool, bool]] = []

    def add_range(
        start: int,
        end: int,
        text: str,
        csv_quoted: bool = False,
        csv_field: bool = False,
    ) -> None:
        if text.strip():
            ranges.append((start, end, append_units(units, text), csv_quoted, csv_field))

    if extension == ".csv":
        cursor = 0
        while cursor < len(source):
            if source[cursor] == '"':
                start = cursor + 1
                cursor += 1
                while cursor < len(source):
                    if source[cursor:cursor + 2] == '""':
                        cursor += 2
                    elif source[cursor] == '"':
                        break
                    else:
                        cursor += 1
                add_range(start, cursor, source[start:cursor].replace('""', '"'), True, True)
                if cursor < len(source) and source[cursor] == '"':
                    cursor += 1
            elif source[cursor] in ",\r\n":
                cursor += 1
            else:
                field_start = cursor
                while cursor < len(source) and source[cursor] not in ",\r\n":
                    cursor += 1
                raw = source[field_start:cursor]
                leading = len(raw) - len(raw.lstrip())
                text = raw.strip()
                add_range(field_start + leading, field_start + leading + len(text), text, False, True)
    in_fence = False
    fence = ""
    for match in re.finditer(r"[^\r\n]+", source):
        if extension == ".csv":
            break
        line = match.group(0)
        trimmed = line.strip()
        if extension in {".md", ".markdown"}:
            fence_match = re.match(r"^(`{3,}|~{3,})", trimmed)
            if fence_match:
                marker = fence_match.group(1)[0]
                if not in_fence:
                    in_fence, fence = True, marker
                elif marker == fence:
                    in_fence, fence = False, ""
                continue
            if in_fence or re.match(r"^(    |\t)", line):
                continue
        if not trimmed:
            continue
        leading = len(line) - len(line.lstrip())
        prefix = ""
        if extension in {".md", ".markdown"}:
            prefix_match = re.match(r"^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)", line[leading:])
            prefix = prefix_match.group(0) if prefix_match else ""
        start = match.start() + leading + len(prefix)
        text = line[leading + len(prefix):].rstrip()
        if extension in {".md", ".markdown"}:
            protected_pattern = re.compile(r"`+[^`]*`+|https?://[^\s)\]]+|<[^>]+>|[*_~]+|[!\[\]()]")
            content_start = 0
            for protected in protected_pattern.finditer(text):
                add_range(start + content_start, start + protected.start(), text[content_start:protected.start()])
                content_start = protected.end()
            add_range(start + content_start, start + len(text), text[content_start:])
        else:
            add_range(start, start + len(text), text)
    validate_units(units)

    def render(translations: list[str]) -> bytes:
        output = source
        for start, end, indexes, csv_quoted, csv_field in reversed(ranges):
            translated = "".join(translations[index] for index in indexes)
            escaped = translated.replace('"', '""')
            if csv_quoted:
                translated = escaped
            elif csv_field and re.search(r'[",\r\n]', translated):
                translated = f'"{escaped}"'
            output = output[:start] + translated + output[end:]
        return output.encode("utf-8")

    return PreparedFile(file_path, extension, extension, units, render)


def xml_text_nodes(xml: str, text_tag: str, offset: int) -> list[tuple[int, int]]:
    nodes: list[tuple[int, int]] = []
    pattern = re.compile(rf"<{text_tag}(?:\s[^>]*)?>([\s\S]*?)</{text_tag}>")
    for match in pattern.finditer(xml):
        nodes.append((offset + match.start(1), offset + match.end(1)))
    return nodes


def collect_run_groups(
    xml: str,
    paragraph_tag: str,
    run_tag: str,
    properties_tag: str,
    text_tag: str,
    units: list[str],
) -> list[tuple[list[int], list[tuple[int, int]]]]:
    groups: list[tuple[list[int], list[tuple[int, int]]]] = []
    paragraph_pattern = re.compile(rf"<{paragraph_tag}(?:\s[^>]*)?>[\s\S]*?</{paragraph_tag}>")
    run_pattern = re.compile(rf"<{run_tag}(?:\s[^>]*)?>[\s\S]*?</{run_tag}>")
    properties_pattern = re.compile(
        rf"<{properties_tag}(?:\s[^>]*)?\s*/>|<{properties_tag}(?:\s[^>]*)?>[\s\S]*?</{properties_tag}>"
    )
    for paragraph in paragraph_pattern.finditer(xml):
        current_text = ""
        current_nodes: list[tuple[int, int]] = []
        previous_style: str | None = None
        previous_run_end = 0

        def flush() -> None:
            nonlocal current_text, current_nodes
            if current_text.strip():
                groups.append((append_units(units, current_text), current_nodes))
            current_text, current_nodes = "", []

        for run in run_pattern.finditer(paragraph.group(0)):
            gap = paragraph.group(0)[previous_run_end:run.start()]
            if re.search(r"</?w:(?:hyperlink|fldSimple)\b", gap):
                flush()
                previous_style = None
            previous_run_end = run.end()
            offset = paragraph.start() + run.start()
            nodes = xml_text_nodes(run.group(0), text_tag, offset)
            text = "".join(decode_xml_text(xml[start:end]) for start, end in nodes)
            if not text.strip():
                if re.search(r"<w:(?:tab|br|instrText)\b", run.group(0)):
                    flush()
                    previous_style = None
                continue
            style_match = properties_pattern.search(run.group(0))
            style = style_match.group(0) if style_match else ""
            if current_text and style == previous_style:
                current_text += text
                current_nodes.extend(nodes)
            else:
                flush()
                current_text, current_nodes = text, list(nodes)
                previous_style = style
        flush()
    return groups


def collect_container_groups(
    xml: str,
    container_tag: str,
    text_tag: str,
    units: list[str],
) -> list[tuple[list[int], list[tuple[int, int]]]]:
    groups: list[tuple[list[int], list[tuple[int, int]]]] = []
    pattern = re.compile(rf"<{container_tag}(?:\s[^>]*)?>[\s\S]*?</{container_tag}>")
    for container in pattern.finditer(xml):
        nodes = xml_text_nodes(container.group(0), text_tag, container.start())
        text = "".join(decode_xml_text(xml[start:end]) for start, end in nodes)
        if text.strip():
            groups.append((append_units(units, text), nodes))
    return groups


def replace_xml_groups(
    xml: str,
    groups: list[tuple[list[int], list[tuple[int, int]]]],
    translations: list[str],
) -> str:
    replacements: list[tuple[int, int, str]] = []
    for indexes, nodes in groups:
        translated = encode_xml_text("".join(translations[index] for index in indexes))
        for position, (start, end) in enumerate(nodes):
            replacements.append((start, end, translated if position == 0 else ""))
    output = xml
    for start, end, text in sorted(replacements, reverse=True):
        output = output[:start] + text + output[end:]
    return output


def create_office_document(file_path: Path, extension: str) -> PreparedFile:
    try:
        with ZipFile(file_path) as archive:
            infos = archive.infolist()
            if sum(info.file_size for info in infos) > OFFICE_ARCHIVE_MAX_BYTES:
                fail("FILE_TOO_LARGE", "Office 文档解压后超过 200MB")
            entries = [(info, archive.read(info.filename)) for info in infos]
    except (BadZipFile, OSError) as error:
        fail("FILE_READ_ERROR", f"Office 文件不是有效的 Open XML 文档：{error}")

    units: list[str] = []
    parts: dict[str, tuple[str, list[tuple[list[int], list[tuple[int, int]]]]]] = {}
    for info, data in entries:
        name = info.filename
        if extension == ".docx":
            selected = bool(re.match(r"^word/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$", name))
        elif extension == ".xlsx":
            selected = name == "xl/sharedStrings.xml" or bool(re.match(r"^xl/worksheets/sheet\d+\.xml$", name))
        else:
            selected = bool(re.match(r"^ppt/slides/slide\d+\.xml$", name))
        if not selected:
            continue
        try:
            xml = data.decode("utf-8")
        except UnicodeDecodeError:
            fail("FILE_READ_ERROR", f"Office XML 编码无效：{name}")
        if extension == ".docx":
            groups = collect_run_groups(xml, "w:p", "w:r", "w:rPr", "w:t", units)
        elif extension == ".pptx":
            groups = collect_run_groups(xml, "a:p", "a:r", "a:rPr", "a:t", units)
        else:
            groups = collect_container_groups(xml, "si" if name == "xl/sharedStrings.xml" else "is", "t", units)
        if groups:
            parts[name] = (xml, groups)
    validate_units(units)

    def render(translations: list[str]) -> bytes:
        output = BytesIO()
        with ZipFile(output, "w") as archive:
            for info, data in entries:
                if info.filename in parts:
                    xml, groups = parts[info.filename]
                    data = replace_xml_groups(xml, groups, translations).encode("utf-8")
                archive.writestr(info, data)
        return output.getvalue()

    return PreparedFile(file_path, extension, extension, units, render)


def docx_paragraph(text: str) -> str:
    return f'<w:p><w:r><w:t xml:space="preserve">{encode_xml_text(text)}</w:t></w:r></w:p>'


def create_docx(pages: list[list[str]]) -> bytes:
    page_xml: list[str] = []
    for index, paragraphs in enumerate(pages):
        page_xml.extend(docx_paragraph(text) for text in paragraphs)
        if index + 1 < len(pages):
            page_xml.append('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
    content_types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    relationships = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    document = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{"".join(page_xml)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>'
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types.encode("utf-8"))
        archive.writestr("_rels/.rels", relationships.encode("utf-8"))
        archive.writestr("word/document.xml", document.encode("utf-8"))
    return output.getvalue()


def create_pdf_document(file_path: Path) -> PreparedFile:
    try:
        import pdfplumber
    except ImportError:
        fail(
            "FILE_DEPENDENCY_MISSING",
            f"缺少 PDF 依赖，请运行：python -m pip install pdfplumber=={PDFPLUMBER_VERSION}",
        )
    try:
        with pdfplumber.open(file_path) as pdf:
            pages = [page.extract_text() or "" for page in pdf.pages]
    except Exception as error:
        fail("FILE_READ_ERROR", f"PDF 解析失败：{error}")
    units: list[str] = []
    page_indexes = [
        [append_units(units, paragraph.strip()) for paragraph in re.split(r"\n\s*\n|\n", page) if paragraph.strip()]
        for page in pages
    ]
    validate_units(units)

    def render(translations: list[str]) -> bytes:
        translated_pages = [
            ["".join(translations[index] for index in indexes) for indexes in page]
            for page in page_indexes
        ]
        return create_docx(translated_pages)

    return PreparedFile(file_path, ".pdf", ".docx", units, render)


def prepare_file_translation(file_path_value: str) -> PreparedFile:
    file_path = Path(file_path_value).resolve()
    try:
        file_stat = file_path.stat()
    except OSError as error:
        fail("FILE_READ_ERROR", f"无法读取文件：{file_path}：{error}")
    if not file_path.is_file():
        fail("FILE_READ_ERROR", f"路径不是文件：{file_path}")
    if file_stat.st_size > FILE_MAX_BYTES:
        fail("FILE_TOO_LARGE", "文件超过 20MB，请压缩或分批处理")
    extension = file_path.suffix.lower()
    if extension in TEXT_EXTENSIONS:
        try:
            source = file_path.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeDecodeError) as error:
            fail("FILE_READ_ERROR", f"文件不是有效的 UTF-8 文本：{file_path}：{error}")
        return create_text_document(file_path, source, extension)
    if extension in OFFICE_EXTENSIONS:
        return create_office_document(file_path, extension)
    if extension == ".pdf":
        return create_pdf_document(file_path)
    fail("FILE_FORMAT_UNSUPPORTED", f"不支持的文件格式：{extension or '无扩展名'}")


def translated_text(prepared: PreparedFile, translations: list[str]) -> str:
    del prepared
    return "\n".join(translations)


def write_translated_file(
    prepared: PreparedFile,
    translations: list[str],
    target_lang: str,
    requested_path: str | None,
) -> tuple[Path | None, bool]:
    expected_extension = prepared.output_extension
    output_path = Path(requested_path).resolve() if requested_path else None
    if output_path and output_path.suffix.lower() != expected_extension:
        fail("INVALID_ARGUMENT", f"输出文件必须使用 {expected_extension} 扩展名", 2)
    if output_path is None:
        language = re.sub(r"[^a-z0-9-]", "_", target_lang, flags=re.IGNORECASE).upper()
        for suffix in range(1000):
            index = f".{suffix}" if suffix else ""
            candidate = prepared.source_path.with_name(
                f"{prepared.source_path.stem}_{language}{index}{expected_extension}"
            )
            if not candidate.exists():
                output_path = candidate
                break
    if output_path is None:
        fail("FILE_WRITE_ERROR", "无法生成译文文件名")
    try:
        with output_path.open("xb") as handle:
            handle.write(prepared.render(translations))
        return output_path, False
    except OSError as error:
        return None, True
