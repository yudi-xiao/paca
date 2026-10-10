import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionConfig, SprintFieldUpdate } from "@/lib/automation-api";
import { sprintsQueryOptions } from "@/lib/interaction-api";

type Props = {
	type: string;
	config: ActionConfig;
	projectId: string;
	canEdit: boolean;
	saving?: boolean;
	onSave: (config: Record<string, unknown>) => void;
};
const fields = ["name", "start_date", "end_date", "goal", "status"] as const;
const labels = {
	name: "sprintNameLabel",
	start_date: "sprintStartDateLabel",
	end_date: "sprintEndDateLabel",
	goal: "sprintGoalLabel",
	status: "sprintStatusLabel",
} as const;
const selectClass =
	"h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50";
export function SprintActionConfig({
	type,
	config,
	projectId,
	canEdit,
	saving,
	onSave,
}: Props) {
	const { t } = useTranslation("projects");
	const id = useId();
	const [update, setUpdate] = useState<SprintFieldUpdate>(
		config.sprint_update ?? {},
	);
	const [enabled, setEnabled] = useState(
		() => new Set(Object.keys(config.sprint_update ?? {})),
	);
	const [destination, setDestination] = useState(
		config.move_to_sprint_id ?? "",
	);
	const query = useQuery({
		...sprintsQueryOptions(projectId),
		enabled: type === "complete_sprint" && !!projectId,
	});
	const label = (field: (typeof fields)[number]) =>
		t(`automation.nodeConfig.action.${labels[field]}`);
	const disabled = !canEdit || !!saving;
	const patch = Object.fromEntries(
		fields
			.filter((field) => enabled.has(field))
			.map((field) => [field, update[field]]),
	);
	const invalidName =
		enabled.has("name") &&
		(!update.name?.trim() || update.name.trim().length > 200);
	const invalidGoal =
		enabled.has("goal") && (update.goal?.trim().length ?? 0) > 10_000;
	const invalidDates =
		["start_date", "end_date"].some((field) => {
			if (!enabled.has(field)) return false;
			const value = patch[field];
			if (value === null) return false;
			if (
				typeof value !== "string" ||
				!/^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z)?$/.test(value)
			)
				return true;
			const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
			return (
				Number.isNaN(date.getTime()) ||
				date.toISOString().slice(0, 10) !== value.slice(0, 10)
			);
		}) ||
		(enabled.has("start_date") &&
			enabled.has("end_date") &&
			!!update.start_date &&
			!!update.end_date &&
			update.start_date.slice(0, 10) > update.end_date.slice(0, 10));
	const invalidStatus =
		enabled.has("status") &&
		!["planned", "active", "completed"].includes(update.status ?? "");
	const invalid = invalidName || invalidGoal || invalidDates || invalidStatus;
	const setField = (field: (typeof fields)[number], value: string | null) =>
		setUpdate((prev) => ({ ...prev, [field]: value }));
	const destinations = (query.data ?? []).filter(
		(sprint) => sprint.status !== "completed",
	);
	const destinationMissing =
		!!destination &&
		!query.isPending &&
		!query.isError &&
		!destinations.some((sprint) => sprint.id === destination);
	const destinationUnavailable =
		!!destination && (query.isPending || query.isError || destinationMissing);
	return (
		<div className="space-y-3">
			<p className="text-xs text-muted-foreground">
				{t(
					`automation.nodeConfig.action.${type === "update_sprint" ? "sprintContextHint" : "completeSprintHint"}`,
				)}
			</p>
			{type === "update_sprint" ? (
				<>
					{fields.map((field) => (
						<div key={field} className="space-y-1.5">
							<label className="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									checked={enabled.has(field)}
									disabled={disabled}
									onChange={(event) => {
										setEnabled((prev) => {
											const next = new Set(prev);
											if (event.target.checked) next.add(field);
											else next.delete(field);
											return next;
										});
										if (event.target.checked && update[field] === undefined)
											setField(field, field === "status" ? "planned" : "");
									}}
								/>
								{t("automation.nodeConfig.action.enableField", {
									field: label(field),
								})}
							</label>
							{enabled.has(field) && (
								<>
									<Label htmlFor={`${id}-${field}`}>{label(field)}</Label>
									{field === "status" ? (
										<select
											id={`${id}-${field}`}
											value={update.status ?? "planned"}
											onChange={(event) => setField(field, event.target.value)}
											disabled={disabled}
											className={selectClass}
										>
											{(["planned", "active", "completed"] as const).map(
												(status) => (
													<option key={status} value={status}>
														{t(
															`automation.nodeConfig.action.sprintStatus${({ planned: "Planned", active: "Active", completed: "Completed" } as const)[status]}`,
														)}
													</option>
												),
											)}
										</select>
									) : field === "goal" ? (
										<Textarea
											id={`${id}-${field}`}
											value={update.goal ?? ""}
											onChange={(event) => setField(field, event.target.value)}
											rows={3}
											disabled={disabled || update.goal === null}
										/>
									) : (
										<Input
											id={`${id}-${field}`}
											type={field === "name" ? "text" : "date"}
											value={
												field === "name"
													? (update.name ?? "")
													: (update[field] ?? "").slice(0, 10)
											}
											onChange={(event) => setField(field, event.target.value)}
											disabled={disabled || update[field] === null}
										/>
									)}
									{(field === "goal" ||
										field === "start_date" ||
										field === "end_date") && (
										<label className="flex items-center gap-2 text-xs">
											<input
												type="checkbox"
												checked={update[field] === null}
												disabled={disabled}
												onChange={(event) =>
													setField(field, event.target.checked ? null : "")
												}
											/>
											{t("automation.nodeConfig.action.clearSprintField", {
												field: label(field),
											})}
										</label>
									)}
								</>
							)}
						</div>
					))}
					<p className="text-xs text-muted-foreground">
						{t("automation.nodeConfig.action.variablesHint")}
					</p>
					{enabled.has("status") && update.status === "completed" && (
						<p className="text-xs text-muted-foreground">
							{t("automation.nodeConfig.action.sprintStatusOnlyHint")}
						</p>
					)}
					{invalid && (
						<p role="alert" className="text-xs text-destructive">
							{t("automation.nodeConfig.action.sprintUpdateInvalid")}
						</p>
					)}
					{canEdit && (
						<Button
							className="w-full"
							size="sm"
							disabled={disabled || enabled.size === 0 || invalid}
							onClick={() => onSave({ sprint_update: patch })}
						>
							{t("automation.nodeConfig.save")}
						</Button>
					)}
				</>
			) : (
				<>
					<Label htmlFor={`${id}-destination`}>
						{t("automation.nodeConfig.action.moveToSprintLabel")}
					</Label>
					<select
						id={`${id}-destination`}
						value={destination}
						onChange={(event) => setDestination(event.target.value)}
						disabled={disabled || query.isPending}
						className={selectClass}
					>
						<option value="">
							{t("automation.nodeConfig.action.moveToSprintBacklog")}
						</option>
						{!!destination &&
							!destinations.some((sprint) => sprint.id === destination) && (
								<option value={destination} disabled>
									{t("automation.nodeConfig.action.sprintDestinationMissing")}
								</option>
							)}
						{destinations.map((sprint) => (
							<option key={sprint.id} value={sprint.id}>
								{sprint.name}
							</option>
						))}
					</select>
					{query.isPending && (
						<p role="status" className="text-xs text-muted-foreground">
							{t("automation.nodeConfig.trigger.loadingMore")}
						</p>
					)}
					{query.isError && (
						<div role="alert" className="space-y-1 text-xs text-destructive">
							{t("automation.nodeConfig.trigger.sprintsLoadFailed")}
							<Button
								variant="outline"
								size="sm"
								disabled={query.isFetching}
								onClick={() => void query.refetch()}
							>
								{t("automation.nodeConfig.trigger.retryLoad")}
							</Button>
						</div>
					)}
					{destinationMissing && (
						<p role="alert" className="text-xs text-destructive">
							{t("automation.nodeConfig.action.sprintDestinationMissing")}
						</p>
					)}
					<p className="text-xs text-muted-foreground">
						{t("automation.nodeConfig.action.moveToSprintHint")}
					</p>
					{canEdit && (
						<Button
							size="sm"
							className="w-full"
							disabled={disabled || destinationUnavailable}
							onClick={() =>
								onSave({ move_to_sprint_id: destination || undefined })
							}
						>
							{t("automation.nodeConfig.save")}
						</Button>
					)}
				</>
			)}
		</div>
	);
}
