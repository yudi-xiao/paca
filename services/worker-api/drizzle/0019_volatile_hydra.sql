BEGIN;

CREATE TABLE "paca_agent_host_runtime" (
	"host_id" text PRIMARY KEY NOT NULL,
	"approved_labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reported_labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reported_harness_kinds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"labels_version" integer DEFAULT 1 NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"heartbeat_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_agent_host_runtime_labels_version_check" CHECK ("paca_agent_host_runtime"."labels_version" >= 1),
	CONSTRAINT "paca_agent_host_runtime_heartbeat_check" CHECK (("paca_agent_host_runtime"."last_heartbeat_at" is null and "paca_agent_host_runtime"."heartbeat_expires_at" is null) or ("paca_agent_host_runtime"."last_heartbeat_at" is not null and "paca_agent_host_runtime"."heartbeat_expires_at" is not null and "paca_agent_host_runtime"."heartbeat_expires_at" > "paca_agent_host_runtime"."last_heartbeat_at")),
	CONSTRAINT "paca_agent_host_runtime_approved_labels_check" CHECK (jsonb_typeof("paca_agent_host_runtime"."approved_labels") = 'array'),
	CONSTRAINT "paca_agent_host_runtime_reported_labels_check" CHECK (jsonb_typeof("paca_agent_host_runtime"."reported_labels") = 'array'),
	CONSTRAINT "paca_agent_host_runtime_harness_kinds_check" CHECK (jsonb_typeof("paca_agent_host_runtime"."reported_harness_kinds") = 'array')
);
--> statement-breakpoint
CREATE TABLE "paca_agent_task_requirement" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"required_labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_agent_task_requirement_labels_check" CHECK (jsonb_typeof("paca_agent_task_requirement"."required_labels") = 'array')
);
--> statement-breakpoint
ALTER TABLE "paca_agent_host_runtime" ADD CONSTRAINT "paca_agent_host_runtime_host_id_agent_host_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."agent_host"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_agent_host_runtime" ADD CONSTRAINT "paca_agent_host_runtime_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_agent_task_requirement" ADD CONSTRAINT "paca_agent_task_requirement_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_agent_task_requirement" ADD CONSTRAINT "paca_agent_task_requirement_task_project_fk" FOREIGN KEY ("task_id","project_id") REFERENCES "public"."paca_task"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paca_agent_host_runtime_heartbeat_idx" ON "paca_agent_host_runtime" USING btree ("heartbeat_expires_at");--> statement-breakpoint
CREATE INDEX "paca_agent_task_requirement_project_idx" ON "paca_agent_task_requirement" USING btree ("project_id");--> statement-breakpoint

-- Preserve the already-approved internal Hosts' ability to execute tasks while
-- requiring every future Host label expansion to pass through the Paca admin API.
INSERT INTO "paca_agent_host_runtime" (
	"host_id", "approved_labels", "labels_version", "approved_by", "approved_at"
)
SELECT
	"id", '["task:execute"]'::jsonb, 1, "user_id", now()
FROM "agent_host"
WHERE "status" = 'active'
ON CONFLICT ("host_id") DO NOTHING;

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0019_volatile_hydra', 'f699b873f9558d12e7e1c03c793aa030abfb61efdc3db7c7440d0946a0b43592');

COMMIT;
