import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { InteractionLayout } from "@/components/projects/interactions/interaction-layout";
import { useProjectPermissions } from "@/hooks/use-project-permissions";

export const Route = createFileRoute(
	"/_authenticated/projects/$projectId/interactions/backlog",
)({
	component: BacklogPage,
});

function BacklogPage() {
	return <FullBacklogPage />;
}

function FullBacklogPage() {
	const { projectId } = Route.useParams();
	const { hasProjectPermission } = useProjectPermissions(projectId);
	const { t } = useTranslation("projects");

	const canCreate = hasProjectPermission("tasks.write");
	const canEdit = hasProjectPermission("tasks.write");
	const canManageViews = hasProjectPermission("sprints.write");

	return (
		<InteractionLayout
			projectId={projectId}
			interactionKey={`backlog:${projectId}`}
			title={t("board.backlog.title")}
			description={t("board.backlog.description")}
			canCreate={canCreate}
			canEdit={canEdit}
			canManageViews={canManageViews}
			sprintId={null}
			context="backlog"
		/>
	);
}
