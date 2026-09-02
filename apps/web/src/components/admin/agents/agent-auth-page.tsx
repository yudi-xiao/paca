import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Bot,
	Clock3,
	KeyRound,
	Plus,
	Radio,
	ServerCog,
	ShieldCheck,
	ShieldPlus,
	Trash2,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	type AgentAuthHostEnrollment,
	type AgentHostRuntimeProfile,
	agentAuthAgentsQueryOptions,
	agentAuthConfigurationQueryOptions,
	agentAuthHostsQueryOptions,
	agentHostRuntimesQueryOptions,
	approveAgentHostLabels,
	createAgentAuthHost,
	grantAutonomousProjectRead,
	revokeAgentAuthAgent,
	revokeAgentAuthHost,
	revokeAutonomousProjectRead,
} from "@/lib/agent-auth-api";

function HostRuntimeControls({
	hostId,
	profile,
	onSaved,
}: {
	hostId: string;
	profile: AgentHostRuntimeProfile | undefined;
	onSaved: () => Promise<unknown>;
}) {
	const [labels, setLabels] = useState(
		(profile?.approved_labels ?? ["task:execute"]).join(", "),
	);
	const mutation = useMutation({
		mutationFn: () =>
			approveAgentHostLabels({
				hostId,
				approvedLabels: [
					...new Set(
						labels
							.split(",")
							.map((label) => label.trim())
							.filter(Boolean),
					),
				],
			}),
		onSuccess: onSaved,
	});

	return (
		<div className="mt-3 space-y-2 border-t border-border/60 pt-3">
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<Badge variant={profile?.online ? "secondary" : "outline"}>
					<Radio className="mr-1 size-3" />
					{profile?.online ? "在线" : "离线"}
				</Badge>
				{profile?.reported_harness_kinds.map((kind) => (
					<Badge key={kind} variant="outline">
						{kind}
					</Badge>
				))}
			</div>
			<p className="text-xs text-muted-foreground">
				有效标签：{profile?.effective_labels.join(", ") || "无"}
			</p>
			<div className="flex gap-2">
				<Input
					value={labels}
					onChange={(event) => setLabels(event.target.value)}
					placeholder="task:execute, harness:codex"
					className="h-8 font-mono text-xs"
				/>
				<Button
					variant="outline"
					size="sm"
					disabled={mutation.isPending}
					onClick={() => mutation.mutate()}
				>
					审批标签
				</Button>
			</div>
			{mutation.isError && (
				<p className="text-xs text-destructive">标签格式或权限校验失败。</p>
			)}
		</div>
	);
}

