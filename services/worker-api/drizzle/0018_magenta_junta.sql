BEGIN;

CREATE TABLE "paca_agent_task_lease_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lease_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"request_fingerprint" text NOT NULL,
	"action" text NOT NULL,
	"sequence" integer,
	"checkpoint_key" text,
	"summary" text,
	"artifact_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_agent_task_lease_event_request_unique" UNIQUE("request_id"),
	CONSTRAINT "paca_agent_task_lease_event_action_check" CHECK ("paca_agent_task_lease_event"."action" in ('claim', 'renew', 'checkpoint', 'complete', 'fail', 'cancel_ack')),
	CONSTRAINT "paca_agent_task_lease_event_sequence_check" CHECK ("paca_agent_task_lease_event"."sequence" is null or "paca_agent_task_lease_event"."sequence" >= 1)
);
--> statement-breakpoint
CREATE TABLE "paca_agent_task_lease" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"host_id" text NOT NULL,
	"harness_kind" text NOT NULL,
	"harness_version" text,
	"harness_instance_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"last_checkpoint_sequence" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error_code" text,
	"result_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_agent_task_lease_status_check" CHECK ("paca_agent_task_lease"."status" in ('active', 'cancelled', 'completed', 'expired', 'failed')),
	CONSTRAINT "paca_agent_task_lease_version_check" CHECK ("paca_agent_task_lease"."version" >= 1),
	CONSTRAINT "paca_agent_task_lease_checkpoint_sequence_check" CHECK ("paca_agent_task_lease"."last_checkpoint_sequence" >= 0),
	CONSTRAINT "paca_agent_task_lease_finished_check" CHECK (("paca_agent_task_lease"."status" = 'active' and "paca_agent_task_lease"."finished_at" is null) or ("paca_agent_task_lease"."status" <> 'active' and "paca_agent_task_lease"."finished_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "paca_agent_task_lease_event" ADD CONSTRAINT "paca_agent_task_lease_event_lease_id_paca_agent_task_lease_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."paca_agent_task_lease"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_agent_task_lease" ADD CONSTRAINT "paca_agent_task_lease_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_agent_task_lease" ADD CONSTRAINT "paca_agent_task_lease_host_id_agent_host_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."agent_host"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_agent_task_lease" ADD CONSTRAINT "paca_agent_task_lease_task_project_fk" FOREIGN KEY ("task_id","project_id") REFERENCES "public"."paca_task"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paca_agent_task_lease_event_checkpoint_uidx" ON "paca_agent_task_lease_event" USING btree ("lease_id","sequence") WHERE "paca_agent_task_lease_event"."sequence" is not null;--> statement-breakpoint
CREATE INDEX "paca_agent_task_lease_event_lease_created_idx" ON "paca_agent_task_lease_event" USING btree ("lease_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "paca_agent_task_lease_active_task_uidx" ON "paca_agent_task_lease" USING btree ("task_id") WHERE "paca_agent_task_lease"."status" = 'active';--> statement-breakpoint
CREATE INDEX "paca_agent_task_lease_agent_status_idx" ON "paca_agent_task_lease" USING btree ("agent_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "paca_agent_task_lease_project_status_idx" ON "paca_agent_task_lease" USING btree ("project_id","status","updated_at");

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0018_magenta_junta', '6017b070be9add98482a614f230c7f3ce853263595ffbb4697c792fb1f72bc5c');

COMMIT;
