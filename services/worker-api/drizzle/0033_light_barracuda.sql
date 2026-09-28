BEGIN;

ALTER TABLE "paca_automation_event_outbox" DROP CONSTRAINT "paca_automation_event_type_check";--> statement-breakpoint
ALTER TABLE "paca_automation_event_outbox" ADD CONSTRAINT "paca_automation_event_type_check" CHECK ("paca_automation_event_outbox"."event_type" in ('task_created', 'status_changed', 'assignee_changed', 'priority_changed', 'tag_added'));

-- A single task update can produce several independent trigger events. Keep
-- capture inside the task transaction and only enqueue enabled event kinds.
CREATE OR REPLACE FUNCTION paca_automation_capture_task_event() RETURNS trigger AS $$
DECLARE
  added_tags jsonb;
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM paca_automation a
      JOIN paca_automation_node n ON n.automation_id = a.id
      WHERE a.project_id = NEW.project_id AND a.status = 'active'
        AND a.deleted_at IS NULL AND n.kind = 'trigger' AND n.type = 'task_created'
    ) THEN
      INSERT INTO paca_automation_event_outbox (project_id, task_id, event_type, payload)
      VALUES (NEW.project_id, NEW.id, 'task_created',
        jsonb_build_object('task_id', NEW.id, 'status_id', NEW.status_id));
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status_id IS DISTINCT FROM NEW.status_id AND EXISTS (
    SELECT 1 FROM paca_automation a
    JOIN paca_automation_node n ON n.automation_id = a.id
    WHERE a.project_id = NEW.project_id AND a.status = 'active'
      AND a.deleted_at IS NULL AND n.kind = 'trigger' AND n.type = 'status_changed'
  ) THEN
    INSERT INTO paca_automation_event_outbox (project_id, task_id, event_type, payload)
    VALUES (NEW.project_id, NEW.id, 'status_changed', jsonb_build_object(
      'task_id', NEW.id, 'previous_status_id', OLD.status_id, 'status_id', NEW.status_id));
  END IF;

  IF OLD.importance IS DISTINCT FROM NEW.importance AND EXISTS (
    SELECT 1 FROM paca_automation a
    JOIN paca_automation_node n ON n.automation_id = a.id
    WHERE a.project_id = NEW.project_id AND a.status = 'active'
      AND a.deleted_at IS NULL AND n.kind = 'trigger' AND n.type = 'priority_changed'
  ) THEN
    INSERT INTO paca_automation_event_outbox (project_id, task_id, event_type, payload)
    VALUES (NEW.project_id, NEW.id, 'priority_changed', jsonb_build_object(
      'task_id', NEW.id, 'previous_importance', OLD.importance, 'importance', NEW.importance));
  END IF;

  IF OLD.tags IS DISTINCT FROM NEW.tags THEN
    SELECT coalesce(jsonb_agg(tag ORDER BY tag), '[]'::jsonb) INTO added_tags
    FROM (
      SELECT DISTINCT value AS tag FROM jsonb_array_elements_text(NEW.tags)
      EXCEPT
      SELECT DISTINCT value AS tag FROM jsonb_array_elements_text(OLD.tags)
    ) added;
    IF jsonb_array_length(added_tags) > 0 AND EXISTS (
      SELECT 1 FROM paca_automation a
      JOIN paca_automation_node n ON n.automation_id = a.id
      WHERE a.project_id = NEW.project_id AND a.status = 'active'
        AND a.deleted_at IS NULL AND n.kind = 'trigger' AND n.type = 'tag_added'
    ) THEN
      INSERT INTO paca_automation_event_outbox (project_id, task_id, event_type, payload)
      VALUES (NEW.project_id, NEW.id, 'tag_added', jsonb_build_object(
        'task_id', NEW.id, 'added_tags', added_tags));
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER paca_automation_task_event_status ON paca_task;
CREATE TRIGGER paca_automation_task_event_fields
AFTER UPDATE OF status_id, importance, tags ON paca_task
FOR EACH ROW EXECUTE FUNCTION paca_automation_capture_task_event();

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0033_light_barracuda', '6c376dfc86cb44f975f7838ddc5d8911b8c33dd11824e40d7f81536048649c10');

COMMIT;
