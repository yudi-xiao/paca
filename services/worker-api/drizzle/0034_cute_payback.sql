BEGIN;

ALTER TABLE "paca_automation_event_outbox" DROP CONSTRAINT "paca_automation_event_type_check";--> statement-breakpoint
ALTER TABLE "paca_automation_event_outbox" ADD CONSTRAINT "paca_automation_event_type_check" CHECK ("paca_automation_event_outbox"."event_type" in ('task_created', 'status_changed', 'assignee_changed', 'priority_changed', 'tag_added', 'predecessor_done'));

-- A predecessor event represents one transition into the Done category, not
-- every status edit while the task remains Done. The planner rechecks the
-- entire watched set before creating a Run.
CREATE FUNCTION paca_automation_capture_predecessor_done() RETURNS trigger AS $$
DECLARE
  eligible_trigger_ids jsonb;
BEGIN
  IF NEW.deleted_at IS NOT NULL OR OLD.status_id IS NOT DISTINCT FROM NEW.status_id THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM paca_task_status s
    WHERE s.id = NEW.status_id AND s.project_id = NEW.project_id AND s.category = 'done'
  ) AND NOT EXISTS (
    SELECT 1 FROM paca_task_status s
    WHERE s.id = OLD.status_id AND s.project_id = OLD.project_id AND s.category = 'done'
  ) THEN
    -- Serialize concurrent completions of different watched tasks through
    -- their active graph row. The later transaction must observe the earlier
    -- committed status before deciding whether the AND-join became true.
    PERFORM a.id FROM paca_automation a
    WHERE a.project_id = NEW.project_id AND a.status = 'active'
      AND a.deleted_at IS NULL AND EXISTS (
        SELECT 1 FROM paca_automation_node n
        WHERE n.automation_id = a.id AND n.kind = 'trigger'
          AND n.type = 'predecessor_done'
          AND jsonb_typeof(n.config->'watched_task_ids') = 'array'
          AND (n.config->'watched_task_ids') ? (NEW.id::text)
      )
    ORDER BY a.id FOR UPDATE OF a;
    IF NOT FOUND THEN RETURN NEW; END IF;

    -- Freeze the eligible node set at event time. Otherwise an earlier
    -- predecessor event delivered after another task completes could start a
    -- duplicate Run for the same AND-join.
    SELECT coalesce(jsonb_agg(n.id), '[]'::jsonb) INTO eligible_trigger_ids
    FROM paca_automation a
    JOIN paca_automation_node n ON n.automation_id = a.id
    WHERE a.project_id = NEW.project_id AND a.status = 'active'
      AND a.deleted_at IS NULL AND n.kind = 'trigger' AND n.type = 'predecessor_done'
      AND jsonb_typeof(n.config->'watched_task_ids') = 'array'
      AND (n.config->'watched_task_ids') ? (NEW.id::text)
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(CASE
          WHEN jsonb_typeof(n.config->'watched_task_ids') = 'array'
          THEN n.config->'watched_task_ids' ELSE '[]'::jsonb END) watched(task_id)
        LEFT JOIN paca_task t ON t.id::text = watched.task_id
          AND t.project_id = NEW.project_id AND t.deleted_at IS NULL
        LEFT JOIN paca_task_status s ON s.id = t.status_id
          AND s.project_id = NEW.project_id
        WHERE s.category IS DISTINCT FROM 'done'
      );
    IF jsonb_array_length(eligible_trigger_ids) > 0 THEN
      INSERT INTO paca_automation_event_outbox (project_id, task_id, event_type, payload)
      VALUES (NEW.project_id, NEW.id, 'predecessor_done', jsonb_build_object(
        'task_id', NEW.id, 'watched_task_id', NEW.id,
        'status_id', NEW.status_id, 'eligible_trigger_ids', eligible_trigger_ids));
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER paca_automation_task_predecessor_done
AFTER UPDATE OF status_id ON paca_task
FOR EACH ROW EXECUTE FUNCTION paca_automation_capture_predecessor_done();

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0034_cute_payback', '8a4d26aa520f7c4ed15e1746077eb1af6e2f010696813d663d2fd8f501d82e29');

COMMIT;
