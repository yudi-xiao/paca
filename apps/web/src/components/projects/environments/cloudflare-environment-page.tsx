import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	Archive,
	Loader2,
	Pencil,
	Plus,
	Server,
	ShieldCheck,
	TerminalSquare,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectPermissions } from "@/hooks/use-project-permissions";
import {
	archiveCloudflareEnvironment,
	type CloudflareEnvironment,
	cloudflareEnvironmentsQueryOptions,
	createCloudflareEnvironment,
	renameCloudflareEnvironment,
} from "@/lib/cloudflare-environment-api";
import { projectQueryOptions } from "@/lib/project-api";

function backendLabel(backend: CloudflareEnvironment["backend"]): string {
	switch (backend) {
		case "cloudflare-sandbox":
			return "Cloudflare Sandbox";
		case "cloudflare-computer":
			return "Cloudflare Computer";
	}
}

function EnvironmentNameDialog({
	projectId,
	environment,
	open,
	onOpenChange,
}: {
	projectId: string;
	environment?: CloudflareEnvironment;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { t } = useTranslation("projects");
	const queryClient = useQueryClient();
	const [name, setName] = useState(environment?.name ?? "");
	const mutation = useMutation({
		mutationFn: () =>
			environment
				? renameCloudflareEnvironment(projectId, environment.id, name.trim())
				: createCloudflareEnvironment(projectId, name.trim()),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: ["projects", projectId, "cloudflare-environments"],
			});
			setName(environment?.name ?? "");
			onOpenChange(false);
		},
	});
	const handleOpenChange = (next: boolean) => {
		if (mutation.isPending) return;
		if (!next) {
			setName(environment?.name ?? "");
			mutation.reset();
		}
		onOpenChange(next);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogTitle>
					{t(
						environment
							? "environments.cloudflare.renameTitle"
							: "environments.cloudflare.createTitle",
					)}
				</DialogTitle>
				<DialogDescription>
					{t("environments.cloudflare.createDescription")}
				</DialogDescription>
				<div className="space-y-2 py-2">
					<Label htmlFor="cloudflare-environment-name">
						{t("environments.createDialog.nameLabel")}
					</Label>
					<Input
						id="cloudflare-environment-name"
						value={name}
						onChange={(event) => setName(event.target.value)}
						maxLength={100}
						autoFocus
					/>
					{mutation.isError ? (
						<p className="text-xs text-destructive">
							{t("environments.cloudflare.saveFailed")}
						</p>
					) : null}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => handleOpenChange(false)}>
						{t("environments.createDialog.cancel")}
					</Button>
					<Button
						disabled={!name.trim() || mutation.isPending}
						onClick={() => mutation.mutate()}
					>
						{mutation.isPending ? (
							<Loader2 className="size-4 animate-spin" />
						) : null}
						{t(
							environment
								? "environments.cloudflare.rename"
								: "environments.createDialog.create",
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function ArchiveEnvironmentDialog({
	projectId,
	environment,
	onOpenChange,
}: {
	projectId: string;
	environment: CloudflareEnvironment | null;
	onOpenChange: (open: boolean) => void;
}) {
	const { t } = useTranslation("projects");
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: () =>
			archiveCloudflareEnvironment(projectId, environment?.id ?? ""),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: ["projects", projectId, "cloudflare-environments"],
			});
			onOpenChange(false);
		},
	});
	const handleOpenChange = (next: boolean) => {
		if (mutation.isPending) return;
		if (!next) mutation.reset();
		onOpenChange(next);
	};

	return (
		<Dialog open={environment !== null} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogTitle>
					{t("environments.cloudflare.archiveTitle", {
						name: environment?.name ?? "",
					})}
				</DialogTitle>
				<DialogDescription>
					{t("environments.cloudflare.archiveDescription")}
				</DialogDescription>
				{mutation.isError ? (
					<p className="text-xs text-destructive">
						{t("environments.cloudflare.archiveFailed")}
					</p>
				) : null}
				<DialogFooter>
					<Button variant="outline" onClick={() => handleOpenChange(false)}>
						{t("environments.createDialog.cancel")}
					</Button>
					<Button
						variant="destructive"
						disabled={mutation.isPending || !environment}
						onClick={() => mutation.mutate()}
					>
						{mutation.isPending ? (
							<Loader2 className="size-4 animate-spin" />
						) : null}
						{t("environments.cloudflare.archive")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function CloudflareEnvironmentPage({
	projectId,
	initialCreate = false,
}: {
	projectId: string;
	initialCreate?: boolean;
}) {
	const { t } = useTranslation("projects");
	const { hasProjectPermission } = useProjectPermissions(projectId);
	const canWrite = hasProjectPermission("environments.write");
	const canConnect = hasProjectPermission("environments.connect");
	const { data: project } = useQuery(projectQueryOptions(projectId));
	const { data: environments = [], isLoading } = useQuery(
		cloudflareEnvironmentsQueryOptions(projectId),
	);
	const [createOpen, setCreateOpen] = useState(initialCreate);
	const [renaming, setRenaming] = useState<CloudflareEnvironment | null>(null);
	const [archiving, setArchiving] = useState<CloudflareEnvironment | null>(
		null,
	);
	useEffect(() => {
		if (initialCreate) setCreateOpen(true);
	}, [initialCreate]);

	return (
		<div className="flex flex-col">
			<div className="border-b border-border/50 px-6 py-8">
				<div className="flex items-end justify-between gap-4">
					<div>
						<h1 className="font-[Syne] text-2xl font-bold tracking-tight">
							{t("environments.page.title")}
						</h1>
						<p className="mt-1 text-sm text-muted-foreground">
							{project?.name} · {t("environments.cloudflare.subtitle")}
						</p>
					</div>
					{canWrite ? (
						<Button size="sm" onClick={() => setCreateOpen(true)}>
							<Plus className="size-4" />
							{t("environments.page.newEnvironment")}
						</Button>
					) : null}
				</div>
			</div>

			<div className="p-6">
				<div className="mb-5 flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
					<ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" />
					<div>
						<p className="text-sm font-medium">
							{t("environments.cloudflare.agentAccessTitle")}
						</p>
						<p className="mt-1 text-xs text-muted-foreground">
							{t("environments.cloudflare.agentAccessDescription")}
						</p>
					</div>
				</div>

				{isLoading ? (
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
						{["first", "second", "third"].map((key) => (
							<Skeleton key={key} className="h-40 rounded-xl" />
						))}
					</div>
				) : environments.length === 0 ? (
					<div className="flex flex-col items-center gap-4 py-20 text-center">
						<div className="flex size-16 items-center justify-center rounded-2xl bg-muted/50">
							<Server className="size-8 text-muted-foreground/50" />
						</div>
						<div>
							<p className="text-sm font-medium">
								{t("environments.page.empty.title")}
							</p>
							<p className="mt-1 max-w-sm text-xs text-muted-foreground">
								{t("environments.cloudflare.emptyDescription")}
							</p>
						</div>
						{canWrite ? (
							<Button size="sm" onClick={() => setCreateOpen(true)}>
								<Plus className="size-4" />
								{t("environments.page.empty.createFirstEnvironment")}
							</Button>
						) : null}
					</div>
				) : (
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
						{environments.map((environment) => (
							<div
								key={environment.id}
								className="flex min-h-40 flex-col justify-between rounded-xl border border-border/60 bg-card p-5"
							>
								<div>
									<div className="flex items-start justify-between gap-3">
										<div className="flex min-w-0 items-center gap-3">
											<div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
												<Server className="size-4 text-primary" />
											</div>
											<p className="truncate text-sm font-semibold">
												{environment.name}
											</p>
										</div>
										<Badge variant="secondary">
											{backendLabel(environment.backend)}
										</Badge>
									</div>
									<div className="mt-4 flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
										<span className="size-2 rounded-full bg-current" />
										{t("environments.cloudflare.readyOnDemand")}
									</div>
								</div>
								{canWrite || canConnect ? (
									<div className="mt-5 flex gap-2 border-t border-border/50 pt-3">
										{canConnect ? (
											<Link
												to="/projects/$projectId/environments/$environmentId/terminal"
												params={{ projectId, environmentId: environment.id }}
												target="_blank"
												rel="noopener noreferrer"
												className={buttonVariants({ size: "sm" })}
											>
												<TerminalSquare className="size-3.5" />
												{t("environments.connect.webApp.connect")}
											</Link>
										) : null}
										{canWrite ? (
											<>
												<Button
													size="sm"
													variant="ghost"
													onClick={() => setRenaming(environment)}
												>
													<Pencil className="size-3.5" />
													{t("environments.cloudflare.rename")}
												</Button>
												<Button
													size="sm"
													variant="ghost"
													onClick={() => setArchiving(environment)}
												>
													<Archive className="size-3.5" />
													{t("environments.cloudflare.archive")}
												</Button>
											</>
										) : null}
									</div>
								) : null}
							</div>
						))}
					</div>
				)}
			</div>

			<EnvironmentNameDialog
				projectId={projectId}
				open={createOpen}
				onOpenChange={setCreateOpen}
			/>
			{renaming ? (
				<EnvironmentNameDialog
					key={renaming.id}
					projectId={projectId}
					environment={renaming}
					open
					onOpenChange={(open) => {
						if (!open) setRenaming(null);
					}}
				/>
			) : null}
			<ArchiveEnvironmentDialog
				projectId={projectId}
				environment={archiving}
				onOpenChange={(open) => {
					if (!open) setArchiving(null);
				}}
			/>
		</div>
	);
}
