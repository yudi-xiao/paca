import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
	ArrowLeft,
	CircleAlert,
	Loader2,
	MessageSquare,
	Save,
	Trash2,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { AttachmentsSection } from "@/components/projects/interactions/task-detail/attachments-section";
import { SubtasksSection } from "@/components/projects/interactions/task-detail/subtasks-section";
import { TaskLinksSection } from "@/components/projects/interactions/task-detail/task-links-section";
import {
	blocksToText,
	textToBlocks,
} from "@/components/shared/comment-blocknote";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useProjectPermissions } from "@/hooks/use-project-permissions";
import { currentUserQueryOptions } from "@/lib/auth-api";
import {
	type Activity,
	addComment,
	createTask,
	deleteComment,
	deleteTask,
	listTaskActivities,
	listTaskPages,
	subtasksQueryOptions,
	taskQueryOptions,
	updateComment,
	updateTask,
} from "@/lib/interaction-api";
import {
	projectMembersQueryOptions,
	projectQueryOptions,
	taskStatusesQueryOptions,
	taskTypesQueryOptions,
} from "@/lib/project-api";

type Props = {
	projectId: string;
	taskId: string;
};

function activityText(activity: Activity): string {
	if (activity.activity_type === "task.created") return "创建了任务";
	if (activity.activity_type === "task.deleted") return "归档了任务";
	if (activity.activity_type === "task.attachment.added") {
		const fileName = (activity.content as { file_name?: unknown })?.file_name;
		return typeof fileName === "string"
			? `添加了附件：${fileName}`
			: "添加了附件";
	}
	if (activity.activity_type === "task.attachment.removed") {
		const fileName = (activity.content as { file_name?: unknown })?.file_name;
		return typeof fileName === "string"
			? `移除了附件：${fileName}`
			: "移除了附件";
	}
	if (activity.activity_type === "task.attachment.restored") {
		const fileName = (activity.content as { file_name?: unknown })?.file_name;
		return typeof fileName === "string"
			? `恢复了附件：${fileName}`
			: "恢复了附件";
	}
	if (activity.activity_type === "task.link.added") return "添加了关联工作项";
	if (activity.activity_type === "task.link.removed") return "移除了关联工作项";
	if (activity.activity_type !== "task.updated") return "更新了任务";
	const changes =
		(activity.content as { changes?: Array<{ field?: unknown }> }).changes ??
		[];
	if (changes.length === 0) return "更新了任务";
	const labels: Record<string, string> = {
		title: "标题",
		status: "状态",
		task_type: "类型",
		parent_task: "父任务",
		description: "描述",
		importance: "优先级",
		story_points: "故事点",
		assignee: "负责人",
		custom_fields: "自定义字段",
		start_date: "开始日期",
		due_date: "截止日期",
		tags: "标签",
	};
	return `更新了${changes
		.map(
			(change) =>
				labels[String(change.field)] ?? String(change.field ?? "字段"),
		)
		.join("、")}`;
}

function commentText(activity: Activity): string {
	if (!Array.isArray(activity.content)) return "";
	return blocksToText(activity.content);
}

