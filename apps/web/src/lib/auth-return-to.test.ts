import { describe, expect, it } from "vitest";

import { safeAuthReturnTo } from "./auth-return-to";

describe("safeAuthReturnTo", () => {
	it("preserves a device authorization path and search parameters", () => {
		expect(
			safeAuthReturnTo("/device/capabilities?agent_id=agent-1&code=ABCD-1234"),
		).toBe("/device/capabilities?agent_id=agent-1&code=ABCD-1234");
	});

	it.each([
		"https://evil.example/device/capabilities",
		"//evil.example/device/capabilities",
		"/\\evil.example/device/capabilities",
		"device/capabilities",
		42,
		null,
	])("rejects unsafe return target %s", (value) => {
		expect(safeAuthReturnTo(value)).toBeNull();
	});
});
