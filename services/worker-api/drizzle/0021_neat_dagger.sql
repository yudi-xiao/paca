BEGIN;

ALTER TABLE "paca_agent_task_lease_event" DROP CONSTRAINT "paca_agent_task_lease_event_action_check";--> statement-breakpoint
ALTER TABLE "paca_agent_task_lease_event" ADD CONSTRAINT "paca_agent_task_lease_event_action_check" CHECK ("paca_agent_task_lease_event"."action" in ('claim', 'renew', 'checkpoint', 'complete', 'fail', 'cancel_ack', 'cancel_request', 'expire'));

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0021_neat_dagger', 'a9ff731926a82b83d81305a82b9d7a907ded5b162fbd46a1cb27870b8b72c51c');

COMMIT;
