import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useProjectPermissions } from "@/hooks/use-project-permissions";
import {
	completedDeliveryRunsQueryOptions,
	type DeliveryCommand,
	deliveryRepositoryQueryOptions,
	executeDeliveryCommand,
	taskDeliveryQueryOptions,
} from "@/lib/github-delivery-api";

function errorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object" || !("response" in error))
		return undefined;
	const response = error.response;
	if (!response || typeof response !== "object" || !("data" in response))
		return undefined;
	const data = response.data;
	return data &&
		typeof data === "object" &&
		"error_code" in data &&
		typeof data.error_code === "string"
		? data.error_code
		: undefined;
}
export function TaskDeliveryCard({
	projectId,
	taskId,
}: {
	projectId: string;
	taskId: string;
}) {
	const { hasProjectPermission } = useProjectPermissions(projectId);
	if (!hasProjectPermission("tasks.read")) return null;
	// Remount on task switches so a retry can never reuse another task's command.
	return (
		<DeliveryContent
			key={`${projectId}:${taskId}`}
			projectId={projectId}
			taskId={taskId}
			canWrite={hasProjectPermission("tasks.write")}
		/>
	);
}
function DeliveryContent({
	projectId,
	taskId,
	canWrite,
}: {
	projectId: string;
	taskId: string;
	canWrite: boolean;
}) {
	const { t } = useTranslation("projects");
	const client = useQueryClient();
	const id = useId();
	const repository = useQuery(deliveryRepositoryQueryOptions(projectId));
	const query = useQuery({
		...taskDeliveryQueryOptions(projectId, taskId),
		refetchInterval: 30000,
	});
	const runs = useInfiniteQuery({
		...completedDeliveryRunsQueryOptions(projectId, taskId),
		enabled: canWrite && repository.data?.status === "active",
	});
	const [runId, setRunId] = useState("");
	const [pull, setPull] = useState("");
	const [sha, setSha] = useState("");
	const [note, setNote] = useState("");
	const [clock, setClock] = useState(Date.now);
	const [retryCommand, setRetryCommand] = useState<DeliveryCommand | null>(
		null,
	);
	useEffect(() => {
		const timer = window.setInterval(() => setClock(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, []);
	const mutation = useMutation({
		mutationFn: (command: DeliveryCommand) =>
			executeDeliveryCommand(projectId, taskId, command),
		retry: false,
		onSuccess: async (delivery) => {
			setRetryCommand(null);
			setNote("");
			client.setQueryData(
				taskDeliveryQueryOptions(projectId, taskId).queryKey,
				delivery,
			);
			await client.invalidateQueries({
				queryKey: taskDeliveryQueryOptions(projectId, taskId).queryKey,
			});
		},
		onError: async (error, command) => {
			// Unknown transport outcome must retry the same request ID and version.
			// Known domain failures require fresh state and a new explicit decision.
			setRetryCommand(errorCode(error) ? null : command);
			await Promise.all([query.refetch(), repository.refetch()]);
		},
	});
	const delivery = query.isError ? null : query.data;
	const noteReference = `${delivery?.reference.pullNumber ?? ""}:${delivery?.reference.headSha ?? ""}`;
	const previousNoteReference = useRef(noteReference);
	useEffect(() => {
		if (previousNoteReference.current !== noteReference) {
			previousNoteReference.current = noteReference;
			setNote("");
		}
	}, [noteReference]);
	const observed = Date.parse(delivery?.evidence.observedAt ?? "");
	const expired =
		!Number.isFinite(observed) ||
		clock - observed > 60000 ||
		observed > clock + 5000;
	const state =
		delivery &&
		expired &&
		["accepted", "awaiting_acceptance"].includes(delivery.state)
			? "stale"
			: delivery?.state;
	const active = repository.data?.status === "active";
	const busy = mutation.isPending || query.isFetching || repository.isFetching;
	const items = [
		...new Map(
			(runs.data?.pages.flatMap((page) => page.items) ?? []).map((run) => [
				run.leaseId,
				run,
			]),
		).values(),
	];
	const canSubmit =
		active &&
		canWrite &&
		!query.isError &&
		!runs.isError &&
		!busy &&
		!retryCommand &&
		items.some((run) => run.leaseId === runId) &&
		/^[1-9][0-9]*$/.test(pull) &&
		Number.isSafeInteger(Number(pull)) &&
		/^[a-f0-9]{40}$/.test(sha);
	function act(command: DeliveryCommand) {
		if (!busy && canWrite && active && !retryCommand) mutation.mutate(command);
	}
	const error = mutation.isError ? errorCode(mutation.error) : undefined;
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">{t("delivery.title")}</CardTitle>
				<p className="text-sm text-muted-foreground">{t("delivery.hint")}</p>
			</CardHeader>
			<CardContent className="space-y-4">
				{(repository.isPending || query.isPending) && (
					<p role="status">{t("search.loading")}</p>
				)}
				{(repository.isError || query.isError) && (
					<div role="alert">
						<p>{t("delivery.error")}</p>
						<Button
							variant="outline"
							onClick={() => {
								void repository.refetch();
								void query.refetch();
							}}
						>
							{t("search.retry")}
						</Button>
					</div>
				)}
				{!repository.isPending && !repository.isError && !repository.data && (
					<p>{t("delivery.noRepository")}</p>
				)}
				{repository.data?.status === "revoked" && (
					<p role="alert">{t("delivery.revoked")}</p>
				)}
				{delivery && (
					<div className="space-y-2">
						<p role="status" className="font-medium">
							{t(`delivery.state.${state ?? "unavailable"}`)}
						</p>
						<a
							href={`https://github.com/${delivery.evidence.repository}/pull/${delivery.reference.pullNumber}`}
							target="_blank"
							rel="noopener noreferrer"
							className="text-primary underline"
						>
							{delivery.evidence.repository} #{delivery.reference.pullNumber}
						</a>
						<p className="break-all font-mono text-xs">
							{delivery.reference.headSha}
						</p>
						{delivery.evidence.reasons.includes("PR_IS_DRAFT") && (
							<p className="text-sm">{t("delivery.draft")}</p>
						)}
						{delivery.evidence.reasons.includes("PR_HEAD_CHANGED") && (
							<p className="text-sm">{t("delivery.headChanged")}</p>
						)}
						<ul className="space-y-1 text-sm">
							{delivery.evidence.checks.map((check) => (
								<li
									key={`${check.appId}:${check.name}`}
									className="flex flex-wrap justify-between gap-2"
								>
									<span className="break-words">{check.name}</span>
									<span>{t(`delivery.check.${check.state}`)}</span>
								</li>
							))}
						</ul>
						{repository.data && (
							<p className="text-sm">
								{t("delivery.reviews", {
									count: delivery.evidence.approvalCount,
									required: repository.data.policy.requiredApprovals,
								})}
							</p>
						)}
						{Number.isFinite(observed) && (
							<p className="text-xs text-muted-foreground">
								{t("delivery.observed", {
									time: new Date(observed).toLocaleString(),
								})}
							</p>
						)}
						{delivery.reviewNote && (
							<p className="whitespace-pre-wrap break-words text-sm">
								{delivery.reviewNote}
							</p>
						)}
						{delivery.lastAcceptance && state !== "accepted" && (
							<p className="text-xs text-muted-foreground">
								{t("delivery.previousAcceptance", {
									time: new Date(delivery.lastAcceptance.at).toLocaleString(),
								})}
							</p>
						)}
						{canWrite && active && !query.isError && (
							<div className="space-y-2">
								<label htmlFor={`${id}-note`} className="block text-sm">
									{t("delivery.note")}
								</label>
								<textarea
									id={`${id}-note`}
									value={note}
									onChange={(event) => setNote(event.target.value)}
									maxLength={2000}
									disabled={busy || !!retryCommand}
									className="min-h-20 w-full rounded-md border bg-background p-2 text-sm"
								/>
								<div className="flex flex-wrap gap-2">
									<Button
										variant="outline"
										disabled={busy || !!retryCommand}
										onClick={() =>
											act({
												operation: "refresh",
												input: {
													requestId: crypto.randomUUID(),
													expectedVersion: delivery.version,
												},
											})
										}
									>
										{t("delivery.refresh")}
									</Button>
									<Button
										disabled={
											busy ||
											!!retryCommand ||
											state !== "awaiting_acceptance" ||
											expired ||
											delivery.requiresRefresh
										}
										onClick={() =>
											act({
												operation: "decision",
												input: {
													requestId: crypto.randomUUID(),
													expectedVersion: delivery.version,
													decision: "accept",
													note: note.trim(),
												},
											})
										}
									>
										{t("delivery.accept")}
									</Button>
									<Button
										variant="outline"
										disabled={busy || !!retryCommand || !note.trim()}
										onClick={() =>
											act({
												operation: "decision",
												input: {
													requestId: crypto.randomUUID(),
													expectedVersion: delivery.version,
													decision: "request_changes",
													note: note.trim(),
												},
											})
										}
									>
										{t("delivery.requestChanges")}
									</Button>
								</div>
							</div>
						)}
					</div>
				)}
				{canWrite && active && !query.isError && (
					<form
						className="space-y-3 border-t pt-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (canSubmit)
								act({
									operation: "submit",
									input: {
										requestId: crypto.randomUUID(),
										expectedVersion: delivery?.version ?? 0,
										leaseId: runId,
										pullNumber: Number(pull),
										headSha: sha,
									},
								});
						}}
					>
						<label htmlFor={`${id}-run`} className="block text-sm">
							{t("delivery.run")}
						</label>
						<select
							id={`${id}-run`}
							value={runId}
							onChange={(event) => setRunId(event.target.value)}
							disabled={busy || !!retryCommand}
							className="w-full rounded-md border bg-background p-2 text-sm"
						>
							<option value="">{t("delivery.chooseRun")}</option>
							{items.map((run) => (
								<option key={run.leaseId} value={run.leaseId}>
									{run.harnessKind} ·{" "}
									{new Date(run.finishedAt).toLocaleString()} ·{" "}
									{run.leaseId.slice(0, 8)}
								</option>
							))}
						</select>
						{runs.isPending && <p role="status">{t("search.loading")}</p>}
						{runs.isError && (
							<div role="alert">
								<p>{t("delivery.error")}</p>
								<Button
									type="button"
									variant="outline"
									onClick={() => void runs.refetch()}
								>
									{t("search.retry")}
								</Button>
							</div>
						)}
						{!runs.isPending && !runs.isError && items.length === 0 && (
							<p className="text-sm text-muted-foreground">
								{t("delivery.noRuns")}
							</p>
						)}
						{runs.hasNextPage && (
							<Button
								type="button"
								variant="outline"
								disabled={runs.isFetchingNextPage}
								onClick={() => void runs.fetchNextPage()}
							>
								{t("search.more")}
							</Button>
						)}
						<label htmlFor={`${id}-pr`} className="block text-sm">
							{t("delivery.pr")}
						</label>
						<Input
							id={`${id}-pr`}
							type="number"
							min="1"
							step="1"
							value={pull}
							onChange={(event) => setPull(event.target.value)}
							disabled={busy || !!retryCommand}
						/>
						<label htmlFor={`${id}-sha`} className="block text-sm">
							{t("delivery.sha")}
						</label>
						<Input
							id={`${id}-sha`}
							value={sha}
							maxLength={40}
							onChange={(event) =>
								setSha(event.target.value.trim().toLowerCase())
							}
							disabled={busy || !!retryCommand}
							className="font-mono"
						/>
						<Button type="submit" disabled={!canSubmit}>
							{t("delivery.submit")}
						</Button>
					</form>
				)}
				{mutation.isError && (
					<div role="alert" className="space-y-2">
						<p>
							{t(
								error === "DELIVERY_VERSION_CONFLICT"
									? "delivery.conflict"
									: error === "DELIVERY_EVIDENCE_NOT_READY"
										? "delivery.notReady"
										: "delivery.error",
							)}
						</p>
						{retryCommand && canWrite && active && (
							<Button
								variant="outline"
								disabled={busy}
								onClick={() => mutation.mutate(retryCommand)}
							>
								{t("search.retry")}
							</Button>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
