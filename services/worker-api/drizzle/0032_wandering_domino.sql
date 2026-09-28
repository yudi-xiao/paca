BEGIN;

ALTER TABLE "paca_notification" DROP CONSTRAINT "paca_notification_actor_type_check";--> statement-breakpoint
ALTER TABLE "paca_notification" DROP CONSTRAINT "paca_notification_actor_identity_check";--> statement-breakpoint
ALTER TABLE "paca_notification" ADD CONSTRAINT "paca_notification_actor_type_check" CHECK ("paca_notification"."actor_type" in ('user', 'agent', 'system'));--> statement-breakpoint
ALTER TABLE "paca_notification" ADD CONSTRAINT "paca_notification_actor_identity_check" CHECK (("paca_notification"."actor_type" = 'user' and "paca_notification"."actor_agent_id" is null) or ("paca_notification"."actor_type" = 'agent' and "paca_notification"."actor_user_id" is null) or ("paca_notification"."actor_type" = 'system' and "paca_notification"."actor_user_id" is null and "paca_notification"."actor_agent_id" is null));

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0032_wandering_domino', '56c631618eb71ca4db5ed78107c5758c56cf5a76c1a570330cf082b5cb31cb6c');

COMMIT;
