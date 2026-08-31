BEGIN;

CREATE TABLE "paca_custom_field_definition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"display_name" text NOT NULL,
	"field_type" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_custom_field_definition_id_project_unique" UNIQUE("id","project_id"),
	CONSTRAINT "paca_custom_field_definition_project_key_unique" UNIQUE("project_id","field_key"),
	CONSTRAINT "paca_custom_field_definition_type_check" CHECK ("paca_custom_field_definition"."field_type" in ('text', 'number', 'date', 'select', 'multi_select', 'boolean', 'url'))
);
--> statement-breakpoint
CREATE TABLE "paca_sprint" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start_date" date,
	"end_date" date,
	"goal" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_sprint_id_project_unique" UNIQUE("id","project_id"),
	CONSTRAINT "paca_sprint_status_check" CHECK ("paca_sprint"."status" in ('planned', 'active', 'completed')),
	CONSTRAINT "paca_sprint_date_range_check" CHECK ("paca_sprint"."start_date" is null or "paca_sprint"."end_date" is null or "paca_sprint"."start_date" <= "paca_sprint"."end_date")
);
--> statement-breakpoint
CREATE TABLE "paca_task_view" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sprint_id" uuid,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"view_type" text DEFAULT 'table' NOT NULL,
	"view_context" text DEFAULT 'sprint' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_task_view_id_project_unique" UNIQUE("id","project_id"),
	CONSTRAINT "paca_task_view_type_check" CHECK ("paca_task_view"."view_type" in ('table', 'board', 'roadmap', 'plugin')),
	CONSTRAINT "paca_task_view_context_check" CHECK ("paca_task_view"."view_context" in ('sprint', 'backlog', 'timeline')),
	CONSTRAINT "paca_task_view_scope_check" CHECK (("paca_task_view"."view_context" = 'sprint' and "paca_task_view"."sprint_id" is not null) or ("paca_task_view"."view_context" in ('backlog', 'timeline') and "paca_task_view"."sprint_id" is null))
);
--> statement-breakpoint
CREATE TABLE "paca_view_task_position" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"view_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"group_key" text,
	CONSTRAINT "paca_view_task_position_view_task_unique" UNIQUE("view_id","task_id")
);
--> statement-breakpoint
ALTER TABLE "paca_task" ADD COLUMN "sprint_id" uuid;--> statement-breakpoint
ALTER TABLE "paca_custom_field_definition" ADD CONSTRAINT "paca_custom_field_definition_project_id_paca_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."paca_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_sprint" ADD CONSTRAINT "paca_sprint_project_id_paca_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."paca_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_task_view" ADD CONSTRAINT "paca_task_view_project_id_paca_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."paca_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_task_view" ADD CONSTRAINT "paca_task_view_sprint_project_fk" FOREIGN KEY ("sprint_id","project_id") REFERENCES "public"."paca_sprint"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_view_task_position" ADD CONSTRAINT "paca_view_task_position_view_project_fk" FOREIGN KEY ("view_id","project_id") REFERENCES "public"."paca_task_view"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_view_task_position" ADD CONSTRAINT "paca_view_task_position_task_project_fk" FOREIGN KEY ("task_id","project_id") REFERENCES "public"."paca_task"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paca_custom_field_definition_project_name_idx" ON "paca_custom_field_definition" USING btree ("project_id","display_name");--> statement-breakpoint
CREATE INDEX "paca_sprint_project_status_idx" ON "paca_sprint" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "paca_sprint_project_created_idx" ON "paca_sprint" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "paca_task_view_sprint_position_idx" ON "paca_task_view" USING btree ("sprint_id","position");--> statement-breakpoint
CREATE INDEX "paca_task_view_project_context_position_idx" ON "paca_task_view" USING btree ("project_id","view_context","position");--> statement-breakpoint
CREATE INDEX "paca_view_task_position_view_position_idx" ON "paca_view_task_position" USING btree ("view_id","position");--> statement-breakpoint
CREATE INDEX "paca_view_task_position_task_idx" ON "paca_view_task_position" USING btree ("task_id");--> statement-breakpoint
-- PostgreSQL supports a column list for SET NULL. Keep project_id intact when a sprint is deleted.
ALTER TABLE "paca_task" ADD CONSTRAINT "paca_task_sprint_project_fk" FOREIGN KEY ("sprint_id","project_id") REFERENCES "public"."paca_sprint"("id","project_id") ON DELETE SET NULL ("sprint_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paca_task_project_sprint_idx" ON "paca_task" USING btree ("project_id","sprint_id");--> statement-breakpoint
INSERT INTO "paca_task_view" (
	"id", "sprint_id", "project_id", "name", "view_type", "view_context", "config", "position"
)
SELECT
	gen_random_uuid(),
	NULL,
	p."id",
	'Table',
	'table',
	'backlog',
	'{"column_by":"sprint","filters":{"task_types":{"all":false,"items":{"normal":{"all":true}}}}}'::jsonb,
	0
FROM "paca_project" p
WHERE p."status" = 'active'
	AND NOT EXISTS (
		SELECT 1
		FROM "paca_task_view" v
		WHERE v."project_id" = p."id" AND v."view_context" = 'backlog'
	);--> statement-breakpoint
INSERT INTO "paca_task_view" (
	"id", "sprint_id", "project_id", "name", "view_type", "view_context", "config", "position"
)
SELECT gen_random_uuid(), NULL, p."id", 'Roadmap', 'roadmap', 'timeline', '{}'::jsonb, 0
FROM "paca_project" p
WHERE p."status" = 'active'
	AND NOT EXISTS (
		SELECT 1
		FROM "paca_task_view" v
		WHERE v."project_id" = p."id" AND v."view_context" = 'timeline'
	);

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0007_yummy_microbe', '548548d4ab1b198e60310a788fce763c0251395e7a017ebd6eeae2e00ff4ace5');

COMMIT;
