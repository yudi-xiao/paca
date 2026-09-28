BEGIN;

CREATE TABLE "paca_automation_event_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid,
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
	CONSTRAINT "paca_automation_event_type_check" CHECK ("paca_automation_event_outbox"."event_type" in ('task_created', 'status_changed')),
	CONSTRAINT "paca_automation_event_status_check" CHECK ("paca_automation_event_outbox"."status" in ('pending', 'enqueuing', 'enqueued', 'delivered')),
	CONSTRAINT "paca_automation_event_attempts_check" CHECK ("paca_automation_event_outbox"."attempts" >= 0),
	CONSTRAINT "paca_automation_event_payload_check" CHECK (jsonb_typeof("paca_automation_event_outbox"."payload") = 'object')
);
--> statement-breakpoint
ALTER TABLE "paca_automation_event_outbox" ADD CONSTRAINT "paca_automation_event_outbox_project_id_paca_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."paca_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paca_automation_event_dispatch_idx" ON "paca_automation_event_outbox" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "paca_automation_event_project_idx" ON "paca_automation_event_outbox" USING btree ("project_id","created_at");

-- A business event is written in the same transaction as its task mutation.
-- Only currently active graphs create work; activating a draft must never replay
-- an old task event whose Queue delivery happened later.
CREATE FUNCTION paca_automation_capture_task_event() RETURNS trigger AS $$
DECLARE
  event_type text;
  event_payload jsonb;
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    event_type := 'task_created';
    event_payload := jsonb_build_object('task_id', NEW.id, 'status_id', NEW.status_id);
  ELSIF OLD.status_id IS DISTINCT FROM NEW.status_id THEN
    event_type := 'status_changed';
    event_payload := jsonb_build_object(
      'task_id', NEW.id,
      'previous_status_id', OLD.status_id,
      'status_id', NEW.status_id
    );
  ELSE
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM paca_automation a
    JOIN paca_automation_node n ON n.automation_id = a.id
    WHERE a.project_id = NEW.project_id
      AND a.status = 'active'
      AND a.deleted_at IS NULL
      AND n.kind = 'trigger'
      AND n.type = event_type
  ) THEN
    INSERT INTO paca_automation_event_outbox (project_id, task_id, event_type, payload)
    VALUES (NEW.project_id, NEW.id, event_type, event_payload);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER paca_automation_task_event_insert
AFTER INSERT ON paca_task
FOR EACH ROW EXECUTE FUNCTION paca_automation_capture_task_event();

CREATE TRIGGER paca_automation_task_event_status
AFTER UPDATE OF status_id ON paca_task
FOR EACH ROW EXECUTE FUNCTION paca_automation_capture_task_event();

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0030_lively_mephisto', '06a75017bf4747f965253b2f5ec6c854c64ccc6f8ed12eddc5271890398bb890');

COMMIT;
