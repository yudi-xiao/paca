export const DOCUMENT_AGENT_LEASE_MESSAGE_TYPE = "document.agent-lease";

export type DocumentAgentLeaseStatus = {
	active: boolean;
	expiresAt: number | null;
	serverTime: number;
	type: typeof DOCUMENT_AGENT_LEASE_MESSAGE_TYPE;
};

export function parseDocumentAgentLeaseStatus(
	value: string,
): DocumentAgentLeaseStatus | null {
	try {
		const parsed = JSON.parse(value) as Partial<DocumentAgentLeaseStatus>;
		if (
			parsed.type !== DOCUMENT_AGENT_LEASE_MESSAGE_TYPE ||
			typeof parsed.active !== "boolean" ||
			(parsed.expiresAt !== null && !Number.isSafeInteger(parsed.expiresAt)) ||
			!Number.isSafeInteger(parsed.serverTime)
		) {
			return null;
		}
		return parsed as DocumentAgentLeaseStatus;
	} catch {
		return null;
	}
}
