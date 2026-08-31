import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { InteractionLayout } from "@/components/projects/interactions/interaction-layout";
import { useProjectPermissions } from "@/hooks/use-project-permissions";

export const Route = createFileRoute(
	"/_authenticated/projects/$projectId/interactions/timeline",
)({
	component: TimelinePage,
});

function TimelinePage() {
	return <FullTimelinePage />;
}

function FullTimelinePage() {
	const { t } = useTranslation("projects");
	const { projectId } = Route.useParams();
	const { hasProjectPermission } = useProjectPermissions(projectId);

	const canCreate = hasProjectPermission("tasks.write");
	const canEdit = hasProjectPermission("tasks.write");
	const canManageViews = hasProjectPermission("sprints.write");

	return (
		<InteractionLayout
			projectId={projectId}
			interactionKey={`timeline:${projectId}`}
			title={t("layout.timeline.title")}
			description={t("layout.timeline.description")}
			canCreate={canCreate}
			canEdit={canEdit}
			canManageViews={canManageViews}
			sprintId={null}
			context="timeline"
		/>
	);
}
