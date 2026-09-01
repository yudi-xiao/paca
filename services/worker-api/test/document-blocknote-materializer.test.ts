import { describe, expect, it } from "vitest";
import {
  encodeStateAsUpdate,
  Doc as YDoc,
  XmlElement as YXmlElement,
  XmlText as YXmlText,
} from "yjs";

import { materializeBlockNoteSnapshot } from "../src/document/blocknote-materializer";

function paragraph(id: string, textValue: string): YXmlElement {
  const container = new YXmlElement("blockContainer");
  container.setAttribute("id", id);
  const content = new YXmlElement("paragraph");
  content.setAttribute("textColor", "default");
  const text = new YXmlText();
  text.insert(0, textValue, { bold: {} });
  content.insert(0, [text]);
  container.insert(0, [content]);
  return container;
}

function snapshotWith(...blocks: YXmlElement[]): Uint8Array {
  const document = new YDoc();
  const group = new YXmlElement("blockGroup");
  group.insert(0, blocks);
  document.getXmlFragment("document-store").insert(0, [group]);
  return encodeStateAsUpdate(document);
}

describe("BlockNote Yjs materializer", () => {
  it("materializes styled inline content and nested blocks", () => {
    const parent = paragraph("parent", "Architecture");
    const children = new YXmlElement("blockGroup");
    children.insert(0, [paragraph("child", "Cloudflare")]);
    parent.insert(parent.length, [children]);

    expect(materializeBlockNoteSnapshot(snapshotWith(parent))).toEqual([
      {
        id: "parent",
        type: "paragraph",
        props: { textColor: "default" },
        content: [{ type: "text", text: "Architecture", styles: { bold: true } }],
        children: [
          {
            id: "child",
            type: "paragraph",
            props: { textColor: "default" },
            content: [{ type: "text", text: "Cloudflare", styles: { bold: true } }],
            children: [],
          },
        ],
      },
    ]);
  });

  it("preserves links and custom inline mentions", () => {
    const container = new YXmlElement("blockContainer");
    container.setAttribute("id", "links");
    const content = new YXmlElement("paragraph");
    const text = new YXmlText();
    text.insert(0, "Paca", { link: { href: "https://paca.howlearnwood.com" } });
    const mention = new YXmlElement("teamMention");
    mention.setAttribute("id", "team-1");
    mention.setAttribute("name", "Core");
    content.insert(0, [text, mention]);
    container.insert(0, [content]);

    expect(materializeBlockNoteSnapshot(snapshotWith(container))).toEqual([
      {
        id: "links",
        type: "paragraph",
        props: {},
        content: [
          {
            type: "link",
            href: "https://paca.howlearnwood.com",
            content: [{ type: "text", text: "Paca", styles: {} }],
          },
          { type: "teamMention", props: { id: "team-1", name: "Core" } },
        ],
        children: [],
      },
    ]);
  });

  it("materializes table cell content, props, headers, and column widths", () => {
    const container = new YXmlElement("blockContainer");
    container.setAttribute("id", "table-1");
    const table = new YXmlElement("table");
    table.setAttribute("textColor", "default");
    const row = new YXmlElement("tableRow");
    const cell = new YXmlElement("tableHeader");
    const setCellAttribute = cell.setAttribute.bind(cell) as (name: string, value: unknown) => void;
    setCellAttribute("colwidth", [120]);
    setCellAttribute("colspan", 1);
    setCellAttribute("rowspan", 1);
    cell.setAttribute("textColor", "default");
    const cellParagraph = new YXmlElement("tableParagraph");
    const cellText = new YXmlText();
    cellText.insert(0, "Name", { bold: {} });
    cellParagraph.insert(0, [cellText]);
    cell.insert(0, [cellParagraph]);
    row.insert(0, [cell]);
    table.insert(0, [row]);
    container.insert(0, [table]);

    expect(materializeBlockNoteSnapshot(snapshotWith(container))).toEqual([
      {
        id: "table-1",
        type: "table",
        props: { textColor: "default" },
        content: {
          type: "tableContent",
          rows: [
            {
              cells: [
                {
                  type: "tableCell",
                  content: [{ type: "text", text: "Name", styles: { bold: true } }],
                  props: { colspan: 1, rowspan: 1, textColor: "default" },
                },
              ],
            },
          ],
          headerRows: 1,
          headerCols: 1,
          columnWidths: [120],
        },
        children: [],
      },
    ]);
  });

  it("fails closed when the snapshot is not a BlockNote document", () => {
    const document = new YDoc();
    document.getText("content").insert(0, "not BlockNote");

    expect(() => materializeBlockNoteSnapshot(encodeStateAsUpdate(document))).toThrow(
      "DOCUMENT_BLOCKNOTE_ROOT_MISSING",
    );

    const malformed = new YDoc();
    malformed.getXmlFragment("document-store").insert(0, [new YXmlElement("unexpected")]);
    expect(() => materializeBlockNoteSnapshot(encodeStateAsUpdate(malformed))).toThrow(
      "DOCUMENT_BLOCKNOTE_ROOT_INVALID",
    );
  });
});
