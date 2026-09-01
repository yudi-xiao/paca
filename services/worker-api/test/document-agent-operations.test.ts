import { describe, expect, it } from "vitest";
import { Doc as YDoc, XmlElement as YXmlElement, XmlText as YXmlText } from "yjs";

import {
  applyDocumentAgentOperations,
  documentAgentCommandSchema,
  documentAgentEditInputSchema,
  evaluateDocumentAgentEdit,
  inspectDocumentForAgent,
} from "../src/document/agent-operations";
import { materializeBlockNoteDocument } from "../src/document/blocknote-materializer";

const DOCUMENT_ID = "44444444-4444-4444-8444-444444444444";
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const RUN_ID = "66666666-6666-4666-8666-666666666666";

function paragraph(id: string, value: string): YXmlElement {
  const container = new YXmlElement("blockContainer");
  container.setAttribute("id", id);
  const content = new YXmlElement("paragraph");
  const text = new YXmlText();
  text.insert(0, value);
  content.insert(0, [text]);
  container.insert(0, [content]);
  return container;
}

function blockNoteDocument(): YDoc {
  const document = new YDoc();
  const group = new YXmlElement("blockGroup");
  group.insert(0, [paragraph("block-a", "Alpha"), paragraph("block-b", "Beta")]);
  document.getXmlFragment("document-store").insert(0, [group]);
  return document;
}

function editInput(document: YDoc) {
  const snapshot = inspectDocumentForAgent(document, DOCUMENT_ID, 3);
  return documentAgentEditInputSchema.parse({
    action: "apply",
    requestId: REQUEST_ID,
    runId: RUN_ID,
    baseRevision: snapshot.revision,
    baseStateVector: snapshot.stateVector,
    operationMode: "collaborate",
    operations: [
      {
        type: "replace_block_content",
        blockId: "block-a",
        expectedBlockVersion: snapshot.blocks[0]?.version,
        content: [
          { type: "text", text: "Paca ", styles: { bold: true } },
          {
            type: "link",
            href: "https://paca.howlearnwood.com",
            content: [{ type: "text", text: "Cloudflare", styles: {} }],
          },
          { type: "teamMention", props: { id: "team-1", name: "Core" } },
        ],
      },
    ],
  });
}

describe("structured Agent document operations", () => {
  it("reads opaque block versions and round-trips supported BlockNote inline content", () => {
    const document = blockNoteDocument();
    const before = inspectDocumentForAgent(document, DOCUMENT_ID, 3);
    const input = editInput(document);

    expect(before.blocks.map((entry) => entry.blockId)).toEqual(["block-a", "block-b"]);
    expect(JSON.parse(before.blocks[0]?.blockJson ?? "null")).toMatchObject({
      id: "block-a",
      content: [{ type: "text", text: "Alpha" }],
    });
    expect(evaluateDocumentAgentEdit(before, input)).toEqual({ conflicts: [] });

    document.transact(() => applyDocumentAgentOperations(document, input.operations));
    expect(materializeBlockNoteDocument(document)[0]).toMatchObject({
      id: "block-a",
      content: [
        { type: "text", text: "Paca ", styles: { bold: true } },
        {
          type: "link",
          href: "https://paca.howlearnwood.com",
          content: [{ type: "text", text: "Cloudflare", styles: {} }],
        },
        { type: "teamMention", props: { id: "team-1", name: "Core" } },
      ],
    });
  });

  it("reports a target conflict without treating unrelated global revisions as a conflict", () => {
    const document = blockNoteDocument();
    const input = editInput(document);
    const newerUnrelatedSnapshot = inspectDocumentForAgent(document, DOCUMENT_ID, 4);

    expect(evaluateDocumentAgentEdit(newerUnrelatedSnapshot, input)).toEqual({ conflicts: [] });
    const changed = blockNoteDocument();
    const changedInput = editInput(changed);
    applyDocumentAgentOperations(
      changed,
      documentAgentEditInputSchema.parse({
        ...changedInput,
        requestId: "77777777-7777-4777-8777-777777777777",
        operations: [
          {
            ...changedInput.operations[0],
            content: [{ type: "text", text: "Changed", styles: {} }],
          },
        ],
      }).operations,
    );
    const conflict = evaluateDocumentAgentEdit(
      inspectDocumentForAgent(changed, DOCUMENT_ID, 4),
      input,
    );
    expect(conflict.conflicts).toEqual([{ blockId: "block-a", version: expect.any(String) }]);
  });

  it("rejects a mismatched state vector when the caller claims the current revision", () => {
    const document = blockNoteDocument();
    const input = editInput(document);
    const current = inspectDocumentForAgent(document, DOCUMENT_ID, input.baseRevision);

    expect(() =>
      evaluateDocumentAgentEdit(current, { ...input, baseStateVector: "invalid" }),
    ).toThrow("DOCUMENT_AGENT_STATE_VECTOR_MISMATCH");
  });

  it("rejects duplicate targets and unsafe links at the execution boundary", () => {
    const document = blockNoteDocument();
    const input = editInput(document);
    expect(
      documentAgentEditInputSchema.safeParse({
        ...input,
        operations: [input.operations[0], input.operations[0]],
      }).success,
    ).toBe(false);
    expect(
      documentAgentEditInputSchema.safeParse({
        ...input,
        operations: [
          {
            ...input.operations[0],
            content: [
              {
                type: "link",
                href: "javascript:alert(1)",
                content: [{ type: "text", text: "unsafe", styles: {} }],
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires a bounded lease for exclusive edits and validates lease commands", () => {
    const document = blockNoteDocument();
    const input = editInput(document);
    expect(
      documentAgentCommandSchema.safeParse({
        ...input,
        operationMode: "exclusive",
      }).success,
    ).toBe(false);
    expect(
      documentAgentCommandSchema.safeParse({
        ...input,
        operationMode: "exclusive",
        leaseId: "88888888-8888-4888-8888-888888888888",
      }).success,
    ).toBe(true);
    expect(
      documentAgentCommandSchema.safeParse({
        action: "acquire_lease",
        requestId: REQUEST_ID,
        runId: RUN_ID,
        operationMode: "exclusive",
        leaseDurationMs: 5_000,
      }).success,
    ).toBe(true);
    expect(
      documentAgentCommandSchema.safeParse({
        action: "acquire_lease",
        requestId: REQUEST_ID,
        runId: RUN_ID,
        operationMode: "exclusive",
        leaseDurationMs: 60_001,
      }).success,
    ).toBe(false);
  });
});
