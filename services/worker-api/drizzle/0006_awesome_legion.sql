BEGIN;

CREATE TABLE "paca_task_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"actor_user_id" text,
	"actor_member_id" uuid,
	"activity_type" text NOT NULL,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "paca_task_activity" ADD CONSTRAINT "paca_task_activity_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_task_activity" ADD CONSTRAINT "paca_task_activity_actor_member_id_paca_project_member_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."paca_project_member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_task_activity" ADD CONSTRAINT "paca_task_activity_task_project_fk" FOREIGN KEY ("task_id","project_id") REFERENCES "public"."paca_task"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paca_task_activity_task_created_idx" ON "paca_task_activity" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "paca_task_activity_project_created_idx" ON "paca_task_activity" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "paca_task_activity_actor_user_idx" ON "paca_task_activity" USING btree ("actor_user_id","created_at") WHERE "paca_task_activity"."actor_user_id" is not null;

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0006_awesome_legion', '166a704c5f050f6d4a11baa9f41db6cef105f8d03941e5256a27ab35ae6afadb');

COMMIT;
