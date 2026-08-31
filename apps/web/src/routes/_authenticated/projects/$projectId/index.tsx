import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { CalendarDays, FolderKanban, Globe, Lock } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { projectQueryOptions } from "@/lib/project-api";

export const Route = createFileRoute("/_authenticated/projects/$projectId/")({
	beforeLoad: ({ params }) => {
		if (import.meta.env.VITE_INTERNAL_PREVIEW === "true") return;
		throw redirect({
			to: "/projects/$projectId/interactions/timeline",
			params: { projectId: params.projectId },
		});
	},
	component: InternalPreviewProjectOverview,
});

function InternalPreviewProjectOverview() {
	const { projectId } = Route.useParams();
	const { data: project } = useQuery(projectQueryOptions(projectId));
	const { t } = useTranslation("shared");

	if (!project) return null;

	return (
		<div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
			<header className="flex items-start gap-4">
				<div className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/10 text-primary">
					<FolderKanban className="size-6" />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<h1 className="font-[Syne] text-2xl font-bold tracking-tight">
							{project.name}
						</h1>
						<Badge variant="outline" className="font-mono">
							{project.task_id_prefix}
						</Badge>
					</div>
					<p className="mt-1 text-sm text-muted-foreground">
						{project.description || t("home.projectCard.noDescription")}
					</p>
				</div>
			</header>

			<Card className="border-border/60">
				<CardHeader>
					<CardTitle className="text-base">
						Cloudflare internal preview
					</CardTitle>
				</CardHeader>
				<CardContent className="grid gap-4 text-sm sm:grid-cols-2">
					<div className="flex items-center gap-3 rounded-lg border border-border/50 p-4">
						{project.is_public ? (
							<Globe className="size-4 text-primary" />
						) : (
							<Lock className="size-4 text-primary" />
						)}
						<span>
							{project.is_public ? t("home.projectCard.public") : "Private"}
						</span>
					</div>
					<div className="flex items-center gap-3 rounded-lg border border-border/50 p-4">
						<CalendarDays className="size-4 text-primary" />
						<span>{new Date(project.created_at).toLocaleString()}</span>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
