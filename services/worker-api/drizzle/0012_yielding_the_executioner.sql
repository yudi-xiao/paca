BEGIN;

CREATE TABLE "paca_attachment_migration_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"source_bucket" text NOT NULL,
	"source_key" text NOT NULL,
	"source_file_id" uuid NOT NULL,
	"source_attachment_id" uuid NOT NULL,
	"target_file_id" uuid NOT NULL,
	"target_attachment_id" uuid NOT NULL,
	"target_bucket" text NOT NULL,
	"target_storage_key" text NOT NULL,
	"source_size" bigint NOT NULL,
	"sha256" text,
	"target_etag" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"owns_target_object" boolean DEFAULT false NOT NULL,
	"owns_target_file" boolean DEFAULT false NOT NULL,
	"owns_target_attachment" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"rollback_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_attachment_migration_run_source_unique" UNIQUE("run_id","source_attachment_id"),
	CONSTRAINT "paca_attachment_migration_source_size_check" CHECK ("paca_attachment_migration_item"."source_size" > 0),
	CONSTRAINT "paca_attachment_migration_status_check" CHECK ("paca_attachment_migration_item"."status" in ('planned', 'copied', 'imported', 'rollback_started', 'rolled_back', 'failed')),
	CONSTRAINT "paca_attachment_migration_attempts_check" CHECK ("paca_attachment_migration_item"."attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX "paca_attachment_migration_run_status_idx" ON "paca_attachment_migration_item" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "paca_attachment_migration_target_idx" ON "paca_attachment_migration_item" USING btree ("target_attachment_id","target_file_id");

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0012_yielding_the_executioner', 'cea98a282885240c950ec6c4288a96da8b45eebe3d934ff077ac670378d4a5e7');

COMMIT;
