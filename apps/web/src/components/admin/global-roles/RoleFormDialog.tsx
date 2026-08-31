import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

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
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
	createGlobalRole,
	type GlobalRole,
	globalRolesQueryOptions,
	updateGlobalRole,
} from "@/lib/admin-api";
import { ApiErrorCode, getApiErrorCode } from "@/lib/api-error";
import {
	expandWildcardPermissions,
	normalizePermissionsToWildcards,
} from "@/lib/permissions";
import {
	collectPluginCustomPermissions,
	type Plugin,
	pluginsQueryOptions,
} from "@/lib/plugin-api";

import {
	KNOWN_PERMISSIONS,
	type KnownPermission,
	PERMISSION_GROUPS,
	toPluginKnownPermissions,
} from "./permissions";

// Stable reference so `allKnownPermissions` doesn't change identity on every
// render while the plugins query has no data yet (pending/error) — an
// inline `= []` default creates a new array each render, which re-triggers
// the effect below in an infinite loop.
const EMPTY_PLUGINS: Plugin[] = [];

interface RoleFormDialogProps {
	role?: GlobalRole;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function RoleFormDialog({
	role,
	open,
	onOpenChange,
}: RoleFormDialogProps) {
	const { t } = useTranslation("admin");
	const queryClient = useQueryClient();
	const isEdit = !!role;

	const { data: plugins = EMPTY_PLUGINS } = useQuery(pluginsQueryOptions);
	const allKnownPermissions = useMemo<KnownPermission[]>(
		() => [
			...KNOWN_PERMISSIONS,
			...toPluginKnownPermissions(
				collectPluginCustomPermissions(plugins, "global"),
			),
		],
		[plugins],
	);

	const [name, setName] = useState(role?.name ?? "");
	const [permissions, setPermissions] = useState<Record<string, boolean>>({});
	const [error, setError] = useState<string | null>(null);
	const [nameError, setNameError] = useState<string | null>(null);

	// Re-derive `permissions` whenever the dialog opens or the known-permission
	// set changes (e.g. plugin data finishes loading after the dialog already
	// opened), rather than only at first mount — otherwise plugin-declared
	// permissions loaded after mount would never make it into the editor and
	// saving the role would silently drop them.
	useEffect(() => {
		if (!open) return;
		setPermissions(
			expandWildcardPermissions(role?.permissions, allKnownPermissions),
		);
	}, [open, allKnownPermissions, role?.permissions]);

	const reset = () => {
		setName(role?.name ?? "");
		setPermissions(
			expandWildcardPermissions(role?.permissions, allKnownPermissions),
		);
		setError(null);
		setNameError(null);
	};

	const mutation = useMutation({
		mutationFn: async () => {
			if (!name.trim())
				throw new Error(t("globalRoles.formDialog.errors.roleNameRequired"));
			const payload = {
				name: name.trim(),
				permissions: normalizePermissionsToWildcards(
					permissions,
					allKnownPermissions,
				),
			};
			if (isEdit && role) {
				return updateGlobalRole(role.id, payload);
			}
			return createGlobalRole(payload);
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: globalRolesQueryOptions.queryKey,
			});
			onOpenChange(false);
			reset();
		},
		onError: (err: unknown) => {
			setNameError(null);
			const code = getApiErrorCode(err);
			if (code === ApiErrorCode.GlobalRoleNameTaken) {
				setNameError(t("globalRoles.formDialog.errors.nameTaken"));
				return;
			}
			if (code === ApiErrorCode.GlobalRoleNameInvalid) {
				setNameError(t("globalRoles.formDialog.errors.nameInvalid"));
				return;
			}
			const messages: Partial<Record<string, string>> = {
				[ApiErrorCode.GlobalRoleNotFound]: t(
					"globalRoles.formDialog.errors.roleNotFound",
				),
				[ApiErrorCode.Forbidden]: t("globalRoles.formDialog.errors.forbidden"),
				[ApiErrorCode.GlobalRoleBuiltIn]: t(
					"globalRoles.formDialog.errors.forbidden",
				),
				[ApiErrorCode.RolePermissionEscalation]: t(
					"globalRoles.formDialog.errors.forbidden",
				),
				[ApiErrorCode.GlobalRoleDescriptionInvalid]: t(
					"globalRoles.formDialog.errors.generic",
				),
				[ApiErrorCode.RolePermissionsInvalid]: t(
					"globalRoles.formDialog.errors.generic",
				),
				[ApiErrorCode.InternalError]: t(
					"globalRoles.formDialog.errors.internalError",
				),
			};
			const fallback =
				err instanceof Error
					? err.message
					: t("globalRoles.formDialog.errors.generic");
			setError((code && messages[code]) ?? fallback);
		},
	});

	const permissionLabel = (permission: KnownPermission): string =>
		permission.rawLabel ?? t(permission.labelKey as never);

	const permissionDescription = (permission: KnownPermission): string =>
		permission.rawDescription ?? t(permission.descriptionKey as never);

	const togglePermission = (key: string, checked: boolean) => {
		setPermissions((prev) => ({ ...prev, [key]: checked }));
	};

	const enabledCount = Object.values(permissions).filter(Boolean).length;

	const handleOpenChange = (next: boolean) => {
		if (!next) reset();
		onOpenChange(next);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="flex flex-col sm:max-w-lg max-h-[90svh]">
				<DialogHeader>
					<div className="flex items-center gap-2.5">
						<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
							<Shield className="size-4" />
						</div>
						<DialogTitle className="text-base">
							{isEdit
								? t("globalRoles.formDialog.editTitle")
								: t("globalRoles.formDialog.createTitle")}
						</DialogTitle>
					</div>
					<DialogDescription className="mt-2">
						{isEdit
							? t("globalRoles.formDialog.editDescription")
							: t("globalRoles.formDialog.createDescription")}
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-5 py-1 overflow-y-auto min-h-0">
					<div className="flex flex-col gap-1.5">
						<Label
							htmlFor="role-name"
							className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
						>
							{t("globalRoles.formDialog.roleNameLabel")}
						</Label>
						<Input
							id="role-name"
							placeholder={t("globalRoles.formDialog.roleNamePlaceholder")}
							value={name}
							onChange={(e) => {
								setName(e.target.value);
								if (nameError) setNameError(null);
							}}
							autoComplete="off"
							className={`font-mono${nameError ? " border-destructive focus-visible:ring-destructive" : ""}`}
							aria-describedby={nameError ? "role-name-error" : undefined}
						/>
						{nameError ? (
							<p id="role-name-error" className="text-xs text-destructive">
								{nameError}
							</p>
						) : null}
					</div>

					<div className="flex flex-col gap-2.5">
						<div className="flex items-center justify-between">
							<span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
								{t("globalRoles.formDialog.permissionsLabel")}
							</span>
							{enabledCount > 0 && (
								<span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
									{t("globalRoles.formDialog.enabledCount", {
										count: enabledCount,
									})}
								</span>
							)}
						</div>

						<div className="flex flex-col gap-4 rounded-lg border bg-muted/20 p-4">
							{PERMISSION_GROUPS.map((group, groupIndex) => {
								const groupPerms = allKnownPermissions.filter(
									(permission) => permission.domain === group.domain,
								);
								if (groupPerms.length === 0) return null;
								const { Icon } = group;
								return (
									<div key={group.domain}>
										{groupIndex > 0 && <Separator className="mb-4" />}
										<div className="mb-3 flex items-center gap-1.5">
											<Icon className="size-3.5 text-muted-foreground" />
											<span className="text-xs font-semibold text-muted-foreground">
												{t(group.labelKey)}
											</span>
										</div>
										<div className="flex flex-col">
											{groupPerms.map((permission, permissionIndex) => (
												<div key={permission.key}>
													{permissionIndex > 0 && (
														<Separator className="my-2" />
													)}
													<div className="flex items-center justify-between py-1">
														<div className="flex flex-col gap-0.5">
															<span className="text-sm font-medium">
																{permissionLabel(permission)}
															</span>
															<span className="text-xs text-muted-foreground">
																{permissionDescription(permission)}
															</span>
														</div>
														<Switch
															checked={!!permissions[permission.key]}
															onCheckedChange={(checked) =>
																togglePermission(permission.key, checked)
															}
														/>
													</div>
												</div>
											))}
										</div>
									</div>
								);
							})}
						</div>
					</div>

					{error ? (
						<div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
							<span className="shrink-0">⚠</span>
							<span>{error}</span>
						</div>
					) : null}
				</div>

				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>
						{t("globalRoles.formDialog.cancel")}
					</DialogClose>
					<Button
						onClick={() => mutation.mutate()}
						disabled={mutation.isPending}
					>
						{mutation.isPending
							? t("globalRoles.formDialog.saving")
							: isEdit
								? t("globalRoles.formDialog.saveChanges")
								: t("globalRoles.formDialog.createRole")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
