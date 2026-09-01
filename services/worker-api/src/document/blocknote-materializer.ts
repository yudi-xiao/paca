import { applyUpdate, Doc as YDoc, XmlElement as YXmlElement, XmlText as YXmlText } from "yjs";

const DOCUMENT_FRAGMENT_NAME = "document-store";
const MAX_BLOCKS = 10_000;
const MAX_DEPTH = 64;
const MAX_JSON_BYTES = 512_000;
const textEncoder = new TextEncoder();

type JsonValue = boolean | number | string | null | JsonValue[] | { [key: string]: JsonValue };
type BlockNoteBlock = {
  id: string;
  type: string;
  props: Record<string, JsonValue>;
  content?: unknown;
  children: BlockNoteBlock[];
};

function fail(code: string): never {
  throw new Error(code);
}

function jsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > MAX_DEPTH) fail("DOCUMENT_BLOCKNOTE_VALUE_TOO_DEEP");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => jsonValue(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) result[key] = jsonValue(item, depth + 1);
    return result;
  }
  fail("DOCUMENT_BLOCKNOTE_VALUE_INVALID");
}

function attributes(element: YXmlElement): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(element.getAttributes()).map(([key, value]) => [key, jsonValue(value)]),
  );
}

function unboxMark(value: unknown): unknown {
  if (value && typeof value === "object" && "stringValue" in value) {
    return (value as { stringValue: unknown }).stringValue;
  }
  return value;
}

function stylesFromMarks(marks: Record<string, unknown>): Record<string, JsonValue> {
  const styles: Record<string, JsonValue> = {};
  for (const [name, rawValue] of Object.entries(marks)) {
    if (name === "link") continue;
    const value = unboxMark(rawValue);
    if (value && typeof value === "object" && Object.keys(value).length === 0) {
      styles[name] = true;
      continue;
    }
    styles[name] = jsonValue(value);
  }
  return styles;
}

function linkFromMarks(marks: Record<string, unknown>): Record<string, JsonValue> | null {
  const raw = marks.link;
  if (!raw || typeof raw !== "object") return null;
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, jsonValue(unboxMark(value))]),
  );
}

function parseText(text: YXmlText): unknown[] {
  const result: unknown[] = [];
  for (const part of text.toDelta()) {
    if (typeof part.insert !== "string") fail("DOCUMENT_BLOCKNOTE_TEXT_EMBED_UNSUPPORTED");
    if (part.insert.length === 0) continue;
    const marks = (part.attributes ?? {}) as Record<string, unknown>;
    const content = { type: "text", text: part.insert, styles: stylesFromMarks(marks) };
    const link = linkFromMarks(marks);
    if (link) {
      const href = link.href;
      if (typeof href !== "string" || href.length === 0) fail("DOCUMENT_BLOCKNOTE_LINK_INVALID");
      result.push({ type: "link", href, content: [content] });
    } else {
      result.push(content);
    }
  }
  return result;
}

function parseInlineContainer(element: YXmlElement): unknown[] {
  const result: unknown[] = [];
  for (const child of element.toArray()) {
    if (child instanceof YXmlText) {
      result.push(...parseText(child));
      continue;
    }
    if (child instanceof YXmlElement) {
      result.push({ type: child.nodeName, props: attributes(child) });
      continue;
    }
    fail("DOCUMENT_BLOCKNOTE_INLINE_INVALID");
  }
  return result;
}

