BEGIN;

CREATE TABLE "paca_task_assignee" (
	"task_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_task_assignee_task_id_member_id_pk" PRIMARY KEY("task_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "paca_task_counter" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"last_value" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paca_task_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"position" integer DEFAULT 0 NOT NULL,
	"category" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_task_status_id_project_unique" UNIQUE("id","project_id"),
	CONSTRAINT "paca_task_status_category_check" CHECK ("paca_task_status"."category" in ('backlog', 'refinement', 'ready', 'todo', 'inprogress', 'done'))
);
--> statement-breakpoint
CREATE TABLE "paca_task_type" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"color" text,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_task_type_id_project_unique" UNIQUE("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "paca_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_number" bigint NOT NULL,
	"task_type_id" uuid,
	"status_id" uuid,
	"parent_task_id" uuid,
	"title" text NOT NULL,
	"description" jsonb,
	"importance" integer DEFAULT 0 NOT NULL,
	"story_points" integer,
	"reporter_id" uuid,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"start_date" date,
	"due_date" date,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "paca_task_id_project_unique" UNIQUE("id","project_id"),
	CONSTRAINT "paca_task_project_number_unique" UNIQUE("project_id","task_number"),
	CONSTRAINT "paca_task_importance_check" CHECK ("paca_task"."importance" >= 0),
	CONSTRAINT "paca_task_story_points_check" CHECK ("paca_task"."story_points" is null or "paca_task"."story_points" >= 0)
);
--> statement-breakpoint
ALTER TABLE "paca_task_assignee" ADD CONSTRAINT "paca_task_assignee_task_id_paca_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."paca_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_task_assignee" ADD CONSTRAINT "paca_task_assignee_member_id_paca_project_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."paca_project_member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_task_assignee" ADD CONSTRAINT "paca_task_assignee_project_id_paca_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."paca_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_task_counter" ADD CONSTRAINT "paca_task_counter_project_id_paca_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."paca_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_task_status" ADD CONSTRAINT "paca_task_status_project_id_paca_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."paca_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_task_type" ADD CONSTRAINT "paca_task_type_project_id_paca_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."paca_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_task" ADD CONSTRAINT "paca_task_project_id_paca_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."paca_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_task" ADD CONSTRAINT "paca_task_task_type_id_paca_task_type_id_fk" FOREIGN KEY ("task_type_id") REFERENCES "public"."paca_task_type"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_task" ADD CONSTRAINT "paca_task_status_id_paca_task_status_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."paca_task_status"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_task" ADD CONSTRAINT "paca_task_parent_task_id_paca_task_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."paca_task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_task" ADD CONSTRAINT "paca_task_reporter_id_paca_project_member_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."paca_project_member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paca_task_assignee_member_idx" ON "paca_task_assignee" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "paca_task_assignee_project_idx" ON "paca_task_assignee" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paca_task_status_project_name_uidx" ON "paca_task_status" USING btree ("project_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "paca_task_status_project_default_uidx" ON "paca_task_status" USING btree ("project_id") WHERE "paca_task_status"."is_default" = true;--> statement-breakpoint
CREATE INDEX "paca_task_status_project_position_idx" ON "paca_task_status" USING btree ("project_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "paca_task_type_project_name_uidx" ON "paca_task_type" USING btree ("project_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "paca_task_type_project_default_uidx" ON "paca_task_type" USING btree ("project_id") WHERE "paca_task_type"."is_default" = true;--> statement-breakpoint
CREATE INDEX "paca_task_type_project_idx" ON "paca_task_type" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "paca_task_project_number_idx" ON "paca_task" USING btree ("project_id","task_number");--> statement-breakpoint
CREATE INDEX "paca_task_project_status_idx" ON "paca_task" USING btree ("project_id","status_id");--> statement-breakpoint
CREATE INDEX "paca_task_parent_idx" ON "paca_task" USING btree ("parent_task_id");--> statement-breakpoint
INSERT INTO "paca_task_type" ("id", "project_id", "name", "icon", "color", "description", "is_default", "is_system")
SELECT gen_random_uuid(), p."id", seed."name", seed."icon", seed."color", seed."description", seed."is_default", true
FROM "paca_project" p
CROSS JOIN (
	VALUES
		('Task', 'circle-check', '#3b82f6', 'Standard project task', true),
		('Bug', 'bug', '#ef4444', 'Defect or unexpected behavior', false)
) AS seed("name", "icon", "color", "description", "is_default")
WHERE p."status" = 'active';--> statement-breakpoint
INSERT INTO "paca_task_status" ("id", "project_id", "name", "color", "position", "category", "is_default")
SELECT gen_random_uuid(), p."id", seed."name", seed."color", seed."position", seed."category", seed."is_default"
FROM "paca_project" p
CROSS JOIN (
	VALUES
		('Backlog', '#64748b', 0, 'backlog', true),
		('To Do', '#3b82f6', 1, 'todo', false),
		('In Progress', '#f59e0b', 2, 'inprogress', false),
		('Done', '#22c55e', 3, 'done', false)
) AS seed("name", "color", "position", "category", "is_default")
WHERE p."status" = 'active';--> statement-breakpoint
INSERT INTO "paca_task_counter" ("project_id", "last_value")
SELECT p."id", 0 FROM "paca_project" p
ON CONFLICT ("project_id") DO NOTHING;

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0005_true_taskmaster', 'cd20a80341fc8839b2a98d79e2efec4a81cd43cb4a8f1dcb482865ea15beb3bb');

COMMIT;