export function InternalPreviewTaskDetail({ projectId, taskId }: Props) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const { hasProjectPermission } = useProjectPermissions(projectId);
	const canWrite = hasProjectPermission("tasks.write");
	const taskQuery = useQuery(taskQueryOptions(projectId, taskId));
	const projectQuery = useQuery(projectQueryOptions(projectId));
	const statusesQuery = useQuery(taskStatusesQueryOptions(projectId));
	const typesQuery = useQuery(taskTypesQueryOptions(projectId));
	const membersQuery = useQuery(projectMembersQueryOptions(projectId));
	const currentUserQuery = useQuery(currentUserQueryOptions);
	const activitiesQuery = useQuery({
		queryKey: ["projects", projectId, "tasks", taskId, "activities"],
		queryFn: () => listTaskActivities(projectId, taskId),
	});
	const subtasksQuery = useQuery(subtasksQueryOptions(projectId, taskId));
	const projectTasksQuery = useQuery({
		queryKey: ["projects", projectId, "tasks", "parent-picker"],
		queryFn: () => listTaskPages(projectId),
		staleTime: 15_000,
	});

	const [title, setTitle] = useState("");
	const [statusId, setStatusId] = useState("");
	const [taskTypeId, setTaskTypeId] = useState("");
	const [parentTaskId, setParentTaskId] = useState("");
	const [importance, setImportance] = useState("0");
	const [storyPoints, setStoryPoints] = useState("");
	const [startDate, setStartDate] = useState("");
	const [dueDate, setDueDate] = useState("");
	const [tags, setTags] = useState("");
	const [description, setDescription] = useState("");
	const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
	const [comment, setComment] = useState("");
	const [error, setError] = useState<string | null>(null);

	const task = taskQuery.data;
	const originalDescription = useMemo(
		() => blocksToText(task?.description ?? []),
		[task?.description],
	);

	useEffect(() => {
		if (!task) return;
		setTitle(task.title);
		setStatusId(task.status_id ?? "");
		setTaskTypeId(task.task_type_id ?? "");
		setParentTaskId(task.parent_task_id ?? "");
		setImportance(String(task.importance));
		setStoryPoints(task.story_points == null ? "" : String(task.story_points));
		setStartDate(task.start_date ?? "");
		setDueDate(task.due_date ?? "");
		setTags((task.tags ?? []).join(", "));
		setDescription(blocksToText(task.description ?? []));
		setAssigneeIds(task.assignee_ids ?? []);
	}, [task]);

	const invalidate = async () => {
		await Promise.all([
			queryClient.invalidateQueries({
				queryKey: ["projects", projectId, "tasks"],
			}),
			queryClient.invalidateQueries({
				queryKey: ["projects", projectId, "tasks", taskId, "activities"],
			}),
			queryClient.invalidateQueries({ queryKey: ["workspace-stats"] }),
		]);
	};

	const saveMutation = useMutation({
		mutationFn: async () => {
			if (!task) throw new Error("TASK_NOT_LOADED");
			const parsedImportance = Number(importance);
			const parsedStoryPoints =
				storyPoints.trim() === "" ? null : Number(storyPoints);
			if (!Number.isInteger(parsedImportance) || parsedImportance < 0) {
				throw new Error("TASK_IMPORTANCE_INVALID");
			}
			if (
				parsedStoryPoints !== null &&
				(!Number.isInteger(parsedStoryPoints) || parsedStoryPoints < 0)
			) {
				throw new Error("TASK_STORY_POINTS_INVALID");
			}
			const payload: Parameters<typeof updateTask>[2] = {
				title,
				status_id: statusId || null,
				task_type_id: taskTypeId || null,
				parent_task_id: parentTaskId || null,
				importance: parsedImportance,
				story_points: parsedStoryPoints,
				start_date: startDate || null,
				due_date: dueDate || null,
				tags: [
					...new Set(
						tags
							.split(",")
							.map((tag) => tag.trim())
							.filter(Boolean),
					),
				],
				assignee_ids: assigneeIds,
			};
			if (description !== originalDescription) {
				payload.description = description.trim()
					? textToBlocks(description)
					: null;
			}
			return updateTask(projectId, taskId, payload);
		},
		onSuccess: async (updated) => {
			setError(null);
			queryClient.setQueryData(
				taskQueryOptions(projectId, taskId).queryKey,
				updated,
			);
			await invalidate();
		},
		onError: () => setError("保存任务失败，请检查字段后重试。"),
	});

	const archiveMutation = useMutation({
		mutationFn: () => deleteTask(projectId, taskId),
		onSuccess: async () => {
			await invalidate();
			await navigate({
				to: "/projects/$projectId/tasks",
				params: { projectId },
			});
		},
		onError: () => setError("归档任务失败。"),
	});

	const commentMutation = useMutation({
		mutationFn: () =>
			addComment(projectId, taskId, textToBlocks(comment.trim())),
		onSuccess: async () => {
			setComment("");
			setError(null);
			await invalidate();
		},
		onError: () => setError("发表评论失败。"),
	});

	const editCommentMutation = useMutation({
		mutationFn: ({ id, text }: { id: string; text: string }) =>
			updateComment(projectId, taskId, id, textToBlocks(text)),
		onSuccess: invalidate,
		onError: () => setError("修改评论失败。"),
	});

	const deleteCommentMutation = useMutation({
		mutationFn: (id: string) => deleteComment(projectId, taskId, id),
		onSuccess: invalidate,
		onError: () => setError("删除评论失败。"),
	});

	const submitComment = (event: FormEvent) => {
		event.preventDefault();
		if (!comment.trim() || commentMutation.isPending) return;
		commentMutation.mutate();
	};

	if (taskQuery.isLoading) {
		return (
			<div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
				<Loader2 className="size-4 animate-spin" /> 正在读取任务详情…
			</div>
		);
	}

	if (!task || taskQuery.isError) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
				<CircleAlert className="size-9" />
				<p>任务不存在、已归档，或你没有读取权限。</p>
				<Link
					to="/projects/$projectId/tasks"
					params={{ projectId }}
					className="text-primary underline"
				>
					返回任务列表
				</Link>
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<div className="flex shrink-0 items-center gap-3 border-b border-border/50 px-5 py-3">
				<Link
					to="/projects/$projectId/tasks"
					params={{ projectId }}
					className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeft className="size-4" /> 任务列表
				</Link>
				<span className="text-muted-foreground/40">/</span>
				<Badge variant="outline">
					{projectQuery.data?.task_id_prefix
						? `${projectQuery.data.task_id_prefix}-`
						: "#"}
					{task.task_number}
				</Badge>
			</div>

			<div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_22rem] lg:overflow-hidden">
				<div className="overflow-y-auto p-5 lg:p-8">
					<div className="mx-auto max-w-3xl space-y-6">
						<header>
							<p className="text-sm text-muted-foreground">
								{projectQuery.data?.name ?? "项目"}
							</p>
							<h1 className="mt-1 font-[Syne] text-2xl font-bold">任务详情</h1>
						</header>

						{error && (
							<div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
								<CircleAlert className="size-4" /> {error}
							</div>
						)}

						<Card>
							<CardHeader>
								<CardTitle className="text-base">基本信息</CardTitle>
							</CardHeader>
							<CardContent className="space-y-5">
								<label
									htmlFor="task-title"
									className="block space-y-1.5 text-sm font-medium"
								>
									标题
									<Input
										id="task-title"
										value={title}
										onChange={(event) => setTitle(event.target.value)}
										disabled={!canWrite}
										maxLength={500}
									/>
								</label>
								<div className="grid gap-4 sm:grid-cols-2">
									<label className="space-y-1.5 text-sm font-medium">
										状态
										<select
											className="h-10 w-full rounded-md border border-input bg-background px-3"
											value={statusId}
											onChange={(event) => setStatusId(event.target.value)}
											disabled={!canWrite}
										>
											<option value="">无状态</option>
											{(statusesQuery.data ?? []).map((status) => (
												<option key={status.id} value={status.id}>
													{status.name}
												</option>
											))}
										</select>
									</label>
									<label className="space-y-1.5 text-sm font-medium">
										类型
										<select
											className="h-10 w-full rounded-md border border-input bg-background px-3"
											value={taskTypeId}
											onChange={(event) => setTaskTypeId(event.target.value)}
											disabled={!canWrite}
										>
											<option value="">未分类</option>
											{(typesQuery.data ?? []).map((type) => (
												<option key={type.id} value={type.id}>
													{type.name}
												</option>
											))}
										</select>
									</label>
									<label className="space-y-1.5 text-sm font-medium sm:col-span-2">
										父工作项
										<select
											className="h-10 w-full rounded-md border border-input bg-background px-3"
											value={parentTaskId}
											onChange={(event) => setParentTaskId(event.target.value)}
											disabled={!canWrite || projectTasksQuery.isLoading}
										>
											<option value="">无父工作项</option>
											{(projectTasksQuery.data ?? [])
												.filter((candidate) => candidate.id !== taskId)
												.map((candidate) => (
													<option key={candidate.id} value={candidate.id}>
														{projectQuery.data?.task_id_prefix
															? `${projectQuery.data.task_id_prefix}-${candidate.task_number}`
															: `#${candidate.task_number}`}{" "}
														{candidate.title}
													</option>
												))}
										</select>
									</label>
									<label
										htmlFor="task-importance"
										className="space-y-1.5 text-sm font-medium"
									>
										优先级
										<Input
											id="task-importance"
											type="number"
											min="0"
											value={importance}
											onChange={(event) => setImportance(event.target.value)}
											disabled={!canWrite}
										/>
									</label>
									<label
										htmlFor="task-story-points"
										className="space-y-1.5 text-sm font-medium"
									>
										故事点
										<Input
											id="task-story-points"
											type="number"
											min="0"
											value={storyPoints}
											onChange={(event) => setStoryPoints(event.target.value)}
											disabled={!canWrite}
										/>
									</label>
									<label
										htmlFor="task-start-date"
										className="space-y-1.5 text-sm font-medium"
									>
										开始日期
										<Input
											id="task-start-date"
											type="date"
											value={startDate}
											onChange={(event) => setStartDate(event.target.value)}
											disabled={!canWrite}
										/>
									</label>
									<label
										htmlFor="task-due-date"
										className="space-y-1.5 text-sm font-medium"
									>
										截止日期
										<Input
											id="task-due-date"
											type="date"
											value={dueDate}
											onChange={(event) => setDueDate(event.target.value)}
											disabled={!canWrite}
										/>
									</label>
								</div>
								<label
									htmlFor="task-tags"
									className="block space-y-1.5 text-sm font-medium"
								>
									标签
									<Input
										id="task-tags"
										value={tags}
										onChange={(event) => setTags(event.target.value)}
										disabled={!canWrite}
										placeholder="用逗号分隔"
									/>
								</label>
								<label className="block space-y-1.5 text-sm font-medium">
									描述
									<textarea
										className="min-h-32 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
										value={description}
										onChange={(event) => setDescription(event.target.value)}
										disabled={!canWrite}
										placeholder="补充任务背景、范围和验收条件"
									/>
								</label>
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle className="text-base">负责人</CardTitle>
							</CardHeader>
							<CardContent className="grid gap-2 sm:grid-cols-2">
								{(membersQuery.data ?? []).map((member) => (
									<label
										key={member.id}
										className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm"
									>
										<input
											type="checkbox"
											checked={assigneeIds.includes(member.id)}
											disabled={!canWrite}
											onChange={(event) =>
												setAssigneeIds((current) =>
													event.target.checked
														? [...new Set([...current, member.id])]
														: current.filter((id) => id !== member.id),
												)
											}
										/>
										<span>{member.full_name || member.username}</span>
									</label>
								))}
								{membersQuery.data?.length === 0 && (
									<p className="text-sm text-muted-foreground">
										项目中还没有可分配成员。
									</p>
								)}
							</CardContent>
						</Card>

						<Card>
							<CardContent className="pt-6">
								<SubtasksSection
									projectId={projectId}
									parentTaskId={taskId}
									subtasks={subtasksQuery.data ?? []}
									statuses={statusesQuery.data ?? []}
									taskTypes={typesQuery.data ?? []}
									members={membersQuery.data ?? []}
									canEdit={canWrite}
									task={task}
									taskIdPrefix={projectQuery.data?.task_id_prefix ?? ""}
									normalTaskTypes={(typesQuery.data ?? []).filter(
										(type) => !type.is_system,
									)}
									onSubtaskClick={(subtask) => {
										void navigate({
											to: "/projects/$projectId/tasks/$taskId",
											params: { projectId, taskId: subtask.id },
										});
									}}
									onSubtaskUpdate={(subtaskId, payload) => {
										void updateTask(projectId, subtaskId, payload)
											.then(invalidate)
											.catch(() => setError("更新子工作项失败。"));
									}}
									onSubtaskCreate={(payload) => {
										const defaultStatus =
											(statusesQuery.data ?? []).find(
												(status) => status.category === "todo",
											) ?? statusesQuery.data?.[0];
										void createTask(projectId, {
											...payload,
											status_id: payload.status_id ?? defaultStatus?.id ?? null,
											parent_task_id: taskId,
										})
											.then(invalidate)
											.catch(() => setError("创建子工作项失败。"));
									}}
								/>
							</CardContent>
						</Card>

						<Card>
							<CardContent className="pt-6">
								<TaskLinksSection
									projectId={projectId}
									taskId={taskId}
									taskIdPrefix={projectQuery.data?.task_id_prefix ?? ""}
									canEdit={canWrite}
									onNavigateToTask={(linkedTaskId) => {
										void navigate({
											to: "/projects/$projectId/tasks/$taskId",
											params: { projectId, taskId: linkedTaskId },
										});
									}}
								/>
							</CardContent>
						</Card>

						<Card>
							<CardContent className="pt-6">
								<AttachmentsSection
									projectId={projectId}
									taskId={taskId}
									canEdit={canWrite}
								/>
							</CardContent>
						</Card>

						{canWrite && (
							<div className="flex flex-wrap justify-between gap-3">
								<Button
									variant="destructive"
									disabled={archiveMutation.isPending}
									onClick={() => {
										if (window.confirm(`确定归档“${task.title}”吗？`))
											archiveMutation.mutate();
									}}
								>
									<Trash2 className="size-4" /> 归档任务
								</Button>
								<Button
									disabled={!title.trim() || saveMutation.isPending}
									onClick={() => saveMutation.mutate()}
								>
									{saveMutation.isPending ? (
										<Loader2 className="size-4 animate-spin" />
									) : (
										<Save className="size-4" />
									)}{" "}
									保存修改
								</Button>
							</div>
						)}
					</div>
				</div>

				<aside className="flex min-h-[28rem] flex-col border-t border-border/50 bg-muted/10 lg:min-h-0 lg:border-t-0 lg:border-l">
					<div className="flex items-center gap-2 border-b border-border/50 px-4 py-3 text-sm font-semibold">
						<MessageSquare className="size-4" /> 活动与评论
					</div>
					<div className="flex-1 space-y-3 overflow-y-auto p-4">
						{activitiesQuery.isLoading && (
							<p className="text-sm text-muted-foreground">正在读取活动…</p>
						)}
						{activitiesQuery.isError && (
							<p className="text-sm text-destructive">活动记录加载失败。</p>
						)}
						{activitiesQuery.data?.length === 0 && (
							<p className="text-sm text-muted-foreground">暂无活动。</p>
						)}
						{activitiesQuery.data?.map((activity) => {
							const isOwnComment =
								activity.activity_type === "comment" &&
								(activity.actor_type === undefined ||
									activity.actor_type === "user") &&
								activity.actor_id === currentUserQuery.data?.id;
							const text = commentText(activity);
							return (
								<div
									key={activity.id}
									className="rounded-lg border border-border/60 bg-background p-3 text-sm"
								>
									<div className="flex items-center justify-between gap-2">
										<span className="font-medium">
											{activity.actor_name || "系统"}
										</span>
										<span className="text-xs text-muted-foreground">
											{new Date(activity.created_at).toLocaleString()}
										</span>
									</div>
									<p className="mt-2 whitespace-pre-wrap text-muted-foreground">
										{activity.activity_type === "comment"
											? text
											: activityText(activity)}
									</p>
									{isOwnComment && canWrite && (
										<div className="mt-2 flex gap-2">
											<Button
												size="sm"
												variant="ghost"
												onClick={() => {
													const next = window.prompt("修改评论", text);
													if (next?.trim())
														editCommentMutation.mutate({
															id: activity.id,
															text: next.trim(),
														});
												}}
											>
												编辑
											</Button>
											<Button
												size="sm"
												variant="ghost"
												onClick={() => {
													if (window.confirm("确定删除这条评论吗？"))
														deleteCommentMutation.mutate(activity.id);
												}}
											>
												删除
											</Button>
										</div>
									)}
								</div>
							);
						})}
					</div>
					{canWrite && (
						<form
							className="space-y-2 border-t border-border/50 p-3"
							onSubmit={submitComment}
						>
							<textarea
								className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
								value={comment}
								onChange={(event) => setComment(event.target.value)}
								placeholder="添加评论"
								maxLength={20_000}
							/>
							<Button
								type="submit"
								className="w-full"
								disabled={!comment.trim() || commentMutation.isPending}
							>
								{commentMutation.isPending ? (
									<Loader2 className="size-4 animate-spin" />
								) : null}
								发表评论
							</Button>
						</form>
					)}
				</aside>
			</div>
		</div>
	);
}
