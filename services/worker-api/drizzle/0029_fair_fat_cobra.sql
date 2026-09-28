BEGIN;

CREATE TABLE "paca_automation_edge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"source_node_id" uuid NOT NULL,
	"source_handle" text,
	"target_node_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_automation_edge_self_check" CHECK ("paca_automation_edge"."source_node_id" <> "paca_automation_edge"."target_node_id"),
	CONSTRAINT "paca_automation_edge_handle_check" CHECK ("paca_automation_edge"."source_handle" is null or (length("paca_automation_edge"."source_handle") between 1 and 100 and "paca_automation_edge"."source_handle" = btrim("paca_automation_edge"."source_handle")))
);
--> statement-breakpoint
CREATE TABLE "paca_automation_node" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pos_x" double precision DEFAULT 0 NOT NULL,
	"pos_y" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_automation_node_id_automation_unique" UNIQUE("id","automation_id"),
	CONSTRAINT "paca_automation_node_kind_check" CHECK ("paca_automation_node"."kind" in ('trigger', 'condition', 'action')),
	CONSTRAINT "paca_automation_node_type_check" CHECK ("paca_automation_node"."type" = btrim("paca_automation_node"."type") and length("paca_automation_node"."type") between 1 and 100),
	CONSTRAINT "paca_automation_node_config_check" CHECK (jsonb_typeof("paca_automation_node"."config") = 'object'),
	CONSTRAINT "paca_automation_node_position_check" CHECK ("paca_automation_node"."pos_x" > '-Infinity'::float8 and "paca_automation_node"."pos_x" < 'Infinity'::float8 and "paca_automation_node"."pos_y" > '-Infinity'::float8 and "paca_automation_node"."pos_y" < 'Infinity'::float8)
);
--> statement-breakpoint
CREATE TABLE "paca_automation_run_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"status" text NOT NULL,
	"input_snapshot" jsonb,
	"output_snapshot" jsonb,
	"error_code" text,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_automation_run_step_key_unique" UNIQUE("run_id","step_key"),
	CONSTRAINT "paca_automation_run_step_key_check" CHECK (length("paca_automation_run_step"."step_key") between 1 and 255),
	CONSTRAINT "paca_automation_run_step_status_check" CHECK ("paca_automation_run_step"."status" in ('completed', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "paca_automation_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"trigger_node_id" uuid NOT NULL,
	"task_id" uuid,
	"event_key" text NOT NULL,
	"graph_version" integer NOT NULL,
	"graph_snapshot" jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "paca_automation_run_id_automation_unique" UNIQUE("id","automation_id"),
	CONSTRAINT "paca_automation_run_event_unique" UNIQUE("automation_id","event_key"),
	CONSTRAINT "paca_automation_run_event_key_check" CHECK (length("paca_automation_run"."event_key") between 1 and 255),
	CONSTRAINT "paca_automation_run_graph_version_check" CHECK ("paca_automation_run"."graph_version" >= 1),
	CONSTRAINT "paca_automation_run_snapshot_check" CHECK (jsonb_typeof("paca_automation_run"."graph_snapshot") = 'object'),
	CONSTRAINT "paca_automation_run_status_check" CHECK ("paca_automation_run"."status" in ('running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "paca_automation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'inactive' NOT NULL,
	"graph_version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "paca_automation_id_project_unique" UNIQUE("id","project_id"),
	CONSTRAINT "paca_automation_name_check" CHECK ("paca_automation"."name" = btrim("paca_automation"."name") and length("paca_automation"."name") between 1 and 255),
	CONSTRAINT "paca_automation_status_check" CHECK ("paca_automation"."status" in ('active', 'inactive')),
	CONSTRAINT "paca_automation_graph_version_check" CHECK ("paca_automation"."graph_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "paca_automation_edge" ADD CONSTRAINT "paca_automation_edge_automation_id_paca_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."paca_automation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_automation_edge" ADD CONSTRAINT "paca_automation_edge_source_automation_fk" FOREIGN KEY ("source_node_id","automation_id") REFERENCES "public"."paca_automation_node"("id","automation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_automation_edge" ADD CONSTRAINT "paca_automation_edge_target_automation_fk" FOREIGN KEY ("target_node_id","automation_id") REFERENCES "public"."paca_automation_node"("id","automation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_automation_node" ADD CONSTRAINT "paca_automation_node_automation_id_paca_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."paca_automation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_automation_run_step" ADD CONSTRAINT "paca_automation_run_step_run_id_paca_automation_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."paca_automation_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_automation_run" ADD CONSTRAINT "paca_automation_run_automation_id_paca_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."paca_automation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_automation" ADD CONSTRAINT "paca_automation_project_id_paca_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."paca_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_automation" ADD CONSTRAINT "paca_automation_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paca_automation_edge_path_uidx" ON "paca_automation_edge" USING btree ("automation_id","source_node_id",coalesce("source_handle", ''),"target_node_id");--> statement-breakpoint
CREATE INDEX "paca_automation_edge_target_idx" ON "paca_automation_edge" USING btree ("target_node_id");--> statement-breakpoint
CREATE INDEX "paca_automation_node_automation_idx" ON "paca_automation_node" USING btree ("automation_id","created_at");--> statement-breakpoint
CREATE INDEX "paca_automation_node_trigger_type_idx" ON "paca_automation_node" USING btree ("type") WHERE "paca_automation_node"."kind" = 'trigger';--> statement-breakpoint
CREATE INDEX "paca_automation_run_step_run_executed_idx" ON "paca_automation_run_step" USING btree ("run_id","executed_at");--> statement-breakpoint
CREATE INDEX "paca_automation_run_automation_started_idx" ON "paca_automation_run" USING btree ("automation_id","started_at");--> statement-breakpoint
CREATE INDEX "paca_automation_run_task_idx" ON "paca_automation_run" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paca_automation_project_name_active_uidx" ON "paca_automation" USING btree ("project_id",lower("name")) WHERE "paca_automation"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "paca_automation_project_status_idx" ON "paca_automation" USING btree ("project_id","status","updated_at");

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0029_fair_fat_cobra', '19be2f71b7fc539643847ed387847df2a57ab3b6f2094df18390bed954720e5d');

COMMIT;
