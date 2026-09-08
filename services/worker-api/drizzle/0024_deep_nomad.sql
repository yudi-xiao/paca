BEGIN;

CREATE TABLE "paca_environment_scope" (
	"environment_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"backend" text NOT NULL,
	"gateway_reference" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "paca_environment_scope_environment_project_unique" UNIQUE("environment_id","project_id"),
	CONSTRAINT "paca_environment_scope_backend_check" CHECK ("paca_environment_scope"."backend" in ('cloudflare-computer', 'legacy-agent-runner')),
	CONSTRAINT "paca_environment_scope_gateway_reference_check" CHECK (length("paca_environment_scope"."gateway_reference") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "paca_environment_scope" ADD CONSTRAINT "paca_environment_scope_project_id_paca_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."paca_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paca_environment_scope_project_idx" ON "paca_environment_scope" USING btree ("project_id");

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0024_deep_nomad', '511becf3c324d222be5dd0ea4bc1c088fe7c621cdde2b35fbb445827ded6710b');

COMMIT;
