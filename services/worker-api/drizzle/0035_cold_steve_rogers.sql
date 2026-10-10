BEGIN;

ALTER TABLE "paca_automation_event_outbox" DROP CONSTRAINT "paca_automation_event_type_check";--> statement-breakpoint
ALTER TABLE "paca_automation_event_outbox" ADD COLUMN "schedule_key" text;--> statement-breakpoint
CREATE INDEX "paca_task_project_due_date_idx" ON "paca_task" USING btree ("project_id","due_date","id") WHERE "paca_task"."deleted_at" is null and "paca_task"."due_date" is not null;--> statement-breakpoint
ALTER TABLE "paca_automation_event_outbox" ADD CONSTRAINT "paca_automation_event_schedule_unique" UNIQUE("schedule_key");--> statement-breakpoint
ALTER TABLE "paca_automation_event_outbox" ADD CONSTRAINT "paca_automation_event_schedule_key_check" CHECK ("paca_automation_event_outbox"."schedule_key" is null or length("paca_automation_event_outbox"."schedule_key") between 1 and 255);--> statement-breakpoint
ALTER TABLE "paca_automation_event_outbox" ADD CONSTRAINT "paca_automation_event_type_check" CHECK ("paca_automation_event_outbox"."event_type" in ('task_created', 'status_changed', 'assignee_changed', 'priority_changed', 'tag_added', 'predecessor_done', 'due_date_reached'));

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0035_cold_steve_rogers', '806b9ae4edcc45aab0038bfe128cad8d2f25ff24bc76df1a7184c16be0567fa2');

COMMIT;
