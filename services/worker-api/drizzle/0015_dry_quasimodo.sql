BEGIN;

CREATE TABLE "paca_realtime_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_type" text NOT NULL,
	"room_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"enqueued_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_realtime_outbox_room_type_check" CHECK ("paca_realtime_outbox"."room_type" in ('project', 'user')),
	CONSTRAINT "paca_realtime_outbox_status_check" CHECK ("paca_realtime_outbox"."status" in ('pending', 'enqueuing', 'enqueued', 'delivered')),
	CONSTRAINT "paca_realtime_outbox_attempts_check" CHECK ("paca_realtime_outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX "paca_realtime_outbox_dispatch_idx" ON "paca_realtime_outbox" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "paca_realtime_outbox_room_idx" ON "paca_realtime_outbox" USING btree ("room_type","room_id","created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.paca_enqueue_project_realtime_event(
	event_type text,
	project_id uuid,
	payload jsonb
) RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, public
AS $$
	INSERT INTO public.paca_realtime_outbox (room_type, room_id, event_type, payload)
	VALUES ('project', project_id::text, event_type, payload || jsonb_build_object('project_id', project_id::text));
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.paca_task_realtime_trigger() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
	row_value public.paca_task;
	event_name text;
BEGIN
	row_value := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
	event_name := CASE
		WHEN TG_OP = 'INSERT' THEN 'task.created'
		WHEN TG_OP = 'DELETE' OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) THEN 'task.deleted'
		ELSE 'task.updated'
	END;
	PERFORM public.paca_enqueue_project_realtime_event(
		event_name,
		row_value.project_id,
		jsonb_build_object('task_id', row_value.id::text, 'task_number', row_value.task_number)
	);
	RETURN row_value;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER paca_task_realtime_outbox
AFTER INSERT OR UPDATE OR DELETE ON public.paca_task
FOR EACH ROW EXECUTE FUNCTION public.paca_task_realtime_trigger();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.paca_task_activity_realtime_trigger() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
	PERFORM public.paca_enqueue_project_realtime_event(
		'task.activity.created',
		NEW.project_id,
		jsonb_build_object(
			'task_id', NEW.task_id::text,
			'activity_id', NEW.id::text,
			'activity_type', NEW.activity_type
		)
	);
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER paca_task_activity_realtime_outbox
AFTER INSERT ON public.paca_task_activity
FOR EACH ROW EXECUTE FUNCTION public.paca_task_activity_realtime_trigger();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.paca_task_link_realtime_trigger() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
	row_value public.paca_task_link;
BEGIN
	row_value := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
	PERFORM public.paca_enqueue_project_realtime_event(
		CASE WHEN TG_OP = 'DELETE' THEN 'task.link.deleted' ELSE 'task.link.created' END,
		row_value.project_id,
		jsonb_build_object(
			'task_id', row_value.source_task_id::text,
			'target_task_id', row_value.target_task_id::text,
			'link_id', row_value.id::text
		)
	);
	RETURN row_value;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER paca_task_link_realtime_outbox
AFTER INSERT OR DELETE ON public.paca_task_link
FOR EACH ROW EXECUTE FUNCTION public.paca_task_link_realtime_trigger();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.paca_task_attachment_realtime_trigger() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
	event_name text;
BEGIN
	event_name := CASE
		WHEN TG_OP = 'INSERT' THEN 'task.attachment.created'
		WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN 'task.attachment.deleted'
		ELSE 'task.attachment.updated'
	END;
	PERFORM public.paca_enqueue_project_realtime_event(
		event_name,
		NEW.project_id,
		jsonb_build_object(
			'task_id', NEW.task_id::text,
			'attachment_id', NEW.id::text,
			'file_id', NEW.file_id::text
		)
	);
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER paca_task_attachment_realtime_outbox
AFTER INSERT OR UPDATE ON public.paca_task_attachment
FOR EACH ROW EXECUTE FUNCTION public.paca_task_attachment_realtime_trigger();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.paca_sprint_realtime_trigger() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
	row_value public.paca_sprint;
	event_name text;
BEGIN
	row_value := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
	event_name := CASE
		WHEN TG_OP = 'INSERT' THEN 'sprint.created'
		WHEN TG_OP = 'DELETE' THEN 'sprint.deleted'
		WHEN OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'completed' THEN 'sprint.completed'
		ELSE 'sprint.updated'
	END;
	PERFORM public.paca_enqueue_project_realtime_event(
		event_name,
		row_value.project_id,
		jsonb_build_object('sprint_id', row_value.id::text)
	);
	RETURN row_value;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER paca_sprint_realtime_outbox
AFTER INSERT OR UPDATE OR DELETE ON public.paca_sprint
FOR EACH ROW EXECUTE FUNCTION public.paca_sprint_realtime_trigger();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.paca_task_view_realtime_trigger() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
	row_value public.paca_task_view;
BEGIN
	row_value := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
	PERFORM public.paca_enqueue_project_realtime_event(
		CASE TG_OP WHEN 'INSERT' THEN 'view.created' WHEN 'DELETE' THEN 'view.deleted' ELSE 'view.updated' END,
		row_value.project_id,
		jsonb_build_object('view_id', row_value.id::text, 'sprint_id', row_value.sprint_id::text)
	);
	RETURN row_value;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER paca_task_view_realtime_outbox
AFTER INSERT OR UPDATE OR DELETE ON public.paca_task_view
FOR EACH ROW EXECUTE FUNCTION public.paca_task_view_realtime_trigger();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.paca_view_task_position_realtime_trigger() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
	row_value public.paca_view_task_position;
BEGIN
	row_value := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
	PERFORM public.paca_enqueue_project_realtime_event(
		'view.updated',
		row_value.project_id,
		jsonb_build_object('view_id', row_value.view_id::text, 'task_id', row_value.task_id::text)
	);
	RETURN row_value;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER paca_view_task_position_realtime_outbox
AFTER INSERT OR UPDATE OR DELETE ON public.paca_view_task_position
FOR EACH ROW EXECUTE FUNCTION public.paca_view_task_position_realtime_trigger();

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0015_dry_quasimodo', 'f9f793bc74eb430479eb5d563a5311c28d77a76fbf688da3058c0960a3fb8187');

COMMIT;
