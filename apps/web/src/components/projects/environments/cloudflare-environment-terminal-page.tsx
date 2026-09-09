import { useQuery } from "@tanstack/react-query";
import { TerminalSquare, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Skeleton } from "@/components/ui/skeleton";
import { cloudflareEnvironmentQueryOptions } from "@/lib/cloudflare-environment-api";
import { EnvironmentTerminal } from "./environment-terminal";

export function CloudflareEnvironmentTerminalPage({
	projectId,
	environmentId,
}: {
	projectId: string;
	environmentId: string;
}) {
	const { t } = useTranslation("projects");
	const { data: environment } = useQuery(
		cloudflareEnvironmentQueryOptions(projectId, environmentId),
	);

	return (
		<div className="fixed inset-0 z-50 flex flex-col bg-background">
			<div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/50 px-4 py-3">
				<div className="flex min-w-0 items-center gap-2">
					<TerminalSquare className="size-4 shrink-0 text-primary" />
					<span className="truncate text-sm font-medium">
						{environment
							? t("environments.connect.webApp.pageTitle", {
									name: environment.name,
								})
							: t("environments.connect.webApp.pageTitleLoading")}
					</span>
				</div>
				<button
					type="button"
					onClick={() => window.close()}
					className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
				>
					<X className="size-4" />
					{t("environments.connect.webApp.closeTab")}
				</button>
			</div>
			<div className="min-h-0 flex-1 p-3">
				{environment ? (
					<EnvironmentTerminal
						projectId={projectId}
						environmentId={environmentId}
						slug={environment.name}
						cloudflareNative
					/>
				) : (
					<Skeleton className="h-full w-full rounded-lg" />
				)}
			</div>
		</div>
	);
}
