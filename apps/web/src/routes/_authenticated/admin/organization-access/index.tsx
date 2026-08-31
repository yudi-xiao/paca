import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
	Building2,
	Edit2,
	KeyRound,
	Lock,
	Plus,
	Shield,
	Trash2,
	Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ApiErrorCode, getApiErrorCode } from "@/lib/api-error";
import {
	createOrganizationRole,
	DEFAULT_ORGANIZATION_ID,
	deleteOrganizationRole,
	type OrganizationMember,
	type OrganizationRole,
	organizationMembersQueryOptions,
	organizationRolesQueryOptions,
	replaceOrganizationMemberRoles,
	updateOrganizationRole,
} from "@/lib/organization-api";

export const Route = createFileRoute(
	"/_authenticated/admin/organization-access/",
)({
	component: OrganizationAccessPage,
});

const ORGANIZATION_PERMISSIONS = [
	"projects.read",
	"projects.write",
	"projects.create",
	"projects.delete",
	"organization.members.read",
	"organization.members.write",
	"organization.roles.read",
	"organization.roles.write",
	"agents.read",
	"agents.write",
	"agents.approveGrant",
	"workflows.read",
	"workflows.write",
	"workflows.execute",
] as const;

function activePermissions(role: OrganizationRole): string[] {
	return Object.entries(role.permissions)
		.filter(([, enabled]) => enabled)
		.map(([permission]) => permission);
}

function errorMessage(error: unknown, fallback: string): string {
	const code = getApiErrorCode(error);
	switch (code) {
		case ApiErrorCode.OrganizationRoleNameTaken:
			return "organizationAccess.errors.nameTaken";
		case ApiErrorCode.OrganizationRoleNameInvalid:
			return "organizationAccess.errors.nameInvalid";
		case ApiErrorCode.OrganizationRoleHasMembers:
			return "organizationAccess.errors.roleHasMembers";
		case ApiErrorCode.OrganizationRoleBuiltIn:
			return "organizationAccess.errors.builtIn";
		case ApiErrorCode.OrganizationMemberLastOwner:
			return "organizationAccess.errors.lastOwner";
		case ApiErrorCode.RolePermissionEscalation:
			return "organizationAccess.errors.escalation";
		case ApiErrorCode.Forbidden:
			return "organizationAccess.errors.forbidden";
		default:
			return fallback;
	}
}