export function AgentAuthPage() {
	const queryClient = useQueryClient();
	const agentsQuery = useQuery(agentAuthAgentsQueryOptions);
	const configurationQuery = useQuery(agentAuthConfigurationQueryOptions);
	const hostsQuery = useQuery(agentAuthHostsQueryOptions);
	const hostRuntimesQuery = useQuery(agentHostRuntimesQueryOptions);
	const [hostName, setHostName] = useState("");
	const [enrollment, setEnrollment] = useState<AgentAuthHostEnrollment | null>(
		null,
	);
	const [autonomousAgentId, setAutonomousAgentId] = useState("");
	const [autonomousProjectId, setAutonomousProjectId] = useState("");
	const [autonomousGrantState, setAutonomousGrantState] = useState<
		"granted" | "revoked" | null
	>(null);
	const createHostMutation = useMutation({
		mutationFn: createAgentAuthHost,
		onSuccess: (created) => {
			setEnrollment(created);
			setHostName("");
			return queryClient.invalidateQueries({
				queryKey: ["agent-auth", "hosts"],
			});
		},
	});
	const revokeHostMutation = useMutation({
		mutationFn: revokeAgentAuthHost,
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["agent-auth", "hosts"] }),
	});
	const autonomousGrantMutation = useMutation({
		mutationFn: grantAutonomousProjectRead,
		onSuccess: () => setAutonomousGrantState("granted"),
	});
	const autonomousRevokeMutation = useMutation({
		mutationFn: revokeAutonomousProjectRead,
		onSuccess: () => setAutonomousGrantState("revoked"),
	});
	const revokeMutation = useMutation({
		mutationFn: revokeAgentAuthAgent,
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["agent-auth", "agents"] }),
	});

	const agents = agentsQuery.data ?? [];
	const hosts = hostsQuery.data ?? [];
	const hostRuntimeById = new Map(
		(hostRuntimesQuery.data ?? []).map((runtime) => [runtime.host_id, runtime]),
	);
	const autonomousEnabled =
		configurationQuery.data?.modes.includes("autonomous") ?? false;

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
			<header className="flex items-start gap-3">
				<div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
					<Bot className="size-5" />
				</div>
				<div>
					<h1 className="font-[Syne] text-2xl font-bold tracking-tight">
						Agent 身份与授权
					</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						此页面只展示 Better Auth Agent Auth 身份，不再调用旧 Agent API。
					</p>
				</div>
			</header>

			<section className="space-y-3">
				<div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
					<div>
						<h2 className="text-lg font-semibold">Agent Hosts</h2>
						<p className="text-xs text-muted-foreground">
							先创建设备登记令牌，再由 Host 在本地生成 Ed25519 密钥并完成
							enrollment。
						</p>
					</div>
					<div className="flex w-full gap-2 sm:w-auto">
						<Input
							value={hostName}
							onChange={(event) => setHostName(event.target.value)}
							placeholder="例如：Mac Studio Runner"
							className="sm:w-64"
						/>
						<Button
							disabled={!hostName.trim() || createHostMutation.isPending}
							onClick={() => createHostMutation.mutate(hostName.trim())}
						>
							<Plus className="size-4" /> 创建 Host
						</Button>
					</div>
				</div>

				{enrollment?.enrollmentToken && (
					<Card className="border-amber-500/40 bg-amber-500/5">
						<CardHeader>
							<CardTitle className="text-sm">
								一次性 Host enrollment token
							</CardTitle>
							<p className="text-xs text-muted-foreground">
								请立即交给受信任的 Host。关闭或刷新页面后不会再次显示。
							</p>
						</CardHeader>
						<CardContent className="space-y-2">
							<code className="block overflow-x-auto rounded-md bg-background p-3 text-xs">
								{enrollment.enrollmentToken}
							</code>
							<p className="font-mono text-xs text-muted-foreground">
								Host ID: {enrollment.hostId}
							</p>
						</CardContent>
					</Card>
				)}

				{createHostMutation.isError && (
					<p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
						Host 创建失败，请确认会话仍有效后重试。
					</p>
				)}

				<div className="grid gap-3 md:grid-cols-2">
					{hostsQuery.isLoading ? (
						<p className="text-sm text-muted-foreground">正在读取 Host…</p>
					) : hosts.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							尚未登记 Agent Host。
						</p>
					) : (
						hosts.map((host) => {
							const runtime = hostRuntimeById.get(host.id);
							return (
								<Card
									key={`${host.id}:${runtime?.labels_version ?? 0}`}
									className="border-border/60"
								>
									<CardContent className="pt-5">
										<div className="flex items-start justify-between gap-3">
											<div className="min-w-0 space-y-1">
												<p className="flex items-center gap-2 font-medium">
													<ServerCog className="size-4" /> {host.name}
												</p>
												<p className="truncate font-mono text-xs text-muted-foreground">
													{host.id}
												</p>
												<Badge variant="outline">{host.status}</Badge>
											</div>
											{host.status !== "revoked" && (
												<Button
													variant="outline"
													size="sm"
													className="text-destructive"
													disabled={revokeHostMutation.isPending}
													onClick={() => {
														if (
															window.confirm(
																`确定撤销 Host“${host.name}”及其 Agent 吗？`,
															)
														) {
															revokeHostMutation.mutate(host.id);
														}
													}}
												>
													<Trash2 className="size-3.5" /> 撤销
												</Button>
											)}
										</div>
										<HostRuntimeControls
											hostId={host.id}
											profile={runtime}
											onSaved={() =>
												queryClient.invalidateQueries({
													queryKey: ["agent-auth", "host-runtimes"],
												})
											}
										/>
									</CardContent>
								</Card>
							);
						})
					)}
				</div>
			</section>

			<section className="space-y-3">
				<div>
					<h2 className="flex items-center gap-2 text-lg font-semibold">
						<ShieldPlus className="size-4" /> Autonomous 最小授权
						<Badge variant={autonomousEnabled ? "secondary" : "outline"}>
							{autonomousEnabled ? "已启用" : "未配置"}
						</Badge>
					</h2>
					<p className="text-xs text-muted-foreground">
						为已通过基础设施 enrollment 的 autonomous Agent 授予 15 分钟、单
						Project 的只读能力。服务端仍会检查你的 agents.approveGrant 权限。
					</p>
				</div>
				<Card className="border-border/60">
					<CardContent className="space-y-3 pt-5">
						<div className="grid gap-3 md:grid-cols-2">
							<Input
								value={autonomousAgentId}
								onChange={(event) => {
									setAutonomousAgentId(event.target.value);
									setAutonomousGrantState(null);
								}}
								placeholder="Autonomous Agent ID"
								className="font-mono"
							/>
							<Input
								value={autonomousProjectId}
								onChange={(event) => {
									setAutonomousProjectId(event.target.value);
									setAutonomousGrantState(null);
								}}
								placeholder="Project UUID"
								className="font-mono"
							/>
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<Button
								disabled={
									!autonomousEnabled ||
									!autonomousAgentId.trim() ||
									!autonomousProjectId.trim() ||
									autonomousGrantMutation.isPending
								}
								onClick={() =>
									autonomousGrantMutation.mutate({
										agentId: autonomousAgentId.trim(),
										projectId: autonomousProjectId.trim(),
									})
								}
							>
								授予 project.read
							</Button>
							<Button
								variant="outline"
								className="text-destructive"
								disabled={
									!autonomousEnabled ||
									!autonomousAgentId.trim() ||
									autonomousRevokeMutation.isPending
								}
								onClick={() =>
									autonomousRevokeMutation.mutate(autonomousAgentId.trim())
								}
							>
								撤销 project.read
							</Button>
							{autonomousGrantState && (
								<Badge variant="secondary">
									{autonomousGrantState === "granted" ? "已授权" : "已撤销"}
								</Badge>
							)}
						</div>
						{(autonomousGrantMutation.isError ||
							autonomousRevokeMutation.isError) && (
							<p className="text-sm text-destructive">
								操作失败：请核对 Agent、Project 和 approveGrant 权限。
							</p>
						)}
					</CardContent>
				</Card>
			</section>

			<section className="space-y-3">
				<h2 className="text-lg font-semibold">Agents</h2>

				{agentsQuery.isLoading ? (
					<p className="py-12 text-center text-sm text-muted-foreground">
						正在读取 Agent…
					</p>
				) : agentsQuery.isError ? (
					<p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
						Agent 列表加载失败，请刷新后重试。
					</p>
				) : agents.length === 0 ? (
					<Card className="border-dashed">
						<CardContent className="flex flex-col items-center gap-3 py-14 text-center">
							<ShieldCheck className="size-8 text-muted-foreground/50" />
							<p className="text-sm font-medium">尚未批准任何 Agent</p>
							<p className="max-w-lg text-xs text-muted-foreground">
								Agent 或 Host 发起 device authorization
								后，请打开返回的验证网址并核对授权码。
							</p>
						</CardContent>
					</Card>
				) : (
					<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
						{agents.map((agent) => (
							<Card key={agent.agent_id} className="border-border/60">
								<CardHeader className="gap-2">
									<div className="flex items-start justify-between gap-3">
										<CardTitle className="truncate text-base">
											{agent.name}
										</CardTitle>
										<Badge variant="outline">{agent.status}</Badge>
									</div>
									<p className="truncate font-mono text-xs text-muted-foreground">
										{agent.agent_id}
									</p>
								</CardHeader>
								<CardContent className="space-y-4 text-sm">
									<div className="space-y-1.5 text-xs text-muted-foreground">
										<p className="flex items-center gap-2">
											<KeyRound className="size-3.5" /> {agent.mode} ·{" "}
											{agent.host_name}
										</p>
										<p className="flex items-center gap-2">
											<Clock3 className="size-3.5" />
											{new Date(agent.created_at).toLocaleString()}
										</p>
									</div>
									<div className="flex flex-wrap gap-1.5">
										{agent.agent_capability_grants.map((grant) => (
											<Badge
												key={grant.capability}
												variant={
													grant.status === "active" ? "secondary" : "outline"
												}
											>
												{grant.capability} · {grant.status}
											</Badge>
										))}
									</div>
									{agent.status !== "revoked" && (
										<Button
											variant="outline"
											size="sm"
											className="text-destructive"
											disabled={revokeMutation.isPending}
											onClick={() => {
												if (
													window.confirm(`确定撤销 Agent“${agent.name}”吗？`)
												) {
													revokeMutation.mutate(agent.agent_id);
												}
											}}
										>
											<Trash2 className="size-3.5" /> 撤销
										</Button>
									)}
								</CardContent>
							</Card>
						))}
					</div>
				)}
			</section>
		</div>
	);
}
