import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
	Bot,
	CheckCircle2,
	KeyRound,
	ShieldAlert,
	ShieldCheck,
	XCircle,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	AgentAuthApiError,
	agentAuthAgentsQueryOptions,
	reauthenticateAndApproveAgent,
	resolveAgentAuthorization,
} from "@/lib/agent-auth-api";
import { currentUserQueryOptions } from "@/lib/auth-api";

export const Route = createFileRoute("/_authenticated/device/capabilities")({
	validateSearch: (search: Record<string, unknown>) => ({
		agent_id: typeof search.agent_id === "string" ? search.agent_id : "",
		code: typeof search.code === "string" ? search.code : "",
	}),
	component: AgentCapabilityApprovalRoute,
});

function AgentCapabilityApprovalRoute() {
	const search = Route.useSearch();
	return (
		<AgentCapabilityApprovalPage
			key={`${search.agent_id}:${search.code}`}
			initialAgentId={search.agent_id}
			initialUserCode={search.code}
		/>
	);
}

function AgentCapabilityApprovalPage({
	initialAgentId,
	initialUserCode,
}: {
	initialAgentId: string;
	initialUserCode: string;
}) {
	const queryClient = useQueryClient();
	const [agentId, setAgentId] = useState(initialAgentId);
	const [userCode, setUserCode] = useState(initialUserCode);
	const [reauthPassword, setReauthPassword] = useState("");
	const [resolvedAction, setResolvedAction] = useState<
		"approve" | "deny" | null
	>(null);
	const agentsQuery = useQuery(agentAuthAgentsQueryOptions);
	const currentUserQuery = useQuery(currentUserQueryOptions);
	const approverEmail =
		currentUserQuery.data?.email ?? currentUserQuery.data?.username ?? "";
	const previewAgent = agentsQuery.data?.find(
		(agent) => agent.agent_id === agentId.trim(),
	);

	const mutation = useMutation({
		mutationFn: (action: "approve" | "deny") =>
			resolveAgentAuthorization({
				agentId: agentId.trim(),
				userCode: userCode.trim(),
				action,
			}),
		onSuccess: async (_data, action) => {
			await queryClient.invalidateQueries({ queryKey: ["agent-auth"] });
			setResolvedAction(action);
		},
	});
	const approvalErrorCode =
		mutation.error instanceof AgentAuthApiError ? mutation.error.code : null;
	const needsFreshSession =
		approvalErrorCode?.toLowerCase() === "fresh_session_required";
	const reauthMutation = useMutation({
		mutationFn: () =>
			reauthenticateAndApproveAgent({
				email: approverEmail,
				password: reauthPassword,
				agentId: agentId.trim(),
				userCode: userCode.trim(),
			}),
		onSuccess: async () => {
			setReauthPassword("");
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["auth"] }),
				queryClient.invalidateQueries({ queryKey: ["agent-auth"] }),
			]);
			setResolvedAction("approve");
		},
	});
	const reauthErrorCode =
		reauthMutation.error instanceof AgentAuthApiError
			? reauthMutation.error.code
			: null;
	const normalizedApprovalErrorCode = approvalErrorCode?.toLowerCase();
	const approvalErrorMessage =
		normalizedApprovalErrorCode === "fresh_session_required"
			? "当前登录 Session 不够新。请在下方重新验证当前账号，页面会保留本次授权上下文并自动重试。"
			: approvalErrorCode === "AGENT_APPROVAL_PERMISSION_DENIED"
				? "当前用户没有该项目的 agents.approveGrant 权限。"
				: approvalErrorCode === "AGENT_APPROVAL_CONSTRAINTS_INVALID"
					? "Agent 请求的 Grant constraints 无效。"
					: approvalErrorCode === "AGENT_APPROVAL_PROJECT_SCOPE_MISMATCH"
						? "Agent 请求的 Organization/Project 作用域与实际项目不一致。"
						: normalizedApprovalErrorCode === "invalid_user_code"
							? "授权码不正确，请使用 Agent Host 最新显示的授权码。"
							: normalizedApprovalErrorCode === "approval_expired"
								? "授权码已过期，请让 Agent Host 为同一 Agent 重新签发设备授权码。"
								: normalizedApprovalErrorCode ===
										"capability_request_already_resolved"
									? "该授权申请已经处理，请返回 Agent 管理页核对最新状态。"
									: "请核对授权码、Grant 约束和项目审批权限。";

	if (resolvedAction) {
		return (
			<div className="mx-auto flex w-full max-w-xl flex-1 items-center p-6">
				<Card className="w-full">
					<CardContent className="flex flex-col items-center gap-4 py-12 text-center">
						{resolvedAction === "approve" ? (
							<CheckCircle2 className="size-10 text-emerald-600" />
						) : (
							<XCircle className="size-10 text-destructive" />
						)}
						<h1 className="text-lg font-semibold">
							{resolvedAction === "approve"
								? "Agent 授权已批准"
								: "Agent 授权已拒绝"}
						</h1>
						<p className="text-sm text-muted-foreground">
							可以关闭此页面并返回 Agent Host。
						</p>
						<Button
							render={<Link to="/admin/agents" search={{ create: false }} />}
							variant="outline"
						>
							查看 Agent
						</Button>
					</CardContent>
				</Card>
			</div>
		);
	}

	return (
		<div className="mx-auto flex w-full max-w-xl flex-1 items-center p-6">
			<Card className="w-full border-border/60">
				<CardHeader>
					<div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
						<Bot className="size-5" />
					</div>
					<CardTitle>核对 Agent Capability Grant</CardTitle>
					<p className="text-sm text-muted-foreground">
						批准前请确认 Agent ID 和授权码与 Agent Host
						显示的内容完全一致。服务端还会校验
						Project、Organization、有效期和你的 approveGrant 权限。
					</p>
				</CardHeader>
				<CardContent className="space-y-5">
					{previewAgent && (
						<div className="space-y-3 rounded-lg border bg-muted/20 p-4">
							<div className="flex items-start justify-between gap-3">
								<div>
									<p className="font-medium">{previewAgent.name}</p>
									<p className="text-xs text-muted-foreground">
										Host：{previewAgent.host_name} · {previewAgent.mode}
									</p>
								</div>
								<Badge variant="outline">{previewAgent.status}</Badge>
							</div>
							<div className="space-y-2">
								<p className="text-xs font-medium">请求的 Capability 与约束</p>
								{previewAgent.agent_capability_grants.map((grant) => (
									<div
										key={grant.capability}
										className="rounded-md bg-background p-2"
									>
										<div className="flex items-center justify-between gap-2">
											<code className="text-xs">{grant.capability}</code>
											<Badge variant="secondary">{grant.status}</Badge>
										</div>
										{grant.constraints && (
											<pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground">
												{JSON.stringify(grant.constraints, null, 2)}
											</pre>
										)}
									</div>
								))}
							</div>
						</div>
					)}
					<div className="space-y-1.5">
						<Label htmlFor="agent-id">Agent ID</Label>
						<Input
							id="agent-id"
							value={agentId}
							onChange={(event) => setAgentId(event.target.value)}
							placeholder="agent identifier"
							className="font-mono"
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="user-code">授权码</Label>
						<div className="relative">
							<KeyRound className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input
								id="user-code"
								value={userCode}
								onChange={(event) =>
									setUserCode(event.target.value.toUpperCase())
								}
								placeholder="XXXX-XXXX"
								className="pl-9 font-mono uppercase tracking-wider"
							/>
						</div>
					</div>
					{mutation.isError && !needsFreshSession && (
						<div className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
							<ShieldAlert className="mt-0.5 size-4 shrink-0" />
							<div>
								<p>授权处理失败。{approvalErrorMessage}</p>
								{approvalErrorCode && (
									<code className="mt-1 block text-xs">
										{approvalErrorCode}
									</code>
								)}
							</div>
						</div>
					)}
					{needsFreshSession && (
						<div className="space-y-3 rounded-lg border border-amber-300/60 bg-amber-50/70 p-4 dark:border-amber-700/60 dark:bg-amber-950/20">
							<div className="flex gap-2 text-sm text-amber-900 dark:text-amber-200">
								<ShieldCheck className="mt-0.5 size-4 shrink-0" />
								<div>
									<p className="font-medium">需要重新验证当前账号</p>
									<p className="mt-1 text-xs opacity-80">
										{approvalErrorMessage}
									</p>
									{approverEmail && (
										<p className="mt-1 text-xs opacity-80">
											账号：{approverEmail}
										</p>
									)}
								</div>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="reauth-password">当前密码</Label>
								<Input
									id="reauth-password"
									type="password"
									autoComplete="current-password"
									value={reauthPassword}
									onChange={(event) => setReauthPassword(event.target.value)}
									onKeyDown={(event) => {
										if (
											event.key === "Enter" &&
											reauthPassword.length >= 12 &&
											approverEmail
										) {
											event.preventDefault();
											reauthMutation.mutate();
										}
									}}
								/>
							</div>
							{reauthMutation.isError && (
								<p className="text-xs text-destructive">
									重新认证或审批失败，请检查密码与授权码。
									{reauthErrorCode ? ` (${reauthErrorCode})` : ""}
								</p>
							)}
							<Button
								className="w-full"
								disabled={
									!approverEmail ||
									reauthPassword.length < 12 ||
									reauthMutation.isPending
								}
								onClick={() => reauthMutation.mutate()}
							>
								{reauthMutation.isPending
									? "正在重新认证并批准…"
									: "重新认证并批准"}
							</Button>
						</div>
					)}
					<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
						<Button
							variant="outline"
							disabled={
								!agentId.trim() ||
								mutation.isPending ||
								reauthMutation.isPending
							}
							onClick={() => mutation.mutate("deny")}
						>
							拒绝
						</Button>
						<Button
							disabled={
								!agentId.trim() ||
								!userCode.trim() ||
								mutation.isPending ||
								reauthMutation.isPending ||
								needsFreshSession
							}
							onClick={() => mutation.mutate("approve")}
						>
							批准 Capability Grant
						</Button>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