function parseTable(table: YXmlElement): Record<string, unknown> {
  const rows = table
    .toArray()
    .filter((child): child is YXmlElement => child instanceof YXmlElement)
    .map((row) => {
      if (row.nodeName !== "tableRow") fail("DOCUMENT_BLOCKNOTE_TABLE_ROW_INVALID");
      return row
        .toArray()
        .filter((child): child is YXmlElement => child instanceof YXmlElement)
        .map((cell) => {
          if (cell.nodeName !== "tableCell" && cell.nodeName !== "tableHeader") {
            fail("DOCUMENT_BLOCKNOTE_TABLE_CELL_INVALID");
          }
          const paragraphs = cell
            .toArray()
            .filter((child): child is YXmlElement => child instanceof YXmlElement);
          if (paragraphs.some((paragraph) => paragraph.nodeName !== "tableParagraph")) {
            fail("DOCUMENT_BLOCKNOTE_TABLE_PARAGRAPH_INVALID");
          }
          const cellContent = paragraphs.flatMap(parseInlineContainer);
          const cellAttributes = attributes(cell);
          const { colwidth: _columnWidth, ...props } = cellAttributes;
          return {
            kind: cell.nodeName,
            attrs: cellAttributes,
            output: { type: "tableCell", content: cellContent, props },
          };
        });
    });
  const headerRows = rows.findIndex((row) => row.some((cell) => cell.kind !== "tableHeader"));
  const rowHeaderCount = headerRows === -1 ? rows.length : headerRows;
  const width = Math.max(0, ...rows.map((row) => row.length));
  let headerCols = 0;
  for (; headerCols < width; headerCols += 1) {
    if (rows.some((row) => row[headerCols]?.kind !== "tableHeader")) break;
  }
  const firstRow = rows[0] ?? [];
  const columnWidths = firstRow.map((cell) => {
    const widthValue = cell.attrs.colwidth;
    return Array.isArray(widthValue) && typeof widthValue[0] === "number" ? widthValue[0] : null;
  });
  return {
    type: "tableContent",
    rows: rows.map((row) => ({ cells: row.map((cell) => cell.output) })),
    ...(rowHeaderCount > 0 ? { headerRows: rowHeaderCount } : {}),
    ...(headerCols > 0 ? { headerCols } : {}),
    ...(columnWidths.some((value) => value !== null) ? { columnWidths } : {}),
  };
}

function parseBlockContainer(
  element: YXmlElement,
  depth: number,
  counter: { value: number },
): BlockNoteBlock {
  if (depth > MAX_DEPTH) fail("DOCUMENT_BLOCKNOTE_TOO_DEEP");
  counter.value += 1;
  if (counter.value > MAX_BLOCKS) fail("DOCUMENT_BLOCKNOTE_TOO_MANY_BLOCKS");
  const id = element.getAttribute("id");
  if (typeof id !== "string" || id.length === 0) fail("DOCUMENT_BLOCKNOTE_BLOCK_ID_INVALID");
  const children = element
    .toArray()
    .filter((child): child is YXmlElement => child instanceof YXmlElement);
  const contentNode = children.find((child) => child.nodeName !== "blockGroup");
  if (!contentNode) fail("DOCUMENT_BLOCKNOTE_BLOCK_CONTENT_MISSING");
  const childGroup = children.find((child) => child.nodeName === "blockGroup");
  const block: BlockNoteBlock = {
    id,
    type: contentNode.nodeName,
    props: attributes(contentNode),
    children: childGroup ? parseBlockGroup(childGroup, depth + 1, counter) : [],
  };
  if (contentNode.nodeName === "table") block.content = parseTable(contentNode);
  else if (contentNode.length > 0) block.content = parseInlineContainer(contentNode);
  return block;
}

function parseBlockGroup(
  element: YXmlElement,
  depth: number,
  counter: { value: number },
): BlockNoteBlock[] {
  return element.toArray().map((child) => {
    if (!(child instanceof YXmlElement) || child.nodeName !== "blockContainer") {
      fail("DOCUMENT_BLOCKNOTE_GROUP_INVALID");
    }
    return parseBlockContainer(child, depth, counter);
  });
}

export function materializeBlockNoteSnapshot(snapshot: ArrayBuffer | Uint8Array): unknown[] {
  const bytes = snapshot instanceof Uint8Array ? snapshot : new Uint8Array(snapshot);
  const document = new YDoc();
  try {
    applyUpdate(document, bytes);
    const fragment = document.getXmlFragment(DOCUMENT_FRAGMENT_NAME);
    const roots = fragment.toArray();
    if (roots.length === 0) fail("DOCUMENT_BLOCKNOTE_ROOT_MISSING");
    if (
      roots.length !== 1 ||
      !(roots[0] instanceof YXmlElement) ||
      roots[0].nodeName !== "blockGroup"
    ) {
      fail("DOCUMENT_BLOCKNOTE_ROOT_INVALID");
    }
    const blocks = parseBlockGroup(roots[0], 0, { value: 0 });
    if (textEncoder.encode(JSON.stringify(blocks)).byteLength > MAX_JSON_BYTES) {
      fail("DOCUMENT_BLOCKNOTE_PROJECTION_TOO_LARGE");
    }
    return blocks;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("DOCUMENT_BLOCKNOTE_")) throw error;
    throw new Error("DOCUMENT_BLOCKNOTE_SNAPSHOT_INVALID");
  } finally {
    document.destroy();
  }
}
