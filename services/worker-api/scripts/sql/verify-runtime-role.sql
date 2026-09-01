\set ON_ERROR_STOP on

\if :{?runtime_role}
\else
  \echo 'runtime_role psql variable is required'
  DO $$ BEGIN RAISE EXCEPTION 'runtime_role psql variable is required'; END $$;
\endif

WITH application_tables(table_name) AS (
  VALUES
    ('user'),
    ('session'),
    ('account'),
    ('verification'),
    ('organization'),
    ('member'),
    ('invitation'),
    ('agent_host'),
    ('agent'),
    ('agent_capability_grant'),
    ('approval_request'),
    ('paca_auth_secondary_storage'),
    ('paca_agent_auth_audit'),
    ('paca_system_role'),
    ('paca_system_role_permission'),
    ('paca_user_system_role'),
    ('paca_organization_role'),
    ('paca_organization_role_permission'),
    ('paca_organization_member_role'),
    ('paca_project'),
    ('paca_project_role'),
    ('paca_role_permission'),
    ('paca_project_member'),
    ('paca_project_member_role'),
    ('paca_task_type'),
    ('paca_task_status'),
    ('paca_task_counter'),
    ('paca_sprint'),
    ('paca_custom_field_definition'),
    ('paca_task_view'),
    ('paca_view_task_position'),
    ('paca_task'),
    ('paca_task_assignee'),
    ('paca_task_activity'),
    ('paca_task_link'),
    ('paca_file'),
    ('paca_task_attachment'),
    ('paca_realtime_outbox')
)
SELECT count(*) = 0 AS crud_is_valid
FROM application_tables
WHERE NOT has_table_privilege(
  :'runtime_role',
  format('public.%I', table_name),
  'SELECT,INSERT,UPDATE,DELETE'
)
\gset

SELECT (
  has_schema_privilege(:'runtime_role', 'public', 'USAGE')
  AND NOT has_schema_privilege(:'runtime_role', 'public', 'CREATE')
  AND NOT has_table_privilege(
    :'runtime_role',
    'public.paca_schema_migration',
    'SELECT,INSERT,UPDATE,DELETE'
  )
  AND NOT has_table_privilege(
    :'runtime_role',
    'public.paca_attachment_migration_item',
    'SELECT,INSERT,UPDATE,DELETE'
  )
) AS boundary_is_valid
\gset

\if :crud_is_valid
  \echo 'runtime role CRUD grants verified'
\else
  \echo 'runtime role is missing one or more required CRUD grants'
  DO $$ BEGIN RAISE EXCEPTION 'runtime role CRUD grants are invalid'; END $$;
\endif

\if :boundary_is_valid
  \echo 'runtime role privilege boundary verified'
\else
  \echo 'runtime role has an invalid schema or migration-ledger privilege'
  DO $$ BEGIN RAISE EXCEPTION 'runtime role privilege boundary is invalid'; END $$;
\endif
