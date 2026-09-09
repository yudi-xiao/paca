import { createFileRoute } from "@tanstack/react-router";
import { CloudflareEnvironmentTerminalPage } from "@/components/projects/environments/cloudflare-environment-terminal-page";
import { EnvironmentTerminalPage } from "@/components/projects/environments/environment-terminal-page";
import { cloudflareEnvironmentQueryOptions } from "@/lib/cloudflare-environment-api";
import { environmentQueryOptions } from "@/lib/environment-api";

const isInternalPreview = import.meta.env.VITE_INTERNAL_PREVIEW === "true";

// Opened in a new browser tab from the Connect page's "web app" tab — see
// environment-terminal-page.tsx's own doc comment for why this renders as
// a full-viewport overlay rather than living outside the `_authenticated`
// layout.
export const Route = createFileRoute(
	"/_authenticated/projects/$projectId/environments/$environmentId/terminal",
)({
	loader: async ({
		context: { queryClient },
		params: { projectId, environmentId },
	}) => {
		if (isInternalPreview) {
			await queryClient.ensureQueryData(
				cloudflareEnvironmentQueryOptions(projectId, environmentId),
			);
			return;
		}
		await queryClient.ensureQueryData(
			environmentQueryOptions(projectId, environmentId),
		);
	},
	component: ProjectEnvironmentTerminalPage,
});

function ProjectEnvironmentTerminalPage() {
	const { projectId, environmentId } = Route.useParams();
	if (isInternalPreview) {
		return (
			<CloudflareEnvironmentTerminalPage
				projectId={projectId}
				environmentId={environmentId}
			/>
		);
	}
	return (
		<EnvironmentTerminalPage
			projectId={projectId}
			environmentId={environmentId}
		/>
	);
}
