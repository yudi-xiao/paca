import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useProjectPermissions } from "@/hooks/use-project-permissions";
import {
	type ProjectSearchKind,
	projectSearchQueryOptions,
} from "@/lib/project-search-api";

export function ProjectSearch({ projectId }: { projectId: string }) {
	const { t } = useTranslation("projects");
	const { hasProjectPermission } = useProjectPermissions(projectId);
	const canReadTasks = hasProjectPermission("tasks.read");
	const canReadDocs = hasProjectPermission("docs.read");
	const [open, setOpen] = useState(false);
	if (!canReadTasks && !canReadDocs) return null;
	return (
		<SidebarMenuItem>
			<SidebarMenuButton
				tooltip={t("search.title")}
				onClick={() => setOpen(true)}
			>
				<Search className="size-4" />
				<span>{t("search.title")}</span>
			</SidebarMenuButton>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>{t("search.title")}</DialogTitle>
						<DialogDescription>{t("search.description")}</DialogDescription>
					</DialogHeader>
					{open && (
						<SearchContent
							key={projectId}
							projectId={projectId}
							canReadTasks={canReadTasks}
							canReadDocs={canReadDocs}
							close={() => setOpen(false)}
						/>
					)}
				</DialogContent>
			</Dialog>
		</SidebarMenuItem>
	);
}
function SearchContent({
	projectId,
	canReadTasks,
	canReadDocs,
	close,
}: {
	projectId: string;
	canReadTasks: boolean;
	canReadDocs: boolean;
	close: () => void;
}) {
	const { t } = useTranslation("projects");
	const inputId = useId();
	const selectId = useId();
	const [selected, setSelected] = useState<ProjectSearchKind>(
		canReadTasks ? "tasks" : "docs",
	);
	const kind =
		selected === "tasks" && canReadTasks
			? "tasks"
			: canReadDocs
				? "docs"
				: "tasks";
	const [draft, setDraft] = useState("");
	const [query, setQuery] = useState("");
	const permitted = kind === "tasks" ? canReadTasks : canReadDocs;
	const results = useInfiniteQuery({
		...projectSearchQueryOptions(projectId, kind, query),
		enabled: permitted && query.length > 0,
	});
	const items = permitted
		? (results.data?.pages.flatMap((page) => page.items) ?? [])
		: [];
	return (
		<div className="space-y-4">
			<form
				className="space-y-2"
				onSubmit={(event) => {
					event.preventDefault();
					const next = draft.trim();
					if (next.length > 0 && next.length <= 200) {
						if (next === query) void results.refetch();
						else setQuery(next);
					}
				}}
			>
				<div className="flex flex-wrap gap-2">
					<div className="min-w-0 flex-1">
						<label className="sr-only" htmlFor={inputId}>
							{t("search.queryLabel")}
						</label>
						<Input
							id={inputId}
							value={draft}
							maxLength={200}
							onChange={(event) => setDraft(event.target.value)}
							placeholder={t("search.placeholder")}
							autoFocus
						/>
					</div>
					<label className="sr-only" htmlFor={selectId}>
						{t("search.kindLabel")}
					</label>
					<select
						id={selectId}
						className="rounded-md border bg-background px-2 py-1"
						value={kind}
						onChange={(event) =>
							setSelected(event.target.value as ProjectSearchKind)
						}
					>
						{canReadTasks && <option value="tasks">{t("search.tasks")}</option>}
						{canReadDocs && <option value="docs">{t("search.docs")}</option>}
					</select>
					<Button type="submit" disabled={!draft.trim() || results.isFetching}>
						{t("search.submit")}
					</Button>
				</div>
			</form>
			<div
				role="status"
				aria-live="polite"
				className="text-sm text-muted-foreground"
			>
				{!query
					? t("search.prompt")
					: results.isPending
						? t("search.loading")
						: items.length === 0 && !results.isError
							? t("search.empty")
							: t("search.resultCount", { count: items.length })}
			</div>
			{results.isError && (
				<div role="alert" className="space-y-2 text-sm">
					<p>{t("search.error")}</p>
					<Button variant="outline" onClick={() => void results.refetch()}>
						{t("search.retry")}
					</Button>
				</div>
			)}
			<ul
				className="max-h-[50vh] space-y-2 overflow-y-auto"
				aria-label={t("search.resultsLabel")}
			>
				{items.map((item) => (
					<li key={item.id}>
						<Link
							to={
								kind === "tasks"
									? "/projects/$projectId/tasks/$taskId"
									: "/projects/$projectId/docs/$docId"
							}
							params={{ projectId, taskId: item.id, docId: item.id }}
							onClick={close}
							className="block rounded-md border p-3 hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
						>
							<div className="flex items-center gap-2">
								<span className="font-medium break-words">
									{item.task_number !== null ? `#${item.task_number} ` : ""}
									{item.title}
								</span>
								<span className="ml-auto shrink-0 text-xs text-muted-foreground">
									{item.matched_in === "content"
										? t("search.bodyMatch")
										: t("search.titleMatch")}
								</span>
							</div>
							{item.snippet && (
								<p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">
									{item.snippet}
								</p>
							)}
						</Link>
					</li>
				))}
			</ul>
			{results.hasNextPage && (
				<Button
					variant="outline"
					className="w-full"
					disabled={results.isFetchingNextPage}
					onClick={() => void results.fetchNextPage()}
				>
					{results.isFetchingNextPage ? t("search.loading") : t("search.more")}
				</Button>
			)}
		</div>
	);
}
