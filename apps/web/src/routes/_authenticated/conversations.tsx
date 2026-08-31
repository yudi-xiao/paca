import { createFileRoute, redirect } from "@tanstack/react-router";
import { ConversationsLayout } from "@/components/projects/agents/conversations-layout";
import {
	chattableAgentsQueryOptions,
	globalConversationsQueryOptions,
} from "@/lib/agent-api";

// Global sibling of routes/_authenticated/projects/$projectId/conversations —
// same UI (see components/projects/agents/conversations-layout.tsx), reused
// as-is, just with no projectId: lists the caller's own global-chat
// conversations (with global agents, from the home/admin pages) instead of
// one project's.
export const Route = createFileRoute("/_authenticated/conversations")({
	beforeLoad: () => {
		if (import.meta.env.VITE_INTERNAL_PREVIEW === "true") {
			throw redirect({ to: "/home" });
		}
	},
	loader: async ({ context: { queryClient } }) => {
		await Promise.all([
			queryClient.ensureInfiniteQueryData(globalConversationsQueryOptions()),
			queryClient.ensureQueryData(chattableAgentsQueryOptions),
		]);
	},
	component: () => <ConversationsLayout />,
});
