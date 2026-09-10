package authz

// RoleDefinition binds a role name to the permissions it grants.
type RoleDefinition struct {
	Name        string
	Permissions []Permission
}

// DefaultGlobalRoles returns the built-in global role set.
func DefaultGlobalRoles() []RoleDefinition {
	return []RoleDefinition{
		{
			Name:        "SUPER_ADMIN",
			Permissions: []Permission{PermissionAll},
		},
		{
			Name: "ADMIN",
			Permissions: []Permission{
				PermissionUsersAll,
				PermissionGlobalRolesAll,
				PermissionProjectsAll,
				PermissionSettingsWrite,
			},
		},
		{
			Name: "USER",
			Permissions: []Permission{
				PermissionUsersRead,
			},
		},
	}
}

// DefaultProjectRoles returns built-in project role templates.
func DefaultProjectRoles() []RoleDefinition {
	return []RoleDefinition{
		{
			Name: "PROJECT_OWNER",
			Permissions: []Permission{
				PermissionProjectsAll,
				PermissionProjectMembersAll,
				PermissionProjectRolesAll,
				PermissionTasksAll,
				PermissionSprintsAll,
				PermissionDocsAll,
				PermissionAgentsAll,
				PermissionWorkflowsAll,
				PermissionEnvironmentsAll,
			},
		},
		{
			Name: "PROJECT_MANAGER",
			Permissions: []Permission{
				PermissionProjectsRead,
				PermissionProjectsWrite,
				PermissionProjectMembersRead,
				PermissionProjectMembersWrite,
				PermissionTasksAll,
				PermissionSprintsAll,
				PermissionDocsAll,
				PermissionAgentsAll,
				PermissionWorkflowsAll,
				PermissionEnvironmentsAll,
			},
		},
		{
			Name: "PROJECT_MEMBER",
			Permissions: []Permission{
				PermissionProjectsRead,
				PermissionProjectMembersRead,
				PermissionProjectRolesRead,
				PermissionTasksRead,
				PermissionTasksWrite,
				PermissionSprintsRead,
				PermissionDocsRead,
				PermissionDocsWrite,
				PermissionAgentsRead,
				PermissionAgentsWrite,
				PermissionWorkflowsRead,
				PermissionWorkflowsWrite,
				PermissionEnvironmentsRead,
				PermissionEnvironmentsWrite,
				PermissionEnvironmentsConnect,
			},
		},
		{
			Name: "PROJECT_VIEWER",
			Permissions: []Permission{
				PermissionProjectsRead,
				PermissionProjectMembersRead,
				PermissionProjectRolesRead,
				PermissionTasksRead,
				PermissionSprintsRead,
				PermissionDocsRead,
				PermissionAgentsRead,
				PermissionWorkflowsRead,
				PermissionEnvironmentsRead,
			},
		},
	}
}