function OrganizationAccessPage() {
	const { t } = useTranslation("admin");
	const rolesQuery = useQuery(organizationRolesQueryOptions);
	const membersQuery = useQuery({
		...organizationMembersQueryOptions,
		enabled: rolesQuery.isSuccess,
	});
	const [editingRole, setEditingRole] = useState<OrganizationRole | null>(null);
	const [deletingRole, setDeletingRole] = useState<OrganizationRole | null>(
		null,
	);
	const [editingMember, setEditingMember] = useState<OrganizationMember | null>(
		null,
	);
	const [createOpen, setCreateOpen] = useState(false);

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<div className="mb-2 flex items-center gap-2 text-primary">
						<Building2 className="size-5" />
						<span className="text-xs font-semibold uppercase tracking-wider">
							{t("organizationAccess.eyebrow")}
						</span>
					</div>
					<h1 className="font-[Syne] text-2xl font-semibold tracking-tight">
						{t("organizationAccess.title")}
					</h1>
					<p className="mt-1 max-w-2xl text-sm text-muted-foreground">
						{t("organizationAccess.description")}
					</p>
				</div>
				{rolesQuery.isSuccess ? (
					<Button onClick={() => setCreateOpen(true)}>
						<Plus className="size-4" />
						{t("organizationAccess.newRole")}
					</Button>
				) : null}
			</div>

			{rolesQuery.isPending ? (
				<AccessSkeleton />
			) : rolesQuery.isError ? (
				<div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
					{t("organizationAccess.errors.load")}
				</div>
			) : (
				<>
					<section className="overflow-hidden rounded-xl border bg-card">
						<div className="flex items-center gap-3 border-b px-5 py-4">
							<div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
								<Shield className="size-4" />
							</div>
							<div>
								<h2 className="font-[Syne] font-semibold">
									{t("organizationAccess.roles.title")}
								</h2>
								<p className="text-xs text-muted-foreground">
									{t("organizationAccess.roles.description")}
								</p>
							</div>
						</div>
						<RolesTable
							roles={rolesQuery.data}
							onEdit={setEditingRole}
							onDelete={setDeletingRole}
						/>
					</section>

					<section className="overflow-hidden rounded-xl border bg-card">
						<div className="flex items-center gap-3 border-b px-5 py-4">
							<div className="flex size-9 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600">
								<Users className="size-4" />
							</div>
							<div>
								<h2 className="font-[Syne] font-semibold">
									{t("organizationAccess.members.title")}
								</h2>
								<p className="text-xs text-muted-foreground">
									{t("organizationAccess.members.description")}
								</p>
							</div>
						</div>
						{membersQuery.isPending ? (
							<div className="space-y-3 p-5">
								<Skeleton className="h-10 w-full" />
								<Skeleton className="h-10 w-full" />
							</div>
						) : membersQuery.isError ? (
							<p className="p-5 text-sm text-destructive">
								{t("organizationAccess.errors.loadMembers")}
							</p>
						) : (
							<MembersTable
								members={membersQuery.data}
								onEdit={setEditingMember}
							/>
						)}
					</section>
				</>
			)}

			<RoleDialog open={createOpen} onOpenChange={setCreateOpen} />
			{editingRole ? (
				<RoleDialog
					role={editingRole}
					open
					onOpenChange={(open) => !open && setEditingRole(null)}
				/>
			) : null}
			{deletingRole ? (
				<DeleteRoleDialog
					role={deletingRole}
					open
					onOpenChange={(open) => !open && setDeletingRole(null)}
				/>
			) : null}
			{editingMember && rolesQuery.data ? (
				<MemberRolesDialog
					member={editingMember}
					roles={rolesQuery.data}
					open
					onOpenChange={(open) => !open && setEditingMember(null)}
				/>
			) : null}
		</div>
	);
}

