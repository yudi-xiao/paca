import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
	CircleAlert,
	ListTodo,
	Loader2,
	Plus,
	Search,
	Trash2,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useProjectPermissions } from "@/hooks/use-project-permissions";
import {
	allTasksQueryOptions,
	createTask,
	deleteTask,
	updateTask,
} from "@/lib/interaction-api";
import {
	projectQueryOptions,
	taskStatusesQueryOptions,
	taskTypesQueryOptions,
} from "@/lib/project-api";

export const Route = createFileRoute(
	"/_authenticated/projects/$projectId/tasks/",
)({
	component: InternalPreviewTasksPage,
});

function InternalPreviewTasksPage() {
	const { projectId } = Route.useParams();
	const queryClient = useQueryClient();
	const { hasProjectPermission } = useProjectPermissions(projectId);
	const canWrite = hasProjectPermission("tasks.write");
	const [title, setTitle] = useState("");
	const [searchDraft, setSearchDraft] = useState("");
	const [search, setSearch] = useState("");
	const [error, setError] = useState<string | null>(null);

	const projectQuery = useQuery(projectQueryOptions(projectId));
	const typesQuery = useQuery(taskTypesQueryOptions(projectId));
	const statusesQuery = useQuery(taskStatusesQueryOptions(projectId));
	const tasksQuery = useQuery(
		allTasksQueryOptions(projectId, { pageSize: 100, search }),
	);

	const invalidateTasks = async () => {
		await Promise.all([
			queryClient.invalidateQueries({
				queryKey: ["projects", projectId, "tasks"],
			}),
			queryClient.invalidateQueries({ queryKey: ["workspace-stats"] }),
		]);
	};

	const createMutation = useMutation({
		mutationFn: () => createTask(projectId, { title }),
		onSuccess: async () => {
			setTitle("");
			setError(null);
			await invalidateTasks();
		},
		onError: () => setError("创建任务失败，请检查输入或稍后重试。"),
	});

	const statusMutation = useMutation({
		mutationFn: ({
			taskId,
			statusId,
		}: {
			taskId: string;
			statusId: string | null;
		}) => updateTask(projectId, taskId, { status_id: statusId }),
		onSuccess: invalidateTasks,
		onError: () => setError("更新任务状态失败。"),
	});

	const deleteMutation = useMutation({
		mutationFn: (taskId: string) => deleteTask(projectId, taskId),
		onSuccess: invalidateTasks,
		onError: () => setError("归档任务失败。"),
	});

	const statusById = useMemo(
		() =>
			new Map((statusesQuery.data ?? []).map((status) => [status.id, status])),
		[statusesQuery.data],
	);
	const typeById = useMemo(
		() =>
			new Map(
				(typesQuery.data ?? []).map((taskType) => [taskType.id, taskType]),
			),
		[typesQuery.data],
	);

	const submitCreate = (event: FormEvent) => {
		event.preventDefault();
		if (!title.trim() || createMutation.isPending) return;
		createMutation.mutate();
	};

	const submitSearch = (event: FormEvent) => {
		event.preventDefault();
		setSearch(searchDraft.trim());
	};

	const isLoading =
		projectQuery.isLoading ||
		typesQuery.isLoading ||
		statusesQuery.isLoading ||
		tasksQuery.isLoading;
	const loadFailed =
		projectQuery.isError ||
		typesQuery.isError ||
		statusesQuery.isError ||
		tasksQuery.isError;
	const tasks = tasksQuery.data?.items ?? [];

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
			<header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
				<div>
					<div className="flex items-center gap-2">
						<ListTodo className="size-5 text-primary" />
						<h1 className="font-[Syne] text-2xl font-bold tracking-tight">
							任务
						</h1>
					</div>
					<p className="mt-1 text-sm text-muted-foreground">
						{projectQuery.data?.name ?? "项目"} · PostgreSQL 任务纵向切片
					</p>
				</div>
				<Badge variant="outline">{tasksQuery.data?.total_count ?? 0} 项</Badge>
			</header>

			{canWrite && (
				<Card className="border-border/60">
					<CardHeader className="pb-3">
						<CardTitle className="text-base">新建任务</CardTitle>
					</CardHeader>
					<CardContent>
						<form
							className="flex flex-col gap-3 sm:flex-row"
							onSubmit={submitCreate}
						>
							<Input
								value={title}
								onChange={(event) => setTitle(event.target.value)}
								placeholder="输入任务标题"
								maxLength={500}
								disabled={createMutation.isPending}
							/>
							<Button
								type="submit"
								disabled={!title.trim() || createMutation.isPending}
							>
								{createMutation.isPending ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									<Plus className="size-4" />
								)}
								创建
							</Button>
						</form>
					</CardContent>
				</Card>
			)}

			<Card className="border-border/60">
				<CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
					<CardTitle className="text-base">任务列表</CardTitle>
					<form className="flex w-full gap-2 sm:w-80" onSubmit={submitSearch}>
						<Input
							value={searchDraft}
							onChange={(event) => setSearchDraft(event.target.value)}
							placeholder="按标题或 #编号搜索"
							maxLength={200}
						/>
						<Button
							type="submit"
							size="icon"
							variant="outline"
							aria-label="搜索任务"
						>
							<Search className="size-4" />
						</Button>
					</form>
				</CardHeader>
				<CardContent>
					{error && (
						<div className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
							<CircleAlert className="size-4" />
							{error}
						</div>
					)}

					{isLoading ? (
						<div className="flex items-center justify-center gap-2 py-14 text-sm text-muted-foreground">
							<Loader2 className="size-4 animate-spin" /> 正在读取任务…
						</div>
					) : loadFailed ? (
						<div className="py-14 text-center text-sm text-destructive">
							任务数据加载失败。
						</div>
					) : tasks.length === 0 ? (
						<div className="py-14 text-center text-sm text-muted-foreground">
							{search ? "没有匹配的任务。" : "还没有任务，可以先创建第一项。"}
						</div>
					) : (
						<div className="divide-y divide-border/50 rounded-lg border border-border/60">
							{tasks.map((task) => {
								const status = task.status_id
									? statusById.get(task.status_id)
									: undefined;
								const taskType = task.task_type_id
									? typeById.get(task.task_type_id)
									: undefined;
								return (
									<div
										key={task.id}
										className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_11rem_7rem_auto] sm:items-center"
									>
										<div className="min-w-0">
											<Link
												to="/projects/$projectId/tasks/$taskId"
												params={{ projectId, taskId: task.id }}
												className="block truncate text-sm font-medium hover:text-primary hover:underline"
											>
												{task.title}
											</Link>
											<p className="mt-0.5 text-xs text-muted-foreground">
												#{task.task_number} ·{" "}
												{new Date(task.updated_at).toLocaleString()}
											</p>
										</div>
										<select
											className="h-9 rounded-md border border-input bg-background px-3 text-sm disabled:opacity-60"
											value={task.status_id ?? ""}
											disabled={!canWrite || statusMutation.isPending}
											onChange={(event) =>
												statusMutation.mutate({
													taskId: task.id,
													statusId: event.target.value || null,
												})
											}
										>
											<option value="">无状态</option>
											{(statusesQuery.data ?? []).map((option) => (
												<option key={option.id} value={option.id}>
													{option.name}
												</option>
											))}
										</select>
										<Badge variant="secondary" className="w-fit">
											{taskType?.name ?? "未分类"}
										</Badge>
										{canWrite && (
											<Button
												type="button"
												variant="ghost"
												size="icon"
												aria-label={`归档 ${task.title}`}
												disabled={deleteMutation.isPending}
												onClick={() => {
													if (window.confirm(`确定归档“${task.title}”吗？`)) {
														deleteMutation.mutate(task.id);
													}
												}}
											>
												<Trash2 className="size-4 text-muted-foreground" />
											</Button>
										)}
										<span className="sr-only">{status?.name ?? "无状态"}</span>
									</div>
								);
							})}
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
