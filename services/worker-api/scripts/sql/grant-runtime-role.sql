\set ON_ERROR_STOP on

\if :{?runtime_role}
\else
  \echo 'runtime_role psql variable is required'
  \quit 1
\endif

BEGIN;

GRANT USAGE ON SCHEMA public TO :"runtime_role";
REVOKE CREATE ON SCHEMA public FROM :"runtime_role";

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public."user",
  public."session",
  public.account,
  public.verification,
  public.organization,
  public.member,
  public.invitation,
  public.agent_host,
  public.agent,
  public.agent_capability_grant,
  public.approval_request,
  public.paca_auth_secondary_storage,
  public.paca_agent_auth_audit,
  public.paca_system_role,
  public.paca_system_role_permission,
  public.paca_user_system_role,
  public.paca_organization_role,
  public.paca_organization_role_permission,
  public.paca_organization_member_role,
  public.paca_project,
  public.paca_project_role,
  public.paca_role_permission,
  public.paca_project_member,
  public.paca_project_member_role,
  public.paca_task_type,
  public.paca_task_status,
  public.paca_task_counter,
  public.paca_sprint,
  public.paca_custom_field_definition,
  public.paca_task_view,
  public.paca_view_task_position,
  public.paca_task,
  public.paca_task_assignee,
  public.paca_task_activity,
  public.paca_task_link,
  public.paca_file,
  public.paca_task_attachment,
  public.paca_document,
  public.paca_realtime_outbox
TO :"runtime_role";

REVOKE ALL PRIVILEGES ON TABLE public.paca_schema_migration FROM :"runtime_role";
REVOKE ALL PRIVILEGES ON TABLE public.paca_attachment_migration_item FROM :"runtime_role";

COMMIT;
