BEGIN;

CREATE TABLE "paca_notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_user_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" text,
	"actor_agent_id" text,
	"type" text NOT NULL,
	"task_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_activity_id" uuid NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_notification_type_check" CHECK ("paca_notification"."type" in ('assigned', 'mentioned')),
	CONSTRAINT "paca_notification_actor_type_check" CHECK ("paca_notification"."actor_type" in ('user', 'agent')),
	CONSTRAINT "paca_notification_actor_identity_check" CHECK (("paca_notification"."actor_type" = 'user' and "paca_notification"."actor_agent_id" is null) or ("paca_notification"."actor_type" = 'agent' and "paca_notification"."actor_user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "paca_notification" ADD CONSTRAINT "paca_notification_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_notification" ADD CONSTRAINT "paca_notification_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_notification" ADD CONSTRAINT "paca_notification_actor_agent_id_agent_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_notification" ADD CONSTRAINT "paca_notification_source_activity_id_paca_task_activity_id_fk" FOREIGN KEY ("source_activity_id") REFERENCES "public"."paca_task_activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_notification" ADD CONSTRAINT "paca_notification_task_project_fk" FOREIGN KEY ("task_id","project_id") REFERENCES "public"."paca_task"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paca_notification_source_recipient_type_uidx" ON "paca_notification" USING btree ("source_activity_id","recipient_user_id","type");--> statement-breakpoint
CREATE INDEX "paca_notification_recipient_created_idx" ON "paca_notification" USING btree ("recipient_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "paca_notification_recipient_unread_idx" ON "paca_notification" USING btree ("recipient_user_id","created_at") WHERE "paca_notification"."read_at" is null;--> statement-breakpoint
CREATE INDEX "paca_notification_project_created_idx" ON "paca_notification" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "paca_notification_task_created_idx" ON "paca_notification" USING btree ("task_id","created_at");

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0022_fine_molten_man', '36aaf3dff9d6e93af0cc750a1390a9231613a65f7badb6584bf17c42e4bd21ff');

COMMIT;
