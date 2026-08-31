BEGIN;

ALTER TABLE "paca_task_activity" ADD COLUMN "actor_type" text;--> statement-breakpoint
ALTER TABLE "paca_task_activity" ADD COLUMN "actor_id" text;--> statement-breakpoint
ALTER TABLE "paca_task_activity" ADD COLUMN "actor_agent_id" text;--> statement-breakpoint
UPDATE "paca_task_activity"
SET "actor_type" = 'user', "actor_id" = "actor_user_id"
WHERE "actor_user_id" IS NOT NULL;--> statement-breakpoint
UPDATE "paca_task_activity"
SET "actor_type" = 'system', "actor_id" = 'system', "actor_member_id" = NULL
WHERE "actor_user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "paca_task_activity" ALTER COLUMN "actor_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "paca_task_activity" ALTER COLUMN "actor_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "paca_task_activity" ADD CONSTRAINT "paca_task_activity_actor_agent_id_agent_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paca_task_activity_actor_created_idx" ON "paca_task_activity" USING btree ("actor_type","actor_id","created_at");--> statement-breakpoint
CREATE INDEX "paca_task_activity_actor_agent_idx" ON "paca_task_activity" USING btree ("actor_agent_id","created_at") WHERE "paca_task_activity"."actor_agent_id" is not null;--> statement-breakpoint
ALTER TABLE "paca_task_activity" ADD CONSTRAINT "paca_task_activity_actor_type_check" CHECK ("paca_task_activity"."actor_type" in ('user', 'agent', 'system'));--> statement-breakpoint
ALTER TABLE "paca_task_activity" ADD CONSTRAINT "paca_task_activity_actor_identity_check" CHECK (("paca_task_activity"."actor_type" = 'user' and "paca_task_activity"."actor_agent_id" is null and ("paca_task_activity"."actor_user_id" is null or "paca_task_activity"."actor_user_id" = "paca_task_activity"."actor_id")) or ("paca_task_activity"."actor_type" = 'agent' and "paca_task_activity"."actor_user_id" is null and "paca_task_activity"."actor_member_id" is null and ("paca_task_activity"."actor_agent_id" is null or "paca_task_activity"."actor_agent_id" = "paca_task_activity"."actor_id")) or ("paca_task_activity"."actor_type" = 'system' and "paca_task_activity"."actor_id" = 'system' and "paca_task_activity"."actor_user_id" is null and "paca_task_activity"."actor_agent_id" is null and "paca_task_activity"."actor_member_id" is null));

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0009_awesome_scourge', '79444245c9ea385927d350a0bc6424abe7c4d8a26ffc557a1dd62711bfe78049');

COMMIT;
