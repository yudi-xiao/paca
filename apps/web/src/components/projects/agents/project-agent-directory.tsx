import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bot, Clock3, Radio, ServerCog, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { projectAgentDirectoryQueryOptions } from "@/lib/agent-auth-api";
import { projectQueryOptions } from "@/lib/project-api";

function authorizationLabel(status: "active" | "pending" | "inactive") {
	if (status === "active") return "已授权";
	if (status === "pending") return "等待审批";
	return "未授权";
}

function authorizationVariant(status: "active" | "pending" | "inactive") {
	return status === "active" ? "secondary" : "outline";
}

export function ProjectAgentDirectory({ projectId }: { projectId: string }) {
	const project = useQuery(projectQueryOptions(projectId));
	const directory = useQuery(projectAgentDirectoryQueryOptions(projectId));

	return (
		<div className="flex flex-col">
			<div className="relative overflow-hidden border-b border-border/50 px-6 py-8">
				<div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
					<div>
						<h1 className="font-[Syne] text-2xl font-bold tracking-tight">
							Agent
						</h1>
						<p className="mt-1 text-sm text-muted-foreground">
							{project.data?.name} · Better Auth Agent Auth 项目授权目录
						</p>
					</div>
					<Button
						variant="outline"
						size="sm"
						render={<Link to="/admin/agents" search={{ create: false }} />}
					>
						<ServerCog className="size-4" /> 管理 Agent Host
					</Button>
				</div>
			</div>

			<div className="p-6">
				{directory.isLoading ? (
					<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
						{Array.from({ length: 3 }).map((_, index) => (
							<Skeleton
								// biome-ignore lint/suspicious/noArrayIndexKey: fixed loading placeholders
								key={index}
								className="h-52 rounded-xl"
							/>
						))}
					</div>
				) : directory.isError ? (
					<div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
						无法读取项目 Agent。请确认当前角色拥有 agents.read 权限。
					</div>
				) : (directory.data?.length ?? 0) === 0 ? (
					<div className="flex flex-col items-center gap-3 py-20 text-center">
						<div className="flex size-16 items-center justify-center rounded-2xl bg-muted/50">
							<Bot className="size-8 text-muted-foreground/50" />
						</div>
						<p className="font-medium">尚无与此项目关联的 Agent</p>
						<p className="max-w-lg text-sm text-muted-foreground">
							Agent Host 注册 Agent 并申请带有此 Project ID 的 Capability Grant
							后，会显示在这里。
						</p>
					</div>
				) : (
					<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
						{directory.data?.map((agent) => (
							<Card key={agent.agent_id} className="border-border/60">
								<CardHeader className="space-y-3">
									<div className="flex items-start justify-between gap-3">
										<div className="min-w-0">
											<CardTitle className="truncate text-base">
												{agent.name}
											</CardTitle>
											<p className="mt-1 truncate font-mono text-xs text-muted-foreground">
												{agent.agent_id}
											</p>
										</div>
										<Badge
											variant={authorizationVariant(agent.authorization_status)}
										>
											<ShieldCheck className="mr-1 size-3" />
											{authorizationLabel(agent.authorization_status)}
										</Badge>
									</div>
								</CardHeader>
								<CardContent className="space-y-3 text-xs">
									<div className="flex flex-wrap gap-2">
										<Badge
											variant={agent.host_online ? "secondary" : "outline"}
										>
											<Radio className="mr-1 size-3" />
											{agent.host_online ? "Host 在线" : "Host 离线"}
										</Badge>
										<Badge variant="outline">{agent.mode}</Badge>
										{agent.harness_kinds.map((kind) => (
											<Badge key={kind} variant="outline">
												{kind}
											</Badge>
										))}
									</div>
									<p className="flex items-center gap-1 text-muted-foreground">
										<ServerCog className="size-3.5" />
										{agent.host_name ?? agent.host_id}
									</p>
									<div className="flex flex-wrap gap-1.5 border-t border-border/60 pt-3">
										{agent.capability_grants.map((grant) => (
											<Badge
												key={grant.id}
												variant={
													grant.status === "active" ? "secondary" : "outline"
												}
											>
												{grant.capability}
											</Badge>
										))}
									</div>
									{agent.capability_grants.some(
										(grant) => grant.valid_until,
									) ? (
										<p className="flex items-center gap-1 text-muted-foreground">
											<Clock3 className="size-3.5" />
											能力均按短期 Grant 到期并需重新审批
										</p>
									) : null}
								</CardContent>
							</Card>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
