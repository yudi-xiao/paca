BEGIN;

ALTER TABLE "paca_automation_event_outbox" DROP CONSTRAINT "paca_automation_event_type_check";--> statement-breakpoint
ALTER TABLE "paca_automation_node" ADD COLUMN "next_scheduled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "paca_automation_node_schedule_idx" ON "paca_automation_node" USING btree ("next_scheduled_at","id") WHERE "paca_automation_node"."kind" = 'trigger' and "paca_automation_node"."type" = 'cron' and "paca_automation_node"."next_scheduled_at" is not null;--> statement-breakpoint
ALTER TABLE "paca_automation_event_outbox" ADD CONSTRAINT "paca_automation_event_type_check" CHECK ("paca_automation_event_outbox"."event_type" in ('task_created', 'status_changed', 'assignee_changed', 'priority_changed', 'tag_added', 'predecessor_done', 'due_date_reached', 'cron', 'sprint_created', 'sprint_started', 'sprint_completed', 'sprint_deleted'));

-- Business Sprint events must commit/rollback with their lifecycle mutation.
-- Snapshot deleted Sprints so delayed condition steps need no legacy database.
CREATE FUNCTION paca_automation_capture_sprint_event() RETURNS trigger AS $$
DECLARE
  sprint_row paca_sprint%ROWTYPE;
  event_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    sprint_row := OLD;
    event_type := 'sprint_deleted';
  ELSIF TG_OP = 'INSERT' THEN
    sprint_row := NEW;
    event_type := 'sprint_created';
  ELSE
    sprint_row := NEW;
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
    IF NEW.status = 'active' THEN event_type := 'sprint_started';
    ELSIF NEW.status = 'completed' THEN event_type := 'sprint_completed';
    ELSE RETURN NEW;
    END IF;
  END IF;

  -- A project cascade must not try to re-create an outbox FK into a deleted
  -- project. Archived projects cannot start new business automation either.
  IF EXISTS (SELECT 1 FROM paca_project p WHERE p.id = sprint_row.project_id AND p.status = 'active') THEN
    INSERT INTO paca_automation_event_outbox (project_id, event_type, payload)
    VALUES (sprint_row.project_id, event_type, jsonb_build_object(
      'sprint_id', sprint_row.id,
      'sprint', jsonb_build_object('id', sprint_row.id, 'projectId', sprint_row.project_id,
        'name', sprint_row.name, 'status', sprint_row.status, 'goal', sprint_row.goal,
        'startDate', to_char(sprint_row.start_date, 'YYYY-MM-DD'), 'endDate', to_char(sprint_row.end_date, 'YYYY-MM-DD'))));
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER paca_automation_sprint_event
AFTER INSERT OR UPDATE OF status OR DELETE ON paca_sprint
FOR EACH ROW EXECUTE FUNCTION paca_automation_capture_sprint_event();


INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0036_majestic_white_queen', 'dd3666a7c25ed57596bd6f7a89d08599d624b4b7ded383f766a03194c554c522');

COMMIT;
