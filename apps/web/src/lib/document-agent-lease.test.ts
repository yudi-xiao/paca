import { describe, expect, it } from "vitest";

import { parseDocumentAgentLeaseStatus } from "./document-agent-lease";

describe("parseDocumentAgentLeaseStatus", () => {
	it("accepts active and inactive server lease messages", () => {
		expect(
			parseDocumentAgentLeaseStatus(
				JSON.stringify({
					type: "document.agent-lease",
					active: true,
					expiresAt: 1_800_000_000_000,
					serverTime: 1_799_999_970_000,
				}),
			),
		).toEqual({
			type: "document.agent-lease",
			active: true,
			expiresAt: 1_800_000_000_000,
			serverTime: 1_799_999_970_000,
		});
		expect(
			parseDocumentAgentLeaseStatus(
				'{"type":"document.agent-lease","active":false,"expiresAt":null,"serverTime":1799999970000}',
			),
		).toEqual({
			type: "document.agent-lease",
			active: false,
			expiresAt: null,
			serverTime: 1_799_999_970_000,
		});
	});

	it("ignores malformed or unrelated custom messages", () => {
		expect(parseDocumentAgentLeaseStatus("not-json")).toBeNull();
		expect(
			parseDocumentAgentLeaseStatus(
				'{"type":"another-event","active":true,"expiresAt":123,"serverTime":100}',
			),
		).toBeNull();
		expect(
			parseDocumentAgentLeaseStatus(
				'{"type":"document.agent-lease","active":"yes","expiresAt":123,"serverTime":100}',
			),
		).toBeNull();
	});
});