function RolesTable({
	roles,
	onEdit,
	onDelete,
}: {
	roles: OrganizationRole[];
	onEdit: (role: OrganizationRole) => void;
	onDelete: (role: OrganizationRole) => void;
}) {
	const { t } = useTranslation("admin");
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead className="px-5">{t("organizationAccess.name")}</TableHead>
					<TableHead>{t("organizationAccess.permissions")}</TableHead>
					<TableHead className="w-28 text-right">
						{t("organizationAccess.actions")}
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{roles.map((role) => (
					<TableRow key={role.id}>
						<TableCell className="px-5 align-top">
							<div className="flex items-center gap-2">
								{role.is_built_in ? (
									<Lock className="size-3.5 text-muted-foreground" />
								) : (
									<KeyRound className="size-3.5 text-primary" />
								)}
								<span className="font-mono text-sm font-medium">
									{role.role_name}
								</span>
							</div>
							{role.description ? (
								<p className="mt-1 text-xs text-muted-foreground">
									{role.description}
								</p>
							) : null}
						</TableCell>
						<TableCell>
							<div className="flex max-w-2xl flex-wrap gap-1">
								{activePermissions(role).map((permission) => (
									<Badge
										key={permission}
										variant="outline"
										className="font-mono text-[11px]"
									>
										{permission}
									</Badge>
								))}
							</div>
						</TableCell>
						<TableCell>
							{role.is_built_in ? (
								<span className="text-xs text-muted-foreground">
									{t("organizationAccess.builtIn")}
								</span>
							) : (
								<div className="flex justify-end gap-1">
									<Button
										variant="ghost"
										size="icon-sm"
										onClick={() => onEdit(role)}
									>
										<Edit2 className="size-3.5" />
									</Button>
									<Button
										variant="ghost"
										size="icon-sm"
										className="text-destructive"
										onClick={() => onDelete(role)}
									>
										<Trash2 className="size-3.5" />
									</Button>
								</div>
							)}
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

function MembersTable({
	members,
	onEdit,
}: {
	members: OrganizationMember[];
	onEdit: (member: OrganizationMember) => void;
}) {
	const { t } = useTranslation("admin");
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead className="px-5">
						{t("organizationAccess.members.user")}
					</TableHead>
					<TableHead>{t("organizationAccess.members.roles")}</TableHead>
					<TableHead className="w-32 text-right">
						{t("organizationAccess.actions")}
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{members.map((member) => (
					<TableRow key={member.id}>
						<TableCell className="px-5">
							<p className="text-sm font-medium">{member.full_name}</p>
							<p className="text-xs text-muted-foreground">{member.email}</p>
						</TableCell>
						<TableCell>
							<div className="flex flex-wrap gap-1">
								{member.roles.map((role) => (
									<Badge
										key={role.id}
										variant="secondary"
										className="font-mono text-[11px]"
									>
										{role.role_name}
									</Badge>
								))}
							</div>
						</TableCell>
						<TableCell className="text-right">
							<Button
								variant="outline"
								size="sm"
								onClick={() => onEdit(member)}
							>
								{t("organizationAccess.members.assign")}
							</Button>
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

function RoleDialog({
	role,
	open,
	onOpenChange,
}: {
	role?: OrganizationRole;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { t } = useTranslation("admin");
	const queryClient = useQueryClient();
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [permissions, setPermissions] = useState<Record<string, boolean>>({});
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		setName(role?.role_name ?? "");
		setDescription(role?.description ?? "");
		setPermissions(role?.permissions ?? {});
		setError(null);
	}, [open, role]);

	const mutation = useMutation({
		mutationFn: () => {
			const payload = {
				role_name: name,
				description,
				permissions: Object.fromEntries(
					ORGANIZATION_PERMISSIONS.map((permission) => [
						permission,
						permissions[permission] === true,
					]),
				),
			};
			return role
				? updateOrganizationRole(DEFAULT_ORGANIZATION_ID, role.id, payload)
				: createOrganizationRole(DEFAULT_ORGANIZATION_ID, payload);
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: organizationRolesQueryOptions.queryKey,
			});
			void queryClient.invalidateQueries({
				queryKey: organizationMembersQueryOptions.queryKey,
			});
			onOpenChange(false);
		},
		onError: (mutationError) =>
			setError(
				t(
					errorMessage(
						mutationError,
						"organizationAccess.errors.save",
					) as never,
				),
			),
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[90svh] flex-col sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>
						{t(
							role
								? "organizationAccess.roleDialog.edit"
								: "organizationAccess.roleDialog.create",
						)}
					</DialogTitle>
					<DialogDescription>
						{t("organizationAccess.roleDialog.description")}
					</DialogDescription>
				</DialogHeader>
				<div className="min-h-0 space-y-4 overflow-y-auto py-1">
					<div className="space-y-1.5">
						<Label htmlFor="organization-role-name">
							{t("organizationAccess.name")}
						</Label>
						<Input
							id="organization-role-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							maxLength={64}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="organization-role-description">
							{t("organizationAccess.roleDialog.roleDescription")}
						</Label>
						<Textarea
							id="organization-role-description"
							value={description}
							onChange={(event) => setDescription(event.target.value)}
							maxLength={500}
						/>
					</div>
					<div className="space-y-2">
						<Label>{t("organizationAccess.permissions")}</Label>
						<div className="divide-y rounded-lg border px-4">
							{ORGANIZATION_PERMISSIONS.map((permission) => (
								<div
									key={permission}
									className="flex items-center justify-between gap-4 py-3"
								>
									<span className="font-mono text-xs">{permission}</span>
									<Switch
										checked={permissions[permission] === true}
										onCheckedChange={(checked) =>
											setPermissions((current) => ({
												...current,
												[permission]: checked,
											}))
										}
									/>
								</div>
							))}
						</div>
					</div>
					{error ? <p className="text-sm text-destructive">{error}</p> : null}
				</div>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>
						{t("organizationAccess.cancel")}
					</DialogClose>
					<Button
						onClick={() => mutation.mutate()}
						disabled={mutation.isPending || name.trim().length < 2}
					>
						{mutation.isPending
							? t("organizationAccess.saving")
							: t("organizationAccess.save")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function DeleteRoleDialog({
	role,
	open,
	onOpenChange,
}: {
	role: OrganizationRole;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { t } = useTranslation("admin");
	const queryClient = useQueryClient();
	const [error, setError] = useState<string | null>(null);
	const mutation = useMutation({
		mutationFn: () => deleteOrganizationRole(DEFAULT_ORGANIZATION_ID, role.id),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: organizationRolesQueryOptions.queryKey,
			});
			onOpenChange(false);
		},
		onError: (mutationError) =>
			setError(
				t(
					errorMessage(
						mutationError,
						"organizationAccess.errors.delete",
					) as never,
				),
			),
	});
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{t("organizationAccess.deleteDialog.title")}
					</DialogTitle>
					<DialogDescription>
						{t("organizationAccess.deleteDialog.description", {
							name: role.role_name,
						})}
					</DialogDescription>
				</DialogHeader>
				{error ? <p className="text-sm text-destructive">{error}</p> : null}
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>
						{t("organizationAccess.cancel")}
					</DialogClose>
					<Button
						variant="destructive"
						onClick={() => mutation.mutate()}
						disabled={mutation.isPending}
					>
						{t("organizationAccess.delete")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function MemberRolesDialog({
	member,
	roles,
	open,
	onOpenChange,
}: {
	member: OrganizationMember;
	roles: OrganizationRole[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { t } = useTranslation("admin");
	const queryClient = useQueryClient();
	const [selected, setSelected] = useState(() =>
		member.roles.map((role) => role.id),
	);
	const [error, setError] = useState<string | null>(null);
	const mutation = useMutation({
		mutationFn: () =>
			replaceOrganizationMemberRoles(
				DEFAULT_ORGANIZATION_ID,
				member.id,
				selected,
			),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: organizationMembersQueryOptions.queryKey,
			});
			onOpenChange(false);
		},
		onError: (mutationError) =>
			setError(
				t(
					errorMessage(
						mutationError,
						"organizationAccess.errors.assign",
					) as never,
				),
			),
	});
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{t("organizationAccess.members.assignTitle")}
					</DialogTitle>
					<DialogDescription>
						{t("organizationAccess.members.assignDescription", {
							name: member.full_name,
						})}
					</DialogDescription>
				</DialogHeader>
				<div className="divide-y rounded-lg border px-4">
					{roles.map((role) => {
						const checked = selected.includes(role.id);
						return (
							<div
								key={role.id}
								className="flex items-center justify-between gap-4 py-3"
							>
								<div>
									<p className="font-mono text-sm font-medium">
										{role.role_name}
									</p>
									<p className="text-xs text-muted-foreground">
										{role.description}
									</p>
								</div>
								<Switch
									checked={checked}
									onCheckedChange={(next) =>
										setSelected((current) =>
											next
												? [...current, role.id]
												: current.filter((roleId) => roleId !== role.id),
										)
									}
								/>
							</div>
						);
					})}
				</div>
				{error ? <p className="text-sm text-destructive">{error}</p> : null}
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>
						{t("organizationAccess.cancel")}
					</DialogClose>
					<Button
						onClick={() => mutation.mutate()}
						disabled={mutation.isPending || selected.length === 0}
					>
						{t("organizationAccess.save")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function AccessSkeleton() {
	return (
		<div className="space-y-4">
			<Skeleton className="h-56 w-full rounded-xl" />
			<Skeleton className="h-48 w-full rounded-xl" />
		</div>
	);
}
