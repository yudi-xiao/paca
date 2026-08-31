BEGIN;

CREATE TABLE "paca_task_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_task_id" uuid NOT NULL,
	"target_task_id" uuid NOT NULL,
	"link_type" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_task_link_pair_type_unique" UNIQUE("source_task_id","target_task_id","link_type"),
	CONSTRAINT "paca_task_link_type_check" CHECK ("paca_task_link"."link_type" in ('blocks', 'relates_to', 'duplicates')),
	CONSTRAINT "paca_task_link_no_self_check" CHECK ("paca_task_link"."source_task_id" <> "paca_task_link"."target_task_id")
);
--> statement-breakpoint
ALTER TABLE "paca_task_link" ADD CONSTRAINT "paca_task_link_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_task_link" ADD CONSTRAINT "paca_task_link_source_project_fk" FOREIGN KEY ("source_task_id","project_id") REFERENCES "public"."paca_task"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_task_link" ADD CONSTRAINT "paca_task_link_target_project_fk" FOREIGN KEY ("target_task_id","project_id") REFERENCES "public"."paca_task"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paca_task_link_project_source_idx" ON "paca_task_link" USING btree ("project_id","source_task_id");--> statement-breakpoint
CREATE INDEX "paca_task_link_project_target_idx" ON "paca_task_link" USING btree ("project_id","target_task_id");

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0013_glorious_miracleman', '8550d0b4e09031cf8c06af8d73df4636213e7f3cff27db7ba206ad85ecba1885');

COMMIT;
