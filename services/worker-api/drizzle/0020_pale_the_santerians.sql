BEGIN;

ALTER TABLE "paca_agent_task_lease_event" DROP CONSTRAINT "paca_agent_task_lease_event_action_check";--> statement-breakpoint
ALTER TABLE "paca_agent_task_lease_event" ADD COLUMN "actor_type" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "paca_agent_task_lease_event" ADD COLUMN "actor_id" text;--> statement-breakpoint
ALTER TABLE "paca_agent_task_lease_event" ADD CONSTRAINT "paca_agent_task_lease_event_actor_type_check" CHECK ("paca_agent_task_lease_event"."actor_type" in ('agent', 'user', 'system'));--> statement-breakpoint
ALTER TABLE "paca_agent_task_lease_event" ADD CONSTRAINT "paca_agent_task_lease_event_action_check" CHECK ("paca_agent_task_lease_event"."action" in ('claim', 'renew', 'checkpoint', 'complete', 'fail', 'cancel_ack', 'cancel_request'));

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0020_pale_the_santerians', 'ce7171029426358b5a36005767e07b314316611bae94bf0f20941a46129970e6');

COMMIT;
