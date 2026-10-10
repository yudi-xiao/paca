import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePermissions } from "@/hooks/use-permissions";
import { useProjectPermissions } from "@/hooks/use-project-permissions";
import {
	configureDeliveryRepository,
	type DeliveryRepositoryCommand,
	deliveryErrorCode,
	deliveryOutcomeUncertain,
	deliveryRepositoryQueryOptions,
	discoverDeliveryRepository,
	type RepositoryDiscovery,
	type RepositoryDiscoveryInput,
} from "@/lib/github-delivery-api";

const checkKey = (check: { name: string; appId: number }) =>
	`${check.appId}:${check.name}`;
export function GitHubDeliverySettings({ projectId }: { projectId: string }) {
	const { hasPermission } = usePermissions();
	const { hasProjectPermission } = useProjectPermissions(projectId);
	return (
		<RepositorySettings
			key={projectId}
			projectId={projectId}
			canManage={
				hasPermission("settings.write") &&
				hasProjectPermission("projects.write")
			}
		/>
	);
}
function RepositorySettings({
	projectId,
	canManage,
}: {
	projectId: string;
	canManage: boolean;
}) {
	const { t } = useTranslation("projects");
	const id = useId();
	const client = useQueryClient();
	const query = useQuery({
		...deliveryRepositoryQueryOptions(projectId),
		refetchInterval: 30000,
	});
	const current = query.isError ? null : query.data;
	const [repositoryDraft, setRepositoryDraft] = useState<string | null>(null);
	const [reviewerDraft, setReviewerDraft] = useState<string | null>(null);
	const [approvalsDraft, setApprovalsDraft] = useState<string | null>(null);
	const [ageDraft, setAgeDraft] = useState<string | null>(null);
	const [pull, setPull] = useState("");
	const [discovered, setDiscovered] = useState<{
		result: RepositoryDiscovery;
		version: number;
	} | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	const [retryCommand, setRetryCommand] =
		useState<DeliveryRepositoryCommand | null>(null);
	const [saved, setSaved] = useState(false);
	const discovery = useMutation({
		mutationFn: (input: {
			request: RepositoryDiscoveryInput;
			version: number;
		}) => discoverDeliveryRepository(projectId, input.request),
		retry: false,
		onSuccess: (result, input) => {
			setDiscovered({ result, version: input.version });
			setReviewerDraft(result.reviewers.map((user) => user.login).join(", "));
			const required = new Set(
				current?.policy.requiredChecks.map(checkKey) ?? [],
			);
			setSelected(
				result.checks
					.filter((check) => required.has(checkKey(check)))
					.map(checkKey),
			);
		},
	});
	const save = useMutation({
		mutationFn: (input: DeliveryRepositoryCommand) =>
			configureDeliveryRepository(projectId, input),
		retry: false,
		onSuccess: async (result) => {
			setRetryCommand(null);
			setDiscovered(null);
			setSelected([]);
			setSaved(true);
			client.setQueryData(
				deliveryRepositoryQueryOptions(projectId).queryKey,
				result,
			);
			// Policy changes invalidate every task's evidence, including open cards.
			await client.invalidateQueries({
				queryKey: ["projects", projectId, "tasks"],
			});
			await query.refetch();
		},
		onError: async (error, input) => {
			setRetryCommand(deliveryOutcomeUncertain(error) ? input : null);
			if (!deliveryOutcomeUncertain(error)) {
				setDiscovered(null);
				setSelected([]);
			}
			await query.refetch();
		},
	});
	const repository =
		repositoryDraft ??
		(current ? `${current.policy.owner}/${current.policy.repository}` : "");
	const match =
		/^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})$/.exec(
			repository.trim(),
		);
	const reviewerNames = reviewerDraft
		?.split(/[,\s]+/)
		.map((name) => name.trim())
		.filter(Boolean);
	const validNames =
		reviewerNames === undefined ||
		(reviewerNames.length <= 20 &&
			new Set(reviewerNames.map((name) => name.toLowerCase())).size ===
				reviewerNames.length &&
			reviewerNames.every((name) =>
				/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(name),
			));
	const approvals =
		approvalsDraft ?? String(current?.policy.requiredApprovals ?? 0);
	const age =
		ageDraft ?? String((current?.policy.maxCheckAgeSeconds ?? 86400) / 60);
	const ageSeconds = Math.round(Number(age) * 60);
	const busy = query.isFetching || discovery.isPending || save.isPending;
	const blocked = busy || !!retryCommand || query.isError || query.isPending;
	const versionChanged =
		discovered !== null && discovered.version !== (current?.version ?? 0);
	const canDiscover =
		canManage &&
		!blocked &&
		match &&
		match[2] !== "." &&
		match[2] !== ".." &&
		validNames &&
		/^[1-9][0-9]*$/.test(pull) &&
		Number.isSafeInteger(Number(pull));
	const checks =
		discovered?.result.checks.filter((check) =>
			selected.includes(checkKey(check)),
		) ?? [];
	const canSave =
		canManage &&
		!blocked &&
		discovered &&
		!versionChanged &&
		checks.length > 0 &&
		checks.length <= 20 &&
		/^[0-5]$/.test(approvals) &&
		Number(approvals) <= discovered.result.reviewers.length &&
		age.trim() !== "" &&
		Number.isFinite(Number(age)) &&
		ageSeconds >= 60 &&
		ageSeconds <= 604800;
	function edit() {
		setDiscovered(null);
		setSelected([]);
		setSaved(false);
		discovery.reset();
		save.reset();
	}
	const saveError = save.isError ? deliveryErrorCode(save.error) : undefined;
	return (
		<section className="space-y-5 rounded-xl border border-border/60 bg-card p-6">
			<div>
				<h3 className="text-base font-semibold">
					{t("repositorySettings.title")}
				</h3>
				<p className="mt-2 text-sm text-muted-foreground">
					{t("repositorySettings.hint")}
				</p>
			</div>
			{query.isPending && <p role="status">{t("search.loading")}</p>}
			{query.isError && (
				<div role="alert">
					<p>{t("delivery.error")}</p>
					<Button variant="outline" onClick={() => void query.refetch()}>
						{t("search.retry")}
					</Button>
				</div>
			)}
			{current && (
				<div className="space-y-2 rounded-md border p-3 text-sm">
					<a
						className="text-primary underline"
						target="_blank"
						rel="noopener noreferrer"
						href={`https://github.com/${current.policy.owner}/${current.policy.repository}`}
					>
						{current.policy.owner}/{current.policy.repository}
					</a>
					<p>
						{t(
							current.status === "active"
								? "repositorySettings.connected"
								: "delivery.revoked",
						)}
					</p>
					<ul className="list-inside list-disc">
						{current.policy.requiredChecks.map((check) => (
							<li key={checkKey(check)}>
								{check.name} ·{" "}
								{t("repositorySettings.publisher", { id: check.appId })}
							</li>
						))}
					</ul>
					<p>
						{t("repositorySettings.reviewPolicy", {
							count: current.policy.requiredApprovals,
							reviewers: current.policy.reviewerIds.length,
						})}
					</p>
				</div>
			)}
			{!canManage && (
				<p className="text-sm text-muted-foreground">
					{t("repositorySettings.readOnly")}
				</p>
			)}
			{canManage && (
				<div className="space-y-4">
					<form
						className="space-y-3"
						onSubmit={(event) => {
							event.preventDefault();
							if (!canDiscover || !match) return;
							setSaved(false);
							setDiscovered(null);
							setSelected([]);
							save.reset();
							const reviewers =
								reviewerNames === undefined
									? { reviewerIds: current?.policy.reviewerIds ?? [] }
									: { reviewerLogins: reviewerNames };
							discovery.mutate({
								version: current?.version ?? 0,
								request: {
									owner: match[1],
									repository: match[2],
									pullNumber: Number(pull),
									...reviewers,
								},
							});
						}}
					>
						<label className="block text-sm" htmlFor={`${id}-repository`}>
							{t("repositorySettings.repository")}
						</label>
						<Input
							id={`${id}-repository`}
							placeholder="owner/repository"
							value={repository}
							maxLength={140}
							disabled={blocked}
							onChange={(event) => {
								setRepositoryDraft(event.target.value);
								edit();
							}}
						/>
						<label className="block text-sm" htmlFor={`${id}-pull`}>
							{t("repositorySettings.samplePr")}
						</label>
						<Input
							id={`${id}-pull`}
							type="number"
							min="1"
							step="1"
							value={pull}
							disabled={blocked}
							onChange={(event) => {
								setPull(event.target.value);
								edit();
							}}
						/>
						<p className="text-xs text-muted-foreground">
							{t("repositorySettings.sampleHint")}
						</p>
						<label className="block text-sm" htmlFor={`${id}-reviewers`}>
							{t("repositorySettings.reviewers")}
						</label>
						<Input
							id={`${id}-reviewers`}
							value={reviewerDraft ?? ""}
							maxLength={800}
							disabled={blocked}
							placeholder={
								current?.policy.reviewerIds.length && reviewerDraft === null
									? t("repositorySettings.keepReviewers")
									: "alice, bob"
							}
							onChange={(event) => {
								setReviewerDraft(event.target.value);
								edit();
							}}
						/>
						<Button type="submit" disabled={!canDiscover}>
							{discovery.isPending
								? t("search.loading")
								: t("repositorySettings.discover")}
						</Button>
					</form>
					{discovery.isError && (
						<p role="alert" className="text-sm">
							{t("repositorySettings.discoveryError")}
						</p>
					)}
					{discovered && (
						<form
							className="space-y-4 border-t pt-4"
							onSubmit={(event) => {
								event.preventDefault();
								if (!canSave || !discovered) return;
								save.mutate({
									requestId: crypto.randomUUID(),
									expectedVersion: discovered.version,
									repositoryId: discovered.result.repositoryId,
									installationId: discovered.result.installationId,
									policy: {
										owner: discovered.result.owner,
										repository: discovered.result.repository,
										requiredChecks: checks.map((check) => ({
											name: check.name,
											appId: check.appId,
										})),
										reviewerIds: discovered.result.reviewers.map(
											(user) => user.id,
										),
										requiredApprovals: Number(approvals),
										maxCheckAgeSeconds: ageSeconds,
									},
								});
							}}
						>
							<fieldset
								disabled={blocked || versionChanged}
								className="space-y-2"
							>
								<legend className="mb-2 text-sm font-medium">
									{t("repositorySettings.checks")}
								</legend>
								<div className="max-h-80 space-y-2 overflow-y-auto">
									{discovered.result.checks.map((check) => (
										<label
											key={checkKey(check)}
											className="flex items-start gap-2 rounded-md border p-3 text-sm"
										>
											<input
												type="checkbox"
												checked={selected.includes(checkKey(check))}
												onChange={(event) =>
													setSelected((value) =>
														event.target.checked
															? [...value, checkKey(check)]
															: value.filter((key) => key !== checkKey(check)),
													)
												}
												disabled={
													blocked ||
													versionChanged ||
													(!selected.includes(checkKey(check)) &&
														selected.length >= 20)
												}
											/>
											<span className="min-w-0 break-words">
												{check.name}
												<span className="ml-2 text-muted-foreground">
													{check.appName ? `${check.appName} · ` : ""}
													{t("repositorySettings.publisher", {
														id: check.appId,
													})}
												</span>
											</span>
										</label>
									))}
								</div>
								{discovered.result.checks.length === 0 && (
									<p>{t("repositorySettings.noChecks")}</p>
								)}
							</fieldset>
							{discovered.result.reviewers.length > 0 && (
								<p className="text-sm">
									{t("repositorySettings.verifiedReviewers", {
										names: discovered.result.reviewers
											.map((user) => user.login)
											.join(", "),
									})}
								</p>
							)}
							<label className="block text-sm" htmlFor={`${id}-approvals`}>
								{t("repositorySettings.approvals")}
							</label>
							<Input
								id={`${id}-approvals`}
								type="number"
								min="0"
								max={Math.min(5, discovered.result.reviewers.length)}
								step="1"
								value={approvals}
								disabled={blocked || versionChanged}
								onChange={(event) => {
									setApprovalsDraft(event.target.value);
									setSaved(false);
								}}
							/>
							<label className="block text-sm" htmlFor={`${id}-age`}>
								{t("repositorySettings.age")}
							</label>
							<Input
								id={`${id}-age`}
								type="number"
								min="1"
								max="10080"
								step="any"
								value={age}
								disabled={blocked || versionChanged}
								onChange={(event) => {
									setAgeDraft(event.target.value);
									setSaved(false);
								}}
							/>
							<p className="text-sm text-muted-foreground">
								{t("repositorySettings.saveHint")}
							</p>
							{versionChanged && <p role="alert">{t("delivery.conflict")}</p>}
							{!versionChanged &&
								!canSave &&
								selected.length > 0 &&
								!blocked && (
									<p role="alert">{t("repositorySettings.invalidPolicy")}</p>
								)}
							<Button type="submit" disabled={!canSave}>
								{t("repositorySettings.save")}
							</Button>
						</form>
					)}
					{save.isError && (
						<div role="alert" className="space-y-2">
							<p>
								{t(
									saveError === "DELIVERY_VERSION_CONFLICT"
										? "delivery.conflict"
										: "delivery.error",
								)}
							</p>
							{retryCommand && (
								<Button
									variant="outline"
									disabled={busy || query.isError}
									onClick={() => save.mutate(retryCommand)}
								>
									{t("search.retry")}
								</Button>
							)}
						</div>
					)}
					{saved && (
						<p role="status" className="text-sm">
							{t("repositorySettings.saved")}
						</p>
					)}
				</div>
			)}
		</section>
	);
}
